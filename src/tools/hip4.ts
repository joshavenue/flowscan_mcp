import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { get } from "../client.js";
import { defineTool } from "../register.js";
import { envelope, matches, page, pick, result, shapeInput } from "../shape.js";

type Rec = Record<string, unknown>;

/** Shrink one outcome row: drop UI-only flags and replace the embedded question object with its id/name. */
function compactOutcome(o: Rec): Rec {
  const { question, completeness: _c, sideSpecs: _s, liveCompleteness: _l, ...rest } = o;
  const q = question as Rec | null | undefined;
  return q ? { ...rest, questionId: q.questionId, questionName: q.displayName ?? q.name } : rest;
}

function outcomeText(r: Rec): string {
  const q = (r.question as Rec | null) ?? {};
  return [r.name, r.description, r.displayName, r.deployerName, r.category, r.subCategory, r.underlying, r.marketType, q.displayName, q.category].map((x) => String(x ?? "")).join(" ");
}

export function registerHip4Tools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_hip4_markets",
    {
      title: "HIP-4 prediction markets (questions, active & settled outcomes)",
      description:
        "The /hip-4 page: HIP-4 outcome (prediction) markets. section='active' (default, ~250): tradable YES/NO outcomes with outcomeId, yes/noAssetId, marketType (binaryPrice, priceTouch, custom, question...), underlying/targetPrice/expiry for price markets, YES/NO mark prices, 24h change, total volume, spot contexts, deployer and question link. 'settled': recently resolved outcomes with settleFraction and per-side trade stats. 'questions': question groups (e.g. tournament winners) with their named outcome ids. 'all': the three lists. Pass outcomeId/yesAssetId/noAssetId to flowscan_hip4_outcome for candles. Source: flowscan.xyz /api/hip-4.",
      inputSchema: {
        section: z.enum(["active", "settled", "questions", "all"]).optional(),
        search: z.string().optional().describe("Case-insensitive substring over name, description, category, sub-category, underlying, market type, deployer and question name (e.g. 'BTC', 'Premier League', 'binaryPrice')."),
        category: z.string().optional().describe("Filter by category/sub-category/question category substring (e.g. 'NFL', 'Tournament')."),
        settledLimit: z.number().int().min(1).max(1000).optional().describe("How many recent settled outcomes/questions the upstream returns (site default 100)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const data = (await get("/api/hip-4", { limit: args.settledLimit ?? 100 }, { ttlMs: 60_000 })) as Rec;
      const section = args.section ?? "active";
      const key = { active: "activeOutcomes", settled: "settledOutcomes", questions: "questions", all: "" }[section as "active" | "settled" | "questions" | "all"];
      const f = (rows: Rec[]) =>
        rows
          .filter((r) => matches(outcomeText(r), args.search) && (!args.category || [r.category, r.subCategory, (r.question as Rec | null)?.category].some((c) => matches(c ?? "", args.category) && c)))
          .map((r) => (r.outcomeId !== undefined ? compactOutcome(r) : r));
      if (section === "all") {
        const out: Rec = { generatedAt: data.generatedAt };
        const extra: Rec = {};
        for (const k of ["questions", "activeOutcomes", "settledOutcomes"]) {
          const { items, paging } = page(f((data[k] as Rec[]) ?? []), args, 10);
          out[k] = items;
          extra[`${k}Paging`] = paging;
        }
        return result(envelope("/api/hip-4", pick(out, args.fields), extra));
      }
      const { items, paging } = page(f((data[key] as Rec[]) ?? []), args, 20);
      return result(envelope("/api/hip-4", pick({ generatedAt: data.generatedAt, [key]: items }, args.fields), { paging }));
    },
  );

  defineTool(
    server,
    "flowscan_hip4_outcome",
    {
      title: "HIP-4 outcome detail with YES/NO candles",
      description:
        "HIP-4 page outcome drill-down: candles for the YES and NO assets of one outcome over the last N days (compact rows [openTime ms, open, high, low, close, volume, trades]), plus per-side trade stats and, for settled outcomes (settled=true), the settled outcome record. Settled outcomes typically have no candles. Get outcomeId/yesAssetId/noAssetId from flowscan_hip4_markets. Source: flowscan.xyz /api/hip-4/{outcomeId}.",
      inputSchema: {
        outcomeId: z.number().int(),
        yesAssetId: z.string().describe("e.g. '#14730'"),
        noAssetId: z.string().describe("e.g. '#14731'"),
        interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).optional().describe("Candle interval (default '1h', as the site uses)."),
        days: z.number().int().min(1).max(90).optional().describe("Lookback days (default 7)."),
        settled: z.boolean().optional().describe("Set true for settled outcomes (site passes mode=settled)."),
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const route = `/api/hip-4/${encodeURIComponent(String(args.outcomeId))}`;
      const data = (await get(route, { yesCoin: args.yesAssetId, noCoin: args.noAssetId, interval: args.interval ?? "1h", days: args.days ?? 7, mode: args.settled ? "settled" : undefined })) as Rec;
      const compact = (c: unknown) => (Array.isArray(c) ? (c as Rec[]).map((k) => [k.t, k.o, k.h, k.l, k.c, k.v, k.n]) : c);
      const settled = data.settledOutcome && typeof data.settledOutcome === "object" ? compactOutcome(data.settledOutcome as Rec) : data.settledOutcome;
      const out = {
        ...data,
        candleColumns: ["openTime", "open", "high", "low", "close", "volume", "trades"],
        yesCandles: compact(data.yesCandles),
        noCandles: compact(data.noCandles),
        settledOutcome: settled,
      };
      return result(envelope(route, pick(out, args.fields)));
    },
  );

  defineTool(
    server,
    "flowscan_hip4_labels",
    {
      title: "HIP-4 asset id -> human label",
      description: "Resolve HIP-4 outcome asset ids like '#14730' (YES) / '#14731' (NO) to readable labels such as 'Arsenal · Yes', as the address page does for HIP-4 spot balances. Returns {labels: {assetId: label}}. Source: flowscan.xyz /api/hip-4/labels.",
      inputSchema: { assets: z.array(z.string()).min(1).max(100).describe("Asset ids, e.g. ['#14730','#14731'] or numeric strings.") },
    },
    async (args) => {
      const data = await get("/api/hip-4/labels", { assets: args.assets.join(",") });
      return result(envelope("/api/hip-4/labels", data));
    },
  );
}

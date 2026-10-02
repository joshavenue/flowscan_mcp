import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { get } from "../client.js";
import { defineTool } from "../register.js";
import { envelope, matches, page, pick, result, shapeInput } from "../shape.js";

type Rec = Record<string, unknown>;

/** Shrink one outcome row: drop UI-only flags and replace the embedded question object with its id/name. */
function compactOutcome(o: Rec, keepContexts = false): Rec {
  const { question, completeness: _c, sideSpecs: _s, liveCompleteness: _l, yesContext, noContext, ...rest } = o;
  if (keepContexts) Object.assign(rest, { yesContext, noContext });
  else {
    // keep the useful bits of the spot contexts without repeating marks
    const ctx = (c: unknown) => (c && typeof c === "object" ? { prevDayPx: (c as Rec).prevDayPx, dayNtlVlm: (c as Rec).dayNtlVlm, circulatingSupply: (c as Rec).circulatingSupply } : undefined);
    const y = ctx(yesContext);
    if (y) Object.assign(rest, { yesPrevDayPx: y.prevDayPx, yesDayNtlVlm: y.dayNtlVlm, noPrevDayPx: ctx(noContext)?.prevDayPx });
  }
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
        "The /hip-4 page: HIP-4 prediction markets. section='active' (default, ~250): YES/NO outcomes with outcomeId, asset ids, marketType (binaryPrice, priceTouch, custom, question...), underlying/targetPrice/expiry, yesMark/noMark (0-1 = implied probability), 24h change, volume, deployer, question link (full spot contexts with includeContexts). 'settled': resolved outcomes with settleFraction and trade stats. 'questions': question groups with their outcome ids. 'all': all three. Use flowscan_hip4_outcome(outcomeId) for candles.",
      inputSchema: {
        section: z.enum(["active", "settled", "questions", "all"]).optional(),
        search: z.string().optional().describe("Substring over name, description, category, underlying, type, deployer, question (e.g. 'Premier League')."),
        category: z.string().optional().describe("Filter by category/sub-category/question category substring (e.g. 'NFL', 'Tournament')."),
        settledLimit: z.number().int().min(1).max(1000).optional().describe("How many recent settled outcomes/questions the upstream returns (site default 100)."),
        includeContexts: z.boolean().optional().describe("Include the full YES/NO spot contexts per outcome (default false)."),
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
          .map((r) => (r.outcomeId !== undefined ? compactOutcome(r, args.includeContexts) : r));
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
        "HIP-4 page outcome drill-down: candles for the YES and NO assets of one outcome over the last N days (compact rows [openTime ms, open, high, low, close, volume, trades]), plus per-side trade stats and, for settled outcomes (settled=true), the settled outcome record. Settled outcomes typically have no candles. Only outcomeId is required (asset ids default to '#<outcomeId>0' YES / '#<outcomeId>1' NO). Get outcomeId from flowscan_hip4_markets.",
      inputSchema: {
        outcomeId: z.number().int(),
        yesAssetId: z.string().optional().describe("Default '#<outcomeId>0' (e.g. '#14730'); a missing '#' is added."),
        noAssetId: z.string().optional().describe("Default '#<outcomeId>1' (e.g. '#14731'); a missing '#' is added."),
        interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).optional().describe("Candle interval (default '1h', as the site uses)."),
        days: z.number().int().min(1).max(90).optional().describe("Lookback days (default 7)."),
        settled: z.boolean().optional().describe("Set true for settled outcomes (site passes mode=settled)."),
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const route = `/api/hip-4/${encodeURIComponent(String(args.outcomeId))}`;
      const asset = (v: string | undefined, side: 0 | 1) => {
        const x = String(v ?? `${args.outcomeId}${side}`).trim();
        return x.startsWith("#") ? x : `#${x}`;
      };
      const data = (await get(route, { yesCoin: asset(args.yesAssetId, 0), noCoin: asset(args.noAssetId, 1), interval: args.interval ?? "1h", days: args.days ?? 7, mode: args.settled ? "settled" : undefined })) as Rec;
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
      description: "Resolve HIP-4 outcome asset ids like '#14730' (YES) / '#14731' (NO) to readable labels such as 'Arsenal · Yes', as the address page does for HIP-4 spot balances. Returns {labels: {assetId: label}}.",
      inputSchema: { assets: z.array(z.string()).min(1).max(100).describe("Asset ids, e.g. ['#14730','#14731'] or numeric strings.") },
    },
    async (args) => {
      const data = await get("/api/hip-4/labels", { assets: args.assets.join(",") });
      return result(envelope("/api/hip-4/labels", data));
    },
  );
}

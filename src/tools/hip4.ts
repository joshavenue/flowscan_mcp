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

const n = (v: unknown) => Number(v ?? 0) || 0;
/** 24h notional volume (YES + NO spot contexts), 0 when unknown. */
const volume24h = (o: Rec) => n((o.yesContext as Rec | undefined)?.dayNtlVlm) + n((o.noContext as Rec | undefined)?.dayNtlVlm);
/** Lifetime notional volume: totalVolume when present, else YES + NO trade stats. */
const volumeTotal = (o: Rec) => (o.totalVolume !== undefined && o.totalVolume !== null ? n(o.totalVolume) : n((o.yesStats as Rec | undefined)?.volumeNotional) + n((o.noStats as Rec | undefined)?.volumeNotional));

const statsSlim = (st: unknown) =>
  st && typeof st === "object" ? { trades: (st as Rec).trades, uniqueTraders: (st as Rec).uniqueTraders, volumeNotional: (st as Rec).volumeNotional, lastPrice: (st as Rec).lastPrice, vwap: (st as Rec).vwap } : st;

/** Default row: identity, pricing and volume only (no description/keywords/template fields). */
function slimOutcome(o: Rec): Rec {
  const q = o.question as Rec | null | undefined;
  const row: Rec = {
    outcomeId: o.outcomeId,
    name: o.name,
    marketType: o.marketType,
    yesAssetId: o.yesAssetId,
    noAssetId: o.noAssetId,
    underlying: o.underlying,
    targetPrice: o.targetPrice,
    expiry: o.expiry,
    category: o.category ?? q?.category ?? o.subCategory ?? null,
    yesMark: o.yesMark,
    noMark: o.noMark,
    yesChange24h: o.yesChange24h,
    volume24h: volume24h(o),
    totalVolume: volumeTotal(o),
    deployerName: o.deployerName,
    questionId: q?.questionId,
    questionName: q ? (q.displayName ?? q.name) : undefined,
    settleFraction: o.settleFraction,
    settlePrice: o.settlePrice,
    yesStats: statsSlim(o.yesStats),
    noStats: statsSlim(o.noStats),
  };
  for (const k of Object.keys(row)) if (row[k] === undefined || row[k] === null) delete row[k];
  return row;
}

const SORTERS: Record<string, (o: Rec) => number> = {
  volume24h,
  totalVolume: volumeTotal,
  yesMark: (o) => n(o.yesMark),
  change24h: (o) => n(o.yesChange24h),
};

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
        "The /hip-4 page: HIP-4 prediction markets. section='active' (default): slim rows (outcomeId, name, marketType, asset ids, underlying/target/expiry, yesMark/noMark = implied probability, yesChange24h, volume24h, totalVolume, deployer, question) sorted by sortBy (default volume24h desc). 'settled': resolved outcomes with settleFraction and trade stats. 'questions': question groups. 'all': all three. full=true for descriptions. Candles: flowscan_hip4_outcome.",
      inputSchema: {
        section: z.enum(["active", "settled", "questions", "all"]).optional().describe("Default active."),
        search: z.string().optional().describe("Substring over name, description, category, underlying, type, deployer, question (e.g. 'Premier League')."),
        category: z.string().optional().describe("Category substring (e.g. 'NFL')."),
        settledLimit: z.number().int().min(1).max(1000).optional().describe("Settled outcomes to fetch (default 100)."),
        sortBy: z.enum(["volume24h", "totalVolume", "yesMark", "change24h"]).optional().describe("Default volume24h."),
        order: z.enum(["asc", "desc"]).optional().describe("Default desc."),
        full: z.boolean().optional().describe("Full rows instead of slim rows."),
        includeContexts: z.boolean().optional().describe("With full: raw spot contexts."),
        ...shapeInput,
      },
    },
    async (args) => {
      const data = (await get("/api/hip-4", { limit: args.settledLimit ?? 100 }, { ttlMs: 60_000 })) as Rec;
      const section = args.section ?? "active";
      const sortKey = args.sortBy ?? "volume24h";
      const sorter = SORTERS[sortKey];
      const dir = args.order === "asc" ? -1 : 1;
      const key = { active: "activeOutcomes", settled: "settledOutcomes", questions: "questions", all: "" }[section as "active" | "settled" | "questions" | "all"];
      const f = (rows: Rec[]) =>
        rows
          .filter((r) => matches(outcomeText(r), args.search) && (!args.category || [r.category, r.subCategory, (r.question as Rec | null)?.category].some((c) => matches(c ?? "", args.category) && c)))
          .sort((a, b) => (a.outcomeId === undefined ? 0 : (sorter(b) - sorter(a) || volumeTotal(b) - volumeTotal(a)) * dir))
          .map((r) => (r.outcomeId === undefined ? r : args.full ? compactOutcome(r, args.includeContexts) : slimOutcome(r)));
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
      return result(envelope("/api/hip-4", pick({ generatedAt: data.generatedAt, [key]: items }, args.fields), { paging, ...(section === "questions" ? {} : { sortedBy: `${sortKey} ${dir === 1 ? "desc" : "asc"}` }) }));
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
        outcomeId: z.number().int().describe("Outcome id from flowscan_hip4_markets."),
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

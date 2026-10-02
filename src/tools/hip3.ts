import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { get, LONG_TTL_MS } from "../client.js";
import { defineTool } from "../register.js";
import { envelope, matches, page, pick, result, shapeInput } from "../shape.js";

type Rec = Record<string, unknown>;

const snapshot = () => get("/api/dex-stats/snapshot", {}, { ttlMs: LONG_TTL_MS }) as Promise<Rec>;
const perDex = () => get("/api/dex-stats/per-dex", {}, { ttlMs: LONG_TTL_MS }) as Promise<Rec>;
const buildersStats = () => get("/api/dex-stats/builders", {}, { ttlMs: LONG_TTL_MS }) as Promise<Rec>;

/** Convert {dates:[], series:{DEX:[...]}} into recent rows. */
function tailSeries(block: Rec, days: number, dexFilter?: string): Rec {
  const dates = ((block.dates as string[]) ?? []).slice(-days);
  const series: Rec = {};
  for (const [dex, arr] of Object.entries((block.series as Rec) ?? {})) {
    if (dexFilter && !matches(dex, dexFilter)) continue;
    series[dex] = (arr as unknown[]).slice(-days);
  }
  return { dates, series };
}

/**
 * builders.per_dex_summary is {DEX: {total|30d|90d: {volume, builders: [...800+ rows]}}}.
 * Keep the volumes and only the top N builders per window.
 */
function summarizePerDex(pds: unknown, topN: number): Rec {
  const out: Rec = {};
  for (const [dex, windows] of Object.entries((pds as Rec) ?? {})) {
    const w: Rec = {};
    for (const [win, v] of Object.entries((windows as Rec) ?? {})) {
      const block = (v as Rec) ?? {};
      const builders = Array.isArray(block.builders) ? (block.builders as Rec[]) : [];
      w[win] = { volume: block.volume, builderCount: builders.length, topBuilders: builders.slice(0, topN) };
    }
    out[dex] = w;
  }
  return out;
}

export function registerHip3Tools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_hip3_overview",
    {
      title: "HIP-3 perp DEXs overview & market share",
      description:
        "The /hip-3 page headline: totals across all HIP-3 builder-deployed perp DEXs (volume all-time/30d/90d, trades, traders, new users, open interest), per-DEX market share (XYZ, FLX, Hyena, KM, VNTL, Dreamcash, Paragon, Entropy...), DEX list with collateral token, collateral market share, and the builder-routed share of HIP-3 volume (per-DEX top 3 builders; full list via flowscan_hip3_builders). Source: flowscan.xyz /api/dex-stats/snapshot.",
      inputSchema: { fields: shapeInput.fields },
    },
    async (args) => {
      const d = await snapshot();
      const b = (d.builders as Rec) ?? {};
      const out = {
        generated_at: d.generated_at,
        overview: d.overview,
        market_share: d.market_share,
        dexes: d.dexes,
        collateral_mapping: d.collateral_mapping,
        collateral_market_share: d.collateral_market_share,
        builder_routed: { totals: b.totals, per_dex_summary: summarizePerDex(b.per_dex_summary, 3) },
      };
      return result(envelope("/api/dex-stats/snapshot", pick(out, args.fields)));
    },
  );

  defineTool(
    server,
    "flowscan_hip3_daily",
    {
      title: "HIP-3 daily time series (volume, trades, traders, new users, OI)",
      description:
        "HIP-3 page charts: a daily series per DEX. metric: volume, trades, traders, new_users, oi, oi_by_market (top markets), collateral_traders, collateral_oi. Returns the last N days (default 30). Source: flowscan.xyz /api/dex-stats/snapshot.",
      inputSchema: {
        metric: z.enum(["volume", "trades", "traders", "new_users", "oi", "oi_by_market", "collateral_traders", "collateral_oi"]).optional().describe("Default volume."),
        dex: z.string().optional().describe("Only this DEX/series name (substring)."),
        days: z.number().int().min(1).max(400).optional().describe("Default 30."),
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const d = await snapshot();
      const metric = args.metric ?? "volume";
      const key = `daily_${metric}`;
      const block = (d[key] as Rec) ?? {};
      const out = tailSeries(block, args.days ?? 30, args.dex);
      if (block.markets) out.markets = block.markets;
      return result(envelope("/api/dex-stats/snapshot", pick(out, args.fields), { metric }));
    },
  );

  defineTool(
    server,
    "flowscan_hip3_markets",
    {
      title: "HIP-3 markets list & cross-DEX market comparison",
      description:
        "HIP-3 page market tables. Without `symbol`: all HIP-3 markets (dex, symbol, canonical underlying, asset class) filterable by dex/assetClass/search, plus asset-class groupings. With `symbol` (canonical, e.g. 'TSLA', 'GOLD'): which DEXs list it and, per DEX, OI, daily active users, volume, spread, slippage at 1k-1m notional, plus daily OI/DAU history. Source: flowscan.xyz /api/dex-stats/snapshot.",
      inputSchema: {
        symbol: z.string().optional().describe("Canonical underlying symbol for a cross-DEX comparison."),
        dex: z.string().optional(),
        assetClass: z.enum(["Crypto", "Indices", "Equities", "Commodities", "Currencies", "Bonds", "Private", "Other"]).optional(),
        search: z.string().optional(),
        days: z.number().int().min(1).max(400).optional().describe("Comparison history length (default 30)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const d = await snapshot();
      const markets = (d.markets as Rec) ?? {};
      if (args.symbol) {
        const comps = (d.market_comparisons as Rec) ?? {};
        const keyName = Object.keys(comps).find((k) => k.toLowerCase() === args.symbol!.toLowerCase());
        const comp = keyName ? ({ ...(comps[keyName] as Rec) } as Rec) : null;
        if (comp?.history) {
          const h = comp.history as Rec;
          const n = args.days ?? 30;
          comp.history = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Array.isArray(v) ? v.slice(-n) : v]));
        }
        const mappings = ((markets.canonical_mappings as Rec) ?? {})[keyName ?? args.symbol] ?? null;
        return result(envelope("/api/dex-stats/snapshot", pick({ symbol: keyName ?? args.symbol, listedAs: mappings, comparison: comp }, args.fields)));
      }
      const all = ((markets.all as Rec[]) ?? []).filter((m) => matches(m.dex, args.dex) && (!args.assetClass || m.asset_class === args.assetClass) && (matches(m.symbol, args.search) || matches(m.canonical, args.search)));
      const { items, paging } = page(all, args, 100);
      const byClass = Object.fromEntries(Object.entries((markets.by_asset_class as Rec) ?? {}).map(([k, v]) => [k, (v as unknown[]).length]));
      return result(envelope("/api/dex-stats/snapshot", pick({ marketsByAssetClassCount: byClass, markets: items }, args.fields), { paging }));
    },
  );

  defineTool(
    server,
    "flowscan_hip3_dex",
    {
      title: "One HIP-3 DEX: totals, markets, daily totals",
      description:
        "HIP-3 page per-DEX tab (e.g. XYZ, FLX, Hyena, KM, VNTL, Dreamcash, Paragon, Entropy): collateral token, total volume/trades/traders/OI, every market with volume/traders/OI (sorted by volume), and daily totals for the last N days. Source: flowscan.xyz /api/dex-stats/per-dex.",
      inputSchema: {
        dex: z.string().describe("DEX name as in flowscan_hip3_overview market_share keys (case-insensitive)."),
        days: z.number().int().min(1).max(400).optional().describe("Daily totals lookback (default 30)."),
        includeMarketDaily: z.boolean().optional().describe("Include each market's own daily series (large; default false)."),
        search: z.string().optional().describe("Filter markets by symbol substring."),
        ...shapeInput,
      },
    },
    async (args) => {
      const all = await perDex();
      const key = Object.keys(all).find((k) => k.toLowerCase() === args.dex.toLowerCase());
      if (!key) return result(envelope("/api/dex-stats/per-dex", { error: `Unknown DEX '${args.dex}'`, available: Object.keys(all) }));
      const dex = all[key] as Rec;
      const n = args.days ?? 30;
      let markets = ((dex.markets as Rec[]) ?? []).filter((m) => matches(m.symbol, args.search) || matches(m.canonical, args.search));
      markets = [...markets].sort((a, b) => Number(b.volume ?? 0) - Number(a.volume ?? 0));
      if (!args.includeMarketDaily) markets = markets.map(({ daily: _d, ...rest }) => rest);
      const { items, paging } = page(markets, args, 50);
      const dt = (dex.daily_totals as Rec) ?? {};
      const daily_totals = Object.fromEntries(Object.entries(dt).map(([k, v]) => [k, Array.isArray(v) ? v.slice(-n) : v]));
      return result(envelope("/api/dex-stats/per-dex", pick({ dex: key, collateral: dex.collateral, total: dex.total, markets: items, daily_totals }, args.fields), { paging }));
    },
  );

  defineTool(
    server,
    "flowscan_hip3_builders",
    {
      title: "Builder-routed volume on HIP-3 DEXs",
      description:
        "HIP-3 page 'Builders' section: share of HIP-3 volume routed through builder codes (totals for all-time/30d/90d), per-DEX builder volume with the top builders on each DEX, and a leaderboard of 800+ builders (address, name, total/30d/90d volume, share of builder volume and of DEX volume). Pass `dex` to rank builders by their volume on one DEX. Source: flowscan.xyz /api/dex-stats/builders.",
      inputSchema: {
        search: z.string().optional().describe("Filter builders by name/address substring."),
        window: z.enum(["total", "30d", "90d"]).optional().describe("Ranking window (default total = all-time)."),
        dex: z.string().optional().describe("Rank by volume on this DEX only (e.g. 'XYZ'); builders with none there are dropped."),
        includePerDex: z.boolean().optional().describe("Keep each builder's per_dex breakdown (default false)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const d = await buildersStats();
      const w = args.window ?? "total";
      const dexKey = args.dex ? Object.keys((d.per_dex_summary as Rec) ?? {}).find((k) => k.toLowerCase() === args.dex!.toLowerCase()) ?? args.dex : undefined;
      const score = (b: Rec): number => {
        if (!dexKey) return Number(b[w] ?? 0) || 0;
        return Number(((b.per_dex as Rec)?.[dexKey] as Rec | undefined)?.[w] ?? 0) || 0;
      };
      let rows: Rec[] = ((d.summary as Rec[]) ?? []).filter((b) => matches(b.name, args.search) || matches(b.address, args.search));
      if (dexKey) rows = rows.filter((b) => score(b) > 0);
      rows = [...rows].sort((a, b) => score(b) - score(a));
      if (!args.includePerDex) {
        rows = rows.map(({ per_dex, ...rest }) => (dexKey ? { ...rest, [`${dexKey}`]: (per_dex as Rec | undefined)?.[dexKey] ?? null } : rest));
      }
      const { items, paging } = page(rows, args, 50);
      const perDexSummary = summarizePerDex(d.per_dex_summary, 5);
      const out = {
        totals: d.totals,
        per_dex_summary: dexKey ? { [dexKey]: perDexSummary[dexKey] ?? null } : perDexSummary,
        rankedBy: dexKey ? `${dexKey}.${w}` : w,
        builders: items,
      };
      return result(envelope("/api/dex-stats/builders", pick(out, args.fields), { paging }));
    },
  );

  defineTool(
    server,
    "flowscan_hip3_binance_comparison",
    {
      title: "HIP-3 RWA markets vs Binance futures (OI & volume)",
      description:
        "HIP-3 page Binance comparison: ~240 real-world-asset symbols (stocks, HK/KR/CN equities, commodities, indices, FX, pre-market) with the matching Binance USDT-M futures symbol, Binance open interest (USD), 24h volume (USD) and last price. With `symbol`: that symbol's Binance row, its daily Binance OI/volume history, and the HIP-3 side for the same canonical symbol (per-DEX OI, DAU, volume, spread, slippage) for a side-by-side view. Source: flowscan.xyz /api/binance-rwa/comparison (+ /api/dex-stats/snapshot for the HIP-3 side).",
      inputSchema: {
        symbol: z.string().optional().describe("Canonical symbol, e.g. 'GOLD', 'TSLA', 'NVDA'. Returns one symbol with history and the HIP-3 side."),
        underlyingType: z.string().optional().describe("Exact type filter: EQUITY, HK_EQUITY, KR_EQUITY, CN_EQUITY, COMMODITY, INDEX, FX, PREMARKET."),
        sortBy: z.enum(["oi", "volume24h", "lastPrice"]).optional().describe("Default oi desc."),
        days: z.number().int().min(1).max(400).optional().describe("History length for single-symbol lookups (default 30)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const d = (await get("/api/binance-rwa/comparison", {}, { ttlMs: LONG_TTL_MS })) as Rec;
      const symbols = (d.symbols as Rec) ?? {};
      if (args.symbol) {
        const key = Object.keys(symbols).find((k) => k.toLowerCase() === args.symbol!.toLowerCase());
        const hist = key ? (((d.history as Rec) ?? {})[key] as Rec | undefined) : undefined;
        const n = args.days ?? 30;
        const history = hist ? Object.fromEntries(Object.entries(hist).map(([k, v]) => [k, Array.isArray(v) ? v.slice(-n) : v])) : null;
        const snap = await snapshot();
        const comps = (snap.market_comparisons as Rec) ?? {};
        const compKey = Object.keys(comps).find((k) => k.toLowerCase() === (key ?? args.symbol!).toLowerCase());
        const hip3 = compKey ? ((comps[compKey] as Rec).dexes ?? null) : null;
        const out = { generatedAt: d.generatedAt, symbol: key ?? args.symbol, found: Boolean(key), binance: key ? symbols[key] : null, binanceHistory: history, hip3ByDex: hip3 };
        return result(envelope("/api/binance-rwa/comparison", pick(out, args.fields), { units: "oi, volume24h and history values in USD" }));
      }
      const sortKey = args.sortBy ?? "oi";
      const wantType = args.underlyingType?.toUpperCase();
      const rows: Rec[] = Object.entries(symbols)
        .map(([symbol, v]): Rec => ({ symbol, ...(v as Rec) }))
        .filter((r) => !wantType || String(r.underlyingType ?? "").toUpperCase() === wantType)
        .sort((a, b) => Number(b[sortKey] ?? 0) - Number(a[sortKey] ?? 0));
      const { items, paging } = page(rows, args, 50);
      return result(envelope("/api/binance-rwa/comparison", pick({ generatedAt: d.generatedAt, symbols: items }, args.fields), { paging }));
    },
  );
}

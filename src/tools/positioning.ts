import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { get } from "../client.js";
import { defineTool } from "../register.js";
import { envelope, isoOf, pick, result, shapeInput } from "../shape.js";
import { resolveMarket, TRADER_FILTER_LABELS, traderFilterInput, withLabels } from "./perp.js";

type Rec = Record<string, unknown>;

const SHOWN_ON = "https://www.flowscan.xyz/terminal";
const includeTags = z.boolean().optional().describe("Add Flowscan name and trader tag per address (default true).");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
const snapshotTimes = (d: Rec): Rec => ({
  ...(isoOf(d.timestamp) ? { snapshotIso: isoOf(d.timestamp), snapshotAgeSeconds: Math.round((Date.now() - num(d.timestamp)) / 1000) } : {}),
  ...(isoOf(d.baselineTimestamp) ? { baselineIso: isoOf(d.baselineTimestamp) } : {}),
});

const DETAIL_SECTIONS = ["summary", "leverage", "positionSize", "accountValue", "whales", "liquidationClusters"] as const;

export function registerPositioningTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_perp_market_detail",
    {
      title: "One perp market: distributions, whales, liquidation clusters (/terminal)",
      description:
        "/terminal 'Distribution' tab and 'Depth' chart for ONE market (all accounts): summary (long/short counts and USD notional, two-sided OI, median leverage), positions bucketed by leverage, size and account value (count and USD notional, long vs short), the largest positions (whales, named) and liquidation clusters (USD that would be liquidated at each price; pctFromCurrent < 0 = below price, where longs liquidate), limited to clusterRangePct and summed in liquidationTotals. 'para:PAPER' adds the PAPER valuation panel (alone if PAPER is not in the snapshot).",
      inputSchema: {
        market: z.string().min(1).describe("Market, e.g. 'BTC', 'xyz:TSLA' (case-insensitive; bare 'TSLA' resolves when unique)."),
        sections: z.array(z.enum(DETAIL_SECTIONS)).optional().describe("Sections to return (default all)."),
        whalesLimit: z.number().int().min(1).max(50).optional().describe("Largest positions to return (default 20, max 50)."),
        clusterRangePct: z.number().min(1).max(100).optional().describe("Clusters within this % of price (default 15)."),
        clustersLimit: z.number().int().min(1).max(500).optional().describe("Max clusters, largest first (default 40)."),
        includeTags,
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const isPaper = /^(para|paragon):paper$/i.test(String(args.market).trim());
      // The terminal's PAPER valuation panel comes from /api/paper, whether or not PAPER is in the positioning snapshot.
      const paper = isPaper ? await get("/api/paper", {}, { ttlMs: 30_000 }) : undefined;
      if (isPaper) {
        try {
          await resolveMarket(args.market);
        } catch {
          return result(
            envelope("/api/paper", pick({ market: "para:PAPER", inPositioningSnapshot: false, paperValuation: paper }, args.fields), {
              shownOn: SHOWN_ON,
              note: "PAPER is not in the positioning snapshot right now, so only the valuation panel is returned. Null fields come with an `errors` entry from Flowscan.",
            }),
          );
        }
      }
      const { market, note } = await resolveMarket(args.market);
      const route = `/api/perp-snapshot/markets/${encodeURIComponent(market)}`;
      const d = (await get(route, {}, { ttlMs: 60_000 })) as Rec;
      const data = (d.data as Rec) ?? {};
      const want = new Set<string>(args.sections ?? DETAIL_SECTIONS);
      const out: Rec = { market, ...(note ? { resolvedNote: note } : {}), ...snapshotTimes(d) };
      if (want.has("summary")) out.summary = data.summary;
      if (want.has("leverage")) out.leverageDistribution = data.leverageDistribution;
      if (want.has("positionSize")) out.positionSizeDistribution = data.positionSizeDistribution;
      if (want.has("accountValue")) out.accountValueDistribution = data.accountValueDistribution;
      if (want.has("whales")) {
        const whales = ((data.whales as Rec[]) ?? []).slice(0, args.whalesLimit ?? 20).map(({ deltaBaselineTimestamp: _b, ...w }) => w);
        out.whales = await withLabels(whales, args.includeTags);
      }
      if (want.has("liquidationClusters")) {
        const range = args.clusterRangePct ?? 15;
        const all = ((data.liquidationClusters as Rec[]) ?? []).filter((c) => Math.abs(num(c.pctFromCurrent)) <= range);
        const below = all.filter((c) => num(c.pctFromCurrent) < 0);
        const above = all.filter((c) => num(c.pctFromCurrent) >= 0);
        const sum = (xs: Rec[], k: string) => round2(xs.reduce((a, c) => a + num(c[k]), 0));
        out.liquidationTotals = {
          rangePct: range,
          clusterCount: all.length,
          belowPrice: { longNotional: sum(below, "longNotional"), shortNotional: sum(below, "shortNotional"), levels: below.length },
          abovePrice: { longNotional: sum(above, "longNotional"), shortNotional: sum(above, "shortNotional"), levels: above.length },
          note: "USD notional of open positions whose liquidation price is in range; totals cover every cluster in range, not only the rows returned.",
        };
        out.liquidationClusters = [...all].sort((a, b) => num(b.totalNotional) - num(a.totalNotional)).slice(0, args.clustersLimit ?? 40);
      }
      if (isPaper) out.paperValuation = paper;
      return result(envelope(route, pick(out, args.fields), { shownOn: SHOWN_ON, units: "USD notional; sizes in coins; prices in USD", ...(isPaper ? { paperSource: "https://www.flowscan.xyz/api/paper" } : {}) }));
    },
  );

  defineTool(
    server,
    "flowscan_position_changes",
    {
      title: "Who opened, closed, grew or cut positions in a market (/terminal Changes)",
      description:
        "/terminal 'Changes' tab: who opened, closed, increased, reduced or flipped positions in ONE market since a baseline (window prev = previous snapshot, minutes ago; or ~1h/4h/24h/7d). Rows: address (named), kind, side, size/prevSize (coins), notionalDelta (USD, + = more long), notional and entry now/before, leverage, account value, all-time PnL. `summary` counts each kind plus long/short notional change and buy/sell notional for the cohort, window, side and address filter (it ignores only `kind`). Paged (total, totalPages).",
      inputSchema: {
        market: z.string().min(1).describe("Market, e.g. 'BTC', 'xyz:TSLA' (case-insensitive; bare 'TSLA' resolves when unique)."),
        window: z.enum(["prev", "1h", "4h", "24h", "7d"]).optional().describe("Baseline (default prev)."),
        kind: z.enum(["opened", "closed", "increased", "reduced", "flipped"]).optional().describe("Only one kind of change."),
        side: z.enum(["long", "short"]).optional().describe("Only changes on long or short positions."),
        traderFilter: traderFilterInput,
        address: z.string().optional().describe("Only addresses starting with / containing this."),
        sortBy: z.enum(["absChange", "notionalDelta", "accountValue", "allTimePnl"]).optional().describe("absChange (default, largest USD change), notionalDelta (signed), accountValue, allTimePnl."),
        dir: z.enum(["asc", "desc"]).optional().describe("Sort direction (default desc)."),
        limit: z.number().int().min(1).max(200).optional().describe("Rows per page (default 50, max 200)."),
        page: z.number().int().min(1).optional().describe("1-based page (see totalPages)."),
        includeTags,
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const { market, note } = await resolveMarket(args.market);
      const route = `/api/perp-snapshot/markets/${encodeURIComponent(market)}/changes`;
      const sortBy = args.sortBy ?? "absChange";
      const params = {
        page: args.page ?? 1,
        limit: args.limit ?? 50,
        sort: sortBy,
        dir: args.dir ?? "desc",
        side: args.side,
        kind: args.kind,
        window: args.window && args.window !== "prev" ? args.window : undefined,
        traderFilter: args.traderFilter && args.traderFilter !== "all" ? args.traderFilter : undefined,
        address: args.address,
      };
      const d = (await get(route, params)) as Rec;
      const rows = await withLabels((d.changes as Rec[]) ?? [], args.includeTags);
      const cohort = args.traderFilter ?? "all";
      const out: Rec = {
        market,
        ...(note ? { resolvedNote: note } : {}),
        window: d.window ?? args.window ?? "prev",
        ...snapshotTimes(d),
        referencePrice: d.referencePrice,
        traderFilter: cohort,
        cohort: TRADER_FILTER_LABELS[cohort],
        filter: Object.fromEntries(Object.entries({ kind: args.kind, side: args.side, address: args.address }).filter(([, v]) => v !== undefined)),
        summary: d.summary,
        summaryScope: `cohort '${cohort}', window '${d.window ?? args.window ?? "prev"}'${args.side ? `, side ${args.side}` : ""}${args.address ? `, address '${args.address}'` : ""}; all kinds`,
        total: d.total,
        page: d.page,
        totalPages: d.totalPages,
        changes: rows,
      };
      return result(envelope(route, pick(out, args.fields), { shownOn: SHOWN_ON, units: "USD notional; sizes in coins" }));
    },
  );

  defineTool(
    server,
    "flowscan_twaps",
    {
      title: "Active TWAP orders in a market (/terminal TWAPs)",
      description:
        "/terminal 'TWAPs' tab: TWAP orders running now in ONE market (address with name/tag, buy/sell, total/executed size in coins, executed USD, progressPct, start and end time, reduce-only). `summary` totals every active TWAP per side; activeTwapsAllMarkets counts all markets.",
      inputSchema: {
        market: z.string().min(1).describe("Market, e.g. 'BTC', 'xyz:TSLA' (case-insensitive; bare 'TSLA' resolves when unique)."),
        side: z.enum(["buy", "sell"]).optional().describe("Only buy or only sell TWAPs."),
        includeTags,
        ...shapeInput,
      },
    },
    async (args) => {
      const { market, note } = await resolveMarket(args.market);
      const route = `/api/perp-snapshot/twaps/${encodeURIComponent(market)}`;
      const d = (await get(route, {}, { ttlMs: 15_000 })) as Rec;
      const all = ((d.twaps as Rec[]) ?? []).map((t) => {
        const total = num(t.totalSz);
        const done = num(t.executedSz);
        const start = num(t.startTime);
        const end = start + num(t.durationSecs) * 1000;
        return {
          ...t,
          startIso: isoOf(start),
          endIso: isoOf(end),
          progressPct: total > 0 ? round2((done / total) * 100) : null,
          remainingSz: Math.max(0, total - done),
          avgExecutedPx: done > 0 ? round2(num(t.executedNtl) / done) : null,
        } as Rec;
      });
      const side = (s: string) => {
        const xs = all.filter((t) => t.side === s);
        return { count: xs.length, totalSz: xs.reduce((a, t) => a + num(t.totalSz), 0), executedSz: xs.reduce((a, t) => a + num(t.executedSz), 0), executedNtlUsd: round2(xs.reduce((a, t) => a + num(t.executedNtl), 0)) };
      };
      const filtered = all.filter((t) => !args.side || t.side === args.side).sort((a, b) => num(b.totalSz) - num(a.totalSz));
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      const rows = await withLabels(filtered.slice(offset, offset + limit), args.includeTags);
      const out: Rec = {
        market,
        ...(note ? { resolvedNote: note } : {}),
        snapshotIso: isoOf(d.snapshotTime),
        liveUpdatesIso: isoOf(d.liveUpdatesAt),
        activeTwapsAllMarkets: d.active,
        ...(d.lastSyncError ? { lastSyncError: d.lastSyncError } : {}),
        summary: { count: all.length, buy: side("buy"), sell: side("sell") },
        twaps: rows,
      };
      return result(
        envelope(route, pick(out, args.fields), {
          shownOn: SHOWN_ON,
          paging: { total: filtered.length, offset, limit, hasMore: offset + rows.length < filtered.length },
          units: "sizes in coins; executedNtl in USD",
          ...(all.length === 0 ? { note: `No active TWAP orders in ${market} right now.` } : {}),
        }),
      );
    },
  );
}

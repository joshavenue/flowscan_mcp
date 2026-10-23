import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FlowscanError, get } from "../client.js";
import { labelAddresses } from "../labels.js";
import { defineTool } from "../register.js";
import { ETH_ADDRESS, envelope, isoOf, matches, page, pick, result, shapeInput } from "../shape.js";

type Rec = Record<string, unknown>;

/** Human-readable snapshot time and age. */
function snapshotAge(ts: unknown): Rec {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return {};
  return { snapshotIso: new Date(n).toISOString(), snapshotAgeSeconds: Math.round((Date.now() - n) / 1000) };
}

/** Resolve a user-typed market against the snapshot's market list (case-insensitive, 'TSLA' -> 'xyz:TSLA'). */
export async function marketCandidates(q: string): Promise<{ exact: string[]; suggestions: string[] }> {
  const data = (await get("/api/perp-snapshot/markets")) as Rec;
  const names = ((data.markets as Rec[]) ?? []).map((m) => String(m.market));
  const ql = q.trim().toLowerCase();
  const exact = names.filter((n) => n.toLowerCase() === ql || n.toLowerCase().split(":").pop() === ql);
  const suggestions = names.filter((n) => n.toLowerCase().includes(ql)).slice(0, 15);
  return { exact, suggestions };
}

/**
 * Resolve a user-typed market to the snapshot's exact name ('btc' -> 'BTC', 'TSLA' -> 'xyz:TSLA').
 * Several /api/perp-snapshot routes answer an unknown market with an empty 200, so tools resolve
 * first and reject unknown or ambiguous names with candidates (status 404, before any data request).
 */
export async function resolveMarket(q: string): Promise<{ market: string; note?: string }> {
  const typed = String(q ?? "").trim();
  if (!typed) throw new Error("market is required, e.g. 'BTC' or 'xyz:TSLA'.");
  const { exact, suggestions } = await marketCandidates(typed);
  const full = exact.find((n) => n.toLowerCase() === typed.toLowerCase());
  const one = full ?? (exact.length === 1 ? exact[0] : undefined);
  if (one) return { market: one, ...(one !== typed ? { note: `Market '${typed}' resolved to '${one}'.` } : {}) };
  if (exact.length > 1) throw new Error(`Market '${typed}' is listed on several dexes: ${exact.join(", ")}. Pass the prefixed name.`);
  throw new FlowscanError(
    `Market '${typed}' not found in the perp snapshot.${suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : " Use flowscan_perp_markets to list markets (HIP-3 markets are prefixed, e.g. 'xyz:TSLA')."}`,
    404,
    "/api/perp-snapshot/markets",
  );
}

/** Trader cohorts of the /terminal positioning panel ("All traders", "Top 10k accounts", ...). */
export const TRADER_FILTERS = ["all", "leaderboard", "pnl_30d", "pnl_7d", "pnl_all", "winrate_30d"] as const;
export const TRADER_FILTER_LABELS: Record<string, string> = {
  all: "All traders",
  leaderboard: "Top 10k accounts",
  pnl_30d: "Top 30d PnL (1,000 accounts)",
  pnl_7d: "Top 7d PnL (1,000 accounts)",
  pnl_all: "Top all-time PnL (1,000 accounts)",
  winrate_30d: "Best 30d win rate (1,000 accounts)",
};
export const traderFilterInput = z
  .enum(TRADER_FILTERS)
  .optional()
  .describe("Cohort: all (default) | leaderboard = top 10k accounts (site default) | pnl_30d/pnl_7d/pnl_all = top 1k by PnL | winrate_30d = top 1k by win rate.");
const cohortParam = (f: string | undefined) => (f && f !== "all" ? f : undefined);

/** Add `name` and `tag` (Flowscan's trader classification) to rows keyed by `address`. Never throws. */
export async function withLabels<T extends Rec>(rows: T[], on: boolean | undefined): Promise<T[]> {
  if (on === false || rows.length === 0) return rows;
  try {
    const labels = await labelAddresses(rows.map((r) => String(r.address ?? "")));
    return rows.map((r) => {
      const l = labels.get(String(r.address ?? "").toLowerCase());
      return l ? ({ ...r, name: l.name, tag: l.tag?.label ?? null } as T) : r;
    });
  } catch {
    return rows;
  }
}
const includeTagsInput = z.boolean().optional().describe("Add Flowscan name and trader tag per address (default true).");

export function registerPerpTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_perp_markets",
    {
      title: "Perp positioning snapshot per market",
      description:
        "/terminal positioning snapshot for every perp market (~340 incl. HIP-3 'xyz:TSLA'): long/short counts and USD notional, ratios, open interest (two-sided: long + short, 2x the one-sided OI some UIs show), avg entry, median leverage, unique addresses, snapshotIso/snapshotAgeSeconds (refreshes every few minutes). traderFilter = a cohort. One market's distributions and liquidation clusters: flowscan_perp_market_detail.",
      inputSchema: {
        market: z.string().optional().describe("Filter by market symbol substring (e.g. 'BTC', 'xyz:')."),
        sortBy: z.enum(["openInterest", "totalPositions", "longShortRatioCount", "longShortRatioNotional", "totalUniqueAddresses", "market"]).optional().describe("Sort key (default openInterest desc)."),
        traderFilter: traderFilterInput,
        ...shapeInput,
      },
    },
    async (args) => {
      const data = (await get("/api/perp-snapshot/markets", { traderFilter: cohortParam(args.traderFilter) })) as Rec;
      let markets = ((data.markets as Rec[]) ?? []).filter((m) => matches(m.market, args.market));
      const key = args.sortBy ?? "openInterest";
      markets = [...markets].sort((a, b) => (key === "market" ? String(a.market).localeCompare(String(b.market)) : Number(b[key] ?? 0) - Number(a[key] ?? 0)));
      const { items, paging } = page(markets, args, 60);
      const cohort = args.traderFilter ?? "all";
      return result(envelope("/api/perp-snapshot/markets", pick({ snapshotId: data.snapshotId, timestamp: data.timestamp, ...snapshotAge(data.timestamp), traderFilter: cohort, cohort: TRADER_FILTER_LABELS[cohort], markets: items }, args.fields), { paging }));
    },
  );

  defineTool(
    server,
    "flowscan_perp_positions",
    {
      title: "Largest open perp positions in a market",
      description:
        "/terminal 'Positions' tab: open positions in one market, largest first (address with Flowscan name/tag, signed size, USD notional, side, entry, leverage, margin type, liq price, account value, funding/all-time PnL, sizeDelta since the previous snapshot), plus marketSummary (whole market for the cohort; OI = long + short) and filteredSideSummary (filtered rows only). traderFilter: cohort (site default top 10k; here all). Market is case-insensitive; 'TSLA' resolves to 'xyz:TSLA' when unique.",
      inputSchema: {
        market: z.string().describe("Market, e.g. 'BTC', 'xyz:TSLA'."),
        side: z.enum(["long", "short"]).optional().describe("Only long or only short positions."),
        sort: z.enum(["notional", "size", "entry", "leverage", "liq", "allTimePnl", "funding", "sizeDelta"]).optional().describe("Sort key (default notional)."),
        dir: z.enum(["asc", "desc"]).optional().describe("Sort direction (default desc)."),
        minSize: z.number().optional().describe("Min |size| (coins)."),
        maxSize: z.number().optional().describe("Max |size| (coins)."),
        minNotional: z.number().optional().describe("Min USD notional."),
        maxNotional: z.number().optional().describe("Max USD notional."),
        minEntry: z.number().optional().describe("Min entry price."),
        maxEntry: z.number().optional().describe("Max entry price."),
        minLiq: z.number().optional().describe("Min liq price."),
        maxLiq: z.number().optional().describe("Max liq price."),
        minLeverage: z.number().min(0).optional().describe("Min leverage (x)."),
        maxLeverage: z.number().min(0).optional().describe("Max leverage (x)."),
        leverageType: z.enum(["cross", "isolated"]).optional().describe("Only cross or only isolated margin."),
        address: z.string().optional().describe("Address prefix/substring (e.g. '0x5b5d')."),
        traderFilter: traderFilterInput,
        minReturn: z.number().optional().describe("Min unrealized return (requires markPx)."),
        maxReturn: z.number().optional().describe("Max unrealized return (requires markPx)."),
        markPx: z.number().optional().describe("Mark price used by the server for return filters."),
        limit: z.number().int().min(1).max(200).optional().describe("Positions per page (default 50, max 200)."),
        page: z.number().int().min(1).optional().describe("1-based page (see totalPages)."),
        includeTags: includeTagsInput,
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const { market, fields, includeTags, traderFilter, ...q } = args;
      const params = { ...q, traderFilter: cohortParam(traderFilter), sort: q.sort ?? "notional", dir: q.dir ?? "desc", limit: q.limit ?? 50 };
      const fetchFor = (m: string) => {
        const route = `/api/perp-snapshot/markets/${encodeURIComponent(m)}/positions`;
        return get(route, params).then((d) => ({ route, data: d as Rec }));
      };
      let res: { route: string; data: Rec };
      let resolvedNote: string | undefined;
      try {
        res = await fetchFor(market);
      } catch (err) {
        if (!(err instanceof FlowscanError) || err.status !== 404) throw err;
        const { exact, suggestions } = await marketCandidates(market);
        if (exact.length === 1 && exact[0].toLowerCase() !== market.toLowerCase()) {
          res = await fetchFor(exact[0]);
          resolvedNote = `Market '${market}' resolved to '${exact[0]}'.`;
        } else {
          const cands = exact.length > 1 ? exact : suggestions;
          throw new FlowscanError(
            `Market '${market}' not found in the perp snapshot.${cands.length ? ` Did you mean: ${cands.join(", ")}?` : " Use flowscan_perp_markets to list markets (HIP-3 markets are prefixed, e.g. 'xyz:TSLA')."}`,
            404,
            err.route,
          );
        }
      }
      // filteredSummary describes only the filtered rows (e.g. side=short shows longNotional 0); rename it and add the
      // unfiltered market totals from the markets route so "no longs" is never inferred from a filter.
      const { filteredSummary, ...restData } = res.data;
      const cohort = traderFilter ?? "all";
      const mk = (((await get("/api/perp-snapshot/markets", { traderFilter: cohortParam(traderFilter) })) as Rec).markets as Rec[] | undefined)?.find((m) => String(m.market).toLowerCase() === String(res.data.market ?? market).toLowerCase());
      const filter = Object.fromEntries(
        Object.entries({ side: q.side, minSize: q.minSize, maxSize: q.maxSize, minNotional: q.minNotional, maxNotional: q.maxNotional, minEntry: q.minEntry, maxEntry: q.maxEntry, minLiq: q.minLiq, maxLiq: q.maxLiq, minLeverage: q.minLeverage, maxLeverage: q.maxLeverage, leverageType: q.leverageType, address: q.address, minReturn: q.minReturn, maxReturn: q.maxReturn }).filter(([, v]) => v !== undefined),
      );
      // every row repeats the baseline time of sizeDelta; it is reported once as baselineIso
      const positions = await withLabels(((restData.positions as Rec[]) ?? []).map(({ deltaBaselineTimestamp: _b, ...p }) => p), includeTags);
      const out = {
        ...restData,
        positions,
        ...snapshotAge(res.data.timestamp),
        ...(isoOf(res.data.baselineTimestamp) ? { baselineIso: isoOf(res.data.baselineTimestamp), sizeDeltaNote: "sizeDelta = change in size since the baseline (previous) snapshot" } : {}),
        ...(resolvedNote ? { resolvedNote } : {}),
        traderFilter: cohort,
        cohort: TRADER_FILTER_LABELS[cohort],
        marketSummary: mk
          ? { longCount: mk.longCount, shortCount: mk.shortCount, longNotional: mk.longNotional, shortNotional: mk.shortNotional, openInterest: mk.openInterest, totalPositions: mk.totalPositions, medianLeverage: mk.medianLeverage, avgEntryPrice: mk.avgEntryPrice, note: `whole market for cohort '${cohort}', without the other filters; openInterest = long + short notional (USD)` }
          : null,
        filteredSideSummary: { filter: Object.keys(filter).length ? filter : "none", ...((filteredSummary as Rec) ?? {}), note: "totals over the positions matching `filter` only" },
      };
      return result(envelope(res.route, pick(out, fields)));
    },
  );

  defineTool(
    server,
    "flowscan_address_perp_positions",
    {
      title: "Open perp positions for an address (snapshot)",
      description:
        "Homepage perp snapshot address lookup: an account's open perp positions across all markets incl. HIP-3 (market, side, signed size, notional, entry, leverage, liquidation price, funding PnL, all-time PnL) from the latest snapshot (refreshes every few minutes), with totalNotional and totalPositions. Sorted by notional desc. For live margin/account state use flowscan_address_summary.",
      inputSchema: {
        address: ETH_ADDRESS,
        market: z.string().optional().describe("Filter by market symbol substring (e.g. 'BTC', 'xyz:')."),
        side: z.enum(["long", "short"]).optional().describe("Only long or only short positions."),
        ...shapeInput,
      },
    },
    async (args) => {
      const route = `/api/perp-snapshot/address/${encodeURIComponent(args.address.toLowerCase())}/positions`;
      const data = (await get(route)) as Rec;
      let positions = ((data.positions as Rec[]) ?? []).filter((p) => matches(p.market, args.market) && (!args.side || p.side === args.side));
      positions = [...positions].sort((a, b) => Math.abs(Number(b.notionalSize ?? 0)) - Math.abs(Number(a.notionalSize ?? 0)));
      // every row repeats the queried address and account value; hoist them once
      const accountValue = positions[0]?.accountValue ?? null;
      const rows = positions.map(({ address: _a, accountValue: _v, ...rest }) => rest);
      const { items, paging } = page(rows, args, 50);
      const { positions: _p, ...summary } = data;
      return result(envelope(route, pick({ ...summary, ...snapshotAge(data.timestamp), accountValue, positions: items }, args.fields), { paging }));
    },
  );
}

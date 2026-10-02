import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FlowscanError, get } from "../client.js";
import { defineTool } from "../register.js";
import { ETH_ADDRESS, envelope, matches, page, pick, result, shapeInput } from "../shape.js";

type Rec = Record<string, unknown>;

/** Human-readable snapshot time and age. */
function snapshotAge(ts: unknown): Rec {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return {};
  return { snapshotIso: new Date(n).toISOString(), snapshotAgeSeconds: Math.round((Date.now() - n) / 1000) };
}

/** Resolve a user-typed market against the snapshot's market list (case-insensitive, 'TSLA' -> 'xyz:TSLA'). */
async function marketCandidates(q: string): Promise<{ exact: string[]; suggestions: string[] }> {
  const data = (await get("/api/perp-snapshot/markets")) as Rec;
  const names = ((data.markets as Rec[]) ?? []).map((m) => String(m.market));
  const ql = q.trim().toLowerCase();
  const exact = names.filter((n) => n.toLowerCase() === ql || n.toLowerCase().split(":").pop() === ql);
  const suggestions = names.filter((n) => n.toLowerCase().includes(ql)).slice(0, 15);
  return { exact, suggestions };
}

export function registerPerpTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_perp_markets",
    {
      title: "Perp positioning snapshot per market",
      description:
        "Homepage perp snapshot for every perp market (~330 incl. HIP-3 like 'xyz:TSLA'): long/short counts and notional, ratios, open interest, avg entry, median leverage, unique addresses, snapshotIso/snapshotAgeSeconds (refreshes every few minutes). openInterest is Flowscan's two-sided figure: long + short notional (2x the one-sided OI some UIs show). Prefer this for live OI/positioning; hip3_markets/hip3_dex give HIP-3 history, hip3_binance_comparison the Binance side.",
      inputSchema: {
        market: z.string().optional().describe("Filter by market symbol substring (e.g. 'BTC', 'xyz:')."),
        sortBy: z.enum(["openInterest", "totalPositions", "longShortRatioCount", "longShortRatioNotional", "totalUniqueAddresses", "market"]).optional().describe("Sort key (default openInterest desc)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const data = (await get("/api/perp-snapshot/markets")) as Rec;
      let markets = ((data.markets as Rec[]) ?? []).filter((m) => matches(m.market, args.market));
      const key = args.sortBy ?? "openInterest";
      markets = [...markets].sort((a, b) => (key === "market" ? String(a.market).localeCompare(String(b.market)) : Number(b[key] ?? 0) - Number(a[key] ?? 0)));
      const { items, paging } = page(markets, args, 60);
      return result(envelope("/api/perp-snapshot/markets", pick({ snapshotId: data.snapshotId, timestamp: data.timestamp, ...snapshotAge(data.timestamp), markets: items }, args.fields), { paging }));
    },
  );

  defineTool(
    server,
    "flowscan_perp_positions",
    {
      title: "Largest open perp positions in a market",
      description:
        "Homepage perp snapshot drill-down: open positions in one market, largest first (address, signed size, notional, side, entry, leverage, liquidation price, account value, funding PnL, all-time PnL, size change since last snapshot), plus total/totalPages, snapshotIso/snapshotAgeSeconds and filteredSummary (long/short notional & counts, two-sided OI = long + short, median leverage). Market is case-insensitive; a bare HIP-3 symbol ('TSLA') resolves to 'xyz:TSLA' when unique, else the error lists candidates.",
      inputSchema: {
        market: z.string().describe("Market symbol as shown by flowscan_perp_markets (e.g. 'BTC', 'xyz:TSLA'); case-insensitive."),
        side: z.enum(["long", "short"]).optional(),
        sort: z.enum(["notional", "size"]).optional().describe("Sort by notional (default) or size."),
        dir: z.enum(["asc", "desc"]).optional().describe("Sort direction (default desc)."),
        minSize: z.number().optional(),
        maxSize: z.number().optional(),
        minNotional: z.number().optional(),
        maxNotional: z.number().optional(),
        minEntry: z.number().optional().describe("Min entry price."),
        maxEntry: z.number().optional(),
        minLiq: z.number().optional().describe("Min liquidation price."),
        maxLiq: z.number().optional(),
        minReturn: z.number().optional().describe("Min unrealized return (requires markPx)."),
        maxReturn: z.number().optional(),
        markPx: z.number().optional().describe("Mark price used by the server for return filters."),
        limit: z.number().int().min(1).max(200).optional().describe("Positions per page (default 50, max 200)."),
        page: z.number().int().min(1).optional().describe("1-based page number for paging through all positions (response has total/totalPages)."),
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const { market, fields, ...q } = args;
      const params = { ...q, sort: q.sort ?? "notional", dir: q.dir ?? "desc", limit: q.limit ?? 50 };
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
      const out = { ...res.data, ...snapshotAge(res.data.timestamp), ...(resolvedNote ? { resolvedNote } : {}) };
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
        side: z.enum(["long", "short"]).optional(),
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

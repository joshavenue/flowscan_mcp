import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { get } from "../client.js";
import { defineTool } from "../register.js";
import { ETH_ADDRESS, envelope, matches, page, pick, result, shapeInput } from "../shape.js";

type Rec = Record<string, unknown>;

export function registerPerpTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_perp_markets",
    {
      title: "Perp positioning snapshot per market",
      description:
        "Homepage perp snapshot: for every perp market (incl. HIP-3 markets like 'xyz:TSLA'), long/short position counts and notional, long/short ratios, open interest, average entry price, median leverage, unique addresses. Snapshot refreshes every few minutes. Source: flowscan.xyz /api/perp-snapshot/markets.",
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
      return result(envelope("/api/perp-snapshot/markets", pick({ snapshotId: data.snapshotId, timestamp: data.timestamp, markets: items }, args.fields), { paging }));
    },
  );

  defineTool(
    server,
    "flowscan_perp_positions",
    {
      title: "Largest open perp positions in a market",
      description:
        "Homepage perp snapshot drill-down: individual open positions in one market, largest first by default (address, signed size, notional, side, entry price, leverage type/multiplier, liquidation price, account value, funding PnL, all-time PnL, size change since the previous snapshot), plus total/totalPages and a filteredSummary (long/short notional & counts, OI, median leverage) for the filtered set. Filters mirror the site's position search. Source: flowscan.xyz /api/perp-snapshot/markets/{market}/positions.",
      inputSchema: {
        market: z.string().describe("Exact market symbol as shown by flowscan_perp_markets (e.g. 'BTC', 'ETH', 'xyz:TSLA')."),
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
      const route = `/api/perp-snapshot/markets/${encodeURIComponent(market)}/positions`;
      const data = (await get(route, { ...q, sort: q.sort ?? "notional", dir: q.dir ?? "desc", limit: q.limit ?? 50 })) as Rec;
      return result(envelope(route, pick(data, fields)));
    },
  );

  defineTool(
    server,
    "flowscan_address_perp_positions",
    {
      title: "Open perp positions for an address (snapshot)",
      description:
        "Homepage perp snapshot address lookup: an account's open perp positions across all markets incl. HIP-3 (market, side, signed size, notional, entry, leverage, liquidation price, funding PnL, all-time PnL) from the latest snapshot (refreshes every few minutes), with totalNotional and totalPositions. Sorted by notional desc. For live margin/account state use flowscan_address_summary. Source: flowscan.xyz /api/perp-snapshot/address/{address}/positions.",
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
      return result(envelope(route, pick({ ...summary, accountValue, positions: items }, args.fields), { paging }));
    },
  );
}

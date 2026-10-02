import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { post } from "../client.js";
import { defineTool } from "../register.js";
import { ETH_ADDRESS, envelope, matches, page, pick, result, shapeInput } from "../shape.js";

type Rec = Record<string, unknown>;
const ROUTE = "/api/hydromancer/info";

/** Flowscan's /address/{addr} page fetches account data through this server-side proxy route. */
function info(type: string, user: string, extra: Rec = {}): Promise<unknown> {
  return post(ROUTE, { type, user: user.toLowerCase(), ...extra });
}

const DAY = 86_400_000;
/** Hydromancer time-range queries return at most this many rows, oldest first from startTime. */
const UPSTREAM_ROW_CAP = 2000;

function newestFirst(rows: Rec[], key: string): Rec[] {
  return [...rows].sort((a, b) => Number(b[key] ?? 0) - Number(a[key] ?? 0));
}

function rangeMeta(rows: Rec[], key: string): Rec {
  if (rows.length === 0) return { returned: 0, capped: false };
  const times = rows.map((r) => Number(r[key] ?? 0)).filter((t) => t > 0);
  const from = Math.min(...times);
  const to = Math.max(...times);
  return {
    returned: rows.length,
    capped: rows.length >= UPSTREAM_ROW_CAP,
    coveredRange: { from, to, fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString() },
  };
}

export function registerAddressTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_address_summary",
    {
      title: "Address overview (role, PnL summary, perp state, spot balances)",
      description:
        "The header and overview of Flowscan's /address/{address} page: account role (user/vault/subAccount/agent/missing), lifetime PnL summary (total PnL, win/loss rate, trade count, median hold time, volume, fees, funding, days active, traded pairs), live perp clearinghouse state (account value, total notional, margin used, withdrawable, open positions with size, entry, leverage, liquidation price, unrealized PnL, ROE, cumulative funding) and non-zero spot token balances. Positions are sorted by position value and capped by `positionsLimit`. Perp state covers the main perp DEX unless `dex` names a HIP-3 DEX (e.g. 'xyz'). Source: flowscan.xyz /api/hydromancer/info.",
      inputSchema: {
        address: ETH_ADDRESS,
        include: z
          .array(z.enum(["role", "pnlSummary", "perpState", "spotBalances"]))
          .optional()
          .describe("Which sections to fetch (default all four)."),
        dex: z.string().optional().describe("HIP-3 perp DEX name for perpState (lowercase, e.g. 'xyz', 'flx', 'km'). Omit for the main Hyperliquid perp DEX."),
        positionsLimit: z.number().int().min(1).max(500).optional().describe("Max open positions returned in perpState (default 50, largest first)."),
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const want = new Set(args.include ?? ["role", "pnlSummary", "perpState", "spotBalances"]);
      const [role, pnl, perp, spot] = await Promise.all([
        want.has("role") ? info("userRole", args.address) : null,
        want.has("pnlSummary") ? info("userPnlSummary", args.address) : null,
        want.has("perpState") ? info("clearinghouseState", args.address, args.dex ? { dex: args.dex } : {}) : null,
        want.has("spotBalances") ? info("spotClearinghouseState", args.address) : null,
      ]);
      const out: Rec = { address: args.address.toLowerCase() };
      if (role) out.role = role;
      if (pnl) out.pnlSummary = pnl;
      if (perp && typeof perp === "object") {
        const st = perp as Rec;
        const positions = ((st.assetPositions as Rec[]) ?? [])
          .map((p) => ({ type: p.type, ...((p.position as Rec) ?? {}) }) as Rec)
          .sort((a, b) => Math.abs(Number(b.positionValue ?? 0)) - Math.abs(Number(a.positionValue ?? 0)));
        const lim = args.positionsLimit ?? 50;
        const { assetPositions: _ap, ...rest } = st;
        out.perpState = {
          dex: args.dex ?? "main",
          ...rest,
          positionCount: positions.length,
          positions: positions.slice(0, lim),
          ...(positions.length > lim ? { positionsNote: `showing ${lim} of ${positions.length} positions by value; raise positionsLimit or use flowscan_address_perp_positions` } : {}),
        };
      } else if (perp !== null) out.perpState = perp;
      if (spot && typeof spot === "object") {
        const balances = ((spot as Rec).balances as Rec[]) ?? [];
        out.spotBalances = balances.filter((b) => Number(b.total ?? 0) !== 0 || Number(b.hold ?? 0) !== 0);
      } else if (spot !== null) out.spotBalances = spot;
      return result(envelope(ROUTE, pick(out, args.fields)));
    },
  );

  defineTool(
    server,
    "flowscan_address_orders",
    {
      title: "Address open or historical orders",
      description:
        "Address page 'Open Orders' / 'Order History' tabs. kind='open' (default): every resting order across all DEXs incl. HIP-3 (coin, side B=buy/A=sell, limit price, size, original size, oid, timestamp). kind='openDetailed': open orders on the main DEX with trigger/TP-SL/reduce-only/order-type/TIF details (may be capped by the upstream). kind='historical': recent order history (up to ~2000 orders, newest first) with final status (filled, canceled, rejected...). Source: flowscan.xyz /api/hydromancer/info {type:'openOrders'|'frontendOpenOrders'|'historicalOrders'}.",
      inputSchema: {
        address: ETH_ADDRESS,
        kind: z.enum(["open", "openDetailed", "historical"]).optional().describe("Default 'open'."),
        coin: z.string().optional().describe("Filter by coin symbol substring (e.g. 'BTC', 'xyz:')."),
        ...shapeInput,
      },
    },
    async (args) => {
      const kind = args.kind ?? "open";
      // Note: frontendOpenOrders rejects dex:"ALL_DEXS" ("Length of DEX name exceeds maximum"); openOrders accepts it.
      const raw = (await (kind === "open"
        ? info("openOrders", args.address, { dex: "ALL_DEXS" })
        : kind === "openDetailed"
          ? info("frontendOpenOrders", args.address)
          : info("historicalOrders", args.address))) as Rec[];
      const list = (Array.isArray(raw) ? raw : []).filter((o) => matches((o.order as Rec)?.coin ?? o.coin, args.coin));
      const { items, paging } = page(list, args, kind === "historical" ? 50 : 100);
      return result(envelope(ROUTE, items.map((o) => pick(o, args.fields)), { paging, kind }));
    },
  );

  defineTool(
    server,
    "flowscan_address_fills",
    {
      title: "Address trade fills",
      description:
        "Address page 'Trades' tab: executed fills, newest first (coin, price, size, side B/A, direction such as 'Open Long'/'Close Short', start position, closed PnL, fee + fee token, tx hash, order id, time ms). Without startTime: the most recent fills (upstream keeps ~2000). With startTime[/endTime]: fills in that window; upstream returns at most 2000 fills counted from startTime, so check `capped`/`coveredRange` and move startTime forward to continue. Source: flowscan.xyz /api/hydromancer/info {type:'userFills'|'userFillsByTime'}.",
      inputSchema: {
        address: ETH_ADDRESS,
        startTime: z.number().int().optional().describe("Unix ms. If set, uses the time-range query."),
        endTime: z.number().int().optional().describe("Unix ms (optional, with startTime)."),
        aggregateByTime: z.boolean().optional().describe("Merge partial fills of one order at the same time (default true, as the site does)."),
        coin: z.string().optional().describe("Filter by coin symbol substring."),
        ...shapeInput,
      },
    },
    async (args) => {
      const agg = args.aggregateByTime ?? true;
      const ranged = args.startTime !== undefined;
      const raw = await (ranged
        ? info("userFillsByTime", args.address, { startTime: args.startTime, ...(args.endTime !== undefined ? { endTime: args.endTime } : {}), aggregateByTime: agg })
        : info("userFills", args.address, { aggregateByTime: agg }));
      const all = Array.isArray(raw) ? (raw as Rec[]) : [];
      const meta = rangeMeta(all, "time");
      const list = newestFirst(all, "time").filter((f) => matches(f.coin, args.coin));
      const { items, paging } = page(list, args, 100);
      return result(envelope(ROUTE, items.map((f) => pick(f, args.fields)), { paging, ...meta }));
    },
  );

  defineTool(
    server,
    "flowscan_address_ledger",
    {
      title: "Address funding payments or ledger updates",
      description:
        "Address page 'Funding' and 'Transfers/Ledger' tabs, newest first. kind='ledger' (default): non-funding ledger updates (deposits, withdrawals, internal/spot/sub-account transfers, vault deposits/withdrawals, liquidations...) since startTime (default 30 days ago). kind='funding': hourly funding payments per position {coin, usdc, szi, fundingRate} since startTime (default 7 days ago). Upstream returns at most 2000 rows counted from startTime: check `capped`/`coveredRange` and move startTime forward to continue. Source: flowscan.xyz /api/hydromancer/info {type:'userFunding'|'userNonFundingLedgerUpdates'}.",
      inputSchema: {
        address: ETH_ADDRESS,
        kind: z.enum(["funding", "ledger"]).optional().describe("Default 'ledger'."),
        startTime: z.number().int().optional().describe("Unix ms (default now-30d for ledger, now-7d for funding)."),
        endTime: z.number().int().optional().describe("Unix ms."),
        coin: z.string().optional().describe("Filter by coin (funding) or token (ledger) substring."),
        ...shapeInput,
      },
    },
    async (args) => {
      const kind = args.kind ?? "ledger";
      const startTime = args.startTime ?? Date.now() - (kind === "funding" ? 7 : 30) * DAY;
      const extra: Rec = { startTime };
      if (args.endTime !== undefined) extra.endTime = args.endTime;
      const raw = await info(kind === "funding" ? "userFunding" : "userNonFundingLedgerUpdates", args.address, extra);
      const all = Array.isArray(raw) ? (raw as Rec[]) : [];
      const meta = rangeMeta(all, "time");
      const list = newestFirst(all, "time").filter((r) => {
        if (!args.coin) return true;
        const d = (r.delta as Rec) ?? {};
        return matches(d.coin ?? d.token, args.coin);
      });
      const { items, paging } = page(list, args, 100);
      return result(envelope(ROUTE, items.map((r) => pick(r, args.fields)), { paging, kind, startTime, ...meta }));
    },
  );

  defineTool(
    server,
    "flowscan_address_staking",
    {
      title: "Address staking delegations & history",
      description:
        "Address page 'Staking' section: current HYPE delegations per validator and the delegation/undelegation history. Source: flowscan.xyz /api/hydromancer/info {type:'delegations'|'delegatorHistory'}.",
      inputSchema: {
        address: ETH_ADDRESS,
        historyLimit: z.number().int().min(1).max(500).optional().describe("Max history rows (default 50)."),
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const [delegations, history] = await Promise.all([info("delegations", args.address), info("delegatorHistory", args.address, { limit: args.historyLimit ?? 50 })]);
      return result(envelope(ROUTE, pick({ delegations, history }, args.fields)));
    },
  );

  defineTool(
    server,
    "flowscan_address_vaults_subaccounts",
    {
      title: "Address vault equities & sub-accounts",
      description:
        "Address page 'Vaults' and 'Sub-accounts' sections: equity the address holds in each vault (vault address, equity, lock-up), and its sub-accounts (name, sub-account address, account value, notional, withdrawable, open position count, non-zero spot balances). Use flowscan_address_summary on a sub-account address for its full state. Source: flowscan.xyz /api/hydromancer/info {type:'userVaultEquities'|'subAccounts'}.",
      inputSchema: { address: ETH_ADDRESS, fields: shapeInput.fields },
    },
    async (args) => {
      const [vaultEquities, subs] = await Promise.all([info("userVaultEquities", args.address), info("subAccounts", args.address)]);
      // subAccounts embeds a full clearinghouse + spot state per sub-account; keep the headline numbers.
      const subAccounts = Array.isArray(subs)
        ? (subs as Rec[]).map((sa) => {
            const ch = (sa.clearinghouseState as Rec) ?? {};
            const ms = (ch.marginSummary as Rec) ?? {};
            const spotBal = (((sa.spotState as Rec)?.balances as Rec[]) ?? []).filter((b) => Number(b.total ?? 0) !== 0);
            return {
              name: sa.name,
              subAccountUser: sa.subAccountUser,
              master: sa.master,
              accountValue: ms.accountValue ?? null,
              totalNtlPos: ms.totalNtlPos ?? null,
              withdrawable: ch.withdrawable ?? null,
              openPositions: Array.isArray(ch.assetPositions) ? (ch.assetPositions as unknown[]).length : 0,
              spotBalances: spotBal.slice(0, 20),
            };
          })
        : (subs ?? []);
      return result(envelope(ROUTE, pick({ vaultEquities, subAccounts }, args.fields)));
    },
  );

  defineTool(
    server,
    "flowscan_address_extras",
    {
      title: "Address extras: approved builders, borrow/lend, rate limit, TWAP fills",
      description:
        "Smaller address-page widgets. kind: 'approvedBuilders' (builder codes the user approved with max fee), 'borrowLend' (HyperCore native borrow/lend state per token, health and health factor), 'rateLimit' (API request allowance vs cumulative volume), 'twapSliceFills' (fills generated by the user's TWAP orders). Source: flowscan.xyz /api/hydromancer/info.",
      inputSchema: {
        address: ETH_ADDRESS,
        kind: z.enum(["approvedBuilders", "borrowLend", "rateLimit", "twapSliceFills"]),
        ...shapeInput,
      },
    },
    async (args) => {
      const type = { approvedBuilders: "approvedBuilders", borrowLend: "borrowLendUserState", rateLimit: "userRateLimit", twapSliceFills: "userTwapSliceFills" }[args.kind as "approvedBuilders" | "borrowLend" | "rateLimit" | "twapSliceFills"];
      const data = await info(type, args.address);
      if (Array.isArray(data)) {
        const { items, paging } = page(data as Rec[], args, 100);
        return result(envelope(ROUTE, items.map((r) => pick(r, args.fields)), { paging, kind: args.kind }));
      }
      return result(envelope(ROUTE, pick(data, args.fields), { kind: args.kind }));
    },
  );
}

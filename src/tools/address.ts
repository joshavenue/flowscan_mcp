import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { post } from "../client.js";
import { defineTool } from "../register.js";
import { ETH_ADDRESS, envelope, isoOf, matches, page, pick, result, shapeInput } from "../shape.js";
import { findDex, KNOWN_DEX_HELP } from "../dex.js";
import { stakingOverview } from "./validators.js";

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

/**
 * Coverage metadata for capped upstream lists.
 * mode "range": time-range query (oldest rows first from startTime) -> give a cursor.
 * mode "recent": most-recent query (newest ~2000 kept upstream) -> older rows need a range query.
 */
function rangeMeta(rows: Rec[], key: string, mode: "range" | "recent"): Rec {
  if (rows.length === 0) return { returned: 0, capped: false };
  const times = rows.map((r) => Number(r[key] ?? 0)).filter((t) => t > 0);
  const from = Math.min(...times);
  const to = Math.max(...times);
  const capped = rows.length >= UPSTREAM_ROW_CAP;
  const meta: Rec = {
    returned: rows.length,
    capped,
    coveredRange: { from, to, fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString() },
  };
  if (capped && mode === "range") {
    meta.nextStartTime = to + 1;
    meta.capNote = `Upstream cap hit: these are the OLDEST ${UPSTREAM_ROW_CAP} rows from startTime, covering only ${new Date(from).toISOString()} .. ${new Date(to).toISOString()}. Call again with startTime=nextStartTime for later rows.`;
  } else if (capped) {
    meta.capNote = `Upstream keeps only the most recent ${UPSTREAM_ROW_CAP} rows (covering ${new Date(from).toISOString()} .. ${new Date(to).toISOString()}); older rows need a startTime query.`;
  }
  return meta;
}

/** page() metadata relabelled so a capped upstream count is not mistaken for the window total. */
function rowPaging(p: { total: number; offset: number; limit: number; hasMore: boolean }, capped: boolean): Rec {
  return { rowsReturned: p.total, offset: p.offset, limit: p.limit, hasMore: p.hasMore, ...(capped ? { note: "rowsReturned counts rows in this capped upstream response, not all rows in the period" } : {}) };
}

export function registerAddressTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_address_summary",
    {
      title: "Address overview (role, PnL summary, perp state, spot balances)",
      description:
        "Overview of an /address page: role (user/vault/subAccount/agent/missing), lifetime PnL summary (PnL, win rate, trades, hold time, volume, fees, funding, days active, tradedPairs as count + first 30), live perp state (account value, notional, margin, withdrawable, positions with size/entry/leverage/liquidation/uPnL/ROE/funding, largest first, capped by positionsLimit) and non-zero spot balances. Perp state is the main DEX unless `dex` names a HIP-3 DEX (prefix or display name; unknown names are rejected).",
      inputSchema: {
        address: ETH_ADDRESS,
        include: z
          .array(z.enum(["role", "pnlSummary", "perpState", "spotBalances"]))
          .optional()
          .describe("Which sections to fetch (default all four)."),
        dex: z.string().optional().describe(`HIP-3 DEX for perpState (${KNOWN_DEX_HELP}). Omit for the main DEX.`),
        positionsLimit: z.number().int().min(1).max(500).optional().describe("Max open positions returned in perpState (default 50, largest first)."),
        balancesLimit: z.number().int().min(1).max(500).optional().describe("Max spot balances returned (default 50)."),
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      let dex: string | undefined;
      let dexNote: string | undefined;
      if (args.dex !== undefined && String(args.dex).trim() !== "" && String(args.dex).trim().toLowerCase() !== "main") {
        const d = findDex(String(args.dex));
        if (!d) throw new Error(`Unknown HIP-3 dex '${args.dex}'. Known: ${KNOWN_DEX_HELP}. Omit dex for the main perp DEX.`);
        dex = d.prefix;
        const q = String(args.dex).trim().toLowerCase();
        if (q !== d.prefix) dexNote = d.formerPrefixes.includes(q) ? `'${q}' is ${d.name}'s former prefix; queried its current prefix '${d.prefix}'.` : `'${args.dex}' mapped to on-chain prefix '${d.prefix}'.`;
      }
      const want = new Set(args.include ?? ["role", "pnlSummary", "perpState", "spotBalances"]);
      const [role, pnl, perp, spot] = await Promise.all([
        want.has("role") ? info("userRole", args.address) : null,
        want.has("pnlSummary") ? info("userPnlSummary", args.address) : null,
        want.has("perpState") ? info("clearinghouseState", args.address, dex ? { dex } : {}) : null,
        want.has("spotBalances") ? info("spotClearinghouseState", args.address) : null,
      ]);
      const out: Rec = { address: args.address.toLowerCase() };
      if (role) out.role = role;
      if (pnl && typeof pnl === "object") {
        const ps = { ...(pnl as Rec) };
        const pairs = ps.tradedPairs;
        const wantsPairs = (args.fields ?? []).some((f: string) => f === "pnlSummary" || f.startsWith("pnlSummary.tradedPairs"));
        if (Array.isArray(pairs) && pairs.length > 30 && !wantsPairs) ps.tradedPairs = { count: pairs.length, first30: pairs.slice(0, 30), note: "pass fields:['pnlSummary.tradedPairs'] for the full list" };
        out.pnlSummary = ps;
      } else if (pnl) out.pnlSummary = pnl;
      if (perp && typeof perp === "object") {
        const st = perp as Rec;
        const positions = ((st.assetPositions as Rec[]) ?? [])
          .map((p) => ({ type: p.type, ...((p.position as Rec) ?? {}) }) as Rec)
          .sort((a, b) => Math.abs(Number(b.positionValue ?? 0)) - Math.abs(Number(a.positionValue ?? 0)));
        const lim = args.positionsLimit ?? 50;
        const { assetPositions: _ap, ...rest } = st;
        out.perpState = {
          dex: dex ?? "main",
          ...(dexNote ? { dexNote } : {}),
          ...rest,
          positionCount: positions.length,
          positions: positions.slice(0, lim),
          ...(positions.length > lim ? { positionsNote: `showing ${lim} of ${positions.length} positions by value; raise positionsLimit or use flowscan_address_perp_positions` } : {}),
        };
      } else if (perp !== null) out.perpState = perp;
      if (spot && typeof spot === "object") {
        const balances = ((spot as Rec).balances as Rec[]) ?? [];
        const nonZero = balances.filter((b) => Number(b.total ?? 0) !== 0 || Number(b.hold ?? 0) !== 0);
        const bl = args.balancesLimit ?? 50;
        out.spotBalances = nonZero.slice(0, bl);
        if (nonZero.length > bl) out.spotBalancesNote = `showing ${bl} of ${nonZero.length} non-zero balances; raise balancesLimit`;
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
        "Address 'Open Orders' / 'Order History'. kind='open' (default): all resting orders on every DEX (coin, side B/A, limit price, size, oid, time). 'openDetailed': main-DEX orders with trigger/TP-SL/reduce-only/type/TIF (upstream max 100, `capped` then). 'historical': the newest ~2000 orders with final status; coveredRange shows their time span (seconds for busy accounts).",
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
      const all = Array.isArray(raw) ? raw : [];
      let meta: Rec = { returned: all.length };
      if (kind === "historical") meta = rangeMeta(all, "statusTimestamp", "recent");
      else if (kind === "openDetailed" && all.length === 100) {
        meta = { returned: 100, capped: true, capNote: "frontendOpenOrders returns at most 100 orders (main DEX only); use kind='open' for the complete list across all DEXs." };
      }
      const list = all.filter((o) => matches((o.order as Rec)?.coin ?? o.coin, args.coin));
      const { items, paging } = page(list, args, kind === "historical" ? 50 : 100);
      return result(envelope(ROUTE, items.map((o) => pick(o, args.fields)), { paging: rowPaging(paging, Boolean(meta.capped)), kind, ...meta }));
    },
  );

  defineTool(
    server,
    "flowscan_address_fills",
    {
      title: "Address trade fills",
      description:
        "Address 'Trades' tab: fills, newest first (coin, price, size, side, direction like 'Open Long', start position, closed PnL, fee, tx hash, oid, time). Without startTime: the most recent ~2000 fills. With startTime[/endTime]: upstream returns the OLDEST 2000 fills from startTime; if `capped`, continue with startTime=nextStartTime.",
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
      const meta = rangeMeta(all, "time", ranged ? "range" : "recent");
      const list = newestFirst(all, "time").filter((f) => matches(f.coin, args.coin));
      const { items, paging } = page(list, args, 100);
      return result(envelope(ROUTE, items.map((f) => pick(f, args.fields)), { paging: rowPaging(paging, Boolean(meta.capped)), ...meta }));
    },
  );

  defineTool(
    server,
    "flowscan_address_ledger",
    {
      title: "Address funding payments or ledger updates",
      description:
        "Address 'Funding' / 'Ledger' tabs, newest first. kind='ledger' (default): deposits, withdrawals, transfers, vault flows, liquidations since startTime (default 30 days ago). kind='funding': hourly funding payments {coin, usdc, szi, fundingRate} (default last 7 days). Upstream returns the OLDEST 2000 rows from startTime; if `capped`, continue with startTime=nextStartTime.",
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
      const meta = rangeMeta(all, "time", "range");
      const list = newestFirst(all, "time").filter((r) => {
        if (!args.coin) return true;
        const d = (r.delta as Rec) ?? {};
        return matches(d.coin ?? d.token, args.coin);
      });
      const { items, paging } = page(list, args, 100);
      return result(envelope(ROUTE, items.map((r) => pick(r, args.fields)), { paging: rowPaging(paging, Boolean(meta.capped)), kind, startTime, ...meta }));
    },
  );

  defineTool(
    server,
    "flowscan_address_staking",
    {
      title: "Address staking delegations & history",
      description:
        "Address page 'Staking' section: totalDelegatedHype, current delegations per validator (validator address and name, commission_bps, is_jailed, amountHype, lock-up end) and the staking history (delegate/undelegate, deposits/withdrawals to staking, newest first).",
      inputSchema: {
        address: ETH_ADDRESS,
        historyLimit: z.number().int().min(1).max(500).optional().describe("Max history rows (default 50)."),
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const [delegations, history, overview] = await Promise.all([
        info("delegations", args.address),
        info("delegatorHistory", args.address, { limit: args.historyLimit ?? 50 }),
        stakingOverview().catch(() => null),
      ]);
      const byAddr = new Map<string, Rec>((((overview?.validators as Rec[]) ?? [])).map((v) => [String(v.address).toLowerCase(), v]));
      const dl = Array.isArray(delegations) ? (delegations as Rec[]) : [];
      const enriched = dl
        .map((d) => {
          const v = byAddr.get(String(d.validator).toLowerCase());
          return {
            validator: d.validator,
            validatorName: v ? String(v.name) : null,
            commission_bps: v?.commission_bps ?? null,
            is_jailed: v?.is_jailed ?? null,
            amountHype: d.amount,
            lockedUntil: d.lockedUntilTimestamp,
            lockedUntilIso: isoOf(d.lockedUntilTimestamp),
          };
        })
        .sort((a, b) => Number(b.amountHype ?? 0) - Number(a.amountHype ?? 0));
      const totalDelegatedHype = dl.reduce((a, d) => a + (Number(d.amount) || 0), 0);
      return result(envelope(ROUTE, pick({ totalDelegatedHype, validatorCount: enriched.length, delegations: enriched, history }, args.fields)));
    },
  );

  defineTool(
    server,
    "flowscan_address_vaults_subaccounts",
    {
      title: "Address vault equities & sub-accounts",
      description:
        "Address 'Vaults' and 'Sub-accounts': equity held in each vault (vault, equity, lock-up) and sub-accounts (name, address, account value, notional, withdrawable, open positions, non-zero spot balances).",
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
        "Smaller address-page widgets. kind: 'approvedBuilders' (builder codes the user approved with max fee), 'borrowLend' (HyperCore native borrow/lend state per token, health and health factor), 'rateLimit' (API request allowance vs cumulative volume), 'twapSliceFills' (fills generated by the user's TWAP orders).",
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

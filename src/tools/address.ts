import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { post } from "../client.js";
import { defineTool } from "../register.js";
import { ETH_ADDRESS, envelope, envelopeRows, isoOf, matches, page, pick, result, shapeInput } from "../shape.js";
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

/** Coverage metadata for a fetchWindow() result. */
function windowInfo(rows: Rec[], w: { pages: number; complete: boolean }, startTime: number): Rec {
  if (rows.length === 0) return { returned: 0, capped: false, upstreamRequests: w.pages };
  const times = rows.map((r) => Number(r.time ?? 0)).filter((t) => t > 0);
  const from = Math.min(...times);
  const to = Math.max(...times);
  const meta: Rec = {
    returned: rows.length,
    upstreamRequests: w.pages,
    capped: !w.complete,
    coveredRange: { from, to, fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString(), requestedStartIso: new Date(startTime).toISOString() },
  };
  if (!w.complete) {
    meta.nextStartTime = to;
    meta.capNote = `Window not fully covered after ${w.pages} requests: rows (and totals) only cover ${new Date(from).toISOString()} .. ${new Date(to).toISOString()}. Call again with startTime=nextStartTime (or raise maxPages) for later rows; rows at exactly nextStartTime may repeat.`;
  }
  return meta;
}

/** page() metadata relabelled so a capped upstream count is not mistaken for the window total. */
function rowPaging(p: { total: number; offset: number; limit: number; hasMore: boolean }, capped: boolean): Rec {
  return { rowsReturned: p.total, offset: p.offset, limit: p.limit, hasMore: p.hasMore, ...(capped ? { note: "rowsReturned counts rows in this capped upstream response, not all rows in the period" } : {}) };
}

/**
 * Fetch a time-range query, following the upstream 2000-row cap forward (up to
 * maxPages requests) so totals cover the whole window when possible. Rows at the
 * boundary millisecond are re-requested and de-duplicated by `key`.
 */
async function fetchWindow(type: string, address: string, startTime: number, endTime: number | undefined, extra: Rec, maxPages: number, key: (r: Rec) => string): Promise<{ rows: Rec[]; pages: number; complete: boolean }> {
  const seen = new Set<string>();
  const rows: Rec[] = [];
  let from = startTime;
  let pages = 0;
  let complete = false;
  while (pages < maxPages) {
    const raw = await info(type, address, { startTime: from, ...(endTime !== undefined ? { endTime } : {}), ...extra });
    pages++;
    const batch = Array.isArray(raw) ? (raw as Rec[]) : [];
    let added = 0;
    let maxT = from;
    for (const r of batch) {
      const k = key(r);
      if (!seen.has(k)) {
        seen.add(k);
        rows.push(r);
        added++;
      }
      maxT = Math.max(maxT, Number(r.time ?? 0));
    }
    if (batch.length < UPSTREAM_ROW_CAP) {
      complete = true;
      break;
    }
    // next page starts at the last timestamp (re-fetching that ms, de-duplicated); if nothing new arrived, step past it
    from = added === 0 || maxT === from ? maxT + 1 : maxT;
  }
  return { rows, pages, complete };
}

const sumBy = (rows: Rec[], f: (r: Rec) => number) => rows.reduce((a, r) => a + (f(r) || 0), 0);
const round = (x: number) => Math.round(x * 1e6) / 1e6;

/** Keep the top n entries of a {key: stats} map by a score, folding the rest into `_otherCount`. */
function topN<T extends Rec>(m: Map<string, T>, n: number, score: (v: T) => number): Rec {
  const entries = [...m.entries()].sort((a, b) => score(b[1]) - score(a[1]));
  const out: Rec = Object.fromEntries(entries.slice(0, n));
  if (entries.length > n) out._otherCount = entries.length - n;
  return out;
}

function withIso(r: Rec, key: string, isoKey: string): Rec {
  const v = r[key];
  return typeof v === "number" && v > 0 ? { ...r, [isoKey]: new Date(v).toISOString() } : r;
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
        const wantsPairs = (args.fields ?? []).map((f: string) => f.replace(/^data\./, "")).some((f: string) => f === "pnlSummary" || f.startsWith("pnlSummary.tradedPairs"));
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
        "Address 'Open Orders' / 'Order History'. kind='open' (default): all resting orders on every DEX (coin, side B/A, limit price, size, oid, time). 'openDetailed': main-DEX orders with trigger/TP-SL/reduce-only/type/TIF (upstream max 100, `capped` then). 'historical': the newest ~2000 orders with final status, newest first; countsByStatus (filled/canceled/...) covers all of them, coveredRange shows their time span (seconds for busy accounts). Returns `count` of matching orders; pages default to 100 (open) / 50 rows. Times have ISO twins.",
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
      const counts: Rec = { count: list.length };
      if (kind === "historical") {
        const by: Record<string, number> = {};
        for (const o of list) by[String(o.status ?? "unknown")] = (by[String(o.status ?? "unknown")] ?? 0) + 1;
        counts.countsByStatus = Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]));
      }
      const { items, paging } = page(list, args, kind === "open" ? 100 : 50);
      const rows = items.map((o) =>
        kind === "historical"
          ? { ...withIso(o, "statusTimestamp", "statusTimeIso"), order: withIso((o.order as Rec) ?? {}, "timestamp", "timestampIso") }
          : withIso(o, "timestamp", "timestampIso"),
      );
      return result(envelopeRows(ROUTE, rows, args.fields, { kind, ...counts, paging: rowPaging(paging, Boolean(meta.capped)), ...meta }));
    },
  );

  defineTool(
    server,
    "flowscan_address_fills",
    {
      title: "Address trade fills",
      description:
        "Address 'Trades' tab: fills newest first, 50/page (coin, px, sz, side, direction, closed PnL, fee, hash, time + timeIso). `totals` (count, closedPnlUsdc, fees, volumeUsd = px*sz, byCoin) cover ALL matched fills in coveredRange: quote them, never add rows. No startTime: the latest ~2000 fills. With startTime[/endTime]: pages past the 2000-row cap are followed (maxPages); if still `capped`, continue from nextStartTime.",
      inputSchema: {
        address: ETH_ADDRESS,
        startTime: z.number().int().optional().describe("Unix ms. If set, uses the time-range query."),
        endTime: z.number().int().optional().describe("Unix ms (optional, with startTime)."),
        aggregateByTime: z.boolean().optional().describe("Merge partial fills (default true)."),
        maxPages: z.number().int().min(1).max(10).optional().describe("Pages to follow past the 2000-row cap (default 5)."),
        coin: z.string().optional().describe("Filter by coin symbol substring."),
        ...shapeInput,
      },
    },
    async (args) => {
      const agg = args.aggregateByTime ?? true;
      const ranged = args.startTime !== undefined;
      let all: Rec[];
      let windowMeta: Rec;
      if (ranged) {
        const w = await fetchWindow("userFillsByTime", args.address, args.startTime, args.endTime, { aggregateByTime: agg }, args.maxPages ?? 5, (r) => String(r.tid ?? `${r.time}:${r.coin}:${r.px}:${r.sz}`));
        all = w.rows;
        windowMeta = windowInfo(all, w, args.startTime);
      } else {
        const raw = await info("userFills", args.address, { aggregateByTime: agg });
        all = Array.isArray(raw) ? (raw as Rec[]) : [];
        windowMeta = rangeMeta(all, "time", "recent");
      }
      const list = newestFirst(all, "time").filter((f) => matches(f.coin, args.coin));
      const byCoin = new Map<string, { count: number; volumeUsd: number; closedPnlUsd: number; fees: number }>();
      for (const f of list) {
        const c = String(f.coin);
        const e = byCoin.get(c) ?? { count: 0, volumeUsd: 0, closedPnlUsd: 0, fees: 0 };
        e.count++;
        e.volumeUsd += Number(f.px) * Number(f.sz) || 0;
        e.closedPnlUsd += Number(f.closedPnl) || 0;
        e.fees += Number(f.fee) || 0;
        byCoin.set(c, e);
      }
      for (const e of byCoin.values()) Object.assign(e, { volumeUsd: round(e.volumeUsd), closedPnlUsd: round(e.closedPnlUsd), fees: round(e.fees) });
      const feesByToken: Record<string, number> = {};
      for (const f of list) feesByToken[String(f.feeToken ?? "USDC")] = round((feesByToken[String(f.feeToken ?? "USDC")] ?? 0) + (Number(f.fee) || 0));
      const totals = {
        over: "all fills matched (after the coin filter) in coveredRange, not just this page",
        count: list.length,
        closedPnlUsdc: round(sumBy(list, (f) => Number(f.closedPnl))),
        feesUsdc: feesByToken.USDC ?? 0,
        feesByToken,
        volumeUsd: round(sumBy(list, (f) => Number(f.px) * Number(f.sz))),
        byCoin: topN(byCoin, 25, (v) => v.volumeUsd),
      };
      const { items, paging } = page(list, args, 50);
      return result(envelopeRows(ROUTE, items.map((f) => withIso(f, "time", "timeIso")), args.fields, { totals, paging: rowPaging(paging, Boolean(windowMeta.capped)), ...windowMeta }));
    },
  );

  defineTool(
    server,
    "flowscan_address_ledger",
    {
      title: "Address funding payments or ledger updates",
      description:
        "Address 'Funding' / 'Ledger' tabs, newest first, rows with timeIso. kind='ledger' (default, 50/page, since 30 days ago): deposits, withdrawals, sends, transfers, vault/staking moves; totals.byType {count, sumUsdc, inUsdc, outUsdc}. kind='funding' (100/page, last 7 days): hourly payments; totals {netUsdc, paidUsdc, receivedUsdc, byCoin}. Totals cover ALL matched rows in coveredRange: quote them, never add rows. Pages past the 2000-row cap are followed (maxPages); if still `capped`, continue from nextStartTime.",
      inputSchema: {
        address: ETH_ADDRESS,
        kind: z.enum(["funding", "ledger"]).optional().describe("Default 'ledger'."),
        startTime: z.number().int().optional().describe("Unix ms (default now-30d for ledger, now-7d for funding)."),
        endTime: z.number().int().optional().describe("Unix ms."),
        coin: z.string().optional().describe("Filter by coin (funding) or token (ledger) substring; applied before totals."),
        maxPages: z.number().int().min(1).max(10).optional().describe("Pages to follow past the 2000-row cap (default 5)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const kind = args.kind ?? "ledger";
      const startTime = args.startTime ?? Date.now() - (kind === "funding" ? 7 : 30) * DAY;
      const addr = args.address.toLowerCase();
      const w = await fetchWindow(kind === "funding" ? "userFunding" : "userNonFundingLedgerUpdates", args.address, startTime, args.endTime, {}, args.maxPages ?? 5, (r) =>
        `${r.time}:${r.hash}:${JSON.stringify(r.delta)}`,
      );
      const windowMeta = windowInfo(w.rows, w, startTime);
      const list = newestFirst(w.rows, "time").filter((r) => {
        if (!args.coin) return true;
        const d = (r.delta as Rec) ?? {};
        return matches(d.coin ?? d.token, args.coin);
      });
      const usd = (d: Rec) => Number(d.usdc ?? d.usdcValue ?? NaN);
      let totals: Rec;
      if (kind === "funding") {
        const byCoin = new Map<string, { net: number; paid: number; received: number; count: number }>();
        let paid = 0;
        let received = 0;
        for (const r of list) {
          const d = (r.delta as Rec) ?? {};
          const v = Number(d.usdc) || 0;
          const e = byCoin.get(String(d.coin)) ?? { net: 0, paid: 0, received: 0, count: 0 };
          e.count++;
          e.net += v;
          if (v < 0) {
            e.paid -= v;
            paid -= v;
          } else {
            e.received += v;
            received += v;
          }
          byCoin.set(String(d.coin), e);
        }
        for (const e of byCoin.values()) Object.assign(e, { net: round(e.net), paid: round(e.paid), received: round(e.received) });
        totals = {
          over: "all funding rows matched (after the coin filter) in coveredRange, not just this page",
          count: list.length,
          netUsdc: round(received - paid),
          paidUsdc: round(paid),
          receivedUsdc: round(received),
          sign: "netUsdc > 0 means the account received funding; paidUsdc/receivedUsdc are positive magnitudes",
          byCoin: topN(byCoin, 25, (v) => Math.abs(v.net)),
        };
      } else {
        const byType = new Map<string, { count: number; sumUsdc: number; inUsdc: number; outUsdc: number; noUsdValue: number }>();
        for (const r of list) {
          const d = (r.delta as Rec) ?? {};
          const t = String(d.type ?? "unknown");
          const e = byType.get(t) ?? { count: 0, sumUsdc: 0, inUsdc: 0, outUsdc: 0, noUsdValue: 0 };
          e.count++;
          const v = usd(d);
          if (Number.isNaN(v)) e.noUsdValue++;
          else {
            e.sumUsdc += v;
            const outgoing = t === "withdraw" || (typeof d.user === "string" && d.user.toLowerCase() === addr && String(d.destination ?? "").toLowerCase() !== addr);
            const incoming = t === "deposit" || (typeof d.destination === "string" && d.destination.toLowerCase() === addr && String(d.user ?? "").toLowerCase() !== addr);
            if (outgoing) e.outUsdc += v;
            else if (incoming) e.inUsdc += v;
          }
          byType.set(t, e);
        }
        for (const e of byType.values()) Object.assign(e, { sumUsdc: round(e.sumUsdc), inUsdc: round(e.inUsdc), outUsdc: round(e.outUsdc) });
        totals = {
          over: "all ledger rows matched (after the coin filter) in coveredRange, not just this page",
          count: list.length,
          byType: Object.fromEntries([...byType.entries()].sort((a, b) => b[1].count - a[1].count)),
          note: "sumUsdc uses delta.usdc or delta.usdcValue; inUsdc/outUsdc classify deposits, withdrawals and transfers to/from this address (internal moves such as accountClassTransfer are neither); noUsdValue counts rows without a USD value (e.g. HYPE staking transfers).",
        };
      }
      const { items, paging } = page(list, args, kind === "funding" ? 100 : 50);
      return result(envelopeRows(ROUTE, items.map((r) => withIso(r, "time", "timeIso")), args.fields, { kind, totals, paging: rowPaging(paging, Boolean(windowMeta.capped)), startTime, ...windowMeta }));
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
        return result(envelopeRows(ROUTE, items, args.fields, { paging, kind: args.kind }));
      }
      return result(envelope(ROUTE, pick(data, args.fields), { kind: args.kind }));
    },
  );
}

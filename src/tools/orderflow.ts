import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FlowscanError, get } from "../client.js";
import { defineTool } from "../register.js";
import { envelope, isoOf, pick, result, shapeInput } from "../shape.js";
import { resolveMarket, TRADER_FILTER_LABELS, withLabels } from "./perp.js";

type Rec = Record<string, unknown>;

const SHOWN_ON = "https://www.flowscan.xyz/terminal";
const MIN = 60_000;
const HOUR = 60 * MIN;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

const FOOTPRINT_INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h"] as const;
const INTERVAL_MS: Record<string, number> = { "1m": MIN, "3m": 3 * MIN, "5m": 5 * MIN, "15m": 15 * MIN, "30m": 30 * MIN, "1h": HOUR };

const status = () => get("/api/perp-snapshot/status", {}, { ttlMs: 30_000 }) as Promise<Rec>;

/** Footprint data exists only for the ~100 coins listed in /status; resolve case-insensitively against them. */
async function footprintCoin(q: string): Promise<{ coin: string; note?: string }> {
  const coins = ((((await status()).footprint as Rec)?.coins as string[]) ?? []).map(String);
  const typed = q.trim();
  const ql = typed.toLowerCase();
  const exact = coins.filter((c) => c.toLowerCase() === ql || c.toLowerCase().split(":").pop() === ql);
  const full = exact.find((c) => c.toLowerCase() === ql);
  const one = full ?? (exact.length === 1 ? exact[0] : undefined);
  if (one) return { coin: one, ...(one !== typed ? { note: `Coin '${typed}' resolved to '${one}'.` } : {}) };
  if (exact.length > 1) throw new Error(`Coin '${typed}' matches several footprint markets: ${exact.join(", ")}. Pass the prefixed name.`);
  const near = coins.filter((c) => c.toLowerCase().includes(ql)).slice(0, 10);
  throw new FlowscanError(
    `Flowscan tracks order flow (footprint) for ${coins.length} markets only, and '${typed}' is not one of them.${near.length ? ` Close matches: ${near.join(", ")}.` : ""} Call flowscan_terminal_status for the full list.`,
    404,
    "/api/perp-snapshot/status",
  );
}

export function registerOrderflowTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_liquidations",
    {
      title: "Liquidations: live feed or history (/terminal Liqs)",
      description:
        "/terminal liquidations. view='recent' (default): latest events, newest first, all markets or one `market` (time, market, liquidated address with name, side of the liquidated position, method, price, size, USD notional) with `summary` (count, long/short USD, largest, byMarket). view='history': USD liquidated per minute for ONE market over `hours` (kept ~2-3 days) with totals and peak. Positions near liquidation: flowscan_perp_market_detail.",
      inputSchema: {
        view: z.enum(["recent", "history"]).optional().describe("recent = latest events (default); history = bucketed totals for one market."),
        market: z.string().optional().describe("Market, e.g. 'BTC'. Required for history."),
        hours: z.number().int().min(1).max(168).optional().describe("history: lookback hours (default 24)."),
        side: z.enum(["long", "short"]).optional().describe("recent: only liquidated longs or shorts."),
        minNotional: z.number().min(0).optional().describe("recent: min USD notional."),
        events: z.number().int().min(1).max(400).optional().describe("recent: newest events to fetch (default 120, as the site)."),
        includeTags: z.boolean().optional().describe("recent: add names (default true)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const view = args.view ?? "recent";
      if (view === "history") {
        if (!args.market) throw new Error("view='history' needs a market, e.g. 'BTC'.");
        const { market, note } = await resolveMarket(args.market);
        const hours = args.hours ?? 24;
        const end = Math.floor(Date.now() / MIN) * MIN;
        const start = end - hours * HOUR;
        const route = `/api/perp-snapshot/liquidations/${encodeURIComponent(market)}`;
        const d = (await get(route, { start, end })) as Rec;
        const buckets = ((d.buckets as Rec[]) ?? []).map((b) => ({ t: b.t, timeIso: isoOf(b.t), longNotional: b.longNotional, shortNotional: b.shortNotional }));
        const totals = { longNotional: round2(buckets.reduce((a, b) => a + num(b.longNotional), 0)), shortNotional: round2(buckets.reduce((a, b) => a + num(b.shortNotional), 0)), bucketsWithLiquidations: buckets.length };
        const peak = buckets.reduce<Rec | null>((m, b) => (!m || num(b.longNotional) + num(b.shortNotional) > num(m.longNotional) + num(m.shortNotional) ? b : m), null);
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 200;
        const rows = [...buckets].reverse().slice(offset, offset + limit);
        const out = {
          view,
          market,
          ...(note ? { resolvedNote: note } : {}),
          fromIso: isoOf(d.start ?? start),
          toIso: isoOf(d.end ?? end),
          earliestBucketIso: buckets.length ? buckets[0].timeIso : null,
          bucketMinutes: 1,
          totals: { ...totals, totalNotional: round2(totals.longNotional + totals.shortNotional) },
          peakBucket: peak,
          buckets: rows,
        };
        return result(
          envelope(route, pick(out, args.fields), {
            shownOn: SHOWN_ON,
            paging: { total: buckets.length, offset, limit, hasMore: offset + rows.length < buckets.length },
            note: "One-minute buckets; only minutes with liquidations are listed, newest first. longNotional = USD of long positions liquidated, shortNotional = shorts. Flowscan keeps about 2-3 days of this history, so a longer `hours` returns only what is kept (see earliestBucketIso).",
          }),
        );
      }

      let market: string | undefined;
      let note: string | undefined;
      if (args.market) ({ market, note } = await resolveMarket(args.market));
      const route = market ? `/api/perp-snapshot/liquidations/${encodeURIComponent(market)}/recent` : "/api/perp-snapshot/liquidations/recent";
      const d = (await get(route, { limit: args.events ?? 120 }, { ttlMs: 10_000 })) as Rec;
      const events = ((d.events as Rec[]) ?? [])
        .filter((e) => (!args.side || e.side === args.side) && num(e.notional) >= (args.minNotional ?? 0))
        .map(({ id: _id, ...e }) => ({ ...e, timeIso: isoOf(e.time) }) as Rec);
      const longs = events.filter((e) => e.side === "long");
      const shorts = events.filter((e) => e.side === "short");
      const byMarket = new Map<string, { count: number; notional: number }>();
      for (const e of events) {
        const m = byMarket.get(String(e.coin)) ?? { count: 0, notional: 0 };
        m.count++;
        m.notional += num(e.notional);
        byMarket.set(String(e.coin), m);
      }
      const largest = events.reduce<Rec | null>((m, e) => (!m || num(e.notional) > num(m.notional) ? e : m), null);
      const summary = {
        count: events.length,
        longNotional: round2(longs.reduce((a, e) => a + num(e.notional), 0)),
        shortNotional: round2(shorts.reduce((a, e) => a + num(e.notional), 0)),
        longCount: longs.length,
        shortCount: shorts.length,
        fromIso: events.length ? isoOf(Math.min(...events.map((e) => num(e.time)))) : null,
        toIso: events.length ? isoOf(Math.max(...events.map((e) => num(e.time)))) : null,
        largest,
        ...(market ? {} : { byMarket: [...byMarket.entries()].sort((a, b) => b[1].notional - a[1].notional).slice(0, 15).map(([coin, v]) => ({ market: coin, count: v.count, notional: round2(v.notional) })) }),
      };
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      const rows = (await withLabels(events.slice(offset, offset + limit).map((e) => ({ ...e, address: e.user })), args.includeTags)).map(({ address: _a, ...e }) => e);
      const out = { view, market: market ?? "all", ...(note ? { resolvedNote: note } : {}), feedConnected: d.connected ?? null, summary, events: rows };
      return result(
        envelope(route, pick(out, args.fields), {
          shownOn: SHOWN_ON,
          paging: { total: events.length, offset, limit, hasMore: offset + rows.length < events.length },
          note: "summary covers every fetched event matching the filters (the newest `events` Flowscan returns), not a fixed time window; see summary.fromIso/toIso. side = the side of the position that was liquidated.",
        }),
      );
    },
  );

  defineTool(
    server,
    "flowscan_order_flow",
    {
      title: "Order flow per candle: footprint or open/close flow (/terminal)",
      description:
        "/terminal order-flow indicators for ONE market (~100 tracked, see flowscan_terminal_status). kind='footprint' (default): per candle taker buy/sell USD volume, delta, trades and POC (price with most volume); includeLevels adds [price, buyUsd, sellUsd] rows. kind='flow': USD opened vs closed and realized PnL per candle. Up to 500 candles ending now or endTime, newest first; `totals` cover them all. Data from Aug 2025.",
      inputSchema: {
        market: z.string().min(1).describe("Market, e.g. 'BTC', 'ETH', 'xyz:GOLD' (case-insensitive)."),
        kind: z.enum(["footprint", "flow"]).optional().describe("Default footprint."),
        interval: z.enum(FOOTPRINT_INTERVALS).optional().describe("Candle size (default 1h)."),
        bars: z.number().int().min(1).max(500).optional().describe("Candles (default 24)."),
        endTime: z.number().int().min(1_600_000_000_000).optional().describe("Unix ms inside the last candle wanted (default now)."),
        includeLevels: z.boolean().optional().describe("footprint: per-price levels (large)."),
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const { coin, note } = await footprintCoin(String(args.market));
      const kind = args.kind ?? "footprint";
      const interval = args.interval ?? "1h";
      const step = INTERVAL_MS[interval];
      const bars = args.bars ?? 24;
      const end = args.endTime ?? Date.now();
      if (end > Date.now() + HOUR) throw new Error("endTime is in the future.");
      // The route's range is end-exclusive. The last candle is the one containing endTime
      // (the current, still-forming one by default); ask for exactly `bars` candles up to it.
      const lastOpen = Math.floor(end / step) * step;
      const start = lastOpen - (bars - 1) * step;
      const routeEnd = Math.min(lastOpen + step, Math.ceil(Date.now() / MIN) * MIN);
      const route = `/api/perp-snapshot/footprint/${encodeURIComponent(coin)}${kind === "flow" ? "/flow" : ""}`;
      const d = (await get(route, { interval, start, end: Math.max(routeEnd, start + MIN) })) as Rec;
      const candles = ((d.candles as Rec[]) ?? []).slice(-bars);
      let rows: Rec[];
      let totals: Rec;
      if (kind === "flow") {
        rows = candles.map((c) => ({ t: c.t, timeIso: isoOf(c.t), openedUsd: c.open, closedUsd: c.close, netOpenedUsd: round2(num(c.open) - num(c.close)), realizedPnlUsd: c.pnl }));
        totals = {
          openedUsd: round2(rows.reduce((a, r) => a + num(r.openedUsd), 0)),
          closedUsd: round2(rows.reduce((a, r) => a + num(r.closedUsd), 0)),
          realizedPnlUsd: round2(rows.reduce((a, r) => a + num(r.realizedPnlUsd), 0)),
        };
        totals.netOpenedUsd = round2(num(totals.openedUsd) - num(totals.closedUsd));
      } else {
        rows = candles.map((c) => ({
          t: c.t,
          timeIso: isoOf(c.t),
          buyUsd: c.buy,
          sellUsd: c.sell,
          deltaUsd: c.delta,
          trades: c.trades,
          poc: c.poc,
          ...(c.partial ? { partial: true } : {}),
          ...(args.includeLevels ? { levels: c.levels } : {}),
        }));
        const buy = rows.reduce((a, r) => a + num(r.buyUsd), 0);
        const sell = rows.reduce((a, r) => a + num(r.sellUsd), 0);
        totals = { buyUsd: round2(buy), sellUsd: round2(sell), deltaUsd: round2(buy - sell), trades: rows.reduce((a, r) => a + num(r.trades), 0), buySharePct: buy + sell > 0 ? round2((buy / (buy + sell)) * 100) : null };
      }
      rows.reverse();
      const out = {
        kind,
        market: coin,
        ...(note ? { resolvedNote: note } : {}),
        interval,
        candles: rows.length,
        fromIso: rows.length ? rows[rows.length - 1].timeIso : null,
        toIso: rows.length ? rows[0].timeIso : null,
        ...(kind === "footprint" ? { tickSize: d.tick ?? null, lastTradeIso: isoOf(d.lastTradeTime), ...(Array.isArray(d.gaps) && d.gaps.length ? { gaps: d.gaps } : {}) } : {}),
        totals,
        rows,
      };
      return result(
        envelope(route, pick(out, args.fields), {
          shownOn: SHOWN_ON,
          note:
            kind === "flow"
              ? "openedUsd/closedUsd = USD notional of trades that opened vs closed positions in each candle; realizedPnlUsd = PnL realized by the closes. A candle flagged partial is still forming."
              : "buyUsd/sellUsd = aggressive (taker) buy/sell volume in USD; deltaUsd = buy - sell; poc = price level with the most volume. The newest candle may be partial.",
          ...(rows.length === 0 ? { emptyNote: `No ${kind} candles for ${coin} in this range (data starts Aug 2025).` } : {}),
        }),
      );
    },
  );

  defineTool(
    server,
    "flowscan_terminal_status",
    {
      title: "Terminal data status: snapshot freshness, cohorts, footprint markets, spike alerts",
      description:
        "Freshness behind /terminal: perp snapshot time/age, baseline and history range; trader cohorts (top 10k, top-1k PnL and win rate) with refresh times; the ~100 markets and intervals with order-flow data (flowscan_order_flow); active price-spike alerts.",
      inputSchema: {
        include: z.array(z.enum(["snapshot", "cohorts", "footprint", "spikes"])).optional().describe("Sections (default all)."),
      },
      openWorld: true,
    },
    async (args) => {
      const want = new Set<string>(args.include ?? ["snapshot", "cohorts", "footprint", "spikes"]);
      const [st, lb, sp] = await Promise.all([
        want.has("snapshot") || want.has("footprint") ? status() : null,
        want.has("cohorts") ? (get("/api/perp-snapshot/leaderboard/status", {}, { ttlMs: 5 * MIN }) as Promise<Rec>) : null,
        want.has("spikes") ? (get("/api/perp-snapshot/spikes", {}, { ttlMs: 5_000 }) as Promise<Rec>) : null,
      ]);
      const out: Rec = {};
      if (st && want.has("snapshot")) {
        const h = (st.history as Rec) ?? {};
        out.snapshot = {
          status: st.status,
          snapshotId: st.snapshotId,
          snapshotIso: isoOf(st.timestamp),
          snapshotAgeSeconds: st.timestamp ? Math.round((Date.now() - num(st.timestamp)) / 1000) : null,
          marketCount: st.marketCount,
          nextFetchIn: st.nextFetchIn,
          baselineSnapshotId: st.baselineSnapshotId,
          baselineIso: isoOf(st.baselineTimestamp),
          history: { count: h.count, oldestIso: isoOf(h.oldest), newestIso: isoOf(h.newest) },
        };
      }
      if (st && want.has("footprint")) {
        const f = (st.footprint as Rec) ?? {};
        const live = (f.live as Rec) ?? {};
        out.footprint = {
          coins: f.coins,
          coinCount: Array.isArray(f.coins) ? f.coins.length : 0,
          intervals: f.intervals,
          liveFeedConnected: live.connected ?? null,
          lastTradeIso: isoOf(live.lastFillAt ?? live.lastMessageAt),
          latestSealedDate: ((f.store as Rec) ?? {}).latestSealedDate ?? null,
        };
      }
      if (lb) {
        out.cohorts = {
          ready: lb.ready,
          leaderboard: { id: "leaderboard", label: TRADER_FILTER_LABELS.leaderboard, addressCount: lb.addressCount, fetchedIso: isoOf(lb.fetchedAt) },
          curated: ((lb.cohorts as Rec[]) ?? []).map((c) => ({ id: c.id, label: c.label, window: c.window, sortBy: c.sortBy, count: c.count, rankedFrom: c.total, ready: c.ready, fetchedIso: isoOf(c.fetchedAt), ...(c.error ? { error: c.error } : {}) })),
          note: "Pass a cohort id as traderFilter to flowscan_perp_markets, flowscan_perp_positions or flowscan_position_changes.",
        };
      }
      if (sp) out.spikeAlerts = { count: Array.isArray(sp.alerts) ? sp.alerts.length : 0, alerts: ((sp.alerts as Rec[]) ?? []).map((a) => ({ ...a, atIso: isoOf(a.at), candles: undefined })) };
      const routes = [...(st ? ["/api/perp-snapshot/status"] : []), ...(lb ? ["/api/perp-snapshot/leaderboard/status"] : []), ...(sp ? ["/api/perp-snapshot/spikes"] : [])];
      return result(envelope(routes[0], out, { shownOn: SHOWN_ON, ...(routes.length > 1 ? { sources: routes.map((r) => `https://www.flowscan.xyz${r}`) } : {}) }));
    },
  );
}

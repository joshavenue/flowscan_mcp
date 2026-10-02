/**
 * Hyperliquid-direct market tools: prices, candles, order book, recent trades,
 * spot token directory, perp DEX list, validator summaries and borrow/lend
 * reserves. Registered only when FLOWSCAN_HYPERLIQUID_DIRECT=1.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool } from "../register.js";
import { matches, page, pickRows, result, shapeInput, upstreamEnvelope } from "../shape.js";
import { DEX_ALIASES, findDex } from "../dex.js";
import {
  allMids,
  allPerpMetas,
  borrowLendReserves,
  CANDLE_INTERVALS,
  candleSnapshot,
  deriveCandleWindow,
  dexPrefixOf,
  iso,
  metaAndAssetCtxs,
  num,
  resolveCoin,
  spotMeta,
  spotMetaAndAssetCtxs,
  validatorSummaries,
  type CandleInterval,
} from "../hyperliquid.js";
import { ENDPOINTS, UpstreamError, wsCollect } from "../upstream.js";

type Rec = Record<string, unknown>;
const SITE = "https://www.flowscan.xyz";
const OI_NOTE =
  "Hyperliquid's openInterest counts BOTH sides (long + short size; checked: it equals 2x the summed long positions in Flowscan's perp snapshot). openInterestTwoSided / openInterestUsdTwoSided are on the same basis as Flowscan's perp snapshot openInterest (long + short notional, flowscan_perp_markets) and directly comparable with it; openInterestUsdOneSided is half (one side, e.g. total long notional).";
const r2 = (x: number | null, d = 2) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
const pct = (a: number | null, b: number | null) => (a !== null && b !== null && b !== 0 ? r2(((a - b) / b) * 100, 3) : null);

function perpRow(u: Rec, c: Rec | undefined, dex: string): Rec {
  const mark = num(c?.markPx);
  const oi = num(c?.openInterest);
  const funding = num(c?.funding);
  return {
    coin: u.name,
    ...(dex ? { dex } : {}),
    markPx: mark,
    midPx: num(c?.midPx),
    oraclePx: num(c?.oraclePx),
    prevDayPx: num(c?.prevDayPx),
    change24hPct: pct(mark, num(c?.prevDayPx)),
    fundingHourly: funding,
    fundingAprPct: funding === null ? null : r2(funding * 24 * 365 * 100, 2),
    premium: num(c?.premium),
    openInterestTwoSided: oi,
    openInterestUsdTwoSided: oi !== null && mark !== null ? Math.round(oi * mark) : null,
    openInterestUsdOneSided: oi !== null && mark !== null ? Math.round((oi * mark) / 2) : null,
    dayNtlVlm: num(c?.dayNtlVlm) === null ? null : Math.round(num(c?.dayNtlVlm)!),
    maxLeverage: u.maxLeverage,
    ...(u.isDelisted ? { isDelisted: true } : {}),
  };
}

async function perpRows(dex: string): Promise<Rec[]> {
  const r = await metaAndAssetCtxs(dex);
  if (!Array.isArray(r) || !r[0]?.universe) throw new UpstreamError(`Unknown perp dex '${dex}'`, 404, `${ENDPOINTS.info} {type:metaAndAssetCtxs}`);
  const [meta, ctxs] = r;
  return (meta.universe as Rec[]).map((u, i) => perpRow(u, ctxs[i], dex));
}

function dexArg(input: string | undefined): string {
  if (!input) return "";
  const q = input.trim().replace(/:$/, "");
  if (!q || /^(main|hyperliquid|native)$/i.test(q)) return "";
  return findDex(q)?.prefix ?? q.toLowerCase();
}

/** First WebSocket snapshot for one coin subscription on wss://api.hyperliquid.xyz/ws. */
async function wsSnapshot(subscription: Rec, channel: string, coin: string): Promise<{ data: unknown; openMs: number | null }> {
  let data: unknown = undefined;
  const ws = await wsCollect({
    url: ENDPOINTS.infoWs,
    subscriptions: [subscription],
    durationMs: 8_000,
    onMessage: (m) => {
      const msg = m as Rec;
      if (msg?.channel === "error") throw new UpstreamError(`Hyperliquid WebSocket error: ${String(msg.data).slice(0, 200)}`, 400, ENDPOINTS.infoWs);
      if (msg?.channel !== channel) return false;
      const d = msg.data as Rec | Rec[];
      const c = Array.isArray(d) ? d[0]?.coin : d?.coin;
      if (Array.isArray(d) && d.length === 0) return false;
      if (c !== undefined && c !== coin) return false;
      data = d;
      return true;
    },
  });
  if (data === undefined) throw new UpstreamError(`No ${channel} snapshot for '${coin}' within 8s (no activity on this coin?)`, 404, ENDPOINTS.infoWs);
  return { data, openMs: ws.openMs };
}

export function registerMarketTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_prices",
    {
      title: "Perp prices, funding, OI, 24h volume",
      description:
        "Live perp prices as Flowscan loads them (allMids + metaAndAssetCtxs): mark, mid, oracle, 24h change, hourly funding (+APR), premium, open interest (two-sided like Flowscan's snapshot, plus one-sided USD), 24h notional volume, max leverage. `coins` like ['HYPE','BTC','xyz:TSLA'] (HIP-3 'dex:COIN', display names ok; spot pairs/tokens give mid only). Without coins: top markets of one dex by 24h volume. Answers 'what is the HYPE price'.",
      inputSchema: {
        coins: z.array(z.string()).max(50).optional().describe("Coins to quote."),
        dex: z.string().optional().describe("HIP-3 dex for the top list (prefix or name; default main)."),
        sortBy: z.enum(["volume", "openInterest", "change", "funding"]).optional().describe("Top list order (default volume)."),
        includeDelisted: z.boolean().optional().describe("Include delisted markets (default false)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const requests: Rec[] = [{ type: "allMids" }, { type: "metaAndAssetCtxs" }];
      const mids = await allMids();
      if (args.coins?.length) {
        const rows: Rec[] = [];
        const notFound: Rec[] = [];
        const byDex = new Map<string, Promise<Rec[]>>();
        const rowsFor = (dex: string) => {
          if (!byDex.has(dex)) {
            byDex.set(dex, perpRows(dex));
            if (dex) requests.push({ type: "metaAndAssetCtxs", dex });
          }
          return byDex.get(dex)!;
        };
        rowsFor("");
        for (const raw of args.coins as string[]) {
          const q = raw.trim();
          const i = q.indexOf(":");
          try {
            if (i > 0) {
              const dex = dexArg(q.slice(0, i));
              const want = `${dex}:${q.slice(i + 1)}`.toLowerCase();
              const hit = (await rowsFor(dex)).find((r) => String(r.coin).toLowerCase() === want);
              if (hit) rows.push(hit);
              else notFound.push({ coin: raw, reason: `no market on dex '${dex}'` });
              continue;
            }
            const main = (await rowsFor("")).find((r) => String(r.coin).toLowerCase() === q.toLowerCase());
            if (main) {
              rows.push(main);
              continue;
            }
            const rc = await resolveCoin(q);
            rows.push({ coin: rc.coin, kind: rc.kind, ...(rc.base ? { token: rc.base } : {}), midPx: num(mids[rc.coin]), ...(rc.kind === "spot" ? { hint: "spot: see flowscan_spot_tokens for mark, volume, supply" } : {}) });
          } catch (e) {
            notFound.push({ coin: raw, reason: (e as Error).message });
          }
        }
        const { rows: picked, report } = pickRows(rows, args.fields);
        return result(upstreamEnvelope(ENDPOINTS.info, `${SITE}/`, picked, { request: requests, oiNote: OI_NOTE, count: rows.length, ...(notFound.length ? { notFound } : {}), ...report }));
      }
      const dex = dexArg(args.dex);
      if (dex) requests.push({ type: "metaAndAssetCtxs", dex });
      let rows = await perpRows(dex);
      const delisted = rows.filter((r) => r.isDelisted).length;
      if (!args.includeDelisted) rows = rows.filter((r) => !r.isDelisted);
      const key = { volume: "dayNtlVlm", openInterest: "openInterestUsdTwoSided", change: "change24hPct", funding: "fundingHourly" }[(args.sortBy ?? "volume") as "volume"];
      rows.sort((a, b) => Number(b[key] ?? -Infinity) - Number(a[key] ?? -Infinity));
      const { items, paging } = page(rows, args, 20);
      const { rows: picked, report } = pickRows(items, args.fields);
      const totals = { markets: rows.length, delistedHidden: args.includeDelisted ? 0 : delisted, dayNtlVlmUsd: Math.round(rows.reduce((s, r) => s + Number(r.dayNtlVlm ?? 0), 0)), openInterestUsdTwoSided: Math.round(rows.reduce((s, r) => s + Number(r.openInterestUsdTwoSided ?? 0), 0)) };
      return result(upstreamEnvelope(ENDPOINTS.info, `${SITE}/`, picked, { request: requests, oiNote: OI_NOTE, dex: dex || "main", sortedBy: key, totals, paging, ...report }));
    },
  );

  defineTool(
    server,
    "flowscan_candles",
    {
      title: "OHLCV candles",
      description:
        "Price candles as on the address page position chart (candleSnapshot): rows {t, tIso, o, h, l, c, v, n} oldest first, plus open/close/high/low/change/volume summary. coin: perp (BTC), HIP-3 (xyz:TSLA), spot pair (@107) or spot token (NVDAX). Window = `bars` intervals back from endTime (default now) unless startTime is given.",
      inputSchema: {
        coin: z.string().min(1).describe("Coin: BTC, xyz:TSLA, @107 or NVDAX."),
        interval: z.enum(CANDLE_INTERVALS).optional().describe("Default 1h."),
        bars: z.number().int().min(1).max(500).optional().describe("Default 100, max 500 (most recent kept)."),
        startTime: z.number().int().optional().describe("ms epoch."),
        endTime: z.number().int().optional().describe("ms epoch (default now)."),
      },
    },
    async (args) => {
      const interval = (args.interval ?? "1h") as CandleInterval;
      const rc = await resolveCoin(args.coin);
      const w = deriveCandleWindow({ interval, bars: args.bars, startTime: args.startTime, endTime: args.endTime });
      const raw = await candleSnapshot(rc.coin, interval, w.startTime, w.endTime);
      if (!Array.isArray(raw)) throw new UpstreamError(`No candles for '${rc.coin}'`, 404, `${ENDPOINTS.info} {type:candleSnapshot}`);
      let rows = raw
        .map((c) => ({ t: Number(c.t), tIso: iso(c.t), o: num(c.o), h: num(c.h), l: num(c.l), c: num(c.c), v: num(c.v), n: c.n, T: Number(c.T) }))
        .sort((a, b) => a.t - b.t);
      const upstreamCount = rows.length;
      if (rows.length > w.bars) rows = rows.slice(rows.length - w.bars);
      const now = Date.now();
      const last = rows[rows.length - 1];
      const summary = rows.length
        ? {
            open: rows[0].o,
            close: last.c,
            high: Math.max(...rows.map((r) => r.h ?? -Infinity)),
            low: Math.min(...rows.map((r) => r.l ?? Infinity)),
            changePct: pct(last.c, rows[0].o),
            volume: r2(rows.reduce((s, r) => s + (r.v ?? 0), 0), 4),
            trades: rows.reduce((s, r) => s + Number(r.n ?? 0), 0),
            from: rows[0].tIso,
            to: iso(last.T),
            lastCandleInProgress: last.T >= now,
          }
        : null;
      return result(
        upstreamEnvelope(ENDPOINTS.info, `${SITE}/address/{address}`, { coin: rc.coin, ...(rc.note ? { note: rc.note } : {}), interval, summary, candles: rows.map(({ T: _T, ...r }) => r) }, {
          request: { type: "candleSnapshot", req: { coin: rc.coin, interval, startTime: w.startTime, endTime: w.endTime } },
          shownOnNote: "Price chart of a position's coin on the address page.",
          rows: rows.length,
          ...(args.startTime !== undefined && upstreamCount > rows.length ? { keptMostRecent: rows.length, upstreamRows: upstreamCount, capNote: "More candles than `bars` in the window; the most recent were kept." } : {}),
        }),
      );
    },
  );

  defineTool(
    server,
    "flowscan_order_book",
    {
      title: "Order book (L2) snapshot",
      description:
        "One L2 order book snapshot from the Hyperliquid WebSocket l2Book subscription (what /hip-4 streams for outcome coins): top bids/asks with size, order count, cumulative size and USD, best bid/ask, mid, spread (bps). coin: BTC, xyz:TSLA, @107, NVDAX or an outcome side like #14730. nSigFigs (2-5) aggregates levels.",
      inputSchema: {
        coin: z.string().min(1).describe("Coin: BTC, xyz:TSLA, @107, NVDAX or an outcome side like #14730."),
        depth: z.number().int().min(1).max(20).optional().describe("Levels per side (default 10)."),
        nSigFigs: z.number().int().min(2).max(5).optional().describe("Aggregate price levels to 2-5 significant figures."),
        mantissa: z.literal([1, 2, 5]).optional().describe("Only with nSigFigs=5."),
      },
    },
    async (args) => {
      const rc = await resolveCoin(args.coin);
      const sub: Rec = { type: "l2Book", coin: rc.coin };
      if (args.nSigFigs) sub.nSigFigs = args.nSigFigs;
      if (args.mantissa && args.nSigFigs === 5) sub.mantissa = args.mantissa;
      const { data } = await wsSnapshot(sub, "l2Book", rc.coin);
      const d = data as { coin: string; time: number; levels: Rec[][] };
      const depth = args.depth ?? 10;
      const side = (lv: Rec[]) => {
        let cum = 0;
        let cumUsd = 0;
        return (lv ?? []).slice(0, depth).map((l) => {
          const px = Number(l.px);
          const sz = Number(l.sz);
          cum += sz;
          cumUsd += px * sz;
          return { px, sz, n: l.n, cumSz: r2(cum, 6), cumUsd: Math.round(cumUsd) };
        });
      };
      const bids = side(d.levels?.[0]);
      const asks = side(d.levels?.[1]);
      const bb = bids[0]?.px ?? null;
      const ba = asks[0]?.px ?? null;
      const mid = bb !== null && ba !== null ? (bb + ba) / 2 : null;
      return result(
        upstreamEnvelope(ENDPOINTS.infoWs, `${SITE}/hip-4`, {
          coin: d.coin,
          ...(rc.note ? { note: rc.note } : {}),
          time: d.time,
          timeIso: iso(d.time),
          bestBid: bb,
          bestAsk: ba,
          mid,
          spread: bb !== null && ba !== null ? r2(ba - bb, 8) : null,
          spreadBps: mid && bb !== null && ba !== null ? r2(((ba - bb) / mid) * 10_000, 3) : null,
          bids,
          asks,
        }, { request: { method: "subscribe", subscription: sub }, shownOnNote: "Flowscan streams l2Book for HIP-4 outcome coins on /hip-4; the same subscription works for any coin." }),
      );
    },
  );

  defineTool(
    server,
    "flowscan_recent_trades",
    {
      title: "Recent trades",
      description:
        "Most recent trades for a coin from the Hyperliquid WebSocket trades subscription (what /hip-4 streams for outcome coins; Hyperliquid sends the last 30): time, side (buy = taker bought), price, size, USD notional, hash, buyer, seller, plus buy/sell volume and VWAP. coin: BTC, xyz:TSLA, @107, NVDAX, #14730.",
      inputSchema: {
        coin: z.string().min(1).describe("Coin: BTC, xyz:TSLA, @107, NVDAX or #14730."),
        limit: z.number().int().min(1).max(30).optional().describe("Default 30 (upstream sends 30)."),
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const rc = await resolveCoin(args.coin);
      const sub = { type: "trades", coin: rc.coin };
      const { data } = await wsSnapshot(sub, "trades", rc.coin);
      const trades = (data as Rec[]).slice().sort((a, b) => Number(b.time) - Number(a.time)).slice(0, args.limit ?? 30);
      const rows = trades.map((t) => {
        const px = Number(t.px);
        const sz = Number(t.sz);
        const users = Array.isArray(t.users) ? (t.users as string[]) : [];
        return { time: t.time, timeIso: iso(t.time), side: t.side === "B" ? "buy" : "sell", px, sz, notionalUsd: r2(px * sz), hash: t.hash, tid: t.tid, buyer: users[0], seller: users[1] };
      });
      const buys = rows.filter((r) => r.side === "buy");
      const sells = rows.filter((r) => r.side === "sell");
      const vol = rows.reduce((s, r) => s + r.sz, 0);
      const stats = {
        trades: rows.length,
        buyNotionalUsd: r2(buys.reduce((s, r) => s + r.notionalUsd!, 0)),
        sellNotionalUsd: r2(sells.reduce((s, r) => s + r.notionalUsd!, 0)),
        vwap: vol ? r2(rows.reduce((s, r) => s + r.px * r.sz, 0) / vol, 8) : null,
        from: rows[rows.length - 1]?.timeIso ?? null,
        to: rows[0]?.timeIso ?? null,
      };
      const { rows: picked, report } = pickRows(rows, args.fields);
      return result(upstreamEnvelope(ENDPOINTS.infoWs, `${SITE}/hip-4`, { coin: rc.coin, ...(rc.note ? { note: rc.note } : {}), stats, trades: picked }, { request: { method: "subscribe", subscription: sub }, ...report }));
    },
  );

  defineTool(
    server,
    "flowscan_spot_tokens",
    {
      title: "Spot tokens and pairs (names, prices, supply)",
      description:
        "Hyperliquid spot directory from spotMetaAndAssetCtxs (used by the address page to name and value spot balances): per pair the pair id ('@702'), base/quote token names, token index, decimals, mark/mid, 24h change and volume, circulating/total supply, market cap. Maps '@702' -> NVDAX. search matches token name, full name, pair id or token index.",
      inputSchema: {
        search: z.string().optional().describe("Token name, full name, pair id or token index."),
        sortBy: z.enum(["volume", "marketCap", "name"]).optional().describe("Default volume."),
        ...shapeInput,
      },
    },
    async (args) => {
      const [meta, ctxs] = await spotMetaAndAssetCtxs();
      const tokens = new Map(meta.tokens.map((t) => [Number(t.index), t]));
      const ctxBy = new Map(ctxs.map((c) => [String(c.coin), c]));
      let rows: Rec[] = meta.universe.map((u) => {
        const [bi, qi] = (u.tokens as number[]) ?? [];
        const base = tokens.get(bi);
        const quote = tokens.get(qi);
        const c = ctxBy.get(String(u.name));
        const mark = num(c?.markPx);
        // 92233720368.42... (u64 max / 1e8) is a placeholder supply, not a real one.
        const placeholder = (v: number | null) => v !== null && v >= 9.2e10;
        const circ = num(c?.circulatingSupply);
        const supplyPlaceholder = placeholder(circ) || placeholder(num(c?.totalSupply));
        return {
          pair: u.name,
          pairIndex: u.index,
          base: base?.name,
          quote: quote?.name,
          baseTokenIndex: bi,
          ...(base?.fullName ? { fullName: base.fullName } : {}),
          szDecimals: base?.szDecimals,
          weiDecimals: base?.weiDecimals,
          markPx: mark,
          midPx: num(c?.midPx),
          prevDayPx: num(c?.prevDayPx),
          change24hPct: pct(mark, num(c?.prevDayPx)),
          dayNtlVlm: num(c?.dayNtlVlm),
          circulatingSupply: supplyPlaceholder ? null : circ,
          totalSupply: supplyPlaceholder ? null : num(c?.totalSupply),
          marketCapUsd: !supplyPlaceholder && circ !== null && mark !== null ? Math.round(circ * mark) : null,
          ...(supplyPlaceholder ? { supplyNote: "upstream reports the u64-max placeholder supply" } : {}),
          isCanonical: u.isCanonical,
          ...((base?.evmContract as Rec | null)?.address ? { evmContract: (base!.evmContract as Rec).address } : {}),
        };
      });
      if (args.search) {
        const q = String(args.search).trim();
        rows = q.startsWith("@")
          ? rows.filter((r) => String(r.pair).toLowerCase() === q.toLowerCase())
          : /^\d+$/.test(q)
            ? rows.filter((r) => String(r.baseTokenIndex) === q || String(r.pairIndex) === q)
            : rows.filter((r) => matches(r.base, q) || matches(r.fullName, q) || matches(r.pair, q));
      }
      const sortBy = args.sortBy ?? "volume";
      rows.sort((a, b) => (sortBy === "name" ? String(a.base).localeCompare(String(b.base)) : Number((sortBy === "volume" ? b.dayNtlVlm : b.marketCapUsd) ?? -1) - Number((sortBy === "volume" ? a.dayNtlVlm : a.marketCapUsd) ?? -1)));
      const { items, paging } = page(rows, args, 50);
      const { rows: picked, report } = pickRows(items, args.fields);
      return result(upstreamEnvelope(ENDPOINTS.info, `${SITE}/address/{address}`, picked, { request: { type: "spotMetaAndAssetCtxs" }, shownOnNote: "Spot balances on the address page are named and valued with this data.", totals: { pairs: meta.universe.length, tokens: meta.tokens.length }, paging, ...report }));
    },
  );

  defineTool(
    server,
    "flowscan_perp_dexs",
    {
      title: "Perp DEXs (main + HIP-3) and their markets",
      description:
        "All perp DEXs from allPerpMetas (as /weekend-trading loads them): perp dex index, on-chain prefix, Flowscan display name, collateral token, market counts (active/delisted) and market names. Merged with the HIP-3 display-name aliases. Pass `dex` for one DEX's full list.",
      inputSchema: {
        dex: z.string().optional().describe("Prefix or display name ('xyz', 'KM'); 'main' for the native dex."),
        includeDelisted: z.boolean().optional().describe("Also list delisted market names."),
        namesLimit: z.number().int().min(0).max(500).optional().describe("Names per dex (default 40; all with `dex`)."),
      },
    },
    async (args) => {
      const [metas, sm] = await Promise.all([allPerpMetas(), spotMeta().catch(() => null)]);
      const tokenName = (i: unknown) => sm?.tokens.find((t) => t.index === i)?.name ?? (i === 0 ? "USDC" : i);
      const want = args.dex !== undefined ? dexArg(args.dex) : undefined;
      let rows = metas.map((m, idx) => {
        const prefix = idx === 0 ? "" : dexPrefixOf(m);
        const alias = DEX_ALIASES.find((d) => d.prefix === prefix || d.formerPrefixes.includes(prefix));
        const active = m.universe.filter((u) => !u.isDelisted).map((u) => String(u.name));
        const delisted = m.universe.filter((u) => u.isDelisted).map((u) => String(u.name));
        const limit = args.namesLimit ?? (want !== undefined ? 1000 : 40);
        return {
          perpDexIndex: idx,
          prefix: prefix || "(main)",
          name: idx === 0 ? "Hyperliquid" : alias?.name ?? prefix,
          ...(alias && alias.prefix !== prefix ? { note: `former prefix of ${alias.name} (now '${alias.prefix}')` } : alias?.note ? { note: alias.note } : {}),
          collateral: tokenName(m.collateralToken ?? 0),
          markets: m.universe.length,
          active: active.length,
          delisted: delisted.length,
          names: active.slice(0, limit),
          ...(active.length > limit ? { namesTruncated: active.length - limit } : {}),
          ...(args.includeDelisted ? { delistedNames: delisted.slice(0, limit) } : {}),
          _prefix: prefix,
        };
      });
      if (want !== undefined) {
        rows = rows.filter((r) => r._prefix === want);
        if (!rows.length) throw new UpstreamError(`Unknown perp dex '${args.dex}'. Known: ${metas.map((m, i) => (i === 0 ? "main" : dexPrefixOf(m))).join(", ")}`, 404, `${ENDPOINTS.info} {type:allPerpMetas}`);
      }
      const data = rows.map(({ _prefix, ...r }) => r);
      return result(upstreamEnvelope(ENDPOINTS.info, `${SITE}/weekend-trading`, data, { request: [{ type: "allPerpMetas" }, { type: "spotMeta" }], count: data.length, note: "HIP-3 asset ids are 100000 + perpDexIndex*10000 + market index." }));
    },
  );

  defineTool(
    server,
    "flowscan_validator_summaries",
    {
      title: "Validator APR, uptime, recent blocks",
      description:
        "The /validators table columns that come from Hyperliquid's validatorSummaries: per validator stake (HYPE), commission, jailed/active, recent blocks proposed, uptime % and predicted APR % for a window (day/week/month; Flowscan default week), plus average APR. For stakers/events use flowscan_validator_stakers / flowscan_staking_events.",
      inputSchema: {
        window: z.enum(["day", "week", "month"]).optional().describe("Default week."),
        sortBy: z.enum(["stake", "apr", "uptime", "commission", "recentBlocks", "name"]).optional().describe("Default stake."),
        order: z.enum(["asc", "desc"]).optional().describe("Default desc."),
        search: z.string().optional().describe("Name or address substring."),
        excludeJailed: z.boolean().optional().describe("Drop jailed validators."),
        ...shapeInput,
      },
    },
    async (args) => {
      const window = args.window ?? "week";
      const vs = await validatorSummaries();
      let rows: Rec[] = vs.map((v) => {
        const st = (v.stats as Array<[string, Rec]> | undefined)?.find(([k]) => k === window)?.[1];
        return {
          name: v.name,
          validator: v.validator,
          signer: v.signer,
          stakeHype: Number(v.stake) / 1e8,
          commissionPct: r2(Number(v.commission) * 100, 3),
          isJailed: v.isJailed,
          isActive: v.isActive,
          ...(v.unjailableAfter ? { unjailableAfter: v.unjailableAfter, unjailableAfterIso: iso(v.unjailableAfter) } : {}),
          nRecentBlocks: v.nRecentBlocks,
          uptimePct: st ? r2(Number(st.uptimeFraction) * 100, 3) : null,
          predictedAprPct: st ? r2(Number(st.predictedApr) * 100, 3) : null,
          nSamples: st?.nSamples ?? null,
        };
      });
      const all = rows;
      rows = rows.filter((r) => (matches(r.name, args.search) || matches(r.validator, args.search)) && (!args.excludeJailed || r.isJailed !== true));
      const key = { stake: "stakeHype", apr: "predictedAprPct", uptime: "uptimePct", commission: "commissionPct", recentBlocks: "nRecentBlocks", name: "name" }[(args.sortBy ?? "stake") as "stake"];
      const dir = (args.order ?? (key === "name" ? "asc" : "desc")) === "asc" ? 1 : -1;
      rows.sort((a, b) => (key === "name" ? String(a.name).localeCompare(String(b.name)) : Number(a[key] ?? -Infinity) - Number(b[key] ?? -Infinity)) * dir);
      const withApr = all.filter((r) => r.predictedAprPct !== null);
      const summary = {
        window,
        validators: all.length,
        active: all.filter((r) => r.isActive).length,
        jailed: all.filter((r) => r.isJailed).length,
        totalStakeHype: Math.round(all.reduce((s, r) => s + Number(r.stakeHype), 0)),
        avgPredictedAprPct: withApr.length ? r2(withApr.reduce((s, r) => s + Number(r.predictedAprPct), 0) / withApr.length, 3) : null,
      };
      const { items, paging } = page(rows, args, 50);
      const { rows: picked, report } = pickRows(items, args.fields);
      return result(upstreamEnvelope(ENDPOINTS.info, `${SITE}/validators`, { summary, validators: picked }, { request: { type: "validatorSummaries" }, sortedBy: `${key} ${dir === 1 ? "asc" : "desc"}`, paging, ...report }));
    },
  );

  defineTool(
    server,
    "flowscan_borrow_lend_reserves",
    {
      title: "Borrow/lend reserves (supply & borrow APY)",
      description:
        "Hyperliquid borrow/lend reserve states (allBorrowLendReserveStates, used for the Supply APY / Borrow APY columns of the address page Borrow/Lend tab): per token supply APY, borrow APY, utilization, total supplied/borrowed, available, oracle price, LTV. For one account's borrow/lend positions use flowscan_address_extras kind=borrowLend.",
      inputSchema: { token: z.string().optional().describe("Token name filter (USDC, HYPE).") },
    },
    async (args) => {
      const [reserves, sm] = await Promise.all([borrowLendReserves(), spotMeta().catch(() => null)]);
      const rows = reserves
        .map(([idx, r]) => {
          const supplied = num(r.totalSupplied);
          const px = num(r.oraclePx);
          return {
            token: sm?.tokens.find((t) => t.index === idx)?.name ?? `token ${idx}`,
            tokenIndex: idx,
            supplyApyPct: r2(Number(r.supplyYearlyRate) * 100, 3),
            borrowApyPct: r2(Number(r.borrowYearlyRate) * 100, 3),
            utilizationPct: r2(Number(r.utilization) * 100, 3),
            totalSupplied: supplied,
            totalBorrowed: num(r.totalBorrowed),
            available: num(r.balance),
            oraclePx: px,
            ltv: num(r.ltv),
            totalSuppliedUsd: supplied !== null && px !== null ? Math.round(supplied * px) : null,
          };
        })
        .filter((r) => matches(r.token, args.token));
      return result(upstreamEnvelope(ENDPOINTS.info, `${SITE}/address/{address}`, rows, { request: [{ type: "allBorrowLendReserveStates" }, { type: "spotMeta" }], shownOnNote: "Supply/Borrow APY columns of the Borrow/Lend tab.", count: rows.length }));
    },
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FlowscanError, post } from "../client.js";
import { defineTool } from "../register.js";
import { envelopeRows, isoOf, page, result, shapeInput } from "../shape.js";
import { marketCandidates } from "./perp.js";

type Rec = Record<string, unknown>;

const ROUTE = "/terminal/api/market-history";
const SHOWN_ON = "https://www.flowscan.xyz/terminal";
const HOUR_MS = 3_600_000;
const RANGE_MS = { "1d": 24 * HOUR_MS, "7d": 7 * 24 * HOUR_MS, "14d": 14 * 24 * HOUR_MS, "30d": 30 * 24 * HOUR_MS, "90d": 90 * 24 * HOUR_MS, "1y": 365 * 24 * HOUR_MS } as const;
/** fundingHistory and slippageHistory return at most 500 / 2000 rows counted from startTime, so they stop at 14d. */
const SHORT_RANGES = new Set(["1d", "7d", "14d"]);
const OI_INTERVAL_MS = { "5m": 5 * 60_000, "15m": 15 * 60_000, "30m": 30 * 60_000, "1h": HOUR_MS, "2h": 2 * HOUR_MS, "4h": 4 * HOUR_MS, "8h": 8 * HOUR_MS, "12h": 12 * HOUR_MS, "1d": 24 * HOUR_MS } as const;
const OI_DEFAULT_INTERVAL: Record<string, keyof typeof OI_INTERVAL_MS> = { "1d": "15m", "7d": "1h", "14d": "1h", "30d": "4h", "90d": "12h", "1y": "1d" };
const OI_MAX_ROWS = 3000;
const AMOUNT_USD = { "10k": 10_000, "100k": 100_000, "1m": 1_000_000 } as const;

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
};
/** Six significant digits: funding rates are ~1e-5, so fixed decimals would erase them. */
const sig = (n: number) => Number(n.toPrecision(6));
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The route wants the exact market name ('BTC', 'xyz:TSLA') and answers an unknown
 * one with 200 []. Resolve case-insensitively against the perp snapshot's market
 * list; a bare HIP-3 symbol ('TSLA') resolves when exactly one dex lists it.
 */
async function resolveCoin(q: string): Promise<{ coin: string; known: boolean; note?: string; suggestions: string[] }> {
  const typed = q.trim();
  const ql = typed.toLowerCase();
  const { exact, suggestions } = await marketCandidates(typed);
  const full = exact.find((n) => n.toLowerCase() === ql);
  const pickOne = full ?? (exact.length === 1 ? exact[0] : undefined);
  if (pickOne) return { coin: pickOne, known: true, note: pickOne !== typed ? `Coin '${typed}' resolved to '${pickOne}'.` : undefined, suggestions };
  // Rejected before any request (status/route null, like other input errors).
  if (exact.length > 1) throw new Error(`Coin '${typed}' is listed on several dexes: ${exact.join(", ")}. Pass the prefixed name.`);
  return { coin: typed, known: false, suggestions };
}

function fundingSummary(rows: Rec[]): Rec {
  const rates = rows.map((r) => r.fundingRate as number);
  const m = mean(rates);
  const minI = rates.indexOf(Math.min(...rates));
  const maxI = rates.indexOf(Math.max(...rates));
  const positive = rates.filter((x) => x > 0).length;
  return {
    count: rows.length,
    from: rows.at(-1)!.timeIso,
    to: rows[0].timeIso,
    latestRate: rates[0],
    latestTimeIso: rows[0].timeIso,
    meanHourlyRate: sig(m),
    meanHourlyRatePct: sig(m * 100),
    minRate: rates[minI],
    minTimeIso: rows[minI].timeIso,
    maxRate: rates[maxI],
    maxTimeIso: rows[maxI].timeIso,
    annualizedMeanRate: sig(m * 24 * 365),
    annualizedMeanPct: round(m * 24 * 365 * 100, 3),
    positiveHours: positive,
    shareHoursPositive: round(positive / rows.length, 4),
  };
}

function slippageSummary(rows: Rec[], amountUsd: number): Rec {
  const stats = (k: string) => {
    const xs = rows.map((r) => r[k] as number).filter((x) => typeof x === "number");
    return xs.length ? { mean: round(mean(xs)), median: round(median(xs)), max: Math.max(...xs) } : null;
  };
  const l = rows[0];
  return {
    count: rows.length,
    from: rows.at(-1)!.timeIso,
    to: l.timeIso,
    amountUsd,
    latest: { timeIso: l.timeIso, buySlippageBps: l.buySlippageBps, sellSlippageBps: l.sellSlippageBps, halfSpreadBps: l.halfSpreadBps },
    buySlippageBps: stats("buySlippageBps"),
    sellSlippageBps: stats("sellSlippageBps"),
    halfSpreadBps: stats("halfSpreadBps"),
  };
}

function oiSummary(rows: Rec[]): Rec {
  const usd = rows.map((r) => r.oiUsd as number);
  const latest = rows[0];
  const first = rows.at(-1)!;
  const minI = usd.indexOf(Math.min(...usd));
  const maxI = usd.indexOf(Math.max(...usd));
  const change = (latest.oiUsd as number) - (first.oiUsd as number);
  return {
    count: rows.length,
    from: first.timeIso,
    to: latest.timeIso,
    latest: { timeIso: latest.timeIso, oiUsd: latest.oiUsd, oiCoins: latest.oiClose },
    first: { timeIso: first.timeIso, oiUsd: first.oiUsd, oiCoins: first.oiClose },
    changeUsd: round(change, 2),
    changePct: (first.oiUsd as number) ? round((change / (first.oiUsd as number)) * 100, 2) : null,
    minUsd: usd[minI],
    minTimeIso: rows[minI].timeIso,
    maxUsd: usd[maxI],
    maxTimeIso: rows[maxI].timeIso,
  };
}

export function registerTerminalTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_market_history",
    {
      title: "Funding, slippage or open-interest history for a perp market (/terminal)",
      description:
        "/terminal history for one perp market (incl. HIP-3): kind=funding (hourly rates), slippage (bps vs mid for a market buy/sell of `amount`, ~15 min) or openInterest (per candle, coins and USD). Rows newest first with timeIso; `summary` covers the whole range (latest, mean/median/max; funding annualized; OI change, min/max). funding/slippage up to 14d, openInterest up to 1y.",
      inputSchema: {
        kind: z.enum(["funding", "slippage", "openInterest"]).describe("funding = hourly funding rate history; slippage = order-book slippage/spread history; openInterest = open interest history."),
        coin: z.string().min(1).describe("Market, e.g. 'BTC', 'xyz:TSLA' (case-insensitive; bare 'TSLA' resolves when unique)."),
        range: z.enum(["1d", "7d", "14d", "30d", "90d", "1y"]).optional().describe("Lookback from now (default 1d). 30d/90d/1y only for openInterest."),
        amount: z.enum(["10k", "100k", "1m"]).optional().describe("Slippage only: order size in USD (default 100k)."),
        interval: z.enum(["5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d"]).optional().describe("openInterest only (default by range)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const kind = args.kind as "funding" | "slippage" | "openInterest";
      const range = (args.range ?? "1d") as keyof typeof RANGE_MS;
      if (kind !== "openInterest" && !SHORT_RANGES.has(range)) throw new Error(`range '${range}' is only available for kind='openInterest'; ${kind} history goes back 14d (use 1d, 7d or 14d).`);
      if (kind !== "openInterest" && args.interval) throw new Error("interval applies only to kind='openInterest'.");
      const interval = (args.interval ?? OI_DEFAULT_INTERVAL[range]) as keyof typeof OI_INTERVAL_MS;
      if (kind === "openInterest" && RANGE_MS[range] / OI_INTERVAL_MS[interval] > OI_MAX_ROWS) {
        throw new Error(`range ${range} at interval ${interval} is over ${OI_MAX_ROWS} candles; use a larger interval (default for ${range}: ${OI_DEFAULT_INTERVAL[range]}).`);
      }
      const amountKey = (args.amount ?? "100k") as keyof typeof AMOUNT_USD;
      const amountUsd = AMOUNT_USD[amountKey];
      const { coin, known, note: resolvedNote, suggestions } = await resolveCoin(String(args.coin));
      // Minute-aligned so repeated questions within the cache TTL share one request.
      const now = Math.floor(Date.now() / 60_000) * 60_000;
      const startTime = now - RANGE_MS[range];
      const body: Rec =
        kind === "funding"
          ? { type: "fundingHistory", coin, startTime }
          : kind === "slippage"
            ? { type: "slippageHistory", coin, amount: amountUsd, startTime }
            : { type: "openInterestHistory", coin, interval, startTime, endTime: now };
      const raw = await post(ROUTE, body);
      if (!Array.isArray(raw)) throw new FlowscanError(`Unexpected response from ${ROUTE}`, null, ROUTE, raw);
      const recs = raw as Rec[];

      if (recs.length === 0 && !known) {
        throw new FlowscanError(
          `No ${kind} history for coin '${coin}' (not a market in the perp snapshot).${suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : " Use flowscan_perp_markets to list markets (HIP-3 markets are prefixed, e.g. 'xyz:TSLA')."}`,
          404,
          ROUTE,
        );
      }

      const rows: Rec[] =
        kind === "funding"
          ? recs.map((r) => ({ time: r.time, timeIso: isoOf(r.time), fundingRate: num(r.fundingRate) }))
          : kind === "slippage"
            ? recs.map((r) => ({ time: r.timestamp, timeIso: isoOf(r.timestamp), buySlippageBps: num(r.buySlippageBps), sellSlippageBps: num(r.sellSlippageBps), halfSpreadBps: num(r.halfSpreadBps) }))
            : recs.map((r) => ({ time: r.t, timeIso: isoOf(r.t), oiOpen: num(r.oiOpen), oiHigh: num(r.oiHigh), oiLow: num(r.oiLow), oiClose: num(r.oiClose), oiUsd: num(r.oiUsd) }));
      rows.sort((a, b) => Number(b.time) - Number(a.time));
      const valid = kind === "funding" ? rows.filter((r) => typeof r.fundingRate === "number") : kind === "openInterest" ? rows.filter((r) => typeof r.oiUsd === "number") : rows;
      const summary = valid.length === 0 ? null : kind === "funding" ? fundingSummary(valid) : kind === "slippage" ? slippageSummary(valid, amountUsd) : oiSummary(valid);
      const { items, paging } = page(rows, args, 100);

      const note =
        kind === "funding"
          ? "fundingRate is the hourly rate as a fraction (0.0000125 = 0.00125%/h); positive = longs pay shorts. annualized = mean hourly rate x 24 x 365 (simple, not compounded). summary covers every row in the range, not only this page."
          : kind === "slippage"
            ? "Slippage and half-spread in basis points, measured from the mid price for a market buy/sell of amountUsd (so slippage >= halfSpreadBps). summary covers every row in the range, not only this page."
            : "Open interest per candle: oiOpen/oiHigh/oiLow/oiClose in coins and oiUsd = oiClose valued at the candle's price. This is Hyperliquid's OI figure, on the same two-sided basis (long + short) as openInterest in flowscan_perp_markets; one-sided OI is half. summary covers every row in the range.";
      return result(
        envelopeRows(ROUTE, items, args.fields, {
          shownOn: SHOWN_ON,
          request: body,
          kind,
          coin,
          ...(kind === "slippage" ? { dex: recs[0]?.dex ?? null, amountUsd } : {}),
          ...(kind === "openInterest" ? { interval } : {}),
          range,
          startTimeIso: isoOf(startTime),
          ...(resolvedNote ? { resolvedNote } : {}),
          summary,
          note: rows.length === 0 ? `No ${kind} rows for '${coin}' in the last ${range}.` : note,
          paging,
        }),
      );
    },
  );
}

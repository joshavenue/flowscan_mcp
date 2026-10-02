import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { get } from "../client.js";
import { defineTool } from "../register.js";
import { envelope, isValidYmd, matches, page, pick, result, shapeInput } from "../shape.js";

type Rec = Record<string, unknown>;
const week = z
  .union([z.number().int(), z.string()])
  .optional()
  .describe("fridayCloseTs (ms) or a YYYY-MM-DD date in that weekend. Default: latest.");

/** Add an ISO twin for every *Ts millisecond field (fridayCloseTs -> fridayCloseIso). */
function withIso(o: unknown): unknown {
  if (!o || typeof o !== "object" || Array.isArray(o)) return o;
  const out: Rec = {};
  for (const [k, v] of Object.entries(o as Rec)) {
    out[k] = v;
    if (/Ts$/.test(k) && typeof v === "number" && v > 0) out[k.replace(/Ts$/, "Iso")] = new Date(v).toISOString();
  }
  return out;
}

/** Resolve the `week` argument to the fridayCloseTs the routes expect. */
async function resolveWeek(w: number | string | undefined): Promise<number | undefined> {
  if (w === undefined || w === "") return undefined;
  if (typeof w === "number") return w;
  const t = w.trim();
  if (/^\d{12,}$/.test(t)) return Number(t);
  if (!isValidYmd(t)) throw new Error(`week must be fridayCloseTs (ms) or a YYYY-MM-DD date, got '${w}'.`);
  const day = Date.parse(`${t}T00:00:00Z`);
  const weeks = ((((await get("/api/weekend/weeks")) as Rec).weeks as Rec[]) ?? []);
  const hit = weeks.find((x) => {
    const fri = Number(x.fridayCloseTs);
    const sun = Number(x.sundayCloseTs ?? fri + 3 * 86_400_000);
    const friDay = Date.parse(`${new Date(fri).toISOString().slice(0, 10)}T00:00:00Z`);
    return day >= friDay && day <= sun;
  });
  if (!hit) throw new Error(`No tracked weekend covers ${t}. Recent weekends (Friday close): ${weeks.slice(0, 6).map((x) => new Date(Number(x.fridayCloseTs)).toISOString().slice(0, 10)).join(", ")}.`);
  return Number(hit.fridayCloseTs);
}

export function registerWeekendTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_weekend_weeks",
    {
      title: "Weekend trading: available weekends & schedule",
      description:
        "The /weekend-trading selector: tracked weekends, newest first (fridayCloseTs = week id, sundayCloseTs, ISO twins, status, avg % change, risers/fallers, market count, data availability). includeSchedule adds the next ~12 weekend/holiday sessions.",
      inputSchema: { includeSchedule: z.boolean().optional().describe("Also return the upcoming session schedule (default false)."), ...shapeInput },
    },
    async (args) => {
      const weeks = (await get("/api/weekend/weeks")) as Rec;
      const list = (weeks.weeks as Rec[]) ?? [];
      const { items, paging } = page(list, args, 26);
      const out: Rec = { weeks: items.map((w) => withIso(w)) };
      if (args.includeSchedule) {
        const since = Date.now() - 7 * 86_400_000;
        const sched = (((await get("/api/weekend/schedule")) as Rec).schedule as Rec[]) ?? [];
        out.schedule = sched.filter((x) => Number(x.sessionEndTs ?? x.sundayCloseTs ?? 0) >= since).slice(0, 12).map((x) => withIso(x));
      }
      return result(envelope("/api/weekend/weeks", pick(out, args.fields), { paging }));
    },
  );

  defineTool(
    server,
    "flowscan_weekend_prices",
    {
      title: "Weekend trading: Friday close vs current/Monday prices",
      description:
        "Weekend page price table: for HIP-3 TradFi perps (e.g. 'xyz:TSLA', 'xyz:GOLD'; stocks, indices, commodities, FX), the Friday-close prices, Sunday-close prices (once the weekend is over), live current prices (during an active weekend), and weekendChanges {pct, dollar} per market, plus status and price counts.",
      inputSchema: { week, market: z.string().optional().describe("Filter by market symbol substring, e.g. 'TSLA' or 'xyz:'."), fields: shapeInput.fields },
    },
    async (args) => {
      const data = withIso(await get("/api/weekend/prices", { week: await resolveWeek(args.week) })) as Rec;
      if (args.market) {
        for (const k of Object.keys(data)) {
          const v = data[k];
          if (v && typeof v === "object" && !Array.isArray(v)) {
            const f: Rec = {};
            for (const [m, px] of Object.entries(v as Rec)) if (matches(m, args.market)) f[m] = px;
            data[k] = f;
          }
        }
      }
      return result(envelope("/api/weekend/prices", pick(data, args.fields)));
    },
  );

  defineTool(
    server,
    "flowscan_weekend_positions",
    {
      title: "Weekend trading: positioning changes since Friday close",
      description:
        "Weekend page positioning panel: per perp market (crypto and HIP-3 TradFi, ~330), long/short counts and notional at Friday close vs the latest snapshot, new/closed longs and shorts, net long/short changes, and optionally the top 5 address-level position changes per market.",
      inputSchema: {
        week,
        market: z.string().optional().describe("Filter markets by symbol substring."),
        sortBy: z.enum(["currentLongNotional", "netLongChange", "netShortChange", "newLongsCount", "newShortsCount", "currentLongs", "currentShorts"]).optional().describe("Sort markets (default currentLongNotional desc)."),
        includeTopAddressChanges: z.boolean().optional().describe("Include per-market topAddressChanges lists (default false)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const data = withIso(await get("/api/weekend/positions", { week: await resolveWeek(args.week) })) as Rec;
      const markets = (data.markets as Rec) ?? {};
      const key = args.sortBy ?? "currentLongNotional";
      let rows = Object.entries(markets)
        .filter(([m]) => matches(m, args.market))
        .map(([market, v]) => {
          const r = { market, ...(v as Rec) } as Rec;
          if (!args.includeTopAddressChanges) delete r.topAddressChanges;
          return r;
        })
        .sort((a, b) => Number(b[key] ?? 0) - Number(a[key] ?? 0));
      const { items, paging } = page(rows, args, 50);
      const { markets: _m, ...rest } = data;
      return result(envelope("/api/weekend/positions", pick({ ...rest, markets: items }, args.fields), { paging }));
    },
  );

  defineTool(
    server,
    "flowscan_weekend_coin_changes",
    {
      title: "Weekend trading: one market's history across weekends",
      description:
        "Weekend page coin drill-down: one HIP-3 TradFi market's Friday-close -> Sunday-close move (pct and dollar) for every tracked weekend, newest first. Only DEX-prefixed TradFi markets have data; a bare symbol like 'TSLA' is resolved to 'xyz:TSLA' (crypto like 'BTC' has no weekend data). Timestamps come with ISO twins.",
      inputSchema: { coin: z.string().describe("Market symbol, e.g. 'xyz:TSLA' or just 'TSLA'."), fields: shapeInput.fields },
    },
    async (args) => {
      let coin = String(args.coin).trim();
      let note: string | undefined;
      if (!coin.includes(":")) {
        // bare symbol: find the DEX-prefixed TradFi market(s) in the latest weekend prices
        const prices = (await get("/api/weekend/prices")) as Rec;
        const names = new Set<string>();
        for (const v of Object.values(prices)) if (v && typeof v === "object" && !Array.isArray(v)) for (const k of Object.keys(v as Rec)) if (k.includes(":")) names.add(k);
        const hits = [...names].filter((n) => n.split(":")[1]?.toLowerCase() === coin.toLowerCase());
        const xyz = hits.find((n) => n.startsWith("xyz:"));
        if (hits.length === 1 || xyz) {
          note = `'${coin}' resolved to '${xyz ?? hits[0]}'${hits.length > 1 ? ` (also listed: ${hits.filter((h) => h !== (xyz ?? hits[0])).join(", ")})` : ""}.`;
          coin = xyz ?? hits[0];
        }
      } else {
        const [p, sym] = coin.split(":");
        coin = `${p.toLowerCase()}:${sym.toUpperCase()}`;
      }
      const data = (await get("/api/weekend/coin-changes", { coin })) as Rec;
      const out = { ...data, ...(note ? { note } : {}), changes: Array.isArray(data.changes) ? (data.changes as Rec[]).map((c) => withIso(c)) : data.changes };
      return result(envelope("/api/weekend/coin-changes", pick(out, args.fields)));
    },
  );
}

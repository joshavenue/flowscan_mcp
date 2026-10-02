import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { get } from "../client.js";
import { defineTool } from "../register.js";
import { envelope, matches, page, pick, result, shapeInput } from "../shape.js";

type Rec = Record<string, unknown>;
const week = z.number().int().optional().describe("Week identifier = fridayCloseTs (Unix ms) from flowscan_weekend_weeks. Omit for the latest/active weekend.");

export function registerWeekendTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_weekend_weeks",
    {
      title: "Weekend trading: available weekends & schedule",
      description:
        "The /weekend-trading page selector: tracked weekends, newest first (fridayCloseTs = week id, sundayCloseTs, status, average % change, risers/fallers, market count, whether final prices / position data exist). With includeSchedule: the next ~12 weekend/holiday sessions of the calendar (session start/end, label, extended flag), starting from 7 days ago. Source: flowscan.xyz /api/weekend/weeks and /api/weekend/schedule.",
      inputSchema: { includeSchedule: z.boolean().optional().describe("Also return the upcoming session schedule (default false)."), ...shapeInput },
    },
    async (args) => {
      const weeks = (await get("/api/weekend/weeks")) as Rec;
      const list = (weeks.weeks as Rec[]) ?? [];
      const { items, paging } = page(list, args, 26);
      const out: Rec = { weeks: items };
      if (args.includeSchedule) {
        const since = Date.now() - 7 * 86_400_000;
        const sched = (((await get("/api/weekend/schedule")) as Rec).schedule as Rec[]) ?? [];
        out.schedule = sched.filter((x) => Number(x.sessionEndTs ?? x.sundayCloseTs ?? 0) >= since).slice(0, 12);
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
        "Weekend page price table: for HIP-3 TradFi perps (e.g. 'xyz:TSLA', 'xyz:GOLD'; stocks, indices, commodities, FX), the Friday-close prices, Sunday-close prices (once the weekend is over), live current prices (during an active weekend), and weekendChanges {pct, dollar} per market, plus status and price counts. Source: flowscan.xyz /api/weekend/prices.",
      inputSchema: { week, market: z.string().optional().describe("Filter by market symbol substring, e.g. 'TSLA' or 'xyz:'."), fields: shapeInput.fields },
    },
    async (args) => {
      const data = (await get("/api/weekend/prices", { week: args.week })) as Rec;
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
        "Weekend page positioning panel: per perp market (crypto and HIP-3 TradFi, ~330), long/short counts and notional at Friday close vs the latest snapshot, new/closed longs and shorts, net long/short changes, and optionally the top 5 address-level position changes per market. Source: flowscan.xyz /api/weekend/positions.",
      inputSchema: {
        week,
        market: z.string().optional().describe("Filter markets by symbol substring."),
        sortBy: z.enum(["currentLongNotional", "netLongChange", "netShortChange", "newLongsCount", "newShortsCount", "currentLongs", "currentShorts"]).optional().describe("Sort markets (default currentLongNotional desc)."),
        includeTopAddressChanges: z.boolean().optional().describe("Include per-market topAddressChanges lists (default false)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const data = (await get("/api/weekend/positions", { week: args.week })) as Rec;
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
        "Weekend page coin drill-down: one HIP-3 TradFi market's Friday-close -> Sunday-close move (pct and dollar) for every tracked weekend, newest first. Only DEX-prefixed TradFi markets have data (e.g. 'xyz:TSLA', 'xyz:GOLD'); plain symbols like 'TSLA' or crypto like 'BTC' return an empty list. Source: flowscan.xyz /api/weekend/coin-changes.",
      inputSchema: { coin: z.string().describe("DEX-prefixed market symbol, e.g. 'xyz:TSLA' (see flowscan_weekend_prices for names)."), fields: shapeInput.fields },
    },
    async (args) => {
      const data = await get("/api/weekend/coin-changes", { coin: args.coin });
      return result(envelope("/api/weekend/coin-changes", pick(data, args.fields)));
    },
  );
}

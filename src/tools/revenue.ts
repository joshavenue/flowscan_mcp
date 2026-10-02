import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { post } from "../client.js";
import { dexPrefixes } from "../dex.js";
import { defineTool } from "../register.js";
import { DATE_YMD, envelope, page, pick, result, shapeInput, tail, todayUtc } from "../shape.js";

type Rec = Record<string, unknown>;

const timeRange = {
  startDate: DATE_YMD.optional().describe("First UTC day, YYYY-MM-DD (inclusive). Alternative to startTime."),
  endDate: DATE_YMD.optional().describe("Last UTC day, YYYY-MM-DD (inclusive). Alternative to endTime."),
  startTime: z.number().int().optional().describe("Start of range as Unix milliseconds."),
  endTime: z.number().int().optional().describe("End of range as Unix milliseconds."),
  days: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe("Most recent N days (default 90 without a range)."),
};

type RangeArgs = { startDate?: string; endDate?: string; startTime?: number; endTime?: number; days?: number };

const DEFAULT_DAYS = 90;
const DAY_MS = 86_400_000;

/** Resolve startDate/endDate (UTC days) or startTime/endTime (ms) into the ms bounds the route takes. */
function msRange(args: RangeArgs): { startTime?: number; endTime?: number } {
  if (args.startDate && args.startTime !== undefined) throw new Error("Pass either startDate or startTime, not both.");
  if (args.endDate && args.endTime !== undefined) throw new Error("Pass either endDate or endTime, not both.");
  if (args.startDate && args.endDate && args.startDate > args.endDate) throw new Error(`startDate ${args.startDate} is after endDate ${args.endDate}.`);
  const startTime = args.startDate ? Date.parse(`${args.startDate}T00:00:00Z`) : args.startTime;
  const endTime = args.endDate ? Date.parse(`${args.endDate}T00:00:00Z`) + DAY_MS - 1 : args.endTime;
  if (startTime !== undefined && endTime !== undefined && startTime > endTime) throw new Error("Start of range is after its end.");
  return { startTime, endTime };
}

function body(type: string, r: { startTime?: number; endTime?: number }): Rec {
  const b: Rec = { type };
  if (r.startTime !== undefined) b.startTime = r.startTime;
  if (r.endTime !== undefined) b.endTime = r.endTime;
  return b;
}

/** Most recent N rows (default 90 unless an explicit range was requested); today's row is flagged partial. */
function recent(rows: unknown, args: RangeArgs, r: { startTime?: number; endTime?: number }): Rec[] {
  const list = Array.isArray(rows) ? (rows as Rec[]) : [];
  const n = args.days ?? (r.startTime === undefined && r.endTime === undefined ? DEFAULT_DAYS : undefined);
  const today = todayUtc();
  return tail(list, n).map((row) => (row.day === today ? { ...row, partial: true } : row));
}

const num = (v: unknown) => Number(v ?? 0) || 0;

function rangeInfo(rows: Rec[]): Rec {
  return {
    from: rows[0]?.day ?? null,
    to: rows.at(-1)?.day ?? null,
    days: rows.length,
    includesPartialToday: rows.some((r) => r.partial === true),
  };
}

export function registerRevenueTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_revenue_hypercore_fees",
    {
      title: "Daily HyperCore fee revenue (native vs HIP-3)",
      description:
        "/revenue 'Daily HyperCore Revenue' (and homepage 24h panel): one row per UTC day, oldest first (last 90 days by default; history from 2026-03): nativeHypercoreFee (non-HIP-3 markets) and hip3HypercoreFee (HIP-3 markets), USDC strings, plus rangeTotals. Range via days, startDate/endDate or startTime/endTime (ms). Today's row has partial: true. For 1/7/30-day totals use flowscan_revenue_summary.",
      inputSchema: { ...timeRange, ...shapeInput },
    },
    async (args) => {
      const r = msRange(args);
      const rows = recent(await post("/api/gossip/info", body("hypercoreFeeSummary", r)), args, r);
      const nat = rows.reduce((a, x) => a + num(x.nativeHypercoreFee), 0);
      const hip3 = rows.reduce((a, x) => a + num(x.hip3HypercoreFee), 0);
      const rangeTotals = { ...rangeInfo(rows), nativeHypercoreFeeUsdc: nat, hip3HypercoreFeeUsdc: hip3, totalHypercoreFeeUsdc: nat + hip3 };
      const { items, paging } = page(rows, args, 400);
      return result(envelope("/api/gossip/info", items.map((x) => pick(x, args.fields)), { paging, units: "USDC per day", rangeTotals }));
    },
  );

  defineTool(
    server,
    "flowscan_revenue_deployer_fees",
    {
      title: "Daily HIP-3 deployer fees by DEX",
      description:
        "/revenue 'Deployer Fees': HIP-3 deployer fees per UTC day, oldest first (last 90 days by default): totalFee and byDex [{dex, totalFee}] with on-chain names ('xyz', 'para', 'io', 'mkts', 'hyna', 'cash', 'flx', 'vntl', 'km', 'hyperliquid'), plus rangeTotals (overall and per DEX). Today's row has partial: true. USDC. Paid to deployers, so not part of Flowscan's headline protocol revenue.",
      inputSchema: { ...timeRange, dex: z.string().optional().describe("One DEX: on-chain name ('xyz') or display name ('KM' = km + mkts). Rows then have dexTotalFee and allDexTotalFee."), ...shapeInput },
    },
    async (args) => {
      const r = msRange(args);
      let rows = recent(await post("/api/gossip/info", body("deployerFeeSummary", r)), args, r);
      let dexKeys: string[] | undefined;
      if (args.dex) {
        // accept on-chain names ('xyz', 'mkts') and /hip-3 display names ('KM' -> km + mkts)
        const q = String(args.dex).trim().toLowerCase();
        dexKeys = dexPrefixes(q).length ? dexPrefixes(q) : [q];
        const keep = new Set(dexKeys);
        rows = rows.map((x) => {
          const byDex = ((x.byDex as Rec[]) ?? []).filter((d) => keep.has(String(d.dex).toLowerCase()));
          const { totalFee, ...rest } = x;
          return { ...rest, dexTotalFee: byDex.reduce((a, d) => a + num(d.totalFee), 0), allDexTotalFee: totalFee, byDex };
        });
      }
      const byDexTotals: Record<string, number> = {};
      for (const x of rows) for (const d of (x.byDex as Rec[]) ?? []) byDexTotals[String(d.dex)] = (byDexTotals[String(d.dex)] ?? 0) + num(d.totalFee);
      const rangeTotals = {
        ...rangeInfo(rows),
        ...(dexKeys
          ? { dex: dexKeys, totalFeeUsdc: Object.values(byDexTotals).reduce((a, x) => a + x, 0), allDexTotalFeeUsdc: rows.reduce((a, x) => a + num(x.allDexTotalFee), 0) }
          : { totalFeeUsdc: rows.reduce((a, x) => a + num(x.totalFee), 0) }),
        byDex: Object.fromEntries(Object.entries(byDexTotals).sort((x, y) => y[1] - x[1])),
      };
      const { items, paging } = page(rows, args, 400);
      return result(envelope("/api/gossip/info", items.map((x) => pick(x, args.fields)), { paging, units: "USDC per day", rangeTotals }));
    },
  );

  defineTool(
    server,
    "flowscan_revenue_priority_gas",
    {
      title: "Daily priority gas (write/read) with top users",
      description:
        "Revenue page 'Daily Priority Gas' chart and 'Top Users' table: per UTC day (oldest first, last 90 days by default), writePriority and readPriority {totalGas (HYPE), count} and, with includeTopUsers, the top 5 gas-paying users per day, plus rangeTotals. Today's row is flagged partial: true.",
      inputSchema: {
        ...timeRange,
        includeTopUsers: z.boolean().optional().describe("Include per-day topUsers lists (default false to keep output small)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const r = msRange(args);
      let rows = recent(await post("/api/gossip/info", body("priorityGasSummary", r)), args, r);
      const side = (k: string) => rows.reduce((a, x) => a + num((x[k] as Rec | undefined)?.totalGas), 0);
      const rangeTotals = { ...rangeInfo(rows), writePriorityGasHype: side("writePriority"), readPriorityGasHype: side("readPriority"), totalGasHype: side("writePriority") + side("readPriority") };
      if (!args.includeTopUsers) {
        rows = rows.map((r) => {
          const out: Rec = {};
          for (const [k, v] of Object.entries(r)) {
            if (v && typeof v === "object" && !Array.isArray(v)) {
              const { topUsers: _t, ...rest } = v as Rec;
              out[k] = rest;
            } else out[k] = v;
          }
          return out;
        });
      }
      const { items, paging } = page(rows, args, 400);
      return result(envelope("/api/gossip/info", items.map((x) => pick(x, args.fields)), { paging, units: "HYPE gas per day", rangeTotals }));
    },
  );

  defineTool(
    server,
    "flowscan_revenue_summary",
    {
      title: "Revenue summary (last 1 / 7 / 30 complete days)",
      description:
        "Convenience aggregate of the /revenue page and the homepage '24h Revenue' card: sums native HyperCore fees (USDC), HIP-3 HyperCore fees (USDC), their sum totalUsdcExcludingGas, HIP-3 deployer fees (USDC, paid to deployers, not protocol revenue) and priority gas (HYPE) over the last 1, 7 and 30 complete UTC days, plus the current (partial) UTC day separately and an annualized run-rate from the trailing 7 complete days. Computed from the three /api/gossip/info series on flowscan.xyz.",
      inputSchema: { fields: shapeInput.fields },
    },
    async (args) => {
      const [core, deployer, gas] = (await Promise.all([
        post("/api/gossip/info", { type: "hypercoreFeeSummary" }),
        post("/api/gossip/info", { type: "deployerFeeSummary" }),
        post("/api/gossip/info", { type: "priorityGasSummary" }),
      ])) as [Rec[], Rec[], Rec[]];
      const num = (v: unknown) => Number(v ?? 0) || 0;
      const gasTotal = (r: Rec) => Object.values(r).reduce<number>((a, v) => (v && typeof v === "object" && "totalGas" in (v as Rec) ? a + num((v as Rec).totalGas) : a), 0);
      const today = todayUtc();
      const dayOffset = (n: number) => {
        const d = new Date(`${today}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - n);
        return d.toISOString().slice(0, 10);
      };
      const lastComplete = dayOffset(1);
      const sumRange = (rows: Rec[], from: string, to: string, f: (r: Rec) => number) => {
        let total = 0;
        let days = 0;
        for (const r of Array.isArray(rows) ? rows : []) {
          const day = String(r.day ?? "");
          if (day >= from && day <= to) {
            total += f(r);
            days++;
          }
        }
        return { total, days };
      };
      const windows = [1, 7, 30].map((n) => {
        const from = dayOffset(n);
        const nat = sumRange(core, from, lastComplete, (r) => num(r.nativeHypercoreFee));
        const hip3 = sumRange(core, from, lastComplete, (r) => num(r.hip3HypercoreFee));
        const dep = sumRange(deployer, from, lastComplete, (r) => num(r.totalFee));
        const g = sumRange(gas, from, lastComplete, gasTotal);
        return {
          days: n,
          from,
          to: lastComplete,
          nativeHypercoreFeeUsdc: nat.total,
          hip3HypercoreFeeUsdc: hip3.total,
          totalHypercoreFeeUsdc: nat.total + hip3.total,
          totalUsdcExcludingGas: nat.total + hip3.total,
          deployerFeeUsdc: dep.total,
          priorityGasHype: g.total,
          daysWithData: { hypercoreFees: nat.days, deployerFees: dep.days, priorityGas: g.days },
        };
      });
      const w7 = windows[1];
      const todayRow = (rows: Rec[]) => (Array.isArray(rows) ? rows.find((r) => r.day === today) : undefined);
      const tc = todayRow(core);
      const td = todayRow(deployer);
      const tg = todayRow(gas);
      const out = {
        latestCompleteDay: lastComplete,
        windows,
        currentDayPartial: {
          day: today,
          nativeHypercoreFeeUsdc: tc ? num(tc.nativeHypercoreFee) : null,
          hip3HypercoreFeeUsdc: tc ? num(tc.hip3HypercoreFee) : null,
          deployerFeeUsdc: td ? num(td.totalFee) : null,
          priorityGasHype: tg ? gasTotal(tg) : null,
        },
        annualizedFrom7d: {
          nativeHypercoreFeeUsdc: (w7.nativeHypercoreFeeUsdc / 7) * 365,
          hip3HypercoreFeeUsdc: (w7.hip3HypercoreFeeUsdc / 7) * 365,
          totalHypercoreFeeUsdc: (w7.totalHypercoreFeeUsdc / 7) * 365,
          deployerFeeUsdc: (w7.deployerFeeUsdc / 7) * 365,
        },
        note: "Days are UTC. Flowscan's headline 'Combined' protocol revenue = native HyperCore fees + HIP-3 HyperCore fees (totalUsdcExcludingGas, USDC) + priority gas converted at the live HYPE price. Priority gas here is in HYPE and is NOT converted: the HYPE/USD price is not available from Flowscan's routes and this server does not fetch it, so report gas separately in HYPE. HIP-3 deployer fees go to DEX deployers and are excluded from (not part of) that headline total.",
      };
      return result(envelope("/api/gossip/info", pick(out, args.fields)));
    },
  );
}

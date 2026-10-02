import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { post } from "../client.js";
import { defineTool } from "../register.js";
import { envelope, page, pick, result, shapeInput, tail } from "../shape.js";

type Rec = Record<string, unknown>;

const timeRange = {
  startTime: z.number().int().optional().describe("Start of range as Unix milliseconds (optional)."),
  endTime: z.number().int().optional().describe("End of range as Unix milliseconds (optional)."),
  days: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe("Only the most recent N days (default 90 when no startTime/endTime is given). The last row is the current UTC day, still accumulating."),
};

const DEFAULT_DAYS = 90;

function body(type: string, args: { startTime?: number; endTime?: number }): Rec {
  const b: Rec = { type };
  if (args.startTime !== undefined) b.startTime = args.startTime;
  if (args.endTime !== undefined) b.endTime = args.endTime;
  return b;
}

/** Most recent N rows; default 90 unless an explicit time range was requested. */
function recent<T>(rows: unknown, args: { days?: number; startTime?: number; endTime?: number }): T[] {
  const list = Array.isArray(rows) ? (rows as T[]) : [];
  const n = args.days ?? (args.startTime === undefined && args.endTime === undefined ? DEFAULT_DAYS : undefined);
  return tail(list, n);
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

export function registerRevenueTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_revenue_hypercore_fees",
    {
      title: "Daily HyperCore fee revenue (native vs HIP-3)",
      description:
        "The /revenue page 'Daily HyperCore Revenue' chart and the homepage '24h Revenue' panel. One row per UTC day (oldest first, last 90 days by default, history from 2026-03): nativeHypercoreFee (HyperCore fees from native, non-HIP-3 markets) and hip3HypercoreFee (HyperCore fees from HIP-3 DEX markets), both USDC strings. The last row is the current, still-accumulating day. For window totals use flowscan_revenue_summary. Source: flowscan.xyz /api/gossip/info {type:'hypercoreFeeSummary'}.",
      inputSchema: { ...timeRange, ...shapeInput },
    },
    async (args) => {
      const rows = recent<Rec>(await post("/api/gossip/info", body("hypercoreFeeSummary", args)), args);
      const { items, paging } = page(rows, args, 400);
      return result(envelope("/api/gossip/info", items.map((r) => pick(r, args.fields)), { paging, units: "USDC per day" }));
    },
  );

  defineTool(
    server,
    "flowscan_revenue_deployer_fees",
    {
      title: "Daily HIP-3 deployer fees by DEX",
      description:
        "Revenue page 'Deployer Fees' chart: fees earned by HIP-3 perp DEX deployers per UTC day (oldest first, last 90 days by default): totalFee plus byDex [{dex, totalFee}] with lowercase deployer DEX names such as 'xyz', 'para', 'io', 'mkts', 'hyperliquid'. USDC. Source: flowscan.xyz /api/gossip/info {type:'deployerFeeSummary'}.",
      inputSchema: { ...timeRange, dex: z.string().optional().describe("Only keep this DEX in byDex (exact, case-insensitive, e.g. 'xyz')."), ...shapeInput },
    },
    async (args) => {
      let rows = recent<Rec>(await post("/api/gossip/info", body("deployerFeeSummary", args)), args);
      if (args.dex) rows = rows.map((r) => ({ ...r, byDex: ((r.byDex as Rec[]) ?? []).filter((d) => String(d.dex).toLowerCase() === args.dex!.toLowerCase()) }));
      const { items, paging } = page(rows, args, 400);
      return result(envelope("/api/gossip/info", items.map((r) => pick(r, args.fields)), { paging, units: "USDC per day" }));
    },
  );

  defineTool(
    server,
    "flowscan_revenue_priority_gas",
    {
      title: "Daily priority gas (write/read) with top users",
      description:
        "Revenue page 'Daily Priority Gas' chart and 'Top Users' table: per UTC day (oldest first, last 90 days by default), writePriority and readPriority {totalGas (HYPE), count} and, with includeTopUsers, the top 5 gas-paying users per day. Source: flowscan.xyz /api/gossip/info {type:'priorityGasSummary'}.",
      inputSchema: {
        ...timeRange,
        includeTopUsers: z.boolean().optional().describe("Include per-day topUsers lists (default false to keep output small)."),
        ...shapeInput,
      },
    },
    async (args) => {
      let rows = recent<Rec>(await post("/api/gossip/info", body("priorityGasSummary", args)), args);
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
      return result(envelope("/api/gossip/info", items.map((r) => pick(r, args.fields)), { paging, units: "HYPE gas per day" }));
    },
  );

  defineTool(
    server,
    "flowscan_revenue_summary",
    {
      title: "Revenue summary (last 1 / 7 / 30 complete days)",
      description:
        "Convenience aggregate of the /revenue page and the homepage '24h Revenue' card: sums native HyperCore fees (USDC), HIP-3 HyperCore fees (USDC), HIP-3 deployer fees (USDC) and priority gas (HYPE) over the last 1, 7 and 30 complete UTC days, plus the current (partial) UTC day separately and an annualized run-rate from the trailing 7 complete days. Computed from the three /api/gossip/info series on flowscan.xyz.",
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
        note: "Days are UTC. Priority gas is denominated in HYPE, fees in USDC; Flowscan's 'Combined' line converts gas to USD at the live HYPE price, which this server does not fetch.",
      };
      return result(envelope("/api/gossip/info", pick(out, args.fields)));
    },
  );
}

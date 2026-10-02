/**
 * Ground truth for the numeric prompts whose answer is cheap to compute: calls
 * the tools directly through the MCP client (scripts/qa/lib.ts Harness) and
 * writes results/<run-id>/groundtruth-<label>.json. Run it right before and
 * right after the agent run; report.ts accepts the agent's figure if it matches
 * either snapshot within tolerance (1% for live data).
 *
 *   npx tsx scripts/eval/groundtruth.ts --run-id full --label before
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Harness } from "../qa/lib.js";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n: string, d?: string) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : d);
const runId = opt("run-id", "adhoc")!;
const label = opt("label", "before")!;

export interface GT {
  value: number | string;
  kind: "number" | "name";
  tol?: number; // relative tolerance for numbers
  alt?: (number | string)[]; // other acceptable values (e.g. one-sided OI, other spellings)
  how: string;
}

const h = new Harness();
await h.start();
const gt: Record<string, GT> = {};
const call = async (t: string, a: Record<string, unknown>) => {
  const r = await h.call(t, a);
  if (r.isError || !r.json) throw new Error(`${t} failed: ${r.text.slice(0, 300)}`);
  return r.json;
};
const safe = async (key: string, f: () => Promise<GT>) => {
  try {
    gt[key] = await f();
  } catch (e) {
    console.error(`GT ${key} failed: ${(e as Error).message}`);
  }
};

await safe("fomo45_big", async () => {
  const j = await call("flowscan_builder_revenue", { builder: "0x2a2b6b093a9813fbd8cddae800c3d17d46460d17", days: 45, limit: 1 });
  return { value: j.data.totalRevenueUsd, kind: "number", tol: 0.01, how: `builder_revenue big fomo days=45 ${j.data.range.startDate}..${j.data.range.endDate}` };
});
await safe("fomo45_small", async () => {
  const j = await call("flowscan_builder_revenue", { builder: "id:fomo", days: 45, limit: 1 });
  return { value: j.data.totalRevenueUsd, kind: "number", tol: 0.01, how: `builder_revenue id:fomo days=45 ${j.data.range.startDate}..${j.data.range.endDate}` };
});
await safe("lb_top30d_name", async () => {
  const j = await call("flowscan_builders_leaderboard", { metric: "revenue", window: "30d", limit: 1 });
  const b = j.data.builders[0];
  return { value: b.name, kind: "name", alt: [b.id], how: `leaderboard revenue 30d #1 = ${b.name} (${b.value})` };
});
await safe("lb_top_alltime_name", async () => {
  const j = await call("flowscan_builders_leaderboard", { metric: "revenue", window: "all_time", limit: 1 });
  const b = j.data.builders[0];
  return { value: b.name, kind: "name", alt: [b.id], how: `leaderboard revenue all_time #1 = ${b.name} (${b.value})` };
});
await safe("builders_alltime_revenue", async () => {
  const j = await call("flowscan_builders_summary", { limit: 1 });
  return { value: j.data.totals.revenue, kind: "number", tol: 0.01, how: "builders_summary totals.revenue" };
});
await safe("rev_1d_usdc", async () => {
  const j = await call("flowscan_revenue_summary", {});
  const w = j.data.windows.find((x: any) => x.days === 1);
  return { value: w.totalUsdcExcludingGas, kind: "number", tol: 0.01, how: `revenue_summary 1d ${w.from} totalUsdcExcludingGas` };
});
await safe("rev_7d_usdc", async () => {
  const j = await call("flowscan_revenue_summary", {});
  const w = j.data.windows.find((x: any) => x.days === 7);
  return { value: w.totalUsdcExcludingGas, kind: "number", tol: 0.01, how: `revenue_summary 7d ${w.from}..${w.to} totalUsdcExcludingGas` };
});
await safe("rev_sep_usdc", async () => {
  const j = await call("flowscan_revenue_hypercore_fees", { startDate: "2026-09-01", endDate: "2026-09-30", limit: 1 });
  return { value: j.rangeTotals.totalHypercoreFeeUsdc, kind: "number", tol: 0.01, how: "hypercore_fees 2026-09 rangeTotals.totalHypercoreFeeUsdc" };
});
await safe("deployer_top30d", async () => {
  const j = await call("flowscan_revenue_deployer_fees", { days: 30, limit: 1 });
  const [dex] = Object.entries(j.rangeTotals.byDex as Record<string, number>).sort((a, b) => b[1] - a[1])[0];
  return { value: dex, kind: "name", alt: dex === "xyz" ? ["XYZ"] : [], how: `deployer_fees 30d top dex ${dex}` };
});
await safe("total_staked", async () => {
  const j = await call("flowscan_staking_overview", { limit: 1 });
  return { value: Number(j.data.total_staked), kind: "number", tol: 0.01, how: "staking_overview total_staked" };
});
await safe("validator_count", async () => {
  const j = await call("flowscan_staking_overview", { limit: 1 });
  return { value: j.data.validator_count, kind: "number", tol: 0, how: "staking_overview validator_count" };
});
await safe("delegator_count", async () => {
  const j = await call("flowscan_staking_overview", { limit: 1 });
  return { value: j.data.delegator_count, kind: "number", tol: 0.01, how: "staking_overview delegator_count" };
});
await safe("peers_nodes", async () => {
  const j = await call("flowscan_peers", {});
  return { value: j.data.meta.nodeCount, kind: "number", tol: 0.05, how: `peers meta.nodeCount crawledAt ${j.data.meta.crawledAt}` };
});
await safe("hip3_top_oi_dex", async () => {
  const j = await call("flowscan_hip3_overview", { fields: ["market_share"] });
  const [name] = Object.entries(j.data.market_share as Record<string, any>).sort((a, b) => b[1].oi - a[1].oi)[0];
  return { value: name, kind: "name", how: `hip3_overview market_share max oi = ${name}` };
});
await safe("spot_markets", async () => {
  const j = await call("flowscan_spot_stocks", { fields: ["summary"] });
  return { value: j.data.summary.totalMarkets, kind: "number", tol: 0, how: "spot_stocks summary.totalMarkets" };
});
await safe("spot_value_usd", async () => {
  const j = await call("flowscan_spot_stocks", { fields: ["summary"] });
  return { value: j.data.summary.valueUsd, kind: "number", tol: 0.02, how: "spot_stocks summary.valueUsd" };
});
await safe("btc_top_long_notional", async () => {
  const j = await call("flowscan_perp_positions", { market: "BTC", side: "long", limit: 1 });
  const p = j.data.positions[0];
  return { value: p.notionalSize, kind: "number", tol: 0.01, how: `perp_positions BTC long #1 ${p.address} @ ${j.data.snapshotIso}` };
});
await safe("eth_top_short_notional", async () => {
  const j = await call("flowscan_perp_positions", { market: "ETH", side: "short", limit: 1 });
  const p = j.data.positions[0];
  return { value: p.notionalSize, kind: "number", tol: 0.01, how: `perp_positions ETH short #1 ${p.address} @ ${j.data.snapshotIso}` };
});
await safe("eth_oi", async () => {
  const j = await call("flowscan_perp_markets", { market: "ETH" });
  const m = j.data.markets[0];
  return { value: m.openInterest, kind: "number", tol: 0.01, alt: [m.openInterest / 2], how: `perp_markets ETH openInterest (two-sided; half accepted) @ ${j.data.snapshotIso}` };
});
await safe("top_oi_market", async () => {
  const j = await call("flowscan_perp_markets", { sortBy: "openInterest", limit: 1 });
  const m = j.data.markets[0];
  return { value: m.market, kind: "name", how: `perp_markets sortBy openInterest #1 = ${m.market} (${m.openInterest})` };
});
await safe("stablecoin_total", async () => {
  const j = await call("flowscan_stablecoin_margin", {});
  return { value: j.data.summary.total_value, kind: "number", tol: 0.01, how: "stablecoin_margin summary.total_value" };
});
await h.stop();

const outDir = path.join(EVAL_DIR, "results", runId);
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `groundtruth-${label}.json`);
fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), gt }, null, 1));
console.log(`wrote ${file} (${Object.keys(gt).length} keys)`);
for (const [k, v] of Object.entries(gt)) console.log(`  ${k}: ${v.value}  (${v.how})`);

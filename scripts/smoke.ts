/**
 * End-to-end smoke test against the LIVE www.flowscan.xyz.
 *
 * Spawns the built server (`node dist/index.js`) over stdio with the MCP SDK
 * client, lists the tools and calls every one of them at least once with
 * realistic arguments. Fails (exit 1) if any tool is untested, returns an
 * unexpected error, returns text that is not JSON (or truncated JSON with the
 * TRUNCATED marker), is truncated on a call that should fit, or fails a
 * tool-specific sanity check.
 *
 * Usage: npm run build && npm run smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Json = any;
type Case = {
  tool: string;
  args: Record<string, unknown> | (() => Record<string, unknown>);
  /** Expect isError=true (e.g. input validation). */
  expectError?: boolean;
  /** Allow the TRUNCATED marker (only for calls that deliberately ask for a lot). */
  allowTruncate?: boolean;
  /** Extra assertions on the parsed JSON; throw or return a string to fail. */
  check?: (data: Json) => string | void;
  label?: string;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRUNC_MARKER = "[TRUNCATED:";
const CALL_TIMEOUT_MS = 180_000;

// Live test values (Hyperliquid mainnet).
const VAULT = "0x010461c14e146ac35fe42271bdc1134ee31c703a";
const VALIDATOR = "0xa82fe73bbd768bc15d1ef2f6142a21ff8bd762ad";
const PVP_BUILDER = "0x0cbf655b0d22ae71fba3a674b0e1c0c7e7f975af";
const FOMO_SOCIAL = "0x2a2b6b093a9813fbd8cddae800c3d17d46460d17";
const WEEK = 1789761600000;
const DAY = 86_400_000;

const hip4: { outcomeId?: number; yesAssetId?: string; noAssetId?: string } = {};
const builderRevenue: Record<string, Json> = {};

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const cases: Case[] = [
  { tool: "flowscan_coverage", args: {}, check: (d) => assert(Array.isArray(d.pages) && d.pages.length > 5, "pages missing") },
  { tool: "flowscan_coverage", label: "topic", args: { topic: "builders" }, check: (d) => assert(d.pages.length >= 1, "topic filter returned nothing") },

  // network
  { tool: "flowscan_stablecoin_margin", args: {}, check: (d) => assert(d.data.summary.total_value > 0, "no stablecoin total") },
  { tool: "flowscan_peers", args: {}, check: (d) => assert(d.data.meta.nodeCount > 0 && d.data.sentries.length > 0, "no peers") },
  { tool: "flowscan_peers", label: "nodes JP", args: { section: "nodes", country: "JP", state: "full", limit: 20 }, check: (d) => assert(d.data.nodes.length > 0, "no JP full nodes") },
  { tool: "flowscan_peers", label: "edges", args: { section: "edges", limit: 50 }, check: (d) => assert(d.data.edges.length === 50, "edges") },
  { tool: "flowscan_peers", label: "nodes US exact", args: { section: "nodes", country: "US", limit: 200 }, check: (d) => assert(d.data.nodes.every((n: Json) => n.geo?.cc === "US"), "country filter not exact") },
  {
    tool: "flowscan_peers",
    label: "forced structured truncation",
    args: { section: "all", limit: 1000 },
    allowTruncate: true,
    check: (d) => assert(Array.isArray(d._truncated) && d._truncated.length > 0 && /TRUNCATED/.test(d._truncatedNote), "expected structured truncation metadata"),
  },
  { tool: "flowscan_peers", label: "all", args: { section: "all" }, check: (d) => assert(d.nodesPaging && d.data.nodes.length <= 50, "all not paged") },
  { tool: "flowscan_staking_overview", args: { limit: 10 }, check: (d) => assert(d.data.validators.length === 10 && Number(d.data.total_staked) > 0, "validators") },
  {
    tool: "flowscan_validator_stakers",
    args: { validator: VALIDATOR, limit: 20 },
    check: (d) => {
      assert(d.data.stakers.length === 20, "stakers list empty");
      assert(Number(d.data.stakers[0].amount) >= Number(d.data.stakers[19].amount), "stakers not sorted");
      assert(d.paging.total > 100, "expected thousands of stakers");
    },
  },
  { tool: "flowscan_staking_events", args: { validator: VALIDATOR, limit: 20 }, check: (d) => assert(d.data.length === 20 && d.data[0].timeIso, "events") },
  { tool: "flowscan_staking_events", label: "by name", args: { validator: "Hyper Foundation 2", limit: 3 }, check: (d) => assert(d.validator === VALIDATOR, "name not resolved") },
  { tool: "flowscan_validator_stakers", label: "by name", args: { validator: "hyper foundation 2", limit: 3 }, check: (d) => assert(d.data.address === VALIDATOR, "name not resolved") },
  {
    tool: "flowscan_staking_overview",
    label: "cheapest active",
    args: { sortBy: "commission_bps", order: "asc", excludeJailed: true, limit: 5 },
    check: (d) => assert(d.data.validators.every((v: Json) => !v.is_jailed && !("description" in v)) && d.data.validators[0].commission_bps <= d.data.validators[4].commission_bps, "asc/jailed"),
  },

  // revenue
  { tool: "flowscan_revenue_hypercore_fees", args: { days: 14 }, check: (d) => assert(d.data.length === 14 && d.data[0].nativeHypercoreFee && d.data.at(-1).partial === true && d.rangeTotals.totalHypercoreFeeUsdc > 0, "core fees") },
  { tool: "flowscan_revenue_hypercore_fees", label: "range", args: { startTime: Date.now() - 6 * DAY, endTime: Date.now() - 2 * DAY }, check: (d) => assert(d.data.length >= 3, "range") },
  {
    tool: "flowscan_revenue_deployer_fees",
    args: { days: 7, dex: "xyz" },
    check: (d) => assert(d.data.every((r: Json) => r.byDex.every((x: Json) => x.dex === "xyz") && "allDexTotalFee" in r && !("totalFee" in r)) && d.rangeTotals.totalFeeUsdc > 0, "dex filter"),
  },
  {
    tool: "flowscan_revenue_deployer_fees",
    label: "September by date, KM alias",
    args: { startDate: "2026-09-01", endDate: "2026-09-30", dex: "KM" },
    check: (d) => assert(d.data.length === 30 && d.data[0].day === "2026-09-01" && d.rangeTotals.dex.includes("mkts"), "date range / alias"),
  },
  { tool: "flowscan_revenue_priority_gas", args: { days: 7 }, check: (d) => assert(d.data.length === 7 && !d.data[0].writePriority.topUsers, "gas") },
  { tool: "flowscan_revenue_priority_gas", label: "topUsers", args: { days: 2, includeTopUsers: true }, check: (d) => assert(Array.isArray(d.data[0].writePriority.topUsers), "topUsers") },
  {
    tool: "flowscan_revenue_summary",
    args: {},
    check: (d) => {
      const w = d.data.windows;
      assert(w.length === 3 && w[0].days === 1 && w[2].days === 30, "windows");
      assert(w[0].nativeHypercoreFeeUsdc > 0 && w[2].nativeHypercoreFeeUsdc > w[1].nativeHypercoreFeeUsdc, "window sums not increasing");
      assert(w[2].daysWithData.hypercoreFees === 30, "30d window should have 30 days of data");
    },
  },

  // perp snapshot
  { tool: "flowscan_perp_markets", args: { limit: 10 }, check: (d) => assert(d.data.markets.length === 10, "markets") },
  { tool: "flowscan_perp_markets", label: "xyz:", args: { market: "xyz:", sortBy: "totalPositions", limit: 5 }, check: (d) => assert(d.data.markets.every((m: Json) => m.market.startsWith("xyz:")), "xyz filter") },
  { tool: "flowscan_perp_positions", args: { market: "BTC", limit: 10 }, check: (d) => assert(d.data.positions.length === 10 && d.data.filteredSummary && d.data.snapshotIso, "BTC positions") },
  { tool: "flowscan_perp_positions", label: "bare TSLA", args: { market: "TSLA", limit: 2 }, check: (d) => assert(d.data.market === "xyz:TSLA", "TSLA not resolved") },
  { tool: "flowscan_perp_positions", label: "unknown market", args: { market: "NOPE_NOT_A_MARKET" }, expectError: true },
  {
    tool: "flowscan_perp_positions",
    label: "filters",
    args: { market: "xyz:TSLA", side: "short", minNotional: 10000, limit: 5, page: 1 },
    check: (d) => assert(d.data.positions.every((p: Json) => p.side === "short" && p.notionalSize >= 10000), "filters ignored"),
  },
  { tool: "flowscan_address_perp_positions", args: { address: VAULT, limit: 10 }, check: (d) => assert(d.data.positions.length === 10 && d.data.totalPositions > 10, "address positions") },

  // address
  {
    tool: "flowscan_address_summary",
    args: { address: VAULT },
    check: (d) => {
      assert(d.data.role?.role, "role missing");
      assert(d.data.pnlSummary?.totalPnl !== undefined, "pnl missing");
      assert(d.data.perpState.positions.length > 0, "no positions for test vault");
      assert(Number(d.data.perpState.marginSummary.accountValue) > 0, "no account value");
    },
  },
  { tool: "flowscan_address_summary", label: "dex xyz", args: { address: VAULT, include: ["perpState"], dex: "xyz" }, check: (d) => assert(d.data.perpState.dex === "xyz", "dex") },
  { tool: "flowscan_address_summary", label: "dex KM alias", args: { address: VAULT, include: ["perpState"], dex: "KM" }, check: (d) => assert(d.data.perpState.dex === "mkts", "alias") },
  { tool: "flowscan_address_summary", label: "unknown dex", args: { address: VAULT, include: ["perpState"], dex: "nope" }, expectError: true },
  { tool: "flowscan_address_orders", args: { address: VAULT, limit: 20 }, check: (d) => assert(d.data.length > 0 && d.paging.rowsReturned > 0, "no open orders") },
  { tool: "flowscan_address_orders", label: "openDetailed", args: { address: VAULT, kind: "openDetailed", limit: 10 } },
  { tool: "flowscan_address_orders", label: "historical", args: { address: VAULT, kind: "historical", limit: 20 }, check: (d) => assert(d.data.length === 20 && d.data[0].status && d.coveredRange, "historical") },
  { tool: "flowscan_address_fills", args: { address: VAULT, limit: 20 }, check: (d) => assert(d.data.length === 20 && d.data[0].time >= d.data[19].time, "fills newest first") },
  { tool: "flowscan_address_fills", label: "range", args: { address: VAULT, startTime: Date.now() - 2 * 3600_000, limit: 10 }, check: (d) => assert("capped" in d, "range meta") },
  { tool: "flowscan_address_ledger", args: { address: VAULT, limit: 20 } },
  { tool: "flowscan_address_ledger", label: "funding", args: { address: VAULT, kind: "funding", startTime: Date.now() - 6 * 3600_000, limit: 20 }, check: (d) => assert(d.data.length > 0, "funding") },
  { tool: "flowscan_address_staking", args: { address: VAULT } },
  {
    tool: "flowscan_address_staking",
    label: "staker",
    args: { address: "0xa7904a48ffba1c48146d083737a04db369d3b7a0", historyLimit: 2 },
    check: (d) => assert(d.data.delegations.length > 0 && d.data.delegations.every((x: Json) => typeof x.validatorName === "string") && d.data.totalDelegatedHype > 0, "staking join"),
  },
  { tool: "flowscan_address_vaults_subaccounts", args: { address: VAULT } },
  { tool: "flowscan_address_extras", args: { address: VAULT, kind: "rateLimit" }, check: (d) => assert(d.data.nRequestsCap, "rateLimit") },
  { tool: "flowscan_address_extras", label: "approvedBuilders", args: { address: VAULT, kind: "approvedBuilders" } },
  { tool: "flowscan_address_extras", label: "borrowLend", args: { address: VAULT, kind: "borrowLend" } },
  { tool: "flowscan_address_extras", label: "twapSliceFills", args: { address: VAULT, kind: "twapSliceFills" } },
  { tool: "flowscan_address_summary", label: "bad address", args: { address: "0x123" }, expectError: true },

  // spot stocks
  { tool: "flowscan_spot_stocks", args: {}, check: (d) => assert(d.data.summary.totalMarkets > 0 && d.data.by_token.NVDAX, "spot current") },
  { tool: "flowscan_spot_stocks", label: "timeseries", args: { section: "timeseries", token: "NVDA", days: 7 }, check: (d) => assert(d.data.timeseries.length === 7, "timeseries") },
  { tool: "flowscan_spot_stocks", label: "liquidity", args: { section: "liquidity", token: "NVDAX" }, check: (d) => assert(d.data.NVDAX?.latest, "liquidity") },
  { tool: "flowscan_spot_stocks", label: "liquidity all", args: { section: "liquidity" } },
  { tool: "flowscan_spot_stocks", label: "topHolders", args: { section: "topHolders", token: "NVDAX", limit: 5 }, check: (d) => assert(d.data.NVDAX.holders.length === 5, "holders") },
  { tool: "flowscan_spot_stocks", label: "topHolders all", args: { section: "topHolders" } },

  // weekend
  { tool: "flowscan_weekend_weeks", args: { limit: 5, includeSchedule: true }, check: (d) => assert(d.data.weeks.length === 5 && Array.isArray(d.data.schedule), "weeks") },
  { tool: "flowscan_weekend_prices", args: { week: WEEK, market: "TSLA" }, check: (d) => assert(Object.keys(d.data.fridayClosePrices).length > 0, "prices") },
  { tool: "flowscan_weekend_prices", label: "latest", args: {} },
  { tool: "flowscan_weekend_positions", args: { week: WEEK, limit: 10 }, check: (d) => assert(d.data.markets.length === 10, "positions") },
  { tool: "flowscan_weekend_positions", label: "top changes", args: { market: "xyz:TSLA", includeTopAddressChanges: true }, check: (d) => assert(d.data.markets[0]?.topAddressChanges, "top changes") },
  { tool: "flowscan_weekend_coin_changes", args: { coin: "xyz:TSLA" }, check: (d) => assert(d.data.changes.length > 0 && d.data.changes[0].fridayCloseIso, "coin changes") },
  { tool: "flowscan_weekend_coin_changes", label: "bare TSLA", args: { coin: "TSLA" }, check: (d) => assert(d.data.coin === "xyz:TSLA" && d.data.changes.length > 0, "bare symbol") },
  { tool: "flowscan_weekend_prices", label: "week as date", args: { week: "2026-09-19", market: "TSLA" }, check: (d) => assert(d.data.fridayCloseTs === WEEK, "date week") },

  // HIP-4
  {
    tool: "flowscan_hip4_markets",
    args: { limit: 30 },
    check: (d) => {
      const rows = d.data.activeOutcomes as Json[];
      assert(rows.length > 0, "no active outcomes");
      const withCandles = rows.find((r) => r.totalVolume > 0) ?? rows[0];
      hip4.outcomeId = withCandles.outcomeId;
      hip4.yesAssetId = withCandles.yesAssetId;
      hip4.noAssetId = withCandles.noAssetId;
    },
  },
  { tool: "flowscan_hip4_markets", label: "settled", args: { section: "settled", limit: 5 }, check: (d) => assert(d.data.settledOutcomes.length > 0, "settled") },
  { tool: "flowscan_hip4_markets", label: "questions", args: { section: "questions", limit: 5 } },
  { tool: "flowscan_hip4_markets", label: "all+search", args: { section: "all", search: "BTC" } },
  {
    tool: "flowscan_hip4_outcome",
    args: () => ({ outcomeId: hip4.outcomeId, yesAssetId: hip4.yesAssetId, noAssetId: hip4.noAssetId, days: 3 }),
    check: (d) => assert(Array.isArray(d.data.yesCandles) && d.data.candleColumns, "candles"),
  },
  { tool: "flowscan_hip4_outcome", label: "outcomeId only", args: () => ({ outcomeId: hip4.outcomeId, days: 1 }), check: (d) => assert(d.data.yesAssetId === `#${hip4.outcomeId}0`, "derived ids") },
  { tool: "flowscan_hip4_labels", args: () => ({ assets: [hip4.yesAssetId, hip4.noAssetId] }), check: (d) => assert(Object.keys(d.data.labels ?? {}).length === 2, "labels") },

  // HIP-3
  { tool: "flowscan_hip3_overview", args: {}, check: (d) => assert(d.data.overview.total_volume > 0 && d.data.market_share.XYZ, "overview") },
  { tool: "flowscan_hip3_daily", args: { metric: "volume", days: 14 }, check: (d) => assert(d.data.dates.length === 14 && d.data.series.XYZ.length === 14, "daily") },
  { tool: "flowscan_hip3_daily", label: "oi_by_market", args: { metric: "oi_by_market", days: 7 }, check: (d) => assert(Array.isArray(d.data.markets), "oi_by_market") },
  { tool: "flowscan_hip3_markets", args: { dex: "XYZ", assetClass: "Equities", limit: 20 }, check: (d) => assert(d.data.markets.length > 0, "markets") },
  {
    tool: "flowscan_hip3_markets",
    label: "TSLA",
    args: { symbol: "TSLA", days: 7 },
    check: (d) => assert(d.data.comparison?.dexes?.XYZ && Object.values(d.data.comparison.history.oi).every((a: Json) => a.length === 7), "TSLA comparison"),
  },
  { tool: "flowscan_hip3_dex", args: { dex: "XYZ", days: 7, limit: 10 }, check: (d) => assert(d.data.markets.length === 10 && d.data.total && "lastDayPartial" in d.data.daily_totals, "dex") },
  { tool: "flowscan_hip3_dex", label: "prefix mkts", args: { dex: "mkts", days: 3, limit: 3 }, check: (d) => assert(d.data.dex === "KM", "prefix alias") },
  { tool: "flowscan_hip3_builders", args: { limit: 10 }, check: (d) => assert(d.data.builders.length === 10 && d.data.totals, "builders") },
  { tool: "flowscan_hip3_builders", label: "dex XYZ 30d", args: { dex: "XYZ", window: "30d", limit: 5 }, check: (d) => assert(d.data.builders.length > 0 && d.data.rankedBy === "XYZ.30d", "dex rank") },
  { tool: "flowscan_hip3_binance_comparison", args: { limit: 10 }, check: (d) => assert(d.data.symbols.length === 10, "binance") },
  { tool: "flowscan_hip3_binance_comparison", label: "EQUITY", args: { underlyingType: "EQUITY", limit: 5 }, check: (d) => assert(d.data.symbols.every((s: Json) => s.underlyingType === "EQUITY"), "type filter") },
  { tool: "flowscan_hip3_binance_comparison", label: "TSLA", args: { symbol: "TSLA", days: 7 }, check: (d) => assert(d.data.binance && d.data.hip3ByDex, "TSLA binance") },

  // builders
  { tool: "flowscan_builders_leaderboard", args: {}, check: (d) => assert(d.data.builders.length > 0, "leaderboard") },
  { tool: "flowscan_builders_leaderboard", label: "volume 30d wallet", args: { metric: "volume", window: "30d", category: "wallet", limit: 5 } },
  {
    tool: "flowscan_builders_leaderboard",
    label: "ARPU minUsers",
    args: { metric: "avg_revenue_per_user_all_time", minUsers: 100, limit: 3 },
    check: (d) => assert(d.data.sortedBy === "avg_revenue_per_user_all_time" && d.data.builders.every((b: Json) => b.totalUsers >= 100), "minUsers"),
  },
  { tool: "flowscan_builders_summary", args: { limit: 10 }, check: (d) => assert(d.data.totals && d.data.builders.length === 10, "summary") },
  { tool: "flowscan_builders_daily_revenue", args: { top: 5 }, check: (d) => assert(Object.keys(d.data.rangeTotals).length === 5, "daily revenue") },
  {
    tool: "flowscan_builders_daily_revenue",
    label: "builder fomo",
    args: { builder: "fomo", startDate: "2026-09-01", endDate: "2026-09-07" },
    check: (d) => assert(d.data.matchedKeys.length >= 1, "no matched keys"),
  },
  { tool: "flowscan_builders_user_series", args: { builder: "pvp", days: 14 }, check: (d) => assert(d.data.byBuilder.length >= 1 && d.data.dates.length === 14, "user series") },
  { tool: "flowscan_builder_dashboard", args: { builder: PVP_BUILDER }, check: (d) => assert(d.data.stats && d.data.daily && d.data.volumeByAsset, "dashboard") },
  { tool: "flowscan_builder_dashboard", label: "all window", args: { builder: PVP_BUILDER, window: "all" } },
  { tool: "flowscan_builder_dashboard", label: "by id", args: { builder: "pvp", section: "stats" }, check: (d) => assert(d.resolvedBuilder?.address === PVP_BUILDER, "pvp not resolved") },
  { tool: "flowscan_builder_dashboard", label: "unknown builder", args: { builder: "zzzz-no-such-builder-qq" }, expectError: true },
  { tool: "flowscan_builder_intelligence_list", args: { limit: 10 }, check: (d) => assert(d.data.builders.length === 10 && d.data.categories, "intel list") },
  { tool: "flowscan_builder_intelligence_detail", args: { builderId: "pvp" }, check: (d) => assert(d.data.key_metrics, "intel detail") },
  {
    tool: "flowscan_builder_intelligence_detail",
    label: "phantom heavy sections",
    args: { builderId: "phantom", sections: ["revenue_retention_metrics", "individual_user_metrics", "top_users_by_status"], limit: 10 },
  },
  { tool: "flowscan_builder_intelligence_summary", args: {}, check: (d) => assert(d.data.totals, "intel summary") },
  { tool: "flowscan_builder_intelligence_summary", label: "wallet", args: { category: "wallet" } },
  {
    tool: "flowscan_builder_lookup",
    args: { query: "fomo" },
    check: (d) => {
      assert(d.data.matches.length >= 2 && d.data.exactMatches >= 2, "expected >= 2 fomo builders");
      const ids = d.data.matches.map((m: Json) => m.id);
      assert(ids.includes("fomo") && ids.includes(FOMO_SOCIAL), "both fomo builders expected");
    },
  },
  { tool: "flowscan_builder_lookup", label: "phantom", args: { query: "phantom" }, check: (d) => assert(d.data.matches[0].id === "phantom" && d.data.matches[0].address, "phantom lookup") },
  {
    tool: "flowscan_builder_revenue",
    label: "fomo social 45d",
    args: { builder: FOMO_SOCIAL, days: 45 },
    check: (d) => {
      builderRevenue.fomoSocial = d.data;
      const r = d.data.revenue;
      assert(d.data.range.days === 45, "range days");
      assert(r.fromDailyRevenueRoute.totalUsd > 0 && r.fromBuilderDashboard?.totalUsd > 0, "missing totals");
      const diff = Math.abs(r.fromDailyRevenueRoute.totalUsd - r.fromBuilderDashboard.totalUsd) / r.fromDailyRevenueRoute.totalUsd;
      assert(diff < 0.01, `sources differ by ${(diff * 100).toFixed(2)}%`);
      assert(d.data.daily.length === 45, "daily rows");
    },
  },
  {
    tool: "flowscan_builder_revenue",
    label: "fomo ambiguous",
    args: { builder: "fomo", days: 45 },
    check: (d) => {
      assert(d.data.ambiguous === true, "expected ambiguous");
      const ids = d.data.candidates.map((c: Json) => c.id);
      assert(ids.includes("fomo") && ids.includes(FOMO_SOCIAL), "both candidates expected");
    },
  },
  {
    tool: "flowscan_builder_revenue",
    label: "FOMO id via address",
    args: () => ({ builder: builderRevenue.fomoIdAddress ?? "fomo", days: 45 }),
    check: (d) => {
      builderRevenue.fomoId = d.data;
    },
  },
  {
    tool: "flowscan_builder_revenue",
    label: "id:fomo",
    args: { builder: "id:fomo", days: 45 },
    check: (d) => assert(d.data.builder?.id === "fomo" && d.data.totalRevenueUsd > 0, "id: prefix"),
  },
  { tool: "flowscan_builder_revenue", label: "start > end", args: { builder: "pvp", startDate: "2026-09-15", endDate: "2026-09-01" }, expectError: true },
  { tool: "flowscan_builder_revenue", label: "future", args: { builder: "pvp", startDate: "2099-01-01" }, expectError: true },
  { tool: "flowscan_builders_daily_revenue", label: "2026-02-30", args: { startDate: "2026-02-30", endDate: "2026-03-02" }, expectError: true },
  {
    tool: "flowscan_builder_revenue",
    label: "pvp dates",
    args: { builder: "pvp", startDate: "2026-09-01", endDate: "2026-09-30" },
    check: (d) => assert(d.data.builder.id === "pvp" && d.data.range.days === 30 && d.data.totalRevenueUsd > 0, "pvp revenue"),
  },
];

// The small "FOMO" builder (id "fomo") is only addressable unambiguously through its address; find it from the lookup.
const lookupForFomoId: Case = {
  tool: "flowscan_builder_lookup",
  label: "fomo id address",
  args: { query: "fomo" },
  check: (d) => {
    const m = d.data.matches.find((x: Json) => x.id === "fomo");
    assert(m?.address, "id 'fomo' has no address mapping");
    builderRevenue.fomoIdAddress = m.address;
  },
};
cases.splice(
  cases.findIndex((c) => c.label === "FOMO id via address"),
  0,
  lookupForFomoId,
);

function parsePayload(text: string): { json: Json | null; truncated: boolean } {
  try {
    const json = JSON.parse(text);
    // Structured truncation keeps valid JSON and lists what was shortened in `_truncated`.
    return { json, truncated: Array.isArray(json?._truncated) };
  } catch (err) {
    // Last-resort string cut: not parseable, but must carry the marker.
    if (text.includes(TRUNC_MARKER)) return { json: null, truncated: true };
    throw err;
  }
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "dist", "index.js")],
    env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string")) as Record<string, string>,
    stderr: "pipe",
  });
  let serverStderr = "";
  transport.stderr?.on("data", (b) => (serverStderr += String(b)));
  const client = new Client({ name: "flowscan-smoke", version: "0.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const toolNames = new Set(tools.map((t) => t.name));
  console.log(`server exposes ${tools.length} tools`);

  const failures: string[] = [];
  const rows: Array<{ name: string; status: string; ms: number; size: number }> = [];
  const tested = new Set<string>();

  for (const c of cases) {
    const name = c.label ? `${c.tool} [${c.label}]` : c.tool;
    if (!toolNames.has(c.tool)) {
      failures.push(`${name}: tool not registered`);
      continue;
    }
    tested.add(c.tool);
    const args = typeof c.args === "function" ? c.args() : c.args;
    const t0 = Date.now();
    let status = "ok";
    let text = "";
    try {
      const res = (await client.callTool({ name: c.tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      text = res.content.map((x) => x.text ?? "").join("");
      const isError = Boolean(res.isError);
      if (isError !== Boolean(c.expectError)) {
        status = "FAIL";
        failures.push(`${name}: isError=${isError}, expected ${Boolean(c.expectError)}: ${text.slice(0, 300)}`);
      } else if (isError) {
        status = "error (expected)";
      } else {
        const { json, truncated } = parsePayload(text);
        if (truncated) {
          status = c.allowTruncate ? "ok (truncated)" : "FAIL";
          if (!c.allowTruncate) failures.push(`${name}: output truncated at ${text.length} chars; default output should fit`);
          if (!text.trimStart().startsWith("{") && !text.trimStart().startsWith("[")) failures.push(`${name}: truncated output is not JSON-like`);
          if (json === null) failures.push(`${name}: truncated output is not valid JSON (structured truncation expected)`);
        }
        if (json !== null && c.check) {
          const msg = c.check(json);
          if (typeof msg === "string") throw new Error(msg);
        }
      }
    } catch (err) {
      if (c.expectError) status = "error (expected)";
      else {
        status = "FAIL";
        failures.push(`${name}: ${(err as Error).message}`);
      }
    }
    const ms = Date.now() - t0;
    rows.push({ name, status, ms, size: text.length });
    console.log(`${status === "FAIL" ? "FAIL" : "ok  "} ${name}  ${ms}ms  ${text.length} chars  ${text.slice(0, 200).replace(/\s+/g, " ")}`);
  }

  const untested = [...toolNames].filter((n) => !tested.has(n));
  if (untested.length) failures.push(`untested tools: ${untested.join(", ")}`);
  if (tested.size !== toolNames.size) failures.push(`tested ${tested.size} distinct tools but server has ${toolNames.size}`);

  // Every tool should be advertised by flowscan_coverage.
  const cov = (await client.callTool({ name: "flowscan_coverage", arguments: {} })) as { content: Array<{ text?: string }> };
  const covJson = JSON.parse(cov.content[0].text ?? "{}");
  const advertised = new Set<string>(covJson.pages.flatMap((p: Json) => p.tools));
  const missingFromCoverage = [...toolNames].filter((n) => n !== "flowscan_coverage" && !advertised.has(n));
  if (missingFromCoverage.length) failures.push(`tools missing from coverage map: ${missingFromCoverage.join(", ")}`);

  await client.close();

  console.log("\n=== summary ===");
  console.log(`${"tool".padEnd(70)} ${"status".padEnd(17)} ${"ms".padStart(7)} ${"chars".padStart(7)}`);
  for (const r of rows) console.log(`${r.name.padEnd(70)} ${r.status.padEnd(17)} ${String(r.ms).padStart(7)} ${String(r.size).padStart(7)}`);
  console.log(`\n${rows.length} calls, ${tested.size}/${toolNames.size} tools covered`);

  const fs = builderRevenue.fomoSocial;
  const fi = builderRevenue.fomoId;
  if (fs) console.log(`fomo (${FOMO_SOCIAL}) ${fs.range.startDate}..${fs.range.endDate}: dailyRevenueRoute=${fs.revenue.fromDailyRevenueRoute.totalUsd.toFixed(2)} dashboard=${fs.revenue.fromBuilderDashboard?.totalUsd?.toFixed(2)}`);
  if (fi?.revenue) console.log(`FOMO (id fomo, ${fi.builder.address}) ${fi.range.startDate}..${fi.range.endDate}: dailyRevenueRoute=${fi.revenue.fromDailyRevenueRoute.totalUsd.toFixed(2)} dashboard=${fi.revenue.fromBuilderDashboard?.totalUsd?.toFixed(2)}`);

  if (failures.length) {
    console.error(`\n${failures.length} FAILURE(S):`);
    for (const f of failures) console.error(` - ${f}`);
    if (serverStderr.trim()) console.error(`\nserver stderr:\n${serverStderr.slice(-2000)}`);
    process.exit(1);
  }
  console.log("\nSMOKE OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

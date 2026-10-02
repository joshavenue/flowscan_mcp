/**
 * QA scenario harness for flowscan-mcp.
 *
 * Spawns the server FROM SOURCE (`npx tsx src/index.ts`) with a fetch spy
 * preloaded (scripts/qa/fetch-spy.mjs), runs agent-style scenarios, computes
 * ground truth from the raw www.flowscan.xyz routes, and asserts.
 *
 *   npx tsx scripts/qa/scenarios.ts                 # all scenarios
 *   npx tsx scripts/qa/scenarios.ts --only 1,5,26   # a subset
 *   npx tsx scripts/qa/scenarios.ts --json out.json # also write machine-readable results
 *   npx tsx scripts/qa/scenarios.ts --upstream      # hyperliquid-direct scenarios (101+): the server is
 *                                                   # spawned with FLOWSCAN_HYPERLIQUID_DIRECT=1
 *
 * The default run spawns the server with FLOWSCAN_HYPERLIQUID_DIRECT unset (even if
 * your shell sets it) and fails if any host other than www.flowscan.xyz is
 * contacted. The --upstream run allows exactly www.flowscan.xyz plus
 * api.hyperliquid.xyz, rpc.hyperliquid.xyz, api-ui.hyperliquid.xyz, api.hyperunit.xyz.
 *
 * Each check is either MUST (correctness; failing one makes the run exit 1) or
 * SHOULD (agent-usability / output-quality expectation; reported as WARN).
 * Checks marked SHOULD encode fixes recommended in the QA report, so they flip
 * to OK once the build agent lands them.
 */
import fs from "node:fs";
import { Harness, raw, rawUpstream, sum, type CallResult } from "./lib.js";

type Level = "MUST" | "SHOULD";
interface Check {
  level: Level;
  name: string;
  ok: boolean;
  detail?: string;
}
interface Ctx {
  h: Harness;
  calls: CallResult[];
  checks: Check[];
  call(tool: string, args?: Record<string, unknown>): Promise<CallResult>;
  must(name: string, ok: unknown, detail?: unknown): void;
  should(name: string, ok: unknown, detail?: unknown): void;
  info(msg: string): void;
}
interface Scenario {
  id: number;
  name: string;
  /** Runs only in the --upstream (hyperliquid-direct) pass. */
  upstream?: boolean;
  /** Use a fresh server process (cold cache), e.g. for concurrency/timing checks. */
  fresh?: boolean;
  run(c: Ctx): Promise<void>;
}

const VAULT = "0x010461c14e146ac35fe42271bdc1134ee31c703a";
const FOMO_BIG = "0x2a2b6b093a9813fbd8cddae800c3d17d46460d17";
const FOMO_SMALL_ADDR = "0xb838e4d1c8bcf71fa8e63299d5aa3258c83d6adb";
const STAKER = "0xa7904a48ffba1c48146d083737a04db369d3b7a0"; // delegates to 3 validators
const DAY = 86_400_000;

/** State handed from one hyperliquid-direct scenario to the next (#101 -> #102 -> #103). */
const shared: { height?: number; block?: any } = {};

const near = (a: unknown, b: number, tol = 0.01) => typeof a === "number" && Math.abs(a - b) <= tol;
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);
const todayUtc = () => new Date().toISOString().slice(0, 10);
const utcDay = (offset: number) => {
  const d = new Date(`${todayUtc()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const fmt = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v))?.slice(0, 300);

/* ------------------------------------------------------------------ */

const scenarios: Scenario[] = [
  {
    id: 1,
    name: "FOMO revenue, past 45 days (ambiguous name)",
    async run(c) {
      const look = await c.call("flowscan_builder_lookup", { query: "FOMO" });
      const m = look.json?.data?.matches ?? [];
      c.must("lookup flags ambiguity", look.json?.data?.ambiguous === true, look.json?.data?.ambiguous);
      c.must("lookup lists both FOMO builders", m.some((x: any) => x.id === "fomo") && m.some((x: any) => x.address === FOMO_BIG), m.map((x: any) => x.id));

      const big = await c.call("flowscan_builder_revenue", { builder: FOMO_BIG, startDate: "2026-08-18", endDate: "2026-10-01", limit: 1 });
      const d = big.json?.data;
      c.must("big fomo total = 1,649,115.56", near(d?.totalRevenueUsd, 1649115.56, 0.01), d?.totalRevenueUsd);
      c.must("both sources agree", near(d?.revenue?.fromBuilderDashboard?.totalUsd, d?.revenue?.fromDailyRevenueRoute?.totalUsd, 0.01), d?.revenue);
      c.must("range is inclusive 45 days", d?.range?.days === 45, d?.range);

      const small = await c.call("flowscan_builder_revenue", { builder: FOMO_SMALL_ADDR, startDate: "2026-08-18", endDate: "2026-10-01", limit: 1 });
      c.must("small FOMO (by address) total ~6,435.43", near(small.json?.data?.totalRevenueUsd, 6435.43, 0.05), small.json?.data?.totalRevenueUsd);

      // [build agent, round 2] bare "fomo" is intentionally ambiguous (it is one builder's id AND the other's name);
      // the hints now say to pass the address or "id:<id>", so the check uses the id: form and verifies the hint.
      const bare = await c.call("flowscan_builder_revenue", { builder: "fomo", startDate: "2026-08-18", endDate: "2026-10-01", limit: 1 });
      c.must("bare 'fomo' is ambiguous and the hint names the id:<id> form", bare.json?.data?.ambiguous === true && /id:/.test(String(bare.json?.data?.hint)), bare.json?.data);
      const byId = await c.call("flowscan_builder_revenue", { builder: "id:fomo", startDate: "2026-08-18", endDate: "2026-10-01", limit: 1 });
      c.must(
        "'id:fomo' resolves to the id-'fomo' builder (the hint's suggested form)",
        byId.json?.data?.builder?.id === "fomo" && near(byId.json?.data?.totalRevenueUsd, 6435.43, 0.05),
        byId.json?.data?.ambiguous ? "still ambiguous" : byId.json?.data?.builder,
      );

      const days45 = await c.call("flowscan_builder_revenue", { builder: FOMO_BIG, days: 45, limit: 1, fields: ["range", "totalRevenueUsd"] });
      c.must("days=45 ends yesterday UTC", days45.json?.data?.range?.endDate === utcDay(-1) && days45.json?.data?.range?.days === 45, days45.json?.data?.range);
    },
  },
  {
    id: 2,
    name: "Phantom revenue 2026-09-01..2026-09-15",
    async run(c) {
      const r = await c.call("flowscan_builder_revenue", { builder: "Phantom", startDate: "2026-09-01", endDate: "2026-09-15", limit: 1 });
      const d = r.json?.data;
      c.must("name resolves uniquely", d?.builder?.id === "phantom", d?.builder ?? d);
      const adr = await raw("/api/builders/all-daily-revenue?startDate=2026-09-01&endDate=2026-09-15");
      const truth = sum(Object.values(adr.data.dailyRevenue as Record<string, any>).map((x) => Number(x.phantom ?? 0)));
      const dash = await raw(`/api/dashboard/builder-daily-series?builder=${d?.builder?.address}&window=90d`);
      const dashTruth = sum((dash.dates as string[]).map((dt, i) => (dt >= "2026-09-01" && dt <= "2026-09-15" ? Number(dash.series.revenue[i]) : 0)));
      c.must("total matches all-daily-revenue", near(d?.totalRevenueUsd, truth), { tool: d?.totalRevenueUsd, truth });
      c.must("dashboard figure matches builder-daily-series", near(d?.revenue?.fromBuilderDashboard?.totalUsd, dashTruth), { tool: d?.revenue?.fromBuilderDashboard?.totalUsd, dashTruth });
      c.must("dates inclusive (15 days)", d?.range?.days === 15, d?.range);
    },
  },
  {
    id: 3,
    name: "Leaderboard: most new users this week; highest revenue per user",
    async run(c) {
      const mt = await raw("/api/buildersv2/landing/metrics-table");
      const topNew = [...mt.builders].sort((a: any, b: any) => (b.metrics.new_users?.["7d"] ?? 0) - (a.metrics.new_users?.["7d"] ?? 0))[0];
      const r = await c.call("flowscan_builders_leaderboard", { metric: "new_users", window: "7d", limit: 3 });
      c.must("top new_users.7d matches raw", r.json?.data?.builders?.[0]?.id === topNew.id, { tool: r.json?.data?.builders?.[0]?.id, raw: topNew.id });
      c.should("compact rows (<500 chars per builder)", r.chars / 3 < 500, `${Math.round(r.chars / 3)} chars per row`);

      const a = await c.call("flowscan_builders_leaderboard", { metric: "avg_revenue_per_user_all_time", limit: 3 });
      const arpu = (b: any) => Number(b.metrics.avg_revenue_per_user_all_time ?? 0);
      const topArpu = [...mt.builders].sort((x: any, y: any) => arpu(y) - arpu(x))[0];
      c.must("ARPU sort works (all-time metric without windows)", a.json?.data?.builders?.[0]?.id === topArpu.id, a.json?.data?.builders?.[0]?.id);
      c.should("sortedBy label does not invent a window for all-time metrics", !/\.7d$/.test(String(a.json?.data?.sortedBy)), a.json?.data?.sortedBy);
      // [build agent, round 2] rows are compact by default (totalUsers instead of metrics.total_users.all_time); minUsers is opt-in (default 0).
      const am = await c.call("flowscan_builders_leaderboard", { metric: "avg_revenue_per_user_all_time", minUsers: 100, limit: 3 });
      const top = am.json?.data?.builders?.[0];
      c.should("ARPU ranking can exclude tiny builders (min users filter)", (top?.totalUsers ?? top?.metrics?.total_users?.all_time ?? 0) >= 100, `top ARPU builder has ${top?.totalUsers} users`);
    },
  },
  {
    id: 4,
    name: "Builder ids: walletv, Wallet V, Okto vs Okto2, 0x ids",
    async run(c) {
      const w = await c.call("flowscan_builder_intelligence_detail", { builderId: "walletv", sections: ["metadata"] });
      c.must("intelligence_detail('walletv') works (raw route serves 'walletv', 404s 'wallet_v')", !w.isError, w.text.slice(0, 200));
      const lv = await c.call("flowscan_builder_lookup", { query: "Wallet V" });
      c.must("lookup 'Wallet V' -> walletv", lv.json?.data?.matches?.[0]?.id === "walletv", lv.json?.data?.matches?.[0]);
      const lo = await c.call("flowscan_builder_lookup", { query: "okto" });
      const mo = lo.json?.data?.matches ?? [];
      c.must("Okto is the single exact match", lo.json?.data?.exactMatches === 1 && mo[0]?.name === "Okto", mo.map((x: any) => [x.name, x.exactMatch]));
      c.must("Okto2 listed separately (not conflated)", mo.some((x: any) => x.name === "Okto2" && x.exactMatch === false), mo.map((x: any) => x.name));
      const ox = await c.call("flowscan_builder_intelligence_detail", { builderId: "0x4fe1141b9066f3777f4bd4d4ac9d216173031dc1", sections: ["metadata"] });
      c.must("0x-address builder id with name override works", ox.json?.data?.metadata?.builder_name === "Okto2", ox.json?.data?.metadata);
    },
  },
  {
    id: 5,
    name: "Invalid dates",
    async run(c) {
      const inv = await c.call("flowscan_builder_revenue", { builder: "phantom", startDate: "2026-09-15", endDate: "2026-09-01" });
      c.must("start > end is an error", inv.isError, inv.text.slice(0, 200));
      c.should("start > end validated before any network call", inv.fetches.filter((f) => f.kind === "start").length === 0, `${inv.fetches.filter((f) => f.kind === "start").length} fetches`);
      const fut = await c.call("flowscan_builder_revenue", { builder: "phantom", startDate: "2027-01-01", endDate: "2027-01-10", limit: 1 });
      c.must("future range is an error or explicitly flagged (not a silent $0)", fut.isError || /future|after the latest|not yet/i.test(fut.text), fut.json?.data?.totalRevenueUsd);
      const bad = await c.call("flowscan_builder_revenue", { builder: "phantom", startDate: "2026-13-45", endDate: "2026-09-01" });
      c.must("'2026-13-45' rejected as an invalid date", bad.isError && /invalid|not a (real|valid)/i.test(bad.text), bad.text.slice(0, 200));
      const feb = await c.call("flowscan_builders_daily_revenue", { startDate: "2026-02-30", endDate: "2026-03-02", top: 1 });
      c.must("'2026-02-30' rejected (upstream silently rolls it to 03-02)", feb.isError, feb.json?.data?.dateRange);
      const txt = await c.call("flowscan_builder_revenue", { builder: "phantom", startDate: "Sept 1" });
      c.must("non-ISO date rejected by schema", txt.isError, txt.text.slice(0, 120));
      const up = await c.call("flowscan_builders_daily_revenue", { startDate: "2026-09-15", endDate: "2026-09-01" });
      c.must("upstream 400 surfaced once, no retries", up.isError && up.fetches.filter((f) => f.kind === "start").length <= 1, up.text.slice(0, 150));
    },
  },
  {
    id: 6,
    name: "Hyperliquid revenue yesterday (summary windows vs raw)",
    async run(c) {
      const [core, dep, gas] = await Promise.all(
        ["hypercoreFeeSummary", "deployerFeeSummary", "priorityGasSummary"].map((type) => raw("/api/gossip/info", { method: "POST", body: { type } })),
      );
      const r = await c.call("flowscan_revenue_summary", {});
      const d = r.json?.data;
      const y = utcDay(-1);
      c.must("latestCompleteDay is yesterday UTC", d?.latestCompleteDay === y, d?.latestCompleteDay);
      c.must("currentDayPartial is today UTC", d?.currentDayPartial?.day === todayUtc(), d?.currentDayPartial);
      for (const w of d?.windows ?? []) {
        const inW = (row: any) => row.day >= w.from && row.day <= w.to;
        const nat = sum(core.filter(inW).map((x: any) => +x.nativeHypercoreFee));
        const hip3 = sum(core.filter(inW).map((x: any) => +x.hip3HypercoreFee));
        const de = sum(dep.filter(inW).map((x: any) => +x.totalFee));
        const g = sum(gas.filter(inW).map((x: any) => +(x.writePriority?.totalGas ?? 0) + +(x.readPriority?.totalGas ?? 0)));
        // the current day can tick between our raw fetch and the tool's; windows end yesterday so these are stable
        c.must(`${w.days}d native fees match raw`, rel(w.nativeHypercoreFeeUsdc, nat) < 1e-9, { tool: w.nativeHypercoreFeeUsdc, raw: nat });
        c.must(`${w.days}d hip3 fees match raw`, rel(w.hip3HypercoreFeeUsdc, hip3) < 1e-9, { tool: w.hip3HypercoreFeeUsdc, raw: hip3 });
        c.must(`${w.days}d deployer fees match raw`, rel(w.deployerFeeUsdc, de) < 1e-9, { tool: w.deployerFeeUsdc, raw: de });
        c.must(`${w.days}d priority gas matches raw`, rel(w.priorityGasHype, g) < 1e-9, { tool: w.priorityGasHype, raw: g });
      }
      // [build agent, round 3] `days` now means complete days ending yesterday; today's partial row needs includeToday.
      const series = await c.call("flowscan_revenue_hypercore_fees", { days: 2, includeToday: true });
      const last = series.json?.data?.at?.(-1);
      c.must("raw series last row is today (partial)", last?.day === todayUtc(), last);
      c.should("partial current-day row is flagged in the data (e.g. partial:true)", last && ("partial" in last || "isPartial" in last), last);
    },
  },
  {
    id: 7,
    name: "Total protocol revenue last 7 days in USD (HYPE gas caveat)",
    async run(c) {
      const r = await c.call("flowscan_revenue_summary", {});
      const note = String(r.json?.data?.note ?? "");
      c.must("states that priority gas is HYPE and not converted", /HYPE/.test(note) && /(not fetch|does not)/i.test(note), note);
      c.should(
        "states what Flowscan's headline total includes (native + HIP-3 fees + gas x HYPE price; deployer fees excluded)",
        /deployer/i.test(note) && /exclud|not (part|included)/i.test(note),
        note,
      );
    },
  },
  {
    id: 8,
    name: "xyz deployer fees in September",
    async run(c) {
      const startTime = Date.UTC(2026, 8, 1);
      const endTime = Date.UTC(2026, 9, 1) - 1;
      const rawRows = await raw("/api/gossip/info", { method: "POST", body: { type: "deployerFeeSummary", startTime, endTime } });
      const truth = sum(rawRows.flatMap((r: any) => r.byDex.filter((b: any) => b.dex === "xyz").map((b: any) => +b.totalFee)));
      const r = await c.call("flowscan_revenue_deployer_fees", { dex: "xyz", startTime, endTime });
      const rows = r.json?.data ?? [];
      const got = sum(rows.flatMap((x: any) => (x.byDex ?? []).map((b: any) => +b.totalFee)));
      c.must("30 UTC days returned", rows.length === 30 && rows[0]?.day === "2026-09-01" && rows.at(-1)?.day === "2026-09-30", [rows[0]?.day, rows.at(-1)?.day, rows.length]);
      c.must("sum of xyz byDex matches raw", Math.abs(got - truth) < 0.01, { got, truth });
      c.should("response includes a range total for the filtered dex (agent should not add 30 strings)", /rangeTotal|total(s)?ByDex|rangeSum/i.test(r.text), Object.keys(r.json ?? {}));
    },
  },
  {
    id: 9,
    name: "5 biggest BTC longs right now",
    async run(c) {
      const r = await c.call("flowscan_perp_positions", { market: "BTC", side: "long", sort: "notional", limit: 5 });
      const p = r.json?.data?.positions ?? [];
      c.must("5 long positions", p.length === 5 && p.every((x: any) => x.side === "long"), p.map((x: any) => x.side));
      c.must("sorted by notional desc", p.every((x: any, i: number) => i === 0 || p[i - 1].notionalSize >= x.notionalSize));
      c.must("snapshot timestamp present", typeof r.json?.data?.timestamp === "number", r.json?.data?.timestamp);
      c.should("human-readable snapshot time / age included", /timestampIso|asOf|ageSeconds/i.test(r.text), Object.keys(r.json?.data ?? {}));
    },
  },
  {
    id: 10,
    name: "Market symbol case/format variants",
    async run(c) {
      for (const m of ["btc", "Btc", "xyz:tsla", "XYZ:TSLA"]) {
        const r = await c.call("flowscan_perp_positions", { market: m, limit: 1, fields: ["market", "total"] });
        c.must(`perp_positions('${m}') works`, !r.isError, r.text.slice(0, 150));
        const k = await c.call("flowscan_perp_markets", { market: m });
        c.must(`perp_markets('${m}') finds it`, (k.json?.data?.markets?.length ?? 0) >= 1, k.json?.paging);
      }
      const t = await c.call("flowscan_perp_positions", { market: "TSLA", limit: 1 });
      c.should("perp_positions('TSLA') resolves to xyz:TSLA or the error suggests it", !t.isError || /xyz:TSLA/.test(t.text), t.text.slice(0, 200));
    },
  },
  {
    id: 11,
    name: "Open interest on TSLA (coherent across tools)",
    async run(c) {
      const pm = await c.call("flowscan_perp_markets", { market: "xyz:TSLA" });
      const snapOi = pm.json?.data?.markets?.[0]?.openInterest;
      const dx = await c.call("flowscan_hip3_dex", { dex: "xyz", search: "TSLA", days: 1 });
      const dexOi = dx.json?.data?.markets?.find((m: any) => m.symbol === "TSLA")?.oi;
      c.must("perp snapshot and dex-stats OI agree within 3%", snapOi && dexOi && rel(snapOi, dexOi) < 0.03, { snapOi, dexOi });
      const pmDesc = String((await c.h.listTools()).find((t) => t.name === "flowscan_perp_markets")?.description ?? "");
      c.should("OI convention documented (Flowscan openInterest = long + short notional)", /long.?\+.?short|both sides|two-sided|2x/i.test(pm.text + pmDesc), "no note in output or description");
      const hm = await c.call("flowscan_hip3_markets", { symbol: "TSLA", days: 2 });
      const hist = hm.json?.data?.comparison?.history ?? {};
      const lens: number[] = [];
      for (const v of Object.values(hist)) {
        if (Array.isArray(v)) lens.push(v.length);
        else if (v && typeof v === "object") for (const a of Object.values(v as Record<string, unknown>)) if (Array.isArray(a)) lens.push(a.length);
      }
      c.must("hip3_markets(symbol, days=2) trims nested per-DEX history arrays to 2", lens.length > 0 && lens.every((n) => n <= 2), `array lengths ${[...new Set(lens)].join(",")}; ${hm.chars} chars`);
    },
  },
  {
    id: 12,
    name: "Not-served questions (HYPE price, block, tx, testnet)",
    async run(c) {
      const all = await c.call("flowscan_coverage", {});
      const ns = JSON.stringify(all.json?.notServed ?? "");
      c.must("notServed covers blocks, tx, prices, testnet", /block/i.test(ns) && /transaction/i.test(ns) && /price/i.test(ns) && /testnet/i.test(ns), ns.slice(0, 200));
      for (const topic of ["testnet", "tx", "HYPE price"]) {
        const r = await c.call("flowscan_coverage", { topic });
        c.must(`coverage('${topic}') still returns notServed`, (r.json?.notServed?.length ?? 0) > 0);
      }
      const b = await c.call("flowscan_coverage", { topic: "block" });
      const claims = (b.json?.pages ?? []).filter((p: any) => /recent blocks|transactions/i.test(p.shows));
      c.should("no served page claims to show blocks/transactions", claims.length === 0, claims.map((p: any) => `${p.path}: ${p.shows}`));
    },
  },
  {
    id: 13,
    name: "address_summary: vault, empty, uppercase, malformed",
    async run(c) {
      const v = await c.call("flowscan_address_summary", { address: VAULT, positionsLimit: 2 });
      c.must("vault role", v.json?.data?.role?.role === "vault", v.json?.data?.role);
      const e = await c.call("flowscan_address_summary", { address: "0x000000000000000000000000000000000000dEaD", include: ["role", "pnlSummary", "perpState"] });
      c.must("dead address: clean result", !e.isError && e.json?.data?.pnlSummary?.totalTrades === 0, e.text.slice(0, 120));
      const u = await c.call("flowscan_address_summary", { address: VAULT.toUpperCase().replace("0X", "0x"), include: ["role"] });
      c.must("uppercase normalized to lowercase", u.json?.data?.address === VAULT && u.json?.data?.role?.role === "vault", u.json?.data);
      const bad = await c.call("flowscan_address_summary", { address: "0x123" });
      c.must("malformed address rejected", bad.isError && /address/i.test(bad.text), bad.text.slice(0, 120));
      c.should("tradedPairs list is compacted (vault trades 200+ pairs)", !Array.isArray(v.json?.data?.pnlSummary?.tradedPairs) || v.json.data.pnlSummary.tradedPairs.length <= 50, `${v.json?.data?.pnlSummary?.tradedPairs?.length} pairs, ${v.chars} chars`);
      const km = await c.call("flowscan_address_summary", { address: VAULT, include: ["perpState"], dex: "KM" });
      c.should("unknown/uppercase dex ('KM') fails fast without retrying a deterministic upstream 500", km.fetches.filter((f) => f.kind === "start").length <= 1, `${km.fetches.filter((f) => f.kind === "start").length} fetches, ${km.ms} ms`);
    },
  },
  {
    id: 14,
    name: "Staked HYPE and with which validators",
    async run(c) {
      const r = await c.call("flowscan_address_staking", { address: STAKER, historyLimit: 2 });
      const dl = r.json?.data?.delegations ?? [];
      c.must("delegations returned", dl.length >= 1, dl.length);
      c.should("delegations include validator names", dl.every((x: any) => typeof x.validatorName === "string" || typeof x.name === "string"), dl[0]);
      c.should("total delegated HYPE included", /totalDelegated|totalStaked/i.test(r.text), Object.keys(r.json?.data ?? {}));
    },
  },
  {
    id: 15,
    name: "This address's trades in the last 24h (cap/paging)",
    async run(c) {
      const startTime = Date.now() - DAY;
      const r = await c.call("flowscan_address_fills", { address: VAULT, startTime, limit: 1 });
      c.must("capped flag + coveredRange present", typeof r.json?.capped === "boolean" && r.json?.coveredRange?.fromIso, { capped: r.json?.capped, coveredRange: r.json?.coveredRange });
      c.should("when capped, a nextStartTime cursor is given", !r.json?.capped || "nextStartTime" in (r.json ?? {}), Object.keys(r.json ?? {}));
      c.should("when capped, paging.total is not presented as the window total", !r.json?.capped || r.json?.paging?.total !== 2000 || /upstream|cap/i.test(JSON.stringify(r.json?.paging)), r.json?.paging);
    },
  },
  {
    id: 16,
    name: "Orders: historical + open coin filter on nested order.coin",
    async run(c) {
      const h = await c.call("flowscan_address_orders", { address: VAULT, kind: "historical", coin: "BTC", limit: 50 });
      const coins = (h.json?.data ?? []).map((o: any) => o.order?.coin);
      c.must("historical coin filter works", !h.isError && coins.every((x: string) => /btc/i.test(x)), coins.slice(0, 5));
      const o = await c.call("flowscan_address_orders", { address: VAULT, kind: "open", coin: "BTC", limit: 50 });
      c.must("open coin filter works", !o.isError && (o.json?.data ?? []).every((x: any) => /btc/i.test(x.coin)));
      c.should("historical orders report the covered time range (2000-row cap spans seconds for busy accounts)", /coveredRange/.test(h.text), Object.keys(h.json ?? {}));
    },
  },
  {
    id: 17,
    name: "Lowest-commission non-jailed validator; total staked",
    async run(c) {
      const so = await raw("/api/staking/info", { method: "POST", body: { type: "stakingOverview" } });
      const r = await c.call("flowscan_staking_overview", { limit: 50 });
      c.must("total_staked matches raw", r.json?.data?.total_staked === so.total_staked, [r.json?.data?.total_staked, so.total_staked]);
      c.must("is_jailed visible", (r.json?.data?.validators ?? []).every((v: any) => typeof v.is_jailed === "boolean"));
      const tools = await c.h.listTools();
      const schema: any = tools.find((t) => t.name === "flowscan_staking_overview")?.inputSchema;
      c.should("ascending sort or jailed filter available (answer in one small call)", Boolean(schema?.properties?.dir || schema?.properties?.order || schema?.properties?.jailed || schema?.properties?.excludeJailed), Object.keys(schema?.properties ?? {}));
      const nonzero = (so.validators as any[]).some((v) => Number(v.effective_stake) > 0);
      c.should("effective_stake not advertised while upstream returns 0.0 for every validator", nonzero || !/effective stake/i.test(String(tools.find((t) => t.name === "flowscan_staking_overview")?.description)), "description lists 'effective stake' but all values are 0.0");
    },
  },
  {
    id: 18,
    name: "Nodes in Japan; sentry operators",
    async run(c) {
      const peers = await raw("/api/peers");
      const cc = (code: string) => (peers.nodes as any[]).filter((n) => n.geo?.cc === code).length;
      const jp = await c.call("flowscan_peers", { section: "nodes", country: "JP", limit: 1 });
      const jpName = await c.call("flowscan_peers", { section: "nodes", country: "Japan", limit: 1 });
      // peers re-crawl every few minutes; allow small drift
      c.must("country=JP count matches raw", Math.abs((jp.json?.paging?.total ?? -1) - cc("JP")) <= 5, [jp.json?.paging?.total, cc("JP")]);
      c.must("country=Japan count matches JP", jpName.json?.paging?.total === jp.json?.paging?.total, [jpName.json?.paging?.total, jp.json?.paging?.total]);
      for (const code of ["US", "DE", "IN"]) {
        const r = await c.call("flowscan_peers", { section: "nodes", country: code, limit: 200 });
        const nodes = (r.json?.data?.nodes ?? []) as any[];
        const wrong = nodes.filter((n) => n.geo?.cc !== code).map((n) => `${n.geo?.cc}/${n.geo?.country}`);
        c.must(`country=${code} returns only nodes with that ISO code (no substring hits on country names)`, nodes.length > 0 && wrong.length === 0, `${wrong.length} of ${nodes.length} wrong: ${[...new Set(wrong)].join(", ")} (raw ${code} count ${cc(code)})`);
      }
      const s = await c.call("flowscan_peers", {});
      c.must("sentries with operators in summary", (s.json?.data?.sentries ?? []).every((x: any) => "operator" in x) && s.json?.data?.sentries?.length > 0);
    },
  },
  {
    id: 19,
    name: "Compare XYZ and KM daily volume, 14 days",
    async run(c) {
      const r = await c.call("flowscan_hip3_daily", { metric: "volume", days: 14 });
      // [build agent, round 3] hip3_daily now returns dated rows [{date, XYZ, KM, ...}] (raw=true keeps {dates, series}).
      const d = r.json?.data;
      c.must("14 dated rows", d?.rows?.length === 14 && d.rows.every((x: any) => typeof x.date === "string"));
      c.must("XYZ and KM values on every row", d?.rows?.every((x: any) => "XYZ" in x && "KM" in x));
      const x = await c.call("flowscan_hip3_daily", { metric: "volume", dex: "XYZ", days: 14 });
      c.must("dex='XYZ' returns only XYZ", JSON.stringify(x.json?.data?.columns ?? []) === '["XYZ"]', x.json?.data?.columns);
      c.should("partial current day flagged (last date is today)", d?.rows?.at(-1)?.date !== todayUtc() || /partial/i.test(r.text), d?.rows?.at(-1)?.date);
      c.should("multiple DEXs accepted in one call (e.g. dex=['XYZ','KM'])", false, "dex is a single substring");
    },
  },
  {
    id: 20,
    name: "HIP-3 DEX with most open interest",
    async run(c) {
      const snap = await raw("/api/dex-stats/snapshot");
      const top = Object.entries(snap.market_share as Record<string, any>).sort((a, b) => b[1].oi - a[1].oi)[0][0];
      const r = await c.call("flowscan_hip3_overview", { fields: ["market_share"] });
      const got = Object.entries((r.json?.data?.market_share ?? {}) as Record<string, any>).sort((a, b) => b[1].oi - a[1].oi)[0]?.[0];
      c.must("top OI DEX matches raw", got === top, [got, top]);
      c.should("DEX display names mapped to on-chain dex prefixes (KM->mkts, Paragon->para, Entropy->io)", /mkts/.test(r.text) || /prefix/i.test(r.text), "no mapping in output");
    },
  },
  {
    id: 21,
    name: "Premier League prediction markets + candles",
    async run(c) {
      const r = await c.call("flowscan_hip4_markets", { search: "Premier League" });
      const o = r.json?.data?.activeOutcomes ?? [];
      c.must("Premier League outcomes with YES prices", o.length > 0 && o.every((x: any) => typeof x.yesMark === "number"), o.map((x: any) => [x.name, x.yesMark]));
      const first = o[0];
      const oc = await c.call("flowscan_hip4_outcome", { outcomeId: first?.outcomeId, yesAssetId: first?.yesAssetId, noAssetId: first?.noAssetId, days: 2 });
      c.must("active outcome has YES candles", (oc.json?.data?.yesCandles?.length ?? 0) > 0, oc.text.slice(0, 150));
      const bare = await c.call("flowscan_hip4_outcome", { outcomeId: first?.outcomeId, yesAssetId: String(first?.yesAssetId).replace("#", ""), noAssetId: String(first?.noAssetId).replace("#", ""), days: 2 });
      c.should("asset ids without '#' are normalized (currently silently empty)", (bare.json?.data?.yesCandles?.length ?? 0) > 0, bare.json?.data?.yesCandles?.length);
      c.should("compact outcome rows (<1000 chars each)", r.chars / Math.max(o.length, 1) < 1000, `${Math.round(r.chars / Math.max(o.length, 1))} chars per outcome`);
    },
  },
  {
    id: 22,
    name: "Tokenized stock with most holders / liquidity",
    async run(c) {
      const sc = await raw("/api/spot-stocks/current");
      const top = Object.entries(sc.by_token as Record<string, any>).sort((a, b) => b[1].holders - a[1].holders)[0][0];
      const r = await c.call("flowscan_spot_stocks", {});
      const got = Object.entries((r.json?.data?.by_token ?? {}) as Record<string, any>).sort((a, b) => b[1].holders - a[1].holders)[0]?.[0];
      c.must("most holders matches raw", got === top, [got, top]);
      const l = await c.call("flowscan_spot_stocks", { section: "liquidity" });
      c.must("liquidity section returns depth", /bidDepth/.test(l.text));
      c.should("depth also given in USD so tokens with different prices are comparable", /depth.*usd|usd.*depth/i.test(l.text), "depth only in tokens");
    },
  },
  {
    id: 23,
    name: "TSLA last weekend",
    async run(c) {
      const wp = await raw("/api/weekend/prices");
      const weeks = await raw("/api/weekend/weeks");
      const r = await c.call("flowscan_weekend_prices", { market: "TSLA" });
      const ch = r.json?.data?.weekendChanges?.["xyz:TSLA"];
      c.must("market='TSLA' matches xyz:TSLA", ch && near(ch.pct, wp.weekendChanges["xyz:TSLA"].pct, 1e-9), ch);
      c.must("default week = newest week in weeks list", r.json?.data?.fridayCloseTs === weeks.weeks[0].fridayCloseTs, [r.json?.data?.fridayCloseTs, weeks.weeks[0].fridayCloseTs]);
      c.must("weeks newest first", weeks.weeks.every((w: any, i: number) => i === 0 || weeks.weeks[i - 1].fridayCloseTs > w.fridayCloseTs));
      const cc = await c.call("flowscan_weekend_coin_changes", { coin: "TSLA" });
      c.should("coin_changes('TSLA') resolves to xyz:TSLA instead of an empty list", (cc.json?.data?.changes?.length ?? 0) > 0, cc.json?.data);
      c.should("weekend timestamps also given as ISO dates", /Iso|isoDate|fridayClose(Date|Utc)/.test(r.text), "only Unix ms");
    },
  },
  {
    id: 24,
    name: "Oversized outputs / truncation",
    async run(c) {
      const iu = await c.call("flowscan_builder_intelligence_detail", { builderId: "pvp", sections: ["individual_user_metrics"], limit: 5 });
      c.must("individual_user_metrics paged (total known, 5 rows)", iu.json?.data?.individual_user_metricsPaging?.total > 5 && iu.json?.data?.individual_user_metrics?.length === 5, iu.json?.data?.individual_user_metricsPaging);
      const all = await c.call("flowscan_peers", { section: "all" });
      // [build agent, round 2] section=all is now paged (nodes 50, edges 200) and oversize output is truncated structurally, so the
      // old "shows TRUNCATED marker" expectation became "bounded and parseable".
      c.must("peers section=all is bounded (<= 60k chars) and paged or marked truncated", all.chars <= 60_500 && (all.truncated || all.json?.nodesPaging), `${all.chars} chars`);
      c.should("truncated output is still valid JSON (structured truncation, lists shortened + paging)", all.json !== null, "raw string slice cuts mid-object");
      const nodes = await c.call("flowscan_peers", { section: "nodes", limit: 1, fields: ["meta"] });
      c.should("`fields` honoured for section=nodes", !("nodes" in (nodes.json?.data ?? {})), Object.keys(nodes.json?.data ?? {}));
    },
  },
  {
    id: 25,
    name: "Concurrency: 12 simultaneous calls",
    fresh: true,
    async run(c) {
      const calls: [string, Record<string, unknown>][] = [
        ["flowscan_stablecoin_margin", {}],
        ["flowscan_perp_markets", { limit: 5 }],
        ["flowscan_peers", {}],
        ["flowscan_staking_overview", { limit: 5 }],
        ["flowscan_revenue_summary", {}],
        ["flowscan_spot_stocks", {}],
        ["flowscan_weekend_weeks", { limit: 3 }],
        ["flowscan_hip4_markets", { limit: 3 }],
        ["flowscan_builders_summary", {}],
        ["flowscan_builder_intelligence_list", { limit: 5 }],
        ["flowscan_address_summary", { address: VAULT, positionsLimit: 3 }],
        ["flowscan_hip3_overview", { fields: ["overview"] }],
      ];
      const t0 = Date.now();
      const before = c.h.fetchLog.length;
      const res = await Promise.all(calls.map(([t, a]) => c.call(t, a)));
      const wall = Date.now() - t0;
      const log = c.h.fetchLog.slice(before);
      const maxInflight = Math.max(0, ...log.filter((f) => f.kind === "start").map((f) => f.inflight));
      const statuses = log.filter((f) => f.kind === "end").map((f) => f.status);
      c.must("all 12 succeed", res.every((r) => !r.isError), res.filter((r) => r.isError).map((r) => `${r.tool}: ${r.text.slice(0, 100)}`));
      c.must("no 429s", !statuses.includes(429), statuses);
      c.must("semaphore respected (<= FLOWSCAN_MAX_CONCURRENCY=4 in flight)", maxInflight <= 4, `max in flight ${maxInflight}`);
      c.info(`${wall} ms wall for 12 calls, ${log.filter((f) => f.kind === "start").length} upstream requests, max ${maxInflight} in flight`);
    },
  },
  {
    id: 26,
    name: "Error propagation and fast 404",
    fresh: true,
    async run(c) {
      const n = await c.call("flowscan_perp_positions", { market: "NOPE" });
      // [build agent, round 2] output JSON is compact now ("status":404); a 404 also triggers one lookup of the market list for suggestions.
      c.must("NOPE -> isError 404 with Flowscan message", n.isError && /"status":\s*404/.test(n.text) && /not found/i.test(n.text), n.text.slice(0, 200));
      c.must("NOPE: exactly one positions request (no retries)", n.fetches.filter((f) => f.kind === "start" && /\/positions/.test(f.url)).length === 1, n.fetches.length);
      c.must("NOPE returns in < 2000 ms", n.ms < 2000, `${n.ms} ms`);
      const b = await c.call("flowscan_builder_intelligence_detail", { builderId: "bogus-builder" });
      c.must("bogus-builder -> isError 404", b.isError && /"status":\s*404/.test(b.text), b.text.slice(0, 200));
      c.must("bogus-builder: one request, < 2000 ms", b.fetches.filter((f) => f.kind === "start").length === 1 && b.ms < 2000, `${b.fetches.length} fetch events, ${b.ms} ms`);
    },
  },
  {
    id: 27,
    name: "Tool list hygiene",
    async run(c) {
      const tools = await c.h.listTools();
      c.must("all tools have descriptions", tools.every((t) => (t.description?.length ?? 0) > 50));
      c.must("builder_lookup and builder_revenue registered", ["flowscan_builder_lookup", "flowscan_builder_revenue"].every((n) => tools.some((t) => t.name === n)));
      const total = tools.reduce((a, t) => a + JSON.stringify(t).length, 0);
      c.should("total tool schema under 60k chars (context cost)", total < 60_000, `${tools.length} tools, ${total} chars`);
      const hip4: any = tools.find((t) => t.name === "flowscan_hip4_outcome")?.inputSchema;
      c.should("hip4_outcome derives yes/no asset ids from outcomeId (they are #<id>0/#<id>1)", !(hip4?.required ?? []).includes("yesAssetId"), hip4?.required);
      const dash: any = tools.find((t) => t.name === "flowscan_builder_dashboard")?.inputSchema;
      c.should("builder_dashboard accepts a builder id/name, not only a 0x address", !dash?.properties?.builder?.pattern, dash?.properties?.builder?.pattern);
    },
  },

  /* ------------------------- hyperliquid-direct (--upstream) ------------------------- */
  {
    id: 101,
    name: "What are the latest blocks? (live feed)",
    upstream: true,
    async run(c) {
      const r = await c.call("flowscan_live_feed", { include: "blocks", seconds: 3, limit: 10 });
      const d = r.json;
      const bs = d?.data?.blocks?.rows ?? [];
      c.must("blocks.heightRange and count given (no hand counting)", d?.data?.blocks?.heightRange?.to === bs[0]?.height && d?.data?.blocks?.heightRange?.from <= bs[bs.length - 1]?.height && d?.data?.blocks?.count >= bs.length, d?.data?.blocks?.heightRange);
      c.must("snapshot time (fetchedAt/fetchedAtIso)", typeof d?.fetchedAt === "number" && d?.fetchedAtIso === new Date(d.fetchedAt).toISOString(), d?.fetchedAtIso);
      c.must("envelope: mode, wss source, homepage shownOn", d?.mode === "hyperliquid-direct" && d?.source === "wss://rpc.hyperliquid.xyz/ws" && d?.shownOn === "https://www.flowscan.xyz/", [d?.mode, d?.source, d?.shownOn]);
      c.must("10 blocks, newest first, distinct heights", bs.length === 10 && bs.every((b: any, i: number) => i === 0 || bs[i - 1].height > b.height), bs.map((b: any) => b.height));
      c.must("latest block is < 60 s old", bs[0] && Date.now() - bs[0].blockTime < 60_000, bs[0]?.blockTimeIso);
      c.must("ISO twins", bs.every((b: any) => b.blockTimeIso === new Date(b.blockTime).toISOString()));
      c.must("stats present (blocks/sec, median interval)", d?.data?.stats?.blocksPerSec > 1 && d?.data?.stats?.medianBlockIntervalMs > 0, d?.data?.stats);
      c.must("only the explorer WebSocket was opened", r.fetches.filter((f) => f.kind === "start" && f.group !== "ws").every((f) => f.host === "api.hyperliquid.xyz") && r.fetches.some((f) => f.group === "ws" && f.host === "rpc.hyperliquid.xyz"), r.fetches.map((f) => `${f.group}:${f.host}`));
      // Ground truth: every listed block matches the raw explorer blockDetails.
      const raw0 = await rawUpstream("https://rpc.hyperliquid.xyz/explorer", { height: bs[2].height, type: "blockDetails" });
      const rb = raw0?.blockDetails;
      c.must("feed block == raw blockDetails (height, blockTime, hash, proposer, numTxs)", rb && ["height", "blockTime", "hash", "proposer", "numTxs"].every((k) => rb[k] === bs[2][k]), { feed: bs[2], raw: rb && { height: rb.height, blockTime: rb.blockTime, hash: rb.hash, proposer: rb.proposer, numTxs: rb.numTxs } });
      shared.height = bs[3]?.height;
    },
  },
  {
    id: 102,
    name: "Block lookup: /block/{height} field-by-field vs raw blockDetails",
    upstream: true,
    async run(c) {
      const height = shared.height ?? (await c.call("flowscan_live_feed", { include: "blocks", seconds: 1, limit: 5 })).json?.data?.blocks?.rows?.[3]?.height;
      const r = await c.call("flowscan_block", { height });
      const d = r.json?.data;
      const rb = (await rawUpstream("https://rpc.hyperliquid.xyz/explorer", { height, type: "blockDetails" }))?.blockDetails;
      c.must("raw block fetched", rb && Array.isArray(rb.txs), rb);
      c.must("shownOn = Flowscan block page; source = rpc explorer", r.json?.shownOn === `https://www.flowscan.xyz/block/${height}` && r.json?.source === "https://rpc.hyperliquid.xyz/explorer", [r.json?.shownOn, r.json?.source]);
      c.must("page header fields equal raw: height, blockTime, hash, proposer, numTxs", d && ["height", "blockTime", "hash", "proposer", "numTxs"].every((k) => d[k] === rb[k]), d && { height: d.height, hash: d.hash, proposer: d.proposer, numTxs: d.numTxs });
      c.must("time ISO twin", d?.blockTimeIso === new Date(rb.blockTime).toISOString());
      const failed = rb.txs.filter((t: any) => t.error).length;
      c.must("Failed + Success Rate cards match raw", d?.failed === failed && Math.abs(d?.successRatePct - Math.round(((rb.txs.length - failed) / rb.txs.length) * 1000) / 10) < 1e-9, [d?.failed, failed, d?.successRatePct]);
      const counts: Record<string, number> = {};
      for (const t of rb.txs) counts[t.action.type] = (counts[t.action.type] ?? 0) + 1;
      c.must("Transaction Breakdown matches raw counts per action type", d?.breakdown?.length === Object.keys(counts).length && d.breakdown.every((x: any) => counts[x.type] === x.count), d?.breakdown);
      c.must("tx table total = raw txs", r.json?.txPaging?.total === rb.txs.length, [r.json?.txPaging?.total, rb.txs.length]);
      const rows = d?.txs ?? [];
      c.must("tx table columns (hash, user, type, status, time) match raw, in page order", rows.length === Math.min(50, rb.txs.length) && rows.every((x: any, i: number) => {
        const t = rb.txs[i];
        return x.hash === t.hash && x.user === t.user && x.type === t.action.type && x.status === (t.error ? "error" : "success") && (x.error ?? null) === (t.error ?? null) && (x.time === undefined ? t.time === rb.blockTime : x.time === t.time);
      }), rows.slice(0, 2));
      c.must("every row has a one-line summary", rows.every((x: any) => typeof x.summary === "string" && x.summary.length > 0));
      const name = rb.proposer;
      c.should("proposer named from validatorSummaries", typeof d?.proposerName === "string", name);
      const errRow = rb.txs.findIndex((t: any) => t.error);
      if (errRow >= 0) {
        const er = await c.call("flowscan_block", { height, status: "error", limit: 5 });
        c.must("status=error filter returns only failed txs with their error text", er.json?.data?.txs?.length > 0 && er.json.data.txs.every((x: any) => x.status === "error" && typeof x.error === "string"), er.json?.data?.txs?.[0]);
      }
      shared.block = rb;
    },
  },
  {
    id: 103,
    name: "Tx lookup: /tx/{hash} field-by-field vs raw txDetails",
    upstream: true,
    async run(c) {
      const rb = shared.block;
      c.must("block from #102 available", rb, "run #102 first");
      if (!rb) return;
      const picks = [rb.txs.find((t: any) => t.action.type === "order"), rb.txs.find((t: any) => t.action.type.startsWith("cancel")), rb.txs.find((t: any) => t.error)].filter(Boolean);
      for (const t of picks) {
        const r = await c.call("flowscan_transaction", { hash: t.hash });
        const d = r.json?.data;
        const raw = (await rawUpstream("https://rpc.hyperliquid.xyz/explorer", { hash: t.hash, type: "txDetails" }))?.tx;
        const tag = `${t.action.type}${t.error ? " (failed)" : ""}`;
        c.must(`${tag}: raw txDetails fetched`, raw?.hash === t.hash, raw);
        c.must(`${tag}: hash, block, time, user, error equal raw`, d && d.hash === raw.hash && d.block === raw.block && d.time === raw.time && d.user === raw.user && d.error === (raw.error ?? null), d);
        c.must(`${tag}: status and ISO time`, d?.status === (raw.error ? "error" : "success") && d?.timeIso === new Date(raw.time).toISOString());
        c.must(`${tag}: action type and full payload equal raw (no field dropped)`, d?.type === raw.action.type && JSON.stringify(d?.action) === JSON.stringify(raw.action), d?.action);
        c.must(`${tag}: summary names the action`, typeof d?.summary === "string" && d.summary.length > 0, d?.summary);
        c.must(`${tag}: shownOn = /tx page, links to block and user`, r.json?.shownOn === `https://www.flowscan.xyz/tx/${t.hash}` && r.json?.links?.block === `https://www.flowscan.xyz/block/${raw.block}`);
        if (t.action.type === "order") {
          const o = raw.action.orders[0];
          c.must("order: side/size/price from the first order", d?.details?.side === (o.b ? "buy" : "sell") && d?.details?.size === o.s && d?.details?.price === o.p, d?.details);
          c.should("order: asset index resolved to a name", d?.details?.asset && !String(d.details.asset).startsWith("Asset "), d?.details?.asset);
        }
      }
      const nf = await c.call("flowscan_transaction", { hash: `0x${"ab".repeat(32)}` });
      c.must("unknown hash -> isError 404 'Transaction not found', not retried", nf.isError && /"status":404/.test(nf.text) && /not found/i.test(nf.text) && nf.fetches.filter((f) => f.kind === "start" && f.host === "rpc.hyperliquid.xyz").length === 1, nf.text.slice(0, 200));
    },
  },
  {
    id: 104,
    name: "What is the HYPE price?",
    upstream: true,
    async run(c) {
      const r = await c.call("flowscan_prices", { coins: ["HYPE"] });
      const row = r.json?.data?.[0];
      const mids = await rawUpstream("https://api.hyperliquid.xyz/info", { type: "allMids" });
      const ref = Number(mids?.HYPE);
      c.must("HYPE row with mark, mid, oracle", row?.coin === "HYPE" && row.markPx > 0 && row.midPx > 0 && row.oraclePx > 0, row);
      c.must("mid within 1% of raw allMids.HYPE", Math.abs(row?.midPx - ref) / ref < 0.01, [row?.midPx, ref]);
      c.must("source/mode/shownOn", r.json?.source === "https://api.hyperliquid.xyz/info" && r.json?.mode === "hyperliquid-direct" && r.json?.shownOn === "https://www.flowscan.xyz/");
      c.must("requests are the homepage's (allMids + metaAndAssetCtxs)", JSON.stringify(r.json?.request) === JSON.stringify([{ type: "allMids" }, { type: "metaAndAssetCtxs" }]), r.json?.request);
      c.must("24h volume, OI and funding present", row?.dayNtlVlm > 0 && row?.openInterestUsdTwoSided > 0 && typeof row?.fundingHourly === "number", row);
      c.must("snapshot time given", typeof r.json?.fetchedAt === "number" && r.json?.fetchedAtIso, r.json?.fetchedAtIso);
      // OI basis: Hyperliquid's openInterest is two-sided, the same basis as Flowscan's perp snapshot openInterest (long + short).
      const pm = await c.call("flowscan_perp_markets", { market: "HYPE", limit: 20 });
      const fsHype = (pm.json?.data?.markets ?? []).find((m: any) => m.market === "HYPE");
      c.must("openInterestUsdTwoSided within 3% of Flowscan snapshot openInterest (same basis); one-sided = half", fsHype && rel(row.openInterestUsdTwoSided, fsHype.openInterest) < 0.03 && row.openInterestUsdOneSided === Math.round(row.openInterestUsdTwoSided / 2), [row?.openInterestUsdTwoSided, fsHype?.openInterest]);
      c.must("oiNote explains the basis", /BOTH sides/.test(r.json?.oiNote ?? ""), r.json?.oiNote);
      const multi = await c.call("flowscan_prices", { coins: ["BTC", "eth", "xyz:TSLA", "KM:US500", "NVDAX"] });
      const coins = (multi.json?.data ?? []).map((x: any) => x.coin);
      c.must("BTC/ETH/HIP-3 (incl. display-name alias)/spot token resolve", ["BTC", "ETH", "xyz:TSLA", "mkts:US500", "@702"].every((k) => coins.includes(k)), coins);
    },
  },
  {
    id: 105,
    name: "Candles: BTC 1h, last 24 bars, vs raw candleSnapshot",
    upstream: true,
    async run(c) {
      const r = await c.call("flowscan_candles", { coin: "BTC", interval: "1h", bars: 24 });
      const rows = r.json?.data?.candles ?? [];
      const req = r.json?.request;
      c.must("24 candles, oldest first, 1h apart, ISO twins", rows.length === 24 && rows.every((x: any, i: number) => (i === 0 || x.t - rows[i - 1].t === 3_600_000) && x.tIso === new Date(x.t).toISOString()), rows.length);
      c.must("request window = 24 bars back from endTime", req?.req?.endTime - req?.req?.startTime === 24 * 3_600_000, req);
      const raw = await rawUpstream("https://api.hyperliquid.xyz/info", req);
      const byT = new Map((Array.isArray(raw) ? raw : []).map((x: any) => [x.t, x]));
      const closed = rows.slice(0, -1);
      c.must("closed candles equal raw o/h/l/c/v/n", closed.length === 23 && closed.every((x: any) => {
        const y: any = byT.get(x.t);
        return y && x.o === Number(y.o) && x.h === Number(y.h) && x.l === Number(y.l) && x.c === Number(y.c) && x.v === Number(y.v) && x.n === y.n;
      }), closed[0]);
      c.must("summary consistent", r.json?.data?.summary?.high === Math.max(...rows.map((x: any) => x.h)) && r.json?.data?.summary?.close === rows.at(-1)?.c, r.json?.data?.summary);
    },
  },
  {
    id: 106,
    name: "Direct mode hygiene: tool list, hosts, upstream concurrency",
    upstream: true,
    fresh: true,
    async run(c) {
      const tools = await c.h.listTools();
      const total = tools.reduce((a, t) => a + JSON.stringify(t).length, 0);
      c.must("58 tools (44 + 14 direct)", tools.length === 58, tools.length);
      c.info(`direct-mode tool schema: ${total} chars`);
      const cov = await c.call("flowscan_coverage", { topic: "block" });
      c.must("coverage serves /block in direct mode", cov.json?.mode === "hyperliquid-direct" && cov.json?.servedByThisServer === true, cov.json?.pages?.map((p: any) => p.path));
      const before = c.h.fetchLog.length;
      const res = await Promise.all([
        c.call("flowscan_prices", { dex: "xyz", limit: 3 }),
        c.call("flowscan_spot_tokens", { limit: 3 }),
        c.call("flowscan_perp_dexs", {}),
        c.call("flowscan_validator_summaries", { limit: 3 }),
        c.call("flowscan_borrow_lend_reserves", {}),
        c.call("flowscan_address_portfolio", { address: VAULT, maxPoints: 10 }),
        c.call("flowscan_address_evm_balance", { address: VAULT }),
        c.call("flowscan_address_unit_operations", { address: VAULT }),
      ]);
      const log = c.h.fetchLog.slice(before).filter((f) => f.kind === "start" && f.group === "upstream");
      const maxIn = Math.max(0, ...log.map((f) => f.inflight));
      c.must("all 8 parallel direct calls succeed", res.every((x) => !x.isError), res.filter((x) => x.isError).map((x) => x.text.slice(0, 120)));
      c.must("upstream concurrency <= 2", maxIn <= 2, maxIn);
      c.must("every result has source, shownOn, mode", res.every((x) => x.json?.source && x.json?.shownOn?.startsWith("https://www.flowscan.xyz/") && x.json?.mode === "hyperliquid-direct"));
      c.info(`${log.length} upstream HTTP requests, max ${maxIn} in flight`);
    },
  },
];

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 ? new Set(argv[onlyIdx + 1].split(",").map(Number)) : null;
  const jsonIdx = argv.indexOf("--json");
  const jsonOut = jsonIdx >= 0 ? argv[jsonIdx + 1] : null;

  const upstreamRun = argv.includes("--upstream");
  // Strict run: force the switch off even if the caller's shell sets it. Upstream run: force it on.
  const serverEnv = { FLOWSCAN_HYPERLIQUID_DIRECT: upstreamRun ? "1" : "" };
  const allowedHosts = new Set(["www.flowscan.xyz", ...(upstreamRun ? ["api.hyperliquid.xyz", "rpc.hyperliquid.xyz", "api-ui.hyperliquid.xyz", "api.hyperunit.xyz"] : [])]);

  const sharedHarness = new Harness();
  await sharedHarness.start(serverEnv);
  const results: Array<{ id: number; name: string; ms: number; calls: number; chars: number; checks: Check[]; hosts: string[]; notes: string[] }> = [];
  const allHosts = new Set<string>();

  for (const s of scenarios) {
    if (only && !only.has(s.id)) continue;
    if (Boolean(s.upstream) !== upstreamRun) continue;
    const h = s.fresh ? new Harness() : sharedHarness;
    if (s.fresh) await h.start(serverEnv);
    const notes: string[] = [];
    const ctx: Ctx = {
      h,
      calls: [],
      checks: [],
      async call(tool, args = {}) {
        const r = await h.call(tool, args);
        ctx.calls.push(r);
        return r;
      },
      must(name, ok, detail) {
        ctx.checks.push({ level: "MUST", name, ok: Boolean(ok), detail: ok ? undefined : fmt(detail) });
      },
      should(name, ok, detail) {
        ctx.checks.push({ level: "SHOULD", name, ok: Boolean(ok), detail: ok ? undefined : fmt(detail) });
      },
      info(msg) {
        notes.push(msg);
      },
    };
    const t0 = Date.now();
    try {
      await s.run(ctx);
    } catch (e) {
      ctx.checks.push({ level: "MUST", name: "scenario threw", ok: false, detail: (e as Error).stack?.slice(0, 400) });
    }
    const hosts = [...new Set(ctx.calls.flatMap((r) => r.fetches.map((f) => f.host)))];
    hosts.forEach((x) => allHosts.add(x));
    results.push({ id: s.id, name: s.name, ms: Date.now() - t0, calls: ctx.calls.length, chars: sum(ctx.calls.map((r) => r.chars)), checks: ctx.checks, hosts, notes });
    if (s.fresh) await h.stop();

    const mustFail = ctx.checks.filter((k) => k.level === "MUST" && !k.ok).length;
    const warn = ctx.checks.filter((k) => k.level === "SHOULD" && !k.ok).length;
    const status = mustFail ? "FAIL" : warn ? "WARN" : "OK";
    console.log(`\n[${status}] #${s.id} ${s.name}  (${ctx.calls.length} calls, ${sum(ctx.calls.map((r) => r.chars)).toLocaleString()} chars, ${Date.now() - t0} ms)`);
    for (const k of ctx.checks) {
      const tag = k.ok ? "  ok  " : k.level === "MUST" ? " FAIL " : " warn ";
      console.log(`  [${tag}] ${k.level === "SHOULD" ? "(should) " : ""}${k.name}${k.ok ? "" : `\n          -> ${k.detail}`}`);
    }
    for (const n of notes) console.log(`  [ info ] ${n}`);
    for (const r of ctx.calls) console.log(`      call ${r.tool} ${JSON.stringify(r.args).slice(0, 140)} -> ${r.isError ? "ERROR " : ""}${r.chars} chars, ${r.ms} ms${r.truncated ? ", TRUNCATED" : ""}`);
  }
  await sharedHarness.stop();

  const foreign = [...allHosts].filter((x) => !allowedHosts.has(x));
  console.log(`\nMode: ${upstreamRun ? "hyperliquid-direct (--upstream)" : "strict"}. Outbound hosts seen: ${[...allHosts].join(", ") || "(none)"}${foreign.length ? `  <-- FOREIGN HOSTS: ${foreign.join(", ")}` : ""}`);
  const mustFails = results.flatMap((r) => r.checks.filter((k) => k.level === "MUST" && !k.ok).map((k) => `#${r.id} ${k.name}`));
  const warns = results.flatMap((r) => r.checks.filter((k) => k.level === "SHOULD" && !k.ok).map((k) => `#${r.id} ${k.name}`));
  console.log(`\nSummary: ${results.length} scenarios, ${mustFails.length} MUST failures, ${warns.length} SHOULD warnings.`);
  for (const f of mustFails) console.log(`  FAIL ${f}`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ when: new Date().toISOString(), hosts: [...allHosts], results }, null, 1));
  process.exit(mustFails.length || foreign.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

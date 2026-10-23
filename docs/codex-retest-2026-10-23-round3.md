# Codex retest, round 3 (2026-10-23)

Third independent Codex CLI run (gpt-6.1-sol, fast mode) on commit 04e5553. Verdict: **CLEAN** (no medium or high issues left). Its report follows unchanged.

The two remaining low-severity items were fixed in the next commit: `flowscan_hip4_outcome` lists both routes in `sources` when it runs the existence check, and the reference and skill now say that the builder dashboard's top-users window has no reported dates and that the hot-candles highlight is computed in the browser.

---

# Independent flowscan-mcp retest — round 3

Tested 2026-10-23 UTC, Node v26.7.0 / npm 11.19.0. **Eleven round-2 findings pass; NEW 8 retains low-severity documentation inconsistencies. One new low-severity provenance issue was found. No medium or high issue remains unmitigated in the executed checks.**

## Checks run

| Check | Result |
| --- | --- |
| `npm test` | **PASS** — 58 tests, 58 passed, 0 failed; exit 0, 2.18 s. |
| `npm run smoke` | **PASS** — 163 stdio cases, including 19 expected errors; 54/54 tools. Four HTTP tool calls plus guide/resource checks passed. `SMOKE OK`; exit 0, 98.27 s. |
| `FLOWSCAN_HYPERLIQUID_DIRECT=1 npm run smoke` | **PASS** — 188 stdio cases, including 21 expected errors; 68/68 tools. Five HTTP tool calls plus guide/resource checks passed. `SMOKE OK`; exit 0, 46.18 s. |
| Independent real MCP stdio client | **COMPLETED** — `npx tsx /tmp/flowscan-round3/retest.mts`, importing `Harness` from `scripts/qa/lib.ts`; exit 0, 14.62 s. 265 calls: 53 finding replays/controls/variations and 212 fresh validation calls. Exact arguments came from the round-2 report and its retained call logs. |
| Fresh validation sweep | **PASS** — all 54 strict tools and 14 additional direct tools received null and wrong-type/missing-required inputs; 66 also received an invalid enum, bound, pattern or array input. Seven impossible-calendar-date calls and three reversed account-time ranges were rejected. All 212 rejected inputs made no outbound request. |
| Error shape | **PASS** — all 229 independent error results had `isError:true` and parseable JSON containing `error`, `status`, `route`, `source`; these were input errors with null status/route and `source:"input validation"`. No invalid input was unexpectedly accepted. |
| Envelopes / size | **PASS** for executed independent calls — every successful data result had `source` and `servedAtIso`; coverage is the static-map exception. No non-JSON result or response over 40,000 characters; largest was 6,385 characters. |
| Documentation review | Compared the round-2 fix list with AGENTS.md, README.md, the Flowscan skill, reference and coverage matrix. Remaining contradictions are described below. |

The suites and independent clients ran sequentially with `FLOWSCAN_MAX_CONCURRENCY=3`; independent MCP calls were sequential. The independent strict fetch log recorded only `www.flowscan.xyz`, with maximum concurrency 3. Direct smoke contacted only the four permitted upstream hosts and www.flowscan.xyz, with maximum upstream concurrency 2. Direct access occurred through the MCP server. No manual data HTTP requests were made; the server supplies its built-in User-Agent. No git commands or remote writes were performed. Only `codex-report.md` was deliberately written in the repository; scripts and logs are under `/tmp/flowscan-round3`.

## Round-2 findings

“R1” identifies the three incomplete round-1 fixes; “NEW” uses the round-2 report's numbering. Each row includes an exact replay and a variation. Successful independent data responses were served at **06:10:47–06:10:58 UTC** from Flowscan; this is response time, not necessarily dataset time.

| Finding | Verdict | Concise evidence |
| --- | --- | --- |
| R1 #3 — DEX filtering / unknown list-mode DEX | **PASS** | Replayed TSLA/Kinetiq/days 2 and all reported AAOI DEX variations. AAOI/Hyena and AAOI/Kinetiq now have `listedAs:[]`, `comparison.dexes:{}`, empty OI/DAU DEX maps and `dexNote`; XYZ and Paragon controls retain only their own keys. `{"dex":"R2_UNKNOWN_ID_9724","limit":1}` now returns `"Unknown DEX"` instead of an empty success. |
| R1 #8 — timestamps / top-users window | **PASS** | Replayed wallet labels, 30d top users, empty completed trades and spikes: all have `servedAtIso`. The 7d top-users variation also says `"Flowscan's top-users route does not report the window's start and end dates."` No effective endpoints are invented. |
| R1 #12 — Intelligence dates silently ignored | **PASS — disclosed limitation** | Exact pvp `2026-10-01..2026-10-02` replay now says `"the dates were not applied"` and identifies returned `2024-10-27..2026-09-21`. A `2026-10-10..2026-10-11` variation behaves likewise. End-only `2099-01-02` is explicitly disclosed as unapplied. Summary variation discloses an unstated returned range. Reversed ranges and future starts still error. Filtering itself remains unsupported upstream. |
| NEW 1 — nonexistent outcome success | **PASS** | `flowscan_hip4_outcome {"outcomeId":999999999,"days":1}` now returns `found:false` and explains that the id is absent from active/latest 1,000 settled outcomes. Variation `999999998`, days 2, does the same. The bounded lookup is stated explicitly. |
| NEW 2 — YES/NO or other-outcome overrides | **PASS** | Replayed both swapped `#14871/#14870` and foreign `#14730/#14731` overrides for outcome 1487: both error before fetching, requiring `yesAssetId:'#14870'`. Default control and valid numeric-string overrides `14870/14871` succeed with canonical `#14870/#14871` and identical candle data. |
| NEW 3 — unknown DEX becomes zero/empty | **PASS** | Exact `R2_UNKNOWN_ID_9724` calls to deployer fees (days 3), HIP-3 daily (volume/days 3) and builders (limit 3) now return `"Unknown DEX"` with valid names. `R3_UNKNOWN` variations with different windows/metrics also error; deployer fees lists names present in the range. |
| NEW 4 — collateral metric accepts DEX | **PASS** | Exact `{"metric":"collateral_oi","dex":"XYZ","days":2}` now errors: `"split by collateral token ... not by DEX"`. `collateral_traders`/KM variation also errors. No-DEX control retains USDC/USDH/USDT/USDe columns and dated values. |
| NEW 5 — blank builder lookup | **PASS** | Exact `{"query":" \t "}` and variation `{"query":"\n\t"}` both return JSON minimum-length errors with no fetch. |
| NEW 6 — three missing component-source lists | **PASS for the reported tools** | Exact Intelligence list (limit 2), weekend weeks (limit 3, schedule enabled) and AAOI Binance comparison (days 2) now list both component routes in `sources`. Schedule limit-1 and GOLD/day-1 variations preserve them; disabling categories correctly produces a single-source Intelligence result. A different newly added branch is reported below. |
| NEW 7 — direct smoke coverage assertion | **PASS** | Exact direct `{"topic":"live prices"}` returns `servedByThisServer:true`, no unavailable matches; direct `HYPE price` variation also returns true. Strict replay remains `"partly"` with the limitation. Both smoke commands pass. |
| NEW 8 — documentation / feature contracts | **FAIL — LOW, prose only** | Original perp, HIP-4 limit-3 and unknown-DEX calls replayed. Daily-series wording, README provenance wording, unknown-DEX documentation and HIP-4 aggregate totals are corrected. Limit-3 returns totals over all 335 outcomes; BTC/limit-1 variation reports totals over 33. Both include `volume24hWarning`. However, reference lines 345/532 still promise all dashboard windows end yesterday, while the top-users result explicitly says its dates are unavailable. The skill's “Everything else ... IS served” terminal claim still omits the matrix's partial hot-candle qualification. Scope the dashboard promise to stats/daily/assets and qualify hot candles. |
| NEW 9 — upstream OI disagreement | **PASS — qualified, upstream discrepancy persists** | Exact TSLA calls give live snapshot OI `46045676.88` versus HIP-3 stats `1422193`. NVDA variation gives `86670368.76` versus `0`. Snapshot time: `2026-10-23T06:07:19.000Z`. Both DEX responses now carry `oiNote`: `"refreshed separately ... for current OI use flowscan_perp_markets ... The two can disagree."` This satisfies the requested qualification; it does not establish that upstream numbers were repaired. |

The market evidence comes from Flowscan's [positioning snapshot](https://www.flowscan.xyz/api/perp-snapshot/markets), [HIP-3 snapshot](https://www.flowscan.xyz/api/dex-stats/snapshot), [per-DEX statistics](https://www.flowscan.xyz/api/dex-stats/per-dex) and [HIP-4 data](https://www.flowscan.xyz/api/hip-4), as cited by the actual MCP responses. Intelligence and top-user evidence similarly uses the routes returned in their `source` fields.

## New issue

**LOW — HIP-4's new existence-check branch omits its component provenance.**

Tool and exact arguments: `flowscan_hip4_outcome {"outcomeId":999999999,"days":1}`. Variation: `{"outcomeId":999999998,"days":2}`.

Quoted output: `"source":"https://www.flowscan.xyz/api/hip-4/999999999"`, `"servedAtIso":"2026-10-23T06:10:53.825Z"`, `"found":false`, and `"notFoundNote":"Outcome 999999999 is not among the active outcomes or the latest 1000 settled ones, and Flowscan returned no data for it. Check the id with flowscan_hip4_markets."` There is **no `sources` field**.

The Harness captured requests to both `/api/hip-4/999999999?...` and `/api/hip-4?limit=1000`. The variation also lacks `sources` while using the cached existence list. The classification therefore uses a second route that the envelope does not identify.

Expected: list both component routes, consistent with `docs/reference.md:440` and the NEW 6 fixes. Fix: when the existence check runs, add `sources` containing the outcome route and `https://www.flowscan.xyz/api/hip-4`. The unknown-id classification itself passes.

## Limits

No installation, rebuild, typecheck, conformance run, scenario suite, raw HTTP comparison, browser inspection or upstream root-cause investigation was performed in this round. Smoke tested the supplied build; the independent Harness tested current source over stdio. The validation sweep is bounded and does not cover every argument combination. No 429 was deliberately induced.

**Verdict: CLEAN (no medium or high issues left).**

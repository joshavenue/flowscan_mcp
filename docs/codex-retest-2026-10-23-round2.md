# Codex retest, round 2 (2026-10-23)

Second independent Codex CLI run (gpt-6.1-sol, fast mode) on commit 6393d7a, in a separate clean checkout. It re-ran its round-1 calls and swept every tool again. Its report follows unchanged.

## What was done about each finding

| Finding | Fix (commit after 6393d7a) |
| --- | --- |
| Round-1 #3 incomplete: DEX filter left other DEXs when the DEX had no listing; list mode accepted an unknown DEX | DEX-keyed objects are always filtered (empty when the DEX does not list the symbol, with `dexNote`); every `dex` parameter rejects unknown names. |
| Round-1 #8 incomplete: top-users window has no dates | `windowNote` says Flowscan's top-users route does not report the window's dates. |
| Round-1 #12 incomplete: Intelligence routes ignore accepted dates | The tools add `dateRangeNote` with the requested and the returned range whenever they differ. |
| New 1: unknown HIP-4 outcome id returned an empty success | Empty results are checked against the active and latest 1,000 settled outcomes: `found: false` with a note, or `found: true` with an explanation of the empty data. |
| New 2: asset-id overrides could swap YES/NO or point at another outcome | `yesAssetId` must be `#<outcomeId>0` and `noAssetId` `#<outcomeId>1`. |
| New 3: unknown DEX gave zero/empty results in deployer fees, hip3_daily and hip3_builders | Input error listing the valid names (deployer fees also lists the deployer names present in the range). |
| New 4: collateral metrics accepted a DEX filter | Input error explaining the series is split by collateral token. |
| New 5: builder lookup accepted a blank query | Trimmed before the length check. |
| New 6: multi-route results without `sources` | Added for Builder Intelligence list, weekend weeks with schedule and the Binance comparison. |
| New 7: smoke assertion wrong in direct mode | The check is mode-dependent (strict: partly/false; direct: true). |
| New 8: documentation overstated some contracts | "Data ends yesterday" scoped to daily series; HIP-4 tool gained `totals` (24h and total volume over all matched outcomes); unknown-DEX behaviour, README provenance sentence and the /terminal exceptions corrected. |
| New 9: two Flowscan OI datasets disagree (upstream) | Not a wrapper bug: after a dex-stats regeneration at 05:33 UTC Flowscan's HIP-3 stats showed 0 OI for xyz:NVDA. `flowscan_hip3_dex` now says where its OI comes from and points to the live snapshot; the QA agreement check is a warning. |

While checking New 8 a further upstream quirk turned up: in Flowscan's HIP-4 data every outcome's 24h volume currently equals its lifetime volume. `flowscan_hip4_markets` now adds `volume24hWarning` when that happens.

---

# Independent flowscan-mcp retest — round 2

Tested on 2026-10-23 UTC, Node v26.7.0, npm 11.19.0, in the supplied worktree. **14 round-1 issues pass; 3 fixes remain incomplete (#3, #8, #12). Nine newly reported findings follow.** Six requested commands passed; direct smoke and scenarios failed. No high-severity issue was confirmed.

Only this report was deliberately edited in the repository. Installation/build generated their normal ignored artifacts. Git status was clean before testing and before writing the report. No commits, pushes, checkout/reset operations, trades or other remote writes were performed. Temporary clients, complete output and raw responses are in `/tmp/flowscan-round2`.

## Checks and results

| Check | Result | Actual output / counts |
| --- | --- | --- |
| `npm install` | PASS, exit 0 | `up to date, audited 102 packages in 3s`; prepare/build passed. `3 vulnerabilities (2 moderate, 1 high)`. Install-script warnings named esbuild and fsevents. Advisories were not independently triaged. |
| `npm run typecheck` | PASS, exit 0 | No TypeScript errors; 1.21 s. |
| `npm run build` | PASS, exit 0 | Guide consistency check and TypeScript build passed; 1.34 s. |
| `npm test` | PASS, exit 0 | `tests 58`, `pass 58`, `fail 0`; cancelled/skipped/todo all 0; 2.54 s. |
| `npm run conformance` | PASS, exit 0 | 54 strict / 68 direct tools; `0 error(s), 124 info finding(s). CONFORMANCE OK`; 0.74 s. |
| `npm run smoke` | PASS, exit 0 | 160/160 stdio cases passed, including 16 expected errors; 54/54 tools. HTTP: 4/4 tool calls plus guide/resource checks passed. `SMOKE OK`; 96.00 s. |
| `FLOWSCAN_HYPERLIQUID_DIRECT=1 npm run smoke` | FAIL, exit 1 | 184/185 stdio cases passed, including 18 expected errors; 68/68 tools. HTTP: 5/5 tool calls plus guide/resource checks passed. Failure: `flowscan_coverage [partly served topic]: live prices claimed as served`. This assertion incorrectly runs in direct mode; see NEW 7. 46.45 s. |
| `npx tsx scripts/qa/scenarios.ts` | FAIL, exit 1 | 32 scenarios, 99 MCP calls; 163 passing assertions, 1 MUST failure, 1 SHOULD warning. Failure: `#11 perp snapshot and dex-stats OI agree within 3%`, output `{"snapOi":46064109.3,"dexOi":1424458}`. Warning: `multiple DEXs accepted in one call (e.g. dex=['XYZ','KM'])` → `dex is a single substring`. 21.97 s. |
| Independent MCP stdio sweep | COMPLETED, findings below | 414 calls: 34 exact round-1 replays, 28 labelled variations, 68 realistic calls, 136 malformed calls, 68 calls using default optional arguments, and 80 semantic/focused/follow-up calls. Every one of the 54 strict tools and 14 additional direct tools had a successful realistic call and two rejected malformed inputs. |
| JSON error contract | PASS for executed calls | All 184 error responses parsed as JSON containing `error`, `status`, `route`, `source`. All 136 deliberately malformed schema inputs were rejected. No plain-text tool error was observed. |
| Provenance/time envelopes | PASS for data envelopes; omissions below | Every successful response from the 53 strict data tools had `source` and `servedAtIso`; every direct data tool had `source`, `shownOn`, `fetchedAtIso`. `flowscan_coverage` is the documented static-map exception: it has no data envelope or timestamp. Multi-route source omissions remain; see NEW 6. |
| Unknown identifiers | FAIL in several cases | Unknown outcome and DEX selectors produce empty/zero successes (round-1 #3, NEW 1 and NEW 3). Several documented optional substring filters also return empty matches; see limits. |
| Default sizes | PASS in this sweep | None of the 414 responses exceeded 40,000 characters. Largest independent response: 29,215 characters, default `flowscan_builders_daily_revenue`. 67/68 calls using default optional arguments succeeded; wallet labels correctly requires addresses or search. Smoke also verified structured truncation on an explicitly large peers request. |
| Independent raw comparisons | PASS for comparable checks | 87 direct HTTP requests to www.flowscan.xyz, all HTTP 200; 172/172 numeric/ordering/aggregate comparisons passed. Three HIP-3 overview comparisons were excluded because `generated_at` changed from `2026-10-23T05:33:40.569199` to `2026-10-23T05:48:36.297673`. No wrapper arithmetic discrepancy was confirmed. |
| Schemas and descriptions | REVIEWED, findings below | Actual tools/list: 54 / 68; compact JSON sizes 72,912 / 86,624 characters. All descriptions reviewed; longest 579 characters. Counts and CLI help are updated. Units and sibling-tool guidance are generally useful; unsupported combinations and documentation gaps remain. |
| Documentation | REVIEWED, findings below | Read `docs/coverage-matrix.md`, `docs/reference.md`, `README.md`, `AGENTS.md`, `skills/flowscan/SKILL.md`, and compared them with schemas and executed responses. |

All suites ran sequentially with `FLOWSCAN_MAX_CONCURRENCY=3`. Independent clients called tools sequentially with short pauses. The final strict follow-up client used a cap of 2 while one manual raw request could run alongside it. Raw comparison requests otherwise overlapped only the direct-only sweep, whose upstream cap is 2. Thus at most three data requests were in flight. Strict fetch logs contained only www.flowscan.xyz; direct logs contained only the four permitted upstream hosts. Manual data requests used `User-Agent: flowscan-independent-retest/2` and contacted only www.flowscan.xyz. A preload also supplied a User-Agent to the scenario harness's own raw requests. Direct upstream access was exclusively through the MCP server.

The raw checks covered revenue windows, gas and deployer totals, position summaries and ordering, liquidation clusters/history, historical footprint/flow totals, funding/slippage/OI history, closed trades, paginated funding, historical fills, weekend aggregates, HIP-3 DEX/builder totals, builder leaderboard/daily revenue/dashboard/top-user figures. Floating-point sums used 1e-6 tolerance where appropriate; cent-rounded USD totals used cent tolerance. For example, the fixed account window `1792627200000..1792630800000` (2026-10-22 00:00–01:00 UTC) matched the Flowscan address route: 542 fills, volume 101,543.77529 USD and fees 4.246625 USDC; 26 funding rows, net received 4,607.540946 USDC.

## Round-1 fixes

“Original calls” below refers to the numbered calls and exact JSON in [the round-1 report](docs/codex-retest-2026-10-23.md). **All 34 listed calls were replayed unchanged through `Harness` and real MCP stdio**, including strict tools explicitly labelled direct in that report. Evidence below is selected output, not a full call ledger.

| # | Verdict | Replayed calls, variation and real evidence |
| --- | --- | --- |
| 1 | **PASS** | Original 283/284/356. BTC ascending deltas were `[0.82,-0.82,10.64,10.64,10.64]`; descending `[1529188.06,-1295430.32,691547.29,288693.53,-209834.8]`. Explicit `sortBy:"absChange"` ascending returned `[0.82,-0.82,10.64]`. Variation `{"market":"ETH","sortBy":"absChange","dir":"asc","includeTags":false,"limit":4}` returned `[0.24,-1.2,-10.1,-10.82]`. Captured requests included `sort=absChange&dir=asc`; raw ordering matched. Snapshot: 2026-10-23 05:43:12 UTC. |
| 2 | **PASS** | Original 354/355. Address-filtered result now says `"summaryScope":"cohort 'all', window '24h', address '0x1234'; all kinds"`, alongside zero summary counts. Variation with `side:"short",kind:"opened"` says `"summaryScope":"cohort 'all', window '24h', side short; all kinds"`; the summary includes other kinds, as the corrected description promises. |
| 3 | **FAIL — incomplete** | Original 305, `{"symbol":"TSLA","dex":"Kinetiq","days":2}`, now returned `"dex":"KM","listedAs":[],"comparison":null` with a missing-comparison explanation. TSLA is no longer in the comparison dataset, so this alone cannot prove the filtering fix. XYZ variation returned only its listing. Available-symbol variations exposed the remaining bug: `{"symbol":"AAOI","dex":"Hyena","days":2}` and the same call with `dex:"Kinetiq"` returned `"listedAs":[]` but `comparison.dexes` still had `XYZ` and `Paragon`. With `dex:"XYZ"`, only XYZ remained. Also, list-mode `{"dex":"R2_UNKNOWN_ID_9724","limit":1}` still succeeded with `"markets":[]`; symbol-mode unknown DEX correctly errors. Always filter DEX-keyed objects, including when there is no matching key, and validate DEX in both branches. |
| 4 | **PASS** | Original 304 and variation `{"section":"questions","marketKind":"events","limit":1}` both returned `{"error":"marketKind filters outcomes, not question groups. Use section 'active' or 'settled' (or 'all') with marketKind.","status":null,"route":null,"source":"input validation"}`. Neither made a request. |
| 5 | **PASS** | Original 312 and a second end-only fills call using `endTime:1792627200000` returned `"error":"endTime needs startTime (Unix ms). Without startTime the tool returns the latest ~2000 fills."`. End-only ledger variation returned `"error":"startTime (2026-09-23T05:48:41.526Z, the default) is after endTime; pass an earlier startTime."`. Both used the four-field JSON error shape and made no request. |
| 6 | **PASS** | Original 319 returned `"servedByThisServer":"partly"` and `"servedNote":"Both served pages and notServed items match. Read notServedMatches: if the specific thing asked for is listed there, it is not served in this mode."`. Variation `{"topic":"order books"}` returned `false`. Independent direct-mode `{"topic":"live prices"}` correctly returned `true` and `notServedMatches:[]`. |
| 7 | **PASS for the reported wrong routes** | Original 296/320/321 now cite the actual requested routes: `/api/hydromancer/builder-top-users`, `/api/perp-snapshot/leaderboard/status`, `/api/perp-snapshot/spikes`. Request capture confirmed them. Variation `{"include":["cohorts","spikes"]}` lists both routes in `sources`; assets-only dashboard cites `/api/dashboard/builder-volume-by-asset`. Other tools still omit component sources, separately reported as NEW 6. |
| 8 | **FAIL — timestamps fixed; top-users range still unspecified** | Original 153/296/360/361 all now have `servedAtIso`, including empty completed trades and spikes. The top-users-only replay still returns only `"window":"30d"` and `"windowNote":"the last 30d as Flowscan computes it (complete UTC days ending yesterday for stats/daily/assets)"`. That ending convention explicitly names other sections, and there are no effective from/to endpoints for topUsers. Variation `window:"7d",section:"topUsers",topUsersLimit:1` has the same omission. `servedAtIso` dates response construction, not the fee window. Report the actual top-users window bounds/convention, or explicitly say its effective endpoints are unavailable. |
| 9 | **PASS** | Original 154/157 now return JSON validation errors, e.g. `"error":"Invalid arguments for flowscan_wallet_labels: Expected 0x + 40 hex characters at addresses[0]","status":null,"route":null,"source":"input validation"`. Original direct 175 returns `"error":"Unknown coin '__NO_SUCH_COIN__'...","status":404,"route":null,"source":"input validation"`; no `"?"` source. Variation `flowscan_search {"query":42}` also returns JSON. All 184 executed errors satisfy the four-key contract. |
| 10 | **PASS for the two reported tools** | Original 155/158 reject blank strings. Tab/newline variations `flowscan_wallet_labels {"search":"\t\n"}` and `flowscan_search {"query":"\t\n"}` also return JSON minimum-length errors. A sibling builder lookup still accepts blanks; NEW 5. |
| 11 | **PASS for the reported invalid ids/extra labels** | Original 273 now returns `"type":"unknown"` with the suffix-0/1 hint. Original 316 rejects `outcomeId:-1`; original 317 rejects `not-an-asset`. Variation `outcomeId:-2` also errors. `flowscan_hip4_labels {"assets":["#14730","#14739","#999999990"]}` returns only `"labels":{"#14730":"Arsenal · Yes"}`, `"invalid":["#14739"]`, `"notFound":["#999999990"]`. No unrelated label keys. Other HIP-4 existence/identity problems are NEW 1–2. |
| 12 | **FAIL — invalid-range rejection fixed, accepted ranges still ignored** | Original 310 now returns `"error":"startDate 2026-10-22 is after endDate 2026-10-21."`; future-start detail and reversed-summary variations also error before fetching. But `flowscan_builder_intelligence_detail {"builderId":"pvp","startDate":"2026-10-01","endDate":"2026-10-02","sections":["metadata","daily_activity_metrics"],"limit":1}` returns `"date_range":{"start":"2024-10-27","end":"2026-09-21"}` and a daily row `"date":"2026-08-23"`. The separately fetched raw route returns the same unrelated history. End-only `endDate:"2099-01-02"` is also accepted without a clamp/rejection note. Reject unsupported filtering or apply it and expose the effective range. |
| 13 | **PASS** | Original 352 and variation `{"coin":"ETH","mantissa":5,"nSigFigs":4}` return `"error":"mantissa only applies with nSigFigs=5."` before any request. Valid variation `{"coin":"BTC","mantissa":2,"nSigFigs":5,"depth":2}` succeeds; returned subscription contains `"nSigFigs":5,"mantissa":2`. |
| 14 | **PASS** | Original coverage and direct invalid-terminal-status calls replayed. Actual list counts are 54/68; reference, README, AGENTS and skill counts agree. `node dist/index.js --help` prints `hyperliquid-direct mode (68 tools instead of 54)`. Measured schema sizes, 72,912/86,624 characters, agree with the reference's approximate sizes. Variation coverage topic `terminal` worked. |
| 15 | **PASS** | Original 282 and variation `{"market":"PARAGON:paper","sections":["summary"]}` return the PAPER panel independently of positioning resolution: `"source":"https://www.flowscan.xyz/api/paper"`, `"inPositioningSnapshot":false`, `"complete":false`, with `"valuation":{"error":"PAPER data source unavailable"}` and the positions/hedgers errors preserved. The raw route confirmed that unavailable state. |
| 16 | **PASS** | Original 353 now returns `"scope":"all operations of the address (before the direction filter)","matched":{"direction":"deposit","operations":0,"totalUsd":0}` while all-operation totals remain 2 withdrawals. Withdrawal variation reports `"matched":{"direction":"withdrawal","operations":2,"totalUsd":1167.04}` and paging total 2 with one row. Snapshot: `2026-10-23T05:51:22.113Z`; USD valuation varies with current prices. |
| 17 | **PASS** | Original 366/367/369/370 all replayed. Both footprint and flow now return 4 candles for `bars:4`, from `2026-10-22T23:00:00.000Z` through `2026-10-23T02:00:00.000Z`; `bars:1` returns the 02:00 candle. Variations on ETH with `interval:"15m",bars:3,endTime:1792720800000` return 3 candles, 01:30–02:00, for both kinds. Historical raw candle counts and totals matched. |

## New issues

1. **MEDIUM — Unknown HIP-4 outcome ids return an unqualified empty success.**

   Tool and exact arguments: `flowscan_hip4_outcome {"outcomeId":999999999,"days":1}`.

   Output: `"outcomeId":999999999,"yesAssetId":"#9999999990","noAssetId":"#9999999991","yesCandles":[],"noCandles":[],"settledOutcome":null,"yesStats":null,"noStats":null`; `isError:false`. Source: `https://www.flowscan.xyz/api/hip-4/999999999`, served `2026-10-23T05:50:16.618Z`. The raw route likewise returned HTTP 200 with empty data. In contrast, direct order-book/trades tools reject `#9999999990` as an unknown outcome coin.

   Expected: distinguish nonexistent outcome from an existing settled/inactive outcome with no candles. Suggested fix: verify existence against outcome metadata and return a structured 404 or explicit `found:false` explanation. Do not infer nonexistence merely from empty candles.

2. **MEDIUM — Outcome asset overrides can invert YES/NO or attach another market's candles.**

   Tool and exact arguments: `flowscan_hip4_outcome {"outcomeId":1487,"yesAssetId":"#14871","noAssetId":"#14870","days":1}`.

   Output: `"outcomeId":1487,"yesAssetId":"#14871","noAssetId":"#14870"`, with first YES candle close `"0.94001"`. The control `{"outcomeId":1487,"days":1}` gives `yesAssetId:"#14870"`, first YES close `"0.05999"` at the same open time, `1792645200000`. Another executed call, `{"outcomeId":1487,"yesAssetId":"#14730","noAssetId":"#14731","days":1}`, returns that other outcome's candles under outcome 1487. Source: `/api/hip-4/1487`; responses served 05:50–05:52 UTC. Raw swapped-side request confirmed the behavior.

   Expected: YES ends in 0, NO in 1, and both belong to the selected outcome. Suggested fix: enforce those relationships before fetching, or remove redundant overrides. Current validation checks only that each id ends in either 0 or 1.

3. **MEDIUM — Unknown DEX names can still become credible zero-fee/empty results.**

   Exact calls:

   - `flowscan_revenue_deployer_fees {"days":3,"dex":"R2_UNKNOWN_ID_9724"}` → `"rangeTotals":{"from":"2026-10-20","to":"2026-10-22","days":3,...,"totalFeeUsdc":0,"allDexTotalFeeUsdc":384232.26047214,"byDex":{}}`.
   - `flowscan_hip3_daily {"metric":"volume","days":3,"dex":"R2_UNKNOWN_ID_9724"}` → `"columns":[]`, with date-only rows.
   - `flowscan_hip3_builders {"limit":3,"dex":"R2_UNKNOWN_ID_9724"}` → `"per_dex_summary":{"R2_UNKNOWN_ID_9724":null},"rankedBy":"R2_UNKNOWN_ID_9724.total","builders":[]`.

   All returned `isError:false`, from Flowscan's gossip/dex-stats routes. Expected: unknown DEX is an input error, not zero measured activity. Suggested fix: share strict alias validation across all DEX inputs. The analogous markets-list branch is already included in unresolved round-1 #3.

4. **LOW — Collateral-series metrics accept a DEX filter that removes every value.**

   Tool and exact arguments: `flowscan_hip3_daily {"metric":"collateral_oi","dex":"XYZ","days":2}`.

   Output: `"columns":[],"rows":[{"date":"2026-10-22"},{"date":"2026-10-23","partial":true}]`. Control `{"metric":"collateral_oi","days":2}` returns columns `["USDC","USDH","USDT","USDe"]` and actual values. Source: `/api/dex-stats/snapshot`. XYZ is valid; the filter is being applied to collateral-token column names.

   Expected: explain/reject this unsupported combination, or define how a DEX maps to collateral. Suggested fix: validate the metric/filter dependency and document it in the schema. A shared collateral aggregate should not silently be presented as one DEX's value.

5. **LOW — Builder lookup still treats whitespace as a search for everything.**

   Tool and exact arguments: `flowscan_builder_lookup {"query":" \t "}`.

   Output: `"query":" \t ","exactMatches":0,"totalMatches":1963,"ambiguous":true`; 20 unrelated matches returned, 9,914 characters. Source: `/api/buildersv2/landing/metrics-table`, served `2026-10-23T05:48:46.953Z`.

   Expected: reject a blank query consistently with the fixed search and wallet-label tools. Suggested fix: trim before minimum-length validation in this schema too.

6. **LOW — Multi-route results still omit component provenance.**

   Tool and exact arguments: `flowscan_builder_intelligence_list {"limit":2}`.

   Output has `"source":"https://www.flowscan.xyz/api/intelligence/builders"`, data keys `["builders","categories"]`, and no `sources`. Request capture recorded both `/api/intelligence/builders` and `/api/intelligence/categories`. Likewise, `flowscan_weekend_weeks {"limit":3,"includeSchedule":true}` fetches weeks plus `/api/weekend/schedule` but cites only weeks; `flowscan_hip3_binance_comparison {"symbol":"AAOI","days":2}` combines Binance and dex-stats snapshot data without listing the latter source.

   Expected: component sources are discoverable, as `docs/reference.md` now promises: “results built from several routes also list them in sources.” Suggested fix: apply the same `sources` convention used by the repaired dashboard/status handlers. The original wrong-route examples in #7 are fixed.

7. **LOW — The new strict coverage assertion breaks direct smoke.**

   Tool and exact arguments, direct mode: `flowscan_coverage {"topic":"live prices"}`.

   Actual output: `"mode":"hyperliquid-direct","servedByThisServer":true,"notServedMatches":[]`. This is correct. `scripts/smoke.ts:493` nevertheless requires `"partly"` or `false` in both modes. Actual command failure: `flowscan_coverage [partly served topic]: live prices claimed as served`.

   Expected: direct smoke passes when direct mode serves live prices. Suggested fix: make the expectation mode-dependent, retaining partly/false for strict and requiring true for direct. This is a test defect, not a live-price coverage defect.

8. **LOW — Documentation still overstates temporal/feature contracts.**

   Tools/calls providing the counterexamples: `flowscan_perp_markets {"market":"xyz:TSLA"}`, `flowscan_hip4_markets {"limit":3}`, and `flowscan_hip3_markets {"symbol":"TSLA","dex":"unknown-r2","days":2}`.

   Evidence and affected files:

   - AGENTS.md and the skill say “Data ends at the last complete UTC day (yesterday).” The perp call returns `"snapshotIso":"2026-10-23T05:43:12.000Z"`; terminal history and address data also include today. This must be scoped to the particular complete-day series, as later passages partly explain.
   - The coverage matrix marks the HIP-4 header's 24h volume as covered, but the executed limit-3 result has only `generatedAt` and three `activeOutcomes`, with paging total 336. `volume24h` is per outcome; there is no complete-list volume total. The guide forbids agents from summing rows. Add a total or mark that header feature partial.
   - The reference says unknown DEX names in tools other than hip3_dex/address_summary “simply match nothing.” The executed symbol-mode market call instead returns `"error":"Unknown DEX 'unknown-r2'. Known: ...","source":"input validation"`. Document the actual behavior after making it consistent.
   - README says every result identifies its Flowscan page and date range. Many envelopes identify an API route; top-users-only still lacks an effective range (#8). Narrow that promise to the fields actually returned.
   - The skill's broad claim that everything else on `/terminal` is served except prices/candles/book/trades omits its own later L4-book exception and partial hot-candle coverage. Keep the exceptions consistent with the matrix.

   Expected: each statement is scoped to the actual tool, metric and mode. Suggested fix: reconcile these passages with the live schemas/results; retain the corrected 54/68 counts.

9. **MEDIUM — Flowscan's two TSLA OI datasets disagree substantially (upstream data quality).**

   Exact calls: `flowscan_perp_markets {"market":"xyz:TSLA"}` and `flowscan_hip3_dex {"dex":"xyz","search":"TSLA","days":1}`.

   Independent follow-up output: perp `"openInterest":46064109.3` at snapshot `2026-10-23T05:43:12.000Z`; HIP-3 market `"oi":1422193`, served `2026-10-23T05:52:25.791Z`. Both tool descriptions call these two-sided OI. Independent GETs to `/api/perp-snapshot/markets` and `/api/dex-stats/per-dex` reproduced those respective figures. The earlier scenario observed 1,424,458 for the second dataset and failed its 3% agreement check.

   Expected: comparable same-market figures agree, or their differing datasets/as-of times are clearly qualified. Suggested fix: investigate the upstream discrepancy, surface dataset freshness/scope, and qualify cross-dataset comparisons. Do not adjust these numbers in the wrapper without evidence. This is not a confirmed wrapper summation error; the available results do not establish the upstream cause.

## Limits and untested areas

- No visual/browser UI comparison, interactive frontend operation, testnet, signing, trading, mutations, load testing, alternate Node version or remote-client deployment was tested.
- No manual request was made to a Hyperliquid/Unit host. Direct tools were exercised through MCP, but their totals were not independently compared with raw upstream HTTP/WebSocket responses. Doing that would violate the requested manual-host restriction.
- The 68-tool sweep covers one realistic call and at least two malformed inputs per tool, plus the recorded semantic cases; it does not prove every parameter combination or all historical ranges. Deliberately unknown optional substring filters sometimes return empty matches (including market/account/token filters); they do not generally distinguish an unknown identifier from a valid identifier with no matching activity. Explicit `found:false`, `notFound`, or an explanatory empty note was treated differently from the unqualified outcome success in NEW 1.
- Some live account/order/fill/TWAP/feed values change between requests. I did not interpret changed snapshots as arithmetic bugs. Fixed historical account windows and historical candles were used for reproducible sum checks. Three HIP-3 overview comparisons across different generations remain inconclusive.
- The original TSLA cross-DEX comparison was absent in this run. Its exact call was still replayed; available AAOI comparisons supplied the positive/negative DEX variations that exposed #3.
- The upstream OI disagreement and accepted-but-ignored Intelligence date parameters were reproduced from Flowscan routes. Their backend causes cannot be determined from this repository alone. No 429 was deliberately induced, and the reported npm advisories were not audited.

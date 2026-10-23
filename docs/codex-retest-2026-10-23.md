# Codex retest, round 1 (2026-10-23)

Independent retest by Codex CLI (model gpt-6.1-sol, fast mode) of branch `improve/full-coverage-2026-10` at commit c0d9311, run in a separate clean checkout. Codex was told to find problems, not fix them, and wrote the report below. It is reproduced as written, except that the long evidence ledgers at the end (every MCP call and raw request, about 3,800 lines) are left out to keep the file readable.

## What was done about each issue

All 17 issues were fixed in the commit after c0d9311 and re-checked by a second Codex run (see [codex-retest-2026-10-23-round2.md](codex-retest-2026-10-23-round2.md)).

| # | Issue | Fix |
| --- | --- | --- |
| 1 | `flowscan_position_changes` ignored `dir` for the default sort | `sort` and `dir` are always sent (`absChange` included). |
| 2 | Changes summary scope contradicted the description | Description corrected (summary applies cohort, window, side and address; not kind) and a `summaryScope` field added. |
| 3 | `flowscan_hip3_markets` ignored `dex` with `symbol` | Listings, comparison and history are filtered to that DEX; unknown DEX is an error. |
| 4 | HIP-4 `marketKind` ignored for question groups | That combination is now an input error with a hint. |
| 5 | `flowscan_address_fills` silently ignored `endTime` without `startTime` | Input error; ledger also rejects a default start after `endTime`. |
| 6 | Coverage said live prices are served in strict mode | `servedByThisServer` is `"partly"` (with a note) when pages and notServed items both match. |
| 7 | Some results cited a route that was not called | `source` follows the section requested; multi-route results list `sources`. |
| 8 | Some results had no time | Every strict result has `servedAtIso`; the builder dashboard states its window. |
| 9 | Schema-validation errors were plain text | Rewritten into the JSON error shape (`source: "input validation"`); local direct-mode errors no longer report `source: "?"`. |
| 10 | Whitespace-only queries passed | Queries are trimmed before the length check. |
| 11 | Invalid HIP-4 ids accepted, extra labels returned | Ids must end in 0/1 and outcome ids be >= 0; labels only for requested ids, with `invalid` / `notFound`. |
| 12 | Builder Intelligence accepted a reversed range | Reversed or future ranges are rejected before the request. |
| 13 | `mantissa` ignored without `nSigFigs=5` | Input error. |
| 14 | Stale 45/59 counts in reference and CLI help | Updated to 54/68 and current schema sizes. |
| 15 | `para:PAPER` panel unreachable | The panel is returned even when PAPER is not in the positioning snapshot. |
| 16 | Unit-operation totals not labelled as unfiltered | Totals say their scope and add `matched` totals for the direction filter. |
| 17 | Order-flow bar count wrong at an interval boundary | The candle containing `endTime` is the last one; exactly `bars` candles are requested. |

---

# Independent flowscan-mcp retest

Tested on 2026-10-23 UTC, Node v26.7.0, npm 11.19.0, in the supplied worktree. All eight requested command runs passed. Independent live MCP testing found **17 issues: 9 medium, 8 low, no high-severity issue confirmed**. No material arithmetic discrepancy was found in the raw-route comparisons.

Only `codex-report.md` was written in the repository. Temporary clients, raw responses and full logs are under `/tmp/flowscan-retest`. No source fixes, commits, pushes, signing or trading were performed. Git status was clean before testing and after all test runs, before writing this report.

## Checks run

All requested npm/scenario runs inherited `FLOWSCAN_MAX_CONCURRENCY=3`; direct mode was enabled only for its named smoke run. The custom clients used the same cap, ran one tool call at a time, and paused 400 ms between calls. Test suites ran sequentially. Manual HTTP requests used a User-Agent and contacted only `www.flowscan.xyz`. Direct hosts were contacted only by the MCP server.

| Check | Result | Real output / counts |
| --- | --- | --- |
| `npm install` (includes prepare/build) | PASS, exit 0 | 101 packages added, 102 audited; build passed. npm reported 3 advisories: 2 moderate, 1 high. These advisories were not independently triaged. |
| `npm run typecheck` | PASS, exit 0; 0.98 s | TypeScript exited cleanly. |
| `npm run build` | PASS, exit 0; 1.25 s | Guide consistency check and TypeScript build passed. |
| `npm test` | PASS, exit 0; 2.57 s | 57 tests passed; 0 failed, cancelled, skipped or todo. |
| `npm run conformance` | PASS, exit 0; 0.54 s | 54 strict / 68 direct; 0 errors, 124 informational findings. OpenAI strict opt-in conversion and legacy Cursor tool-count limits are info, not conformance failures. |
| `npm run smoke` | PASS, exit 0; 101.53 s | 152 stdio calls, 54/54 tools; 0 failures; 13 expected-error cases. Streamable HTTP checks also passed. |
| `FLOWSCAN_HYPERLIQUID_DIRECT=1 npm run smoke` | PASS, exit 0; 46.71 s | 177 stdio calls, 68/68 tools; 0 failures; 15 expected-error cases. Streamable HTTP passed; maximum upstream concurrency 2. |
| `npx tsx scripts/qa/scenarios.ts` | PASS, exit 0; 22.71 s | 32 scenarios; 163 passing assertions, 0 MUST failures, 1 SHOULD warning; 98 MCP calls. Warning: multiple DEXs cannot be requested in a single hip3_daily call. |
| Independent stdio client sweep and focused checks | COMPLETED; issues below | 370 MCP calls; 68/68 tools had a realistic call plus at least two bad/edge calls. 48 brand-alias calls covered all eight `dex` parameters. Successful realistic calls: 68/68. |
| Independent raw comparisons | No material numeric mismatch | First batch: 23/24 exact comparisons passed; the sole exact-equality failure was 0.000000001862645149230957 USDC from summation order. Follow-up: 18/18 comparisons passed, including that comparison at 1e-6 USDC tolerance. |
| Manual schema/description review | PASS with usability issues below | Inspected actual tools/list schemas in both modes; no nonportable keywords, all read-only, every tool appears in the reference. Largest description: 579 chars. |
| Coverage/reference cross-check | ISSUES | Both live coverage maps name every registered data tool; matrix row counts match 87 covered + 3 partial + 15 direct + 2 none = 107. Capability matching, PAPER availability and reference counts have defects below. |
| Six page HTML requests | PASS for HTTP access; visual comparison limited | `/terminal`, `/builders`, supplied `/address/...`, `/hip-3`, `/hip-4`, `/weekend-trading`: all HTTP 200, with the expected page titles. No browser JavaScript or interactive UI comparison was run. |
| `node dist/index.js --help` | PASS execution, stale text | Exit 0; still says “59 tools instead of 45”. |

The smoke and QA runs saw no foreign hosts. The strict scenario concurrency check observed a maximum of 3 requests in flight. Custom strict clients also observed a maximum of 3; direct-only upstream clients observed at most 2. Error counts in the call ledger include deliberately invalid inputs and are not equivalent to failed test cases.

## Issues

1. **MEDIUM — Position changes ignores ascending direction for its default sort**

   Tool(s) and exact arguments:

   - Call 283 (strict): `flowscan_position_changes` `{"market":"BTC","dir":"asc","includeTags":false,"limit":5}`.

   - Call 284 (strict): `flowscan_position_changes` `{"market":"BTC","dir":"desc","includeTags":false,"limit":5}`.

   - Call 356 (strict): `flowscan_position_changes` `{"market":"BTC","sortBy":"absChange","dir":"asc","includeTags":false,"limit":3}`.


   What happened: Ascending and descending calls returned the same rows in descending absolute USD change. The independently fetched route supports ascending order, so this is in the wrapper: positioning.ts only sends sort/dir when sortBy is not absChange.


   Relevant real output (selected fields/excerpts; no fabricated values):

   ```text
   Tool notionalDelta values: [2002250.15,-1555138.87,-867376.41]
   Raw GET /api/perp-snapshot/markets/BTC/changes?sort=absChange&dir=asc&limit=3 returned [0.82,-1.64,4.91]
   ```


   Expected: dir="asc" should return the smallest absolute changes first, including when sortBy is omitted or explicitly absChange.


   Suggested fix: Always pass the selected sort and direction to the route; verify default and explicit absChange both honor asc.


2. **MEDIUM — Position-change summary scope contradicts the tool description**

   Tool(s) and exact arguments:

   - Call 354 (strict): `flowscan_position_changes` `{"market":"ETH","window":"24h","includeTags":false,"limit":1}`.

   - Call 355 (strict): `flowscan_position_changes` `{"market":"ETH","window":"24h","address":"0x1234","includeTags":false,"limit":1}`.


   What happened: The advertised description says summary ignores kind/side/address. In fact, adding an address filter changed the summary to zero. The raw address-filtered route returned exactly those zeros; the wrapper does not correct or label this difference. The two calls used the same snapshot and baseline.


   Relevant real output (selected fields/excerpts; no fabricated values):

   ```text
   Without address: {"snapshotIso":"2026-10-23T05:19:05.000Z","baselineIso":"2026-10-22T05:05:05.000Z","summary":{"opened":2473,"closed":2233,"increased":1469,"reduced":892,"flipped":843,"longNotionalChange":-16550364.27,"shortNotionalChange":-16550364.27,"buyNotional":186593778.16,"sellNotional":186593778.86}}
   With address: {"snapshotIso":"2026-10-23T05:19:05.000Z","baselineIso":"2026-10-22T05:05:05.000Z","filter":{"address":"0x1234"},"summary":{"opened":0,"closed":0,"increased":0,"reduced":0,"flipped":0,"longNotionalChange":0,"shortNotionalChange":0,"buyNotional":0,"sellNotional":0}}
   ```


   Expected: The summary should either cover the advertised whole cohort/window or explicitly state that address filtering also applies. An agent must not interpret this as no changes in ETH overall.


   Suggested fix: Correct the description and add summary scope metadata, or fetch the unfiltered cohort summary separately.


3. **MEDIUM — HIP-3 market comparison silently ignores its DEX filter**

   Tool(s) and exact arguments:

   - Call 305 (strict): `flowscan_hip3_markets` `{"symbol":"TSLA","dex":"Kinetiq","days":2}`.


   What happened: symbol="TSLA", dex="Kinetiq" returned listings for XYZ, FLX, KM and Dreamcash and the all-DEX comparison. In hip3.ts the symbol branch returns before applying dex.


   Relevant real output (selected fields/excerpts; no fabricated values):

   ```text
   {"listedAs":[{"dex":"XYZ","symbol":"TSLA","asset_class":"Equities"},{"dex":"FLX","symbol":"TSLA","asset_class":"Equities"},{"dex":"KM","symbol":"TSLA","asset_class":"Equities"},{"dex":"Dreamcash","symbol":"TSLA","asset_class":"Equities"}],"comparison.dexes keys":["XYZ","FLX","KM","Dreamcash"]}
   ```


   Expected: Apply Kinetiq/KM to listedAs, comparison.dexes and related history, or reject/document this combination rather than accepting and ignoring it.


   Suggested fix: Normalize dex before branching and filter every DEX-keyed part of the single-symbol response.


4. **MEDIUM — HIP-4 question groups ignore marketKind**

   Tool(s) and exact arguments:

   - Call 304 (strict): `flowscan_hip4_markets` `{"section":"questions","marketKind":"price","limit":2}`.


   What happened: Asking for price question groups returned sports questions. The code explicitly treats every row without outcomeId as matching every marketKind, which includes question rows.


   Relevant real output (selected fields/excerpts; no fabricated values):

   ```text
   {"paging":{"total":39,"offset":0,"limit":2,"hasMore":true},"firstQuestion":{"questionId":503,"name":"template:sportsContestResult","displayName":"Bundesliga Matchday 7: SC Freiburg v FC Bayern Munich","category":"Bundesliga"}}
   ```


   Expected: The price/events/canonical filter should apply to question groups, or the tool should explain that this combination is unsupported.


   Suggested fix: Classify/filter groups using their linked outcomes, or reject marketKind with section=questions until supported.


5. **MEDIUM — Address fills silently discards endTime without startTime**

   Tool(s) and exact arguments:

   - Call 312 (strict): `flowscan_address_fills` `{"address":"0x5b5d51203a0f9079f8aeb098a6523a13f298c060","endTime":1600000000000,"limit":1}`.


   What happened: A call bounded to September 2020 returned 2,000 recent fills from October 2026. The handler selects userFills whenever startTime is absent and never applies endTime in that branch. The parameter description says endTime is used with startTime, but the invalid combination is accepted silently.


   Relevant real output (selected fields/excerpts; no fabricated values):

   ```text
   {"returned":2000,"capped":true,"coveredRange":{"from":1792682718631,"to":1792724354073,"fromIso":"2026-10-22T15:25:18.631Z","toIso":"2026-10-23T02:59:14.073Z"}}
   First returned fill: {"coin":"ETH","time":1792724354073,"timeIso":"2026-10-23T02:59:14.073Z"}
   ```


   Expected: Reject endTime without startTime, or honor it through an appropriately bounded query. Returning fills later than the supplied endTime is misleading.


   Suggested fix: Add local argument validation for the dependency, or implement an end-only query and echo the effective window.


6. **MEDIUM — Coverage says live prices are served in strict mode**

   Tool(s) and exact arguments:

   - Call 319 (strict): `flowscan_coverage` `{"topic":"live prices"}`.


   What happened: The same response says mode=strict, servedByThisServer=true and lists live prices under notServedMatches. The terminal page matches because its description mentions that live prices need direct mode; any matching page currently forces true.


   Relevant real output (selected fields/excerpts; no fabricated values):

   ```text
   {"mode":"strict","topic":"live prices","servedByThisServer":true,"pages":["/terminal"],"notServedMatches":["Live prices such as HYPE/USD or BTC, perp/spot candles, order books and recent trades (except tokenized stocks on spot, see flowscan_spot_stocks), spot token directory, perp DEX market lists"]}
   ```


   Expected: For this unsupported strict-mode capability, servedByThisServer should be false, or the answer should explicitly distinguish partial page coverage from the requested feature.


   Suggested fix: Match capabilities rather than whole page prose, or give an explicit mixed/partial result when a not-served feature also appears in a page description.


7. **MEDIUM — Some section-specific results cite routes that were not called**

   Tool(s) and exact arguments:

   - Call 296 (strict): `flowscan_builder_dashboard` `{"builder":"0x2a2b6b093a9813fbd8cddae800c3d17d46460d17","section":"topUsers","topUsersLimit":3}`.

   - Call 320 (strict): `flowscan_terminal_status` `{"include":["cohorts"]}`.

   - Call 321 (strict): `flowscan_terminal_status` `{"include":["spikes"]}`.


   What happened: The topUsers-only result cites builder-stats even though the fetch spy recorded only builder-top-users. Likewise, cohorts-only and spikes-only terminal status results cite /status while fetching /leaderboard/status and /spikes respectively. The top-user numeric comparison passed; its provenance is the defect.


   Relevant real output (selected fields/excerpts; no fabricated values):

   ```text
   Call 296: {"source":"https://www.flowscan.xyz/api/dashboard/builder-stats","actualFetches":["https://www.flowscan.xyz/api/hydromancer/builder-top-users?builder=0x2a2b6b093a9813fbd8cddae800c3d17d46460d17&window=30d"]}
   Call 320: {"source":"https://www.flowscan.xyz/api/perp-snapshot/status","actualFetches":["https://www.flowscan.xyz/api/perp-snapshot/leaderboard/status"]}
   Call 321: {"source":"https://www.flowscan.xyz/api/perp-snapshot/status","actualFetches":["https://www.flowscan.xyz/api/perp-snapshot/spikes"]}
   ```


   Expected: source should identify the actual data route. Multi-route aggregates should name their component sources.


   Suggested fix: Choose the source by section or return a sources map; retain builder identity and effective request parameters.


8. **MEDIUM — Several successful live/empty results have no timestamp or effective date range**

   Tool(s) and exact arguments:

   - Call 153 (strict): `flowscan_wallet_labels` `{"addresses":["0x010461c14e146ac35fe42271bdc1134ee31c703a","0x5b5d51203a0f9079f8aeb098a6523a13f298c060"]}`.

   - Call 296 (strict): `flowscan_builder_dashboard` `{"builder":"0x2a2b6b093a9813fbd8cddae800c3d17d46460d17","section":"topUsers","topUsersLimit":3}`.

   - Call 360 (strict): `flowscan_address_completed_trades` `{"address":"0x0000000000000000000000000000000000000000","limit":1}`.

   - Call 361 (strict): `flowscan_terminal_status` `{"include":["spikes"]}`.


   What happened: Wallet labels, topUsers-only, an empty completed-trades result and empty spike alerts contain no snapshot/fetch time. A window string such as 30d also does not say where the window ends. The server cannot fulfill the requested source-and-time convention for these results.


   Relevant real output (selected fields/excerpts; no fabricated values):

   ```text
   Full empty completed-trades result: {"source":"https://www.flowscan.xyz/api/hydromancer/info","network":"mainnet","address":"0x0000000000000000000000000000000000000000","summary":null,"paging":{"total":0,"offset":0,"limit":1,"hasMore":false},"note":"No closed trades match (the account may only have open positions, or none at all).","data":[]}
   Full spikes-only result: {"source":"https://www.flowscan.xyz/api/perp-snapshot/status","network":"mainnet","shownOn":"https://www.flowscan.xyz/terminal","data":{"spikeAlerts":{"count":0,"alerts":[]}}}
   Wallet label top-level keys: ["source","network","data"]; topUsers-only top-level keys: ["source","network","window","data"]
   ```


   Expected: Every data result should carry an as-of/fetch timestamp; windowed results should additionally report effective UTC endpoints, even when empty.


   Suggested fix: Add fetchedAtIso in the common strict envelope and preserve actual upstream snapshot times/range bounds where available.


9. **MEDIUM — The documented uniform JSON error contract is not uniform**

   Tool(s) and exact arguments:

   - Call 154 (strict): `flowscan_wallet_labels` `{"addresses":["0x1234"]}`.

   - Call 157 (strict): `flowscan_search` `{"query":""}`.

   - Call 175 (direct): `flowscan_candles` `{"coin":"__NO_SUCH_COIN__","interval":"1h","bars":24}`.


   What happened: Schema validation runs outside defineTool's try/catch, so malformed addresses, empty required strings, bad enums and numeric bounds return plain MCP error text instead of the documented {error,status,route,source} JSON. Direct coin-resolution errors are JSON, but their provenance is source="?", route="coin". No tool response stack trace was observed.


   Relevant real output (selected fields/excerpts; no fabricated values):

   ```text
   Call 154: MCP error -32602: Input validation error: Invalid arguments for tool flowscan_wallet_labels: Expected 0x + 40 hex characters at addresses[0]
   Call 157: MCP error -32602: Input validation error: Invalid arguments for tool flowscan_search: Too small: expected string to have >=1 characters at query
   Call 175: {"error":"Unknown coin '__NO_SUCH_COIN__'. Use a perp name (BTC), a HIP-3 market (xyz:TSLA), a spot pair (@107, PURR/USDC) or a spot token name (NVDAX).","status":404,"route":"coin","source":"?"}
   ```


   Expected: Input failures should use the promised parseable JSON contract and identify validation failures consistently; direct errors should not expose an unknown placeholder host.


   Suggested fix: Normalize SDK validation failures at the MCP handler boundary. For local coin resolution, use explicit validation provenance/null route rather than parsing a non-URL as a host.


10. **LOW — Whitespace-only search strings bypass minimum length checks**

   Tool(s) and exact arguments:

   - Call 155 (strict): `flowscan_wallet_labels` `{"search":"  "}`.

   - Call 158 (strict): `flowscan_search` `{"query":"   "}`.


   What happened: A whitespace query is trimmed only after Zod validates length. Search then treats the empty substring as matching everything and recommends unrelated tools. Wallet-label search similarly returned the whole directory count.


   Relevant real output (selected fields/excerpts; no fabricated values):

   ```text
   Wallet labels: {"query":"  ","total":720}
   Search: {"query":"","matched":["perpMarkets","spotStocks","builders","validators","labelledWallets","hip4Markets"],"perpMarkets":["BTC","ETH","HYPE","SOL","ZEC"],"next":["flowscan_perp_markets {market: \"BTC\"} for OI/positioning; flowscan_market_history for funding/OI history","flowscan_spot_stocks {token: \"NVDAX\"}","flowscan_builder_revenue / flowscan_builder_dashboard with the builder's address","flowscan_validator_stakers {validator: \"0xa82fe73bbd768bc15d1ef2f6142a21ff8bd762ad\"}","flowscan_address_summary with a wallet's address","flowscan_hip4_markets {search: \"\"}"]}
   ```


   Expected: Trim before checking minimum length and return an input error for a blank query.


   Suggested fix: Use trim().min(...) in these query schemas, with the existing portable listed schema.


11. **LOW — Invalid HIP-4 identifiers are accepted and can produce unrelated labels**

   Tool(s) and exact arguments:

   - Call 273 (strict): `flowscan_search` `{"query":"#14739"}`.

   - Call 316 (strict): `flowscan_hip4_outcome` `{"outcomeId":-1,"days":1}`.

   - Call 317 (strict): `flowscan_hip4_labels` `{"assets":["not-an-asset","#14739"]}`.


   What happened: Search classifies suffix 9 as NO even though the supported sides are 0 and 1. A negative outcome id succeeds with invented negative asset ids and empty candles. The labels tool forwards invalid input and returned #14730/#14731 labels even though neither id was requested.


   Relevant real output (selected fields/excerpts; no fabricated values):

   ```text
   Search: {"source":"https://www.flowscan.xyz/api/hip-4/labels","network":"mainnet","data":{"query":"#14739","type":"HIP-4 outcome asset id","outcomeId":1473,"side":"NO","next":["flowscan_hip4_labels {assets: [\"#14739\"]} for its label","flowscan_hip4_outcome {outcomeId: 1473} for candles"]}}
   Negative outcome: {"source":"https://www.flowscan.xyz/api/hip-4/-1","network":"mainnet","data":{"generatedAt":1792733229932,"outcomeId":-1,"yesAssetId":"#-10","noAssetId":"#-11","interval":"1h","yesCandles":[],"noCandles":[],"settledOutcome":null,"yesStats":null,"noStats":null,"candleColumns":["openTime","open","high","low","close","volume","trades"]}}
   Labels: {"source":"https://www.flowscan.xyz/api/hip-4/labels","network":"mainnet","data":{"labels":{"#14730":"Arsenal · Yes","#14731":"Arsenal · No"}}}
   ```


   Expected: Reject malformed/negative ids and unsupported side suffixes; report unknown identifiers without assigning a false YES/NO identity. A labels result should account for the requested ids.


   Suggested fix: Validate outcomeId bounds and asset-id syntax/suffixes; verify label keys against requested ids and expose missing/invalid entries.


12. **LOW — Builder Intelligence accepts a reversed date range and returns unrelated history**

   Tool(s) and exact arguments:

   - Call 310 (strict): `flowscan_builder_intelligence_detail` `{"builderId":"pvp","startDate":"2026-10-22","endDate":"2026-10-21","sections":["metadata"]}`.


   What happened: The request starts after it ends, yet succeeds. Its metadata covers 2024-10-27..2026-09-21 rather than the supplied October 2026 dates. This contrasts with the local validation in the builder revenue tools.


   Relevant real output (selected fields/excerpts; no fabricated values):

   ```text
   {"builder_id":"pvp","builder_name":"pvp.trade","builder_address":"0x0cbf655b0d22ae71fba3a674b0e1c0c7e7f975af","builder_category":"Telegram trading","analysis_date":"2026-09-21T20:15:43.147759","export_mode":"full","date_range":{"start":"2024-10-27","end":"2026-09-21"},"competitors":[]}
   ```


   Expected: Reject a reversed range before any request; identify any unsupported or ignored date filtering.


   Suggested fix: Reuse common date-range validation for the Intelligence tools, and confirm the returned effective range matches the request.


13. **LOW — Order-book mantissa is silently ignored without nSigFigs=5**

   Tool(s) and exact arguments:

   - Call 352 (direct): `flowscan_order_book` `{"coin":"BTC","mantissa":2}`.


   What happened: The schema describes mantissa as only valid with nSigFigs=5, but the call succeeded and omitted mantissa from the actual subscription.


   Relevant real output (selected fields/excerpts; no fabricated values):

   ```text
   {"request":{"method":"subscribe","subscription":{"type":"l2Book","coin":"BTC"}},"fetchedAtIso":"2026-10-23T05:27:50.823Z"}
   ```


   Expected: Reject this invalid parameter combination, or explicitly report that it was ignored.


   Suggested fix: Validate the cross-field requirement before opening the WebSocket.


14. **LOW — The reference and CLI help still advertise the old tool counts**

   Tool(s) and exact arguments:

   - Call 1 (strict): `flowscan_coverage` `{}`.

   - Call 347 (direct): `flowscan_terminal_status` `{"include":["__INVALID_ENUM__"]}`.


   What happened: The reference introduction and mode table say 45 strict / 59 direct, and its health example says 45. Its tool table correctly says 54. CLI --help also says 59 instead of 45. Actual tools/list counts were 54 and 68; both coverage maps advertised all registered data tools. The reference schema-size estimates are also stale.


   Relevant real output (selected fields/excerpts; no fabricated values):

   ```text
   docs/reference.md: "45 read-only tools"; mode table: "45" / "59: the same 45 plus 14".
   CLI output:   FLOWSCAN_HYPERLIQUID_DIRECT=1       hyperliquid-direct mode (59 tools instead of 45)
   Measured tools/list schema payloads: strict 72,775 chars; direct 86,511 chars (compact JSON array).
   ```


   Expected: Use 54 strict / 68 direct consistently, including CLI help and examples.


   Suggested fix: Generate counts from shared registration metadata and update the measured schema sizes.


15. **LOW — The advertised PAPER panel is blocked by general market resolution**

   Tool(s) and exact arguments:

   - Call 282 (strict): `flowscan_perp_market_detail` `{"market":"para:PAPER","sections":["summary"]}`.


   What happened: The documented para:PAPER recipe fails with Market not found before requesting /api/paper. The raw /api/paper route still exists and returns useful structured availability errors. Thus the coverage matrix's stated pass-through of the unavailable panel cannot be reached on this snapshot.


   Relevant real output (selected fields/excerpts; no fabricated values):

   ```text
   Tool: {"error":"Market 'para:PAPER' not found in the perp snapshot. Use flowscan_perp_markets to list markets (HIP-3 markets are prefixed, e.g. 'xyz:TSLA').","status":404,"route":"/api/perp-snapshot/markets","source":"www.flowscan.xyz"}
   Raw GET /api/paper, HTTP 200: {"asset":"PAPER","totalSupply":null,"perpPriceUsd":null,"impliedParagonValuationUsd":null,"topPositions":null,"topHedgers":null,"positionSnapshot":null,"hedgerSnapshot":null,"errors":{"valuation":{"error":"PAPER data source unavailable"},"positions":{"error":"PAPER data source unavailable"},"hedgers":{"error":"PAPER snapshot refresh is backing off; retry shortly"}},"complete":false}
   ```


   Expected: Expose the panel's actual unavailable status, or mark this recipe as currently unavailable in coverage instead of claiming the panel is served.


   Suggested fix: Handle the PAPER auxiliary panel independently of whether PAPER appears in the position snapshot, or qualify the coverage entry.


16. **LOW — Unit-operation totals are unfiltered without saying so**

   Tool(s) and exact arguments:

   - Call 353 (direct): `flowscan_address_unit_operations` `{"address":"0x5b5d51203a0f9079f8aeb098a6523a13f298c060","direction":"deposit","limit":1}`.


   What happened: A deposit-only call returned no rows and paging.total=0, but totals.operations=2 and totalUsd=1164.29 describe withdrawals. These are totals of all operations before the direction filter, and the response does not state that scope.


   Relevant real output (selected fields/excerpts; no fabricated values):

   ```text
   {"totals":{"operations":2,"deposits":0,"withdrawals":2,"totalUsd":1164.29,"byAsset":{"BTC":{"count":2,"amount":0.01425429}}},"paging":{"total":0,"offset":0,"limit":1,"hasMore":false},"data":[],"fetchedAtIso":"2026-10-23T05:27:51.734Z"}
   ```


   Expected: Either total the matched operations or clearly label the totals as all operations and supply matched totals separately.


   Suggested fix: Apply direction before aggregation, or add explicit totalsOver/allOperationsTotals metadata.


17. **LOW — Order-flow bar counts are inconsistent at an exact interval boundary**

   Tool(s) and exact arguments:

   - Call 366 (strict): `flowscan_order_flow` `{"market":"BTC","kind":"footprint","bars":4,"endTime":1792720800000}`.

   - Call 367 (strict): `flowscan_order_flow` `{"market":"BTC","kind":"flow","bars":4,"endTime":1792720800000}`.

   - Call 369 (strict): `flowscan_order_flow` `{"market":"BTC","kind":"footprint","bars":1,"endTime":1792720800000}`.

   - Call 370 (strict): `flowscan_order_flow` `{"market":"BTC","kind":"flow","bars":1,"endTime":1792720800000}`.


   What happened: With the same historical endTime at 02:00 UTC, bars=4 returned only 3 bars (23:00..01:00), but bars=1 returned the 02:00 bar. That last bar therefore exists, but is omitted from the multi-bar response. The math checks passed for the returned rows; they did not establish that the requested window was complete. The raw route treats the start<end range as end-exclusive, while the wrapper computes start as if the end bar were included.


   Relevant real output (selected fields/excerpts; no fabricated values):

   ```text
   Call 366: {"kind":"footprint","interval":"1h","candles":3,"fromIso":"2026-10-22T23:00:00.000Z","toIso":"2026-10-23T01:00:00.000Z"}
   Call 367: {"kind":"flow","interval":"1h","candles":3,"fromIso":"2026-10-22T23:00:00.000Z","toIso":"2026-10-23T01:00:00.000Z"}
   Call 369: {"kind":"footprint","interval":"1h","candles":1,"fromIso":"2026-10-23T02:00:00.000Z","toIso":"2026-10-23T02:00:00.000Z"}
   Call 370: {"kind":"flow","interval":"1h","candles":1,"fromIso":"2026-10-23T02:00:00.000Z","toIso":"2026-10-23T02:00:00.000Z"}
   ```


   Expected: Use one consistent meaning of endTime and return the requested available number of bars for both one-bar and multi-bar queries.


   Suggested fix: Align start/end to the route's actual interval semantics and handle start=end explicitly; check the requested bar count at exact boundaries.


## Tools that worked well

All 54 strict tools and all 14 additional direct tools succeeded on their realistic baseline call. In particular:

- `flowscan_perp_market_detail`: independently recomputed all four above/below liquidation-cluster notional totals. Totals covered all clusters, even with only two rows returned.

- `flowscan_twaps`: raw count and per-side executed USD matched, with clear snapshot/live-update times and paging.

- `flowscan_liquidations`: recent count/side notionals and 24-hour minute-bucket totals matched raw routes. The history check found 85 nonempty buckets, long USD 37,061,797.60 and short USD 307,927.22 for 2026-10-22T05:28:00.000Z..2026-10-23T05:28:00.000Z.

- `flowscan_order_flow`: both historical footprint and open/close-flow totals matched their raw rows. The separate boundary-window defect remains listed above.

- `flowscan_address_completed_trades`: 54 trades, 32 wins, 22 losses, 59.26% win rate and 74,901,471.102418 USDC net PnL matched raw data; covered close times were 2025-08-23T12:35:14.340Z through 2026-10-22T23:57:57.413Z.

- `flowscan_market_history`: funding hourly fractions/simple annualization, slippage bps and OI count/latest/change matched the raw POST route. The BTC 30-day OI check returned 181 candles and -9.56% change; actual sample times are in the recorded response below. Large 1y/5m OI queries were rejected with a useful candle-count hint.

- `flowscan_perp_markets` / `flowscan_perp_positions`: lowercase BTC worked; SNDK ambiguity returned xyz:SNDK/io:SNDK candidates; TSLA resolved correctly. Trader cohorts, leverage bounds, isolated margin and address filtering worked. A combined leaderboard/10–20x/isolated query matched 25 positions, with returned rows identical to raw. `marketSummary` remained distinct from filtered totals.

- `flowscan_builders_leaderboard`: change/changePct/drop ranking worked; the top three 7d change ids matched raw. Invalid change/1d combinations were rejected. Builder top-user fees/volumes matched raw for both displayed users.

- `flowscan_weekend_coin_changes`: lowercase prefixed TSLA and funding worked. For 2026-10-16T20:00Z..2026-10-18T22:00Z, raw funding count 50 and sum -0.000326236 matched; the preceding weekend also matched. BTC returned an explicit no-weekend-data explanation.

- `flowscan_wallet_labels`: known-address bundle fallback identified HLP Strategy A even though the lookup API name was null; trader tags decoded as expected. Wintermute search returned three matches and honored limit=2.

- `flowscan_hip4_markets`: active price/event/deployer filtering and volume ranking worked. The independently counted active price markets matched paging.total=144 (generatedAt=1792733220587, 2026-10-23T05:27:00.587Z). The question-group combination is the exception above.

- Kinetiq, TradeXYZ, Felix, HyENA, Ventuals and Entropy.io were accepted by `flowscan_revenue_deployer_fees`, `flowscan_address_summary`, all four DEX-taking HIP-3 tools, and direct `flowscan_prices` / `flowscan_perp_dexs`. Inactive DEXs legitimately returned empty/zero current results. The combined symbol/dex exception is listed above.

- All 14 direct tools worked: live-feed snapshot, live-derived block and transaction, prices, candles, L2 book, recent trades, spot directory, perp DEX directory, validator summaries, borrow/lend reserves, portfolio, EVM balance and Unit operations. Direct successes carried source, shownOn, mode and fetchedAtIso. Future candles returned no rows; no forecast data was produced.

## Limits and things not tested

- I fetched the six requested page documents and checked their titles, but did not execute their browser applications or visually compare interactive panels. Doing that without isolating page network traffic could contact hosts outside the user-authorized manual host. Raw API comparisons provide the data checks recorded here.

- I did not call Hyperliquid hosts directly for ground truth. Direct tools were exercised over stdio and checked against their returned requests, fields and smoke assertions. I did not run `scenarios.ts --upstream`, because it performs raw upstream requests from the QA process itself, contrary to the manual-host restriction.

- This is broad sampled testing, not every parameter combination or every available market/address. No production rate limit was deliberately induced. Retry/429/host-guard behavior was exercised by the offline tests, and no load test was run.

- The npm dependency advisories are recorded exactly as install printed them; I did not run an external advisory investigation or claim that the high advisory is exploitable in this server.

- No hosted Gemini/OpenAI/Claude model evaluation was run. Portability evidence is the actual listed schemas, conformance suite, portability unit tests and manual inspection, not a live vendor API acceptance claim.

- PAPER source availability is an upstream site limitation. The separately reported defect is that the advertised tool recipe cannot even expose that existing structured availability response.

## Evidence: arithmetic comparisons

These are the actual comparison outputs. The first comparison used exact JSON number equality and failed only because the two addition orders differed by approximately 1.86e-9 USDC. The follow-up used a 1e-6 USDC tolerance and passed. No figures were rounded into a hidden pass.

```json
[
  {
    "name": "HyperCore range total USDC",
    "ok": false,
    "actual": 11301800.472081998,
    "expected": 11301800.472082
  },
  {
    "name": "Liquidation clusters belowPrice.longNotional",
    "ok": true,
    "actual": 703807427.77,
    "expected": 703807427.77
  },
  {
    "name": "Liquidation clusters belowPrice.shortNotional",
    "ok": true,
    "actual": 0,
    "expected": 0
  },
  {
    "name": "Liquidation clusters abovePrice.longNotional",
    "ok": true,
    "actual": 139638229.21,
    "expected": 139638229.21
  },
  {
    "name": "Liquidation clusters abovePrice.shortNotional",
    "ok": true,
    "actual": 168291177.09,
    "expected": 168291177.09
  },
  {
    "name": "TWAP count",
    "ok": true,
    "actual": 32,
    "expected": 32
  },
  {
    "name": "TWAP buy executed USD",
    "ok": true,
    "actual": 957109.59,
    "expected": 957109.59
  },
  {
    "name": "TWAP sell executed USD",
    "ok": true,
    "actual": 166984.82,
    "expected": 166984.82
  },
  {
    "name": "Completed trades count",
    "ok": true,
    "actual": 54,
    "expected": 54
  },
  {
    "name": "Completed trades net PnL",
    "ok": true,
    "actual": 74901471.102418,
    "expected": 74901471.102418
  },
  {
    "name": "Completed trades win rate",
    "ok": true,
    "actual": 59.26,
    "expected": 59.26
  },
  {
    "name": "OI history count",
    "ok": true,
    "actual": 181,
    "expected": 181
  },
  {
    "name": "OI history latest USD",
    "ok": true,
    "actual": 3585171988.41956,
    "expected": 3585171988.41956
  },
  {
    "name": "OI change percent",
    "ok": true,
    "actual": -9.56,
    "expected": -9.56
  },
  {
    "name": "Funding mean hourly fraction",
    "ok": true,
    "actual": 0.0000103799,
    "expected": 0.0000103799
  },
  {
    "name": "Funding simple annualized percent",
    "ok": true,
    "actual": 9.093,
    "expected": 9.093
  },
  {
    "name": "Slippage buy median bps",
    "ok": true,
    "actual": 0.965,
    "expected": 0.965
  },
  {
    "name": "Builder mover ids",
    "ok": true,
    "actual": [
      "hyperdash",
      "metamask",
      "0x9c87bb379d5ff2fcbf2f83e619f9fccb95a40ad9"
    ],
    "expected": [
      "hyperdash",
      "metamask",
      "0x9c87bb379d5ff2fcbf2f83e619f9fccb95a40ad9"
    ]
  },
  {
    "name": "Builder top users",
    "ok": true,
    "actual": [
      {
        "address": "0x538d89d131b56c7736be4e2eeedc3c51463980de",
        "feesUsd": 91582.87218800014,
        "volumeUsd": 183165808.97197086
      },
      {
        "address": "0x696d1265c8fc4f14797abebfae3c43ebfa9d8e28",
        "feesUsd": 86905.6055359999,
        "volumeUsd": 173811239.7286445
      }
    ],
    "expected": [
      {
        "address": "0x538d89d131b56c7736be4e2eeedc3c51463980de",
        "feesUsd": 91582.87218800014,
        "volumeUsd": 183165808.97197086
      },
      {
        "address": "0x696d1265c8fc4f14797abebfae3c43ebfa9d8e28",
        "feesUsd": 86905.6055359999,
        "volumeUsd": 173811239.7286445
      }
    ]
  },
  {
    "name": "HIP4 price count",
    "ok": true,
    "actual": 144,
    "expected": 144
  },
  {
    "name": "Weekend funding hours 2026-10-16T20:00:00.000Z",
    "ok": true,
    "actual": 50,
    "expected": 50
  },
  {
    "name": "Weekend funding sum 2026-10-16T20:00:00.000Z",
    "ok": true,
    "actual": -0.000326236,
    "expected": -0.000326236
  },
  {
    "name": "Weekend funding hours 2026-10-09T20:00:00.000Z",
    "ok": true,
    "actual": 50,
    "expected": 50
  },
  {
    "name": "Weekend funding sum 2026-10-09T20:00:00.000Z",
    "ok": true,
    "actual": 0.000280619,
    "expected": 0.000280619
  }
]
```

```text
{"name":"Liquidation history buckets","actual":85,"expected":85,"ok":true}
{"name":"Liquidation history longNotional","actual":37061797.6,"expected":37061797.6,"ok":true}
{"name":"Liquidation history shortNotional","actual":307927.22,"expected":307927.22,"ok":true}
{"name":"Recent liquidation count","actual":40,"expected":40,"ok":true}
{"name":"Recent liquidation long USD","actual":29081.84,"expected":29081.84,"ok":true}
{"name":"Recent liquidation short USD","actual":305239.71,"expected":305239.71,"ok":true}
{"name":"Order footprint candle count","actual":3,"expected":3,"ok":true}
{"name":"Order footprint buyUsd","actual":173114360.63,"expected":173114360.63,"ok":true}
{"name":"Order footprint sellUsd","actual":138399778.29,"expected":138399778.29,"ok":true}
{"name":"Order footprint trades","actual":32131,"expected":32131,"ok":true}
{"name":"Order flow candle count","actual":3,"expected":3,"ok":true}
{"name":"Order flow openedUsd","actual":306526600.52,"expected":306526600.52,"ok":true}
{"name":"Order flow closedUsd","actual":316501677.31,"expected":316501677.31,"ok":true}
{"name":"Order flow realizedPnlUsd","actual":-96519.28,"expected":-96519.28,"ok":true}
{"name":"Perp leverage/margin/cohort count","actual":25,"expected":25,"ok":true}
{"name":"Perp leverage/margin/cohort rows","actual":[["0x0f0ff7875ebf8343c5c5eb43ae29233a80048ec0",16,"isolated"],["0xe67dbf2d051106b42104c1a6631af5e5a458b682",11,"isolated"],["0x8ccee825f44c99fbdaa79464d5eb8beed9313da2",13,"isolated"]],"expected":[["0x0f0ff7875ebf8343c5c5eb43ae29233a80048ec0",16,"isolated"],["0xe67dbf2d051106b42104c1a6631af5e5a458b682",11,"isolated"],["0x8ccee825f44c99fbdaa79464d5eb8beed9313da2",13,"isolated"]],"ok":true}
{"name":"Perp whole cohort marketSummary OI","actual":1717305367.12,"expected":1717305367.12,"ok":true}
{"name":"HyperCore total re-evaluated with 1e-6 USDC tolerance","actual":11301800.472081998,"expected":11301800.472082,"ok":true}
MATH 18/18
```

## Evidence: tool-by-tool coverage

The first realistic call and its two baseline edge calls are shown below. The terminal-status sweep initially made one baseline edge call; calls 268 and 269 below supplied the additional empty-array and invalid-enum cases. Every listed tool therefore has at least two executed bad/edge cases. The complete call ledger follows this table.

| Mode | Tool | Realistic arguments | Realistic result | Edge arguments |
| --- | --- | --- | --- | --- |
| strict | `flowscan_coverage` | `{}` | JSON success, 9294 chars | `{"topic":""}`; `{"topic":"__NOT_A_TOPIC_123__"}` |
| strict | `flowscan_stablecoin_margin` | `{}` | JSON success, 1528 chars | `{"fields":["__missing_field__"]}`; `{"fields":123}` |
| strict | `flowscan_peers` | `{}` | JSON success, 5022 chars | `{"fields":["__missing_field__"]}`; `{"section":"__INVALID_ENUM__"}` |
| strict | `flowscan_staking_overview` | `{"limit":10}` | JSON success, 2134 chars | `{"limit":10,"search":"__NO_SUCH_NAME__"}`; `{"limit":10,"sortBy":"__INVALID_ENUM__"}` |
| strict | `flowscan_validator_stakers` | `{"validator":"0xa82fe73bbd768bc15d1ef2f6142a21ff8bd762ad","limit":20}` | JSON success, 2069 chars | `{"validator":"__NO_SUCH_VALIDATOR__","limit":20}`; `{"validator":"0xa82fe73bbd768bc15d1ef2f6142a21ff8bd762ad","limit":-1}` |
| strict | `flowscan_staking_events` | `{"validator":"0xa82fe73bbd768bc15d1ef2f6142a21ff8bd762ad","limit":20}` | JSON success, 7354 chars | `{"validator":"__NO_SUCH_VALIDATOR__","limit":20}`; `{"validator":"0xa82fe73bbd768bc15d1ef2f6142a21ff8bd762ad","limit":-1}` |
| strict | `flowscan_revenue_hypercore_fees` | `{"days":14}` | JSON success, 1690 chars | `{"days":14,"startDate":"2099-01-02","endDate":"2099-01-01"}`; `{"days":14,"limit":-1}` |
| strict | `flowscan_revenue_priority_gas` | `{"days":7}` | JSON success, 1315 chars | `{"days":7,"startDate":"2099-01-02","endDate":"2099-01-01"}`; `{"days":7,"limit":-1}` |
| strict | `flowscan_revenue_deployer_fees` | `{"days":7,"dex":"xyz"}` | JSON success, 1312 chars | `{"days":7,"dex":"__NO_SUCH_DEX__"}`; `{"days":7,"dex":"xyz","limit":-1}` |
| strict | `flowscan_revenue_summary` | `{}` | JSON success, 2006 chars | `{"fields":["__missing_field__"]}`; `{"fields":123}` |
| strict | `flowscan_perp_markets` | `{"limit":10}` | JSON success, 3224 chars | `{"limit":10,"market":"__NO_SUCH_MARKET__"}`; `{"limit":10,"sortBy":"__INVALID_ENUM__"}` |
| strict | `flowscan_perp_positions` | `{"market":"BTC","limit":10}` | JSON success, 4686 chars | `{"market":"BTC","limit":10,"address":"0x1234"}`; `{"market":"BTC","limit":10,"side":"__INVALID_ENUM__"}` |
| strict | `flowscan_address_perp_positions` | `{"address":"0x010461c14e146ac35fe42271bdc1134ee31c703a","limit":10}` | JSON success, 2669 chars | `{"address":"0x1234","limit":10}`; `{"address":"0x010461c14e146ac35fe42271bdc1134ee31c703a","limit":10,"side":"__INVALID_ENUM__"}` |
| strict | `flowscan_market_history` | `{"kind":"funding","coin":"BTC"}` | JSON success, 3038 chars | `{"kind":"funding","coin":"__NO_SUCH_COIN__"}`; `{"kind":"__INVALID_ENUM__","coin":"BTC"}` |
| strict | `flowscan_address_summary` | `{"address":"0x010461c14e146ac35fe42271bdc1134ee31c703a"}` | JSON success, 19373 chars | `{"address":"0x1234"}`; `{"address":""}` |
| strict | `flowscan_address_orders` | `{"address":"0x010461c14e146ac35fe42271bdc1134ee31c703a","limit":20}` | JSON success, 3523 chars | `{"address":"0x1234","limit":20}`; `{"address":"0x010461c14e146ac35fe42271bdc1134ee31c703a","limit":20,"kind":"__INVALID_ENUM__"}` |
| strict | `flowscan_address_fills` | `{"address":"0x010461c14e146ac35fe42271bdc1134ee31c703a","limit":20}` | JSON success, 10102 chars | `{"address":"0x1234","limit":20}`; `{"address":"0x010461c14e146ac35fe42271bdc1134ee31c703a","limit":-1}` |
| strict | `flowscan_address_ledger` | `{"address":"0x5b5d51203a0f9079f8aeb098a6523a13f298c060","kind":"funding"}` | JSON success, 27071 chars | `{"address":"0x1234","kind":"funding"}`; `{"address":"0x5b5d51203a0f9079f8aeb098a6523a13f298c060","kind":"__INVALID_ENUM__"}` |
| strict | `flowscan_address_staking` | `{"address":"0x010461c14e146ac35fe42271bdc1134ee31c703a"}` | JSON success, 159 chars | `{"address":"0x1234"}`; `{"address":""}` |
| strict | `flowscan_address_vaults_subaccounts` | `{"address":"0x010461c14e146ac35fe42271bdc1134ee31c703a"}` | JSON success, 123 chars | `{"address":"0x1234"}`; `{"address":""}` |
| strict | `flowscan_address_extras` | `{"address":"0x010461c14e146ac35fe42271bdc1134ee31c703a","kind":"rateLimit"}` | JSON success, 218 chars | `{"address":"0x1234","kind":"rateLimit"}`; `{"address":"0x010461c14e146ac35fe42271bdc1134ee31c703a","kind":"__INVALID_ENUM__"}` |
| strict | `flowscan_spot_stocks` | `{}` | JSON success, 6814 chars | `{"token":"__NO_SUCH_TOKEN__"}`; `{"section":"__INVALID_ENUM__"}` |
| strict | `flowscan_weekend_weeks` | `{"limit":5,"includeSchedule":true}` | JSON success, 6707 chars | `{"limit":5,"includeSchedule":true,"fields":["__missing_field__"]}`; `{"limit":-1,"includeSchedule":true}` |
| strict | `flowscan_weekend_prices` | `{"week":1789761600000,"market":"TSLA"}` | JSON success, 502 chars | `{"week":1789761600000,"market":"__NO_SUCH_MARKET__"}`; `{"week":1789761600000,"market":"TSLA","fields":123}` |
| strict | `flowscan_weekend_positions` | `{"week":1789761600000,"limit":10}` | JSON success, 4423 chars | `{"week":1789761600000,"limit":10,"market":"__NO_SUCH_MARKET__"}`; `{"week":1789761600000,"limit":10,"sortBy":"__INVALID_ENUM__"}` |
| strict | `flowscan_weekend_coin_changes` | `{"coin":"xyz:TSLA"}` | JSON success, 8832 chars | `{"coin":"__NO_SUCH_COIN__"}`; `{"coin":""}` |
| strict | `flowscan_hip4_markets` | `{"limit":30}` | JSON success, 9614 chars | `{"limit":30,"search":"__NO_SUCH_NAME__"}`; `{"limit":30,"section":"__INVALID_ENUM__"}` |
| strict | `flowscan_hip4_outcome` | `{"outcomeId":1487}` | JSON success, 23382 chars | `{"outcomeId":1487,"fields":["__missing_field__"]}`; `{"outcomeId":1487,"interval":"__INVALID_ENUM__"}` |
| strict | `flowscan_hip4_labels` | `{"assets":["#14870"]}` | JSON success, 161 chars | `{"assets":""}`; `{"assets":123}` |
| strict | `flowscan_hip3_overview` | `{}` | JSON success, 12786 chars | `{"fields":["__missing_field__"]}`; `{"fields":123}` |
| strict | `flowscan_hip3_daily` | `{"metric":"volume","days":14}` | JSON success, 2137 chars | `{"metric":"volume","days":14,"dex":"__NO_SUCH_DEX__"}`; `{"metric":"__INVALID_ENUM__","days":14}` |
| strict | `flowscan_hip3_markets` | `{"dex":"XYZ","assetClass":"Equities","limit":20}` | JSON success, 1762 chars | `{"dex":"__NO_SUCH_DEX__","assetClass":"Equities","limit":20}`; `{"dex":"XYZ","assetClass":"__INVALID_ENUM__","limit":20}` |
| strict | `flowscan_hip3_dex` | `{"dex":"XYZ","days":7,"limit":10}` | JSON success, 1951 chars | `{"dex":"__NO_SUCH_DEX__","days":7,"limit":10}`; `{"dex":"XYZ","days":7,"limit":-1}` |
| strict | `flowscan_hip3_builders` | `{"limit":10}` | JSON success, 16962 chars | `{"limit":10,"dex":"__NO_SUCH_DEX__"}`; `{"limit":10,"window":"__INVALID_ENUM__"}` |
| strict | `flowscan_hip3_binance_comparison` | `{"limit":10}` | JSON success, 1605 chars | `{"limit":10,"fields":["__missing_field__"]}`; `{"limit":10,"sortBy":"__INVALID_ENUM__"}` |
| strict | `flowscan_builders_leaderboard` | `{}` | JSON success, 8933 chars | `{"search":"__NO_SUCH_NAME__"}`; `{"metric":"__INVALID_ENUM__"}` |
| strict | `flowscan_builders_summary` | `{"limit":10}` | JSON success, 4686 chars | `{"limit":10,"fields":["__missing_field__"]}`; `{"limit":-1}` |
| strict | `flowscan_builders_daily_revenue` | `{"top":5}` | JSON success, 8899 chars | `{"top":5,"builder":"__NO_SUCH_BUILDER__"}`; `{"top":5,"fields":123}` |
| strict | `flowscan_builders_user_series` | `{"builder":"pvp","days":14}` | JSON success, 696 chars | `{"builder":"__NO_SUCH_BUILDER__","days":14}`; `{"builder":"pvp","days":14,"metric":"__INVALID_ENUM__"}` |
| strict | `flowscan_builder_dashboard` | `{"builder":"0x0cbf655b0d22ae71fba3a674b0e1c0c7e7f975af"}` | JSON success, 12144 chars | `{"builder":"__NO_SUCH_BUILDER__"}`; `{"builder":"0x0cbf655b0d22ae71fba3a674b0e1c0c7e7f975af","window":"__INVALID_ENUM__"}` |
| strict | `flowscan_builder_intelligence_list` | `{"limit":10}` | JSON success, 4201 chars | `{"limit":10,"search":"__NO_SUCH_NAME__"}`; `{"limit":10,"sortBy":"__INVALID_ENUM__"}` |
| strict | `flowscan_builder_intelligence_detail` | `{"builderId":"pvp"}` | JSON success, 1948 chars | `{"builderId":"__NO_SUCH_BUILDER__"}`; `{"builderId":"pvp","limit":-1}` |
| strict | `flowscan_builder_intelligence_summary` | `{}` | JSON success, 10726 chars | `{"startDate":"2099-01-02","endDate":"2099-01-01"}`; `{"fields":123}` |
| strict | `flowscan_builder_lookup` | `{"query":"fomo"}` | JSON success, 1357 chars | `{"query":"fomo","limit":-1}`; `{"query":123}` |
| strict | `flowscan_builder_revenue` | `{"builder":"0x2a2b6b093a9813fbd8cddae800c3d17d46460d17","days":45}` | JSON success, 5520 chars | `{"builder":"__NO_SUCH_BUILDER__","days":45}`; `{"builder":"0x2a2b6b093a9813fbd8cddae800c3d17d46460d17","days":45,"limit":-1}` |
| strict | `flowscan_terminal_status` | `{}` | JSON success, 2537 chars | `{"include":123}`; `{"include":[]}`; `{"include":["__INVALID_ENUM__"]}` |
| strict | `flowscan_perp_market_detail` | `{"market":"btc","whalesLimit":5,"clustersLimit":5}` | JSON success, 5642 chars | `{"market":"__NO_SUCH_MARKET__","whalesLimit":5,"clustersLimit":5}`; `{"market":"","whalesLimit":5,"clustersLimit":5}` |
| strict | `flowscan_position_changes` | `{"market":"ETH","window":"24h","limit":5}` | JSON success, 2815 chars | `{"market":"ETH","window":"24h","limit":5,"address":"0x1234"}`; `{"market":"ETH","window":"__INVALID_ENUM__","limit":5}` |
| strict | `flowscan_twaps` | `{"market":"BTC","limit":5}` | JSON success, 3115 chars | `{"market":"__NO_SUCH_MARKET__","limit":5}`; `{"market":"BTC","limit":5,"side":"__INVALID_ENUM__"}` |
| strict | `flowscan_liquidations` | `{"limit":10}` | JSON success, 3900 chars | `{"limit":10,"market":"__NO_SUCH_MARKET__"}`; `{"limit":10,"view":"__INVALID_ENUM__"}` |
| strict | `flowscan_order_flow` | `{"market":"ETH","bars":6}` | JSON success, 1493 chars | `{"market":"__NO_SUCH_MARKET__","bars":6}`; `{"market":"ETH","bars":6,"kind":"__INVALID_ENUM__"}` |
| strict | `flowscan_wallet_labels` | `{"addresses":["0x010461c14e146ac35fe42271bdc1134ee31c703a","0x5b5d51203a0f9079f8aeb098a6523a13f298c060"]}` | JSON success, 592 chars | `{"addresses":["0x1234"]}`; `{"search":"  "}` |
| strict | `flowscan_search` | `{"query":"tsla"}` | JSON success, 380 chars | `{"query":""}`; `{"query":"   "}` |
| strict | `flowscan_address_completed_trades` | `{"address":"0x5b5d51203a0f9079f8aeb098a6523a13f298c060","limit":5}` | JSON success, 4001 chars | `{"address":"0x1234","limit":5}`; `{"address":"0x5b5d51203a0f9079f8aeb098a6523a13f298c060","limit":5,"side":"__INVALID_ENUM__"}` |
| direct | `flowscan_live_feed` | `{"seconds":4,"limit":10}` | JSON success, 6766 chars | `{"seconds":4,"limit":10,"include":"__INVALID_ENUM__"}`; `{"seconds":123,"limit":10}` |
| direct | `flowscan_block` | `{"height":1193974397,"limit":5}` | JSON success, 2215 chars | `{"height":0,"limit":5}`; `{"height":1193974397,"limit":5,"status":"__INVALID_ENUM__"}` |
| direct | `flowscan_transaction` | `{"hash":"0x19c4de3eb31295121b3e04472a9a7d0000fff6244e15b3e4bd8d899172166efc"}` | JSON success, 856 chars | `{"hash":"0x1234"}`; `{"hash":""}` |
| direct | `flowscan_prices` | `{"coins":["BTC","ETH","HYPE","xyz:TSLA"]}` | JSON success, 2063 chars | `{"coins":["__NO_SUCH_COIN__"]}`; `{"coins":["btc","TSLA","SNDK"]}` |
| direct | `flowscan_candles` | `{"coin":"BTC","interval":"1h","bars":24}` | JSON success, 3522 chars | `{"coin":"__NO_SUCH_COIN__","interval":"1h","bars":24}`; `{"coin":"BTC","interval":"__INVALID_ENUM__","bars":24}` |
| direct | `flowscan_order_book` | `{"coin":"BTC"}` | JSON success, 1859 chars | `{"coin":"__NO_SUCH_COIN__"}`; `{"coin":"BTC","mantissa":"__INVALID_ENUM__"}` |
| direct | `flowscan_recent_trades` | `{"coin":"BTC","limit":10}` | JSON success, 3706 chars | `{"coin":"__NO_SUCH_COIN__","limit":10}`; `{"coin":"BTC","limit":-1}` |
| direct | `flowscan_spot_tokens` | `{"search":"NVDA"}` | JSON success, 901 chars | `{"search":"__NO_SUCH_NAME__"}`; `{"search":"NVDA","sortBy":"__INVALID_ENUM__"}` |
| direct | `flowscan_perp_dexs` | `{}` | JSON success, 3213 chars | `{"dex":"__NO_SUCH_DEX__"}`; `{"dex":123}` |
| direct | `flowscan_validator_summaries` | `{}` | JSON success, 10687 chars | `{"search":"__NO_SUCH_NAME__"}`; `{"window":"__INVALID_ENUM__"}` |
| direct | `flowscan_borrow_lend_reserves` | `{}` | JSON success, 1546 chars | `{"token":"__NO_SUCH_TOKEN__"}`; `{"token":123}` |
| direct | `flowscan_address_portfolio` | `{"address":"0x010461c14e146ac35fe42271bdc1134ee31c703a"}` | JSON success, 17236 chars | `{"address":"0x1234"}`; `{"address":"0x010461c14e146ac35fe42271bdc1134ee31c703a","window":"__INVALID_ENUM__"}` |
| direct | `flowscan_address_evm_balance` | `{"address":"0x010461c14e146ac35fe42271bdc1134ee31c703a"}` | JSON success, 540 chars | `{"address":"0x1234"}`; `{"address":""}` |
| direct | `flowscan_address_unit_operations` | `{"address":"0x010461c14e146ac35fe42271bdc1134ee31c703a"}` | JSON success, 566 chars | `{"address":"0x1234"}`; `{"address":"0x010461c14e146ac35fe42271bdc1134ee31c703a","direction":"__INVALID_ENUM__"}` |


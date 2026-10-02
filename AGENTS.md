# AGENTS.md: answering Hyperliquid questions with the flowscan MCP server

This file follows the [agents.md](https://agents.md/) convention. It tells an AI agent how to use the `flowscan` MCP server (this repository) once a client has it configured. It is the same guidance as [skills/flowscan/SKILL.md](skills/flowscan/SKILL.md), shortened, for clients that read `AGENTS.md` (Codex, Cursor, VS Code Copilot, Devin Desktop, Zed, Cline, Hermes Agent and others). The server also serves the full text as the MCP prompt `flowscan_guide` and the resource `flowscan://guide`. To use it in your own project, copy this file (or its body) into that project's `AGENTS.md` or rules file; see [docs/clients.md](docs/clients.md).

Working on this repository's code instead? See [CONTRIBUTING.md](CONTRIBUTING.md) and [README.md](README.md#development).

## What the server is

Flowscan (www.flowscan.xyz) is a Hyperliquid explorer. It has nothing to do with the Flow blockchain. The server's tools are named `flowscan_*`; clients may add a prefix (Claude Code: `mcp__flowscan__flowscan_*`, Gemini CLI: `mcp_flowscan_flowscan_*`, Hermes Agent: `mcp_flowscan_flowscan_*`). All tools are read-only.

## Rules

- **Mainnet only.** Flowscan has no testnet mode. If asked about Hyperliquid testnet, say this server cannot serve it.
- **Flowscan only.** Answer with what the tools return. Do not promise data the server does not serve.
- **No other tools or hosts.** Answer Hyperliquid questions only with the `flowscan_*` tools. Never use a shell, curl, web fetch or any other host (api.hyperliquid.xyz, rpc.hyperliquid.xyz, Hydromancer, ...) to fill a gap, even if the user asks. In direct mode the server makes the allowed upstream calls; you never do.
- **No made-up numbers.** Never give a placeholder, example or illustrative value for data that is not served, even labelled as fiction.
- **No forecasts by default.** Data ends at the last complete UTC day (yesterday). For a future range, say there is no data yet. Extrapolate only when explicitly asked, and say how.
- **Cite the source.** Every result has a `source` URL. Say the figures come from Flowscan and give the date range or snapshot time (`latestCompleteDay`, `windows[].from`/`to`, `range`, `coveredRange`, `snapshotIso`, `generated_at`, `crawledAt`, `fetchedAtIso`).
- **Dates are UTC.** `days` windows end yesterday unless you pass `includeToday` (revenue series only). HIP-3 series can end today, flagged `partial` / `lastDayPartial`. Always state the range you report.

## Modes

`flowscan_coverage` returns `mode`:

- `"strict"` (default, 44 tools, only www.flowscan.xyz). Not served: block and transaction lookups, the live block/tx feed, live prices (HYPE, BTC, ...), candles, order books, recent trades, validator APR/uptime, borrow/lend APYs, an address's portfolio chart, HyperEVM balance and Unit bridge operations. Say so plainly, point to the Flowscan page (`https://www.flowscan.xyz/block/<height>`, `/tx/<hash>`, `/address/<address>`), and mention that the operator can set `FLOWSCAN_HYPERLIQUID_DIRECT=1`. When an answer needs the HYPE price, report the HYPE amount and say the price is not available in this mode.
- `"hyperliquid-direct"` (58 tools; opt-in with `FLOWSCAN_HYPERLIQUID_DIRECT=1`). Adds `flowscan_block`, `flowscan_transaction`, `flowscan_live_feed`, `flowscan_prices`, `flowscan_candles`, `flowscan_order_book`, `flowscan_recent_trades`, `flowscan_spot_tokens`, `flowscan_validator_summaries`, `flowscan_address_portfolio`, `flowscan_address_evm_balance`, `flowscan_address_unit_operations` and others. These results have `mode: "hyperliquid-direct"`, `source` = the Hyperliquid URL called and `shownOn` = the Flowscan page; cite `shownOn`. Quote `fetchedAtIso` as the snapshot time. On a 429, read `hint`, wait, and do not retry in a loop. There is no generic Hyperliquid API tool; account history always comes from the `flowscan_address_*` tools.

If tools like `flowscan_block` or `flowscan_prices` are in your tool list, you are in direct mode.

## Picking a tool

1. Unsure which tool fits? Call `flowscan_coverage` with `topic` (for example `revenue`, `address`, `hip-3`, `builders`, `tx hash`). If `servedByThisServer` is false, read `notServedMatches` and tell the user.
2. Tokenized stocks on spot ARE served: `flowscan_spot_stocks` (xStocks tickers end in X, such as NVDAX, TSLAX, MUX; Dinari tickers end in D). Never say spot or token volume is unavailable.
3. Prefer the narrowest tool (`flowscan_hip3_dex` for one DEX, not `flowscan_hip3_overview` plus filtering).
4. Look up ids instead of guessing: builders via `flowscan_builder_lookup`; Builder Intelligence ids via `flowscan_builder_intelligence_list`; HIP-4 `outcomeId` via `flowscan_hip4_markets`; a weekend `week` via `flowscan_weekend_weeks` (or any YYYY-MM-DD in that weekend).
5. Addresses are `0x` plus 40 hex characters. Ask for the full address if given a partial one or a name.
6. `startTime`/`endTime` are Unix milliseconds; `startDate`/`endDate` are `YYYY-MM-DD` (UTC).

### Builder names are ambiguous

Two builders are called "fomo": a small one with id `fomo` (address `0xb838e4d1c8bcf71fa8e63299d5aa3258c83d6adb`) and a large Social-trading builder whose id is its address, `0x2a2b6b093a9813fbd8cddae800c3d17d46460d17`. For any named builder:

1. Call `flowscan_builder_lookup` with `query` set to the name.
2. One clear match: use it. `ambiguous: true` or several plausible matches: show the candidates (name, id, address, category, revenue) and ask. Do not pick silently.
3. Pass the builder to `flowscan_builder_revenue` or `flowscan_builder_dashboard` as its 0x address (preferred) or `id:<id>`.

The leaderboard and dashboard have fixed windows only; use `flowscan_builder_revenue` with `days` or `startDate`/`endDate` for any other range.

### HIP-3 DEX names

Display name and on-chain prefix: XYZ=`xyz`, FLX=`flx`, Hyena=`hyna`, KM=`mkts` (formerly `km`), VNTL=`vntl`, Dreamcash=`cash`, Paragon=`para`, Entropy=`io`. Every `dex` parameter accepts either form.

## Recipes

| Question | Tool and arguments |
| --- | --- |
| Hyperliquid revenue yesterday / 7d / 30d | `flowscan_revenue_summary` (`windows`). In strict mode report `totalUsdcExcludingGas` (USDC) and `priorityGasHype` (HYPE) separately. |
| Daily revenue for a period | `flowscan_revenue_hypercore_fees` with `days` or `startDate`/`endDate`; quote `rangeTotals`. Gas: `flowscan_revenue_priority_gas`. |
| HIP-3 deployer fees | `flowscan_revenue_deployer_fees` with `days: 30`, or `dex` for one DEX. |
| An address's positions / account | `flowscan_address_summary` (`include: ["perpState"]`, `["pnlSummary"]`, `["role"]`); all markets from the snapshot: `flowscan_address_perp_positions`. |
| Trades, orders, funding, deposits | `flowscan_address_fills`, `flowscan_address_orders` (`kind`), `flowscan_address_ledger` (`kind: "funding"` or `"ledger"`). |
| Staking of an address | `flowscan_address_staking`. Vaults and sub-accounts: `flowscan_address_vaults_subaccounts`. |
| Biggest longs or shorts in a market | `flowscan_perp_positions` with `market`, `side`, `limit`. Market totals: `marketSummary`, not `filteredSideSummary`. |
| Open interest, long/short ratio | `flowscan_perp_markets` with `market`. Flowscan's `openInterest` is two-sided (long + short); say which basis you quote. |
| Top builders | `flowscan_builders_leaderboard` (`metric`, `window`, `limit`). Daily across builders: `flowscan_builders_daily_revenue`. |
| One builder's revenue / volume | `flowscan_builder_lookup`, then `flowscan_builder_revenue` or `flowscan_builder_dashboard`. |
| Builder deep dive | `flowscan_builder_intelligence_detail` with `builderId` and only the `sections` you need. |
| HYPE staked, validators | `flowscan_staking_overview`; delegators of one validator: `flowscan_validator_stakers`. |
| HIP-3 market share, markets, Binance comparison | `flowscan_hip3_overview`, `flowscan_hip3_daily`, `flowscan_hip3_markets` (`symbol`), `flowscan_hip3_binance_comparison`. |
| HIP-4 prediction markets | `flowscan_hip4_markets` (`category`, `search`, `sortBy`); candles: `flowscan_hip4_outcome`. |
| Weekend trading of stocks | `flowscan_weekend_prices`, `flowscan_weekend_positions`, `flowscan_weekend_coin_changes`. |
| Tokenized stock volume, price, holders | `flowscan_spot_stocks` with `token` and `section` (`timeseries` with `days`). |
| Stablecoins on Hyperliquid | `flowscan_stablecoin_margin`. |
| Network nodes | `flowscan_peers` (`section: "nodes"` with `country`, `role`, `state`). |
| Direct mode: price, block, tx, candles, book | `flowscan_prices`, `flowscan_block`, `flowscan_transaction`, `flowscan_candles`, `flowscan_order_book`, `flowscan_recent_trades`, `flowscan_live_feed`. |

## Numbers

- Quote the totals the tool computed: `totals`, `rangeTotals`, `totalRevenueUsd`, `windows`, `count`, `countsByStatus`, `marketSummary`, `filteredSideSummary`, `paging.total`. Never add rows by hand, count rows by eye or estimate.
- Funding: `totals.netUsdc` / `paidUsdc` / `receivedUsdc` (`netUsdc > 0` means received). Fills: `totals.count`, `closedPnlUsdc`, `feesUsdc`, `volumeUsd`. Historical orders: `count`, `countsByStatus`.
- If a result has `capped: true`, the totals cover only `coveredRange`; page with `startTime` = `nextStartTime` and report each window, or say the figure is partial.
- Copy addresses, ids, hashes and symbols exactly. A 66-character tx hash may be shortened as the first 10 and last 6 characters, taken from the actual string.

## Keep outputs small

Results are compact JSON capped at about 40,000 characters.

- Pass `limit` and `offset` for lists; follow `paging.hasMore`.
- Pass `fields` to keep only what you need (paths relative to `data`, or to each row). If the result has `_fieldsNotFound`, read `_availableFields` and retry once. An empty `{}` is not "no data".
- Leave bulk flags off unless needed (`includeTopUsers`, `includePerDex`, `full`, `raw`, `section: "all"`, ...).
- If a result has `_truncated`, do not compute from the partial list. Narrow the query and say what you narrowed.

## Not served

- Strict mode: everything listed under "Modes" above.
- Either mode: Flowscan's own address labels, continuous live streams (WebSocket tools return snapshots), and testnet.

Say what is not served and where the user can see it on www.flowscan.xyz. Do not invent values.

## Errors

Failed calls return `{error, status, route, source}`. `status` and `route` are null when the server rejected the input (bad date range, unknown DEX, unknown validator): fix the arguments. A 404 or changed shape on a valid request usually means Flowscan changed that undocumented route; tell the user which route failed instead of retrying the same call.

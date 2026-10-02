---
name: flowscan
description: Use for any question about Hyperliquid data that flowscan.xyz shows, such as protocol revenue and fees, HYPE staking and validators, builder codes, HIP-3 perp DEXs, HIP-4 outcome markets, a specific address's positions/trades/balances, weekend trading of TradFi markets, tokenized spot stocks, perp positioning, or gossip-network peers, answered through the flowscan MCP server's tools.
---

# Flowscan (Hyperliquid explorer) via MCP

This skill assumes the `flowscan` MCP server (this repository) is configured. Its tools are named `flowscan_*`. Some clients add a prefix; in Claude Code they appear as `mcp__flowscan__flowscan_*`.

Flowscan (www.flowscan.xyz) is a Hyperliquid explorer. It has nothing to do with the Flow blockchain.

## Rules

- **Mainnet only.** Flowscan has no testnet mode. If the user asks about Hyperliquid testnet, say this server cannot serve it.
- **Flowscan only.** The server only calls www.flowscan.xyz routes. Do not describe its numbers as coming from the Hyperliquid API, and do not promise data that Flowscan's servers do not provide (see "Not available" below).
- **Read-only.** Nothing here places orders or moves funds.
- **Cite the source.** Every result has a `source` URL. Mention that the figures come from Flowscan, and give the date range or snapshot time when the result includes one (`latestCompleteDay`, `windows[].from`/`to`, `range`, `coveredRange`, `snapshotIso`, `generated_at`, `crawledAt`).
- **Days are UTC.** Today's rows are incomplete: revenue rows have `partial: true`, HIP-3 series have `lastDayPartial: true`. Say so if you quote them.

## Picking a tool

1. If you are not sure which tool fits, call `flowscan_coverage` first. Pass `topic` (for example `revenue`, `address`, `hip-3`, `builders`, `tx hash`). If `servedByThisServer` is false, the topic is something Flowscan's servers do not provide; read `notServedMatches` and tell the user.
2. Prefer the narrowest tool. For example, use `flowscan_hip3_dex` for one DEX instead of `flowscan_hip3_overview` plus filtering.
3. Some tools need an id that another tool provides. Look it up first instead of guessing:
   - builder address or `id:<id>` for `flowscan_builder_revenue` and `flowscan_builder_dashboard`: `flowscan_builder_lookup` (see "Builder names are ambiguous" below)
   - builder id for Builder Intelligence (`phantom`, `pvp`, ...): `flowscan_builder_intelligence_list`; pass it exactly as listed
   - HIP-4 `outcomeId`: `flowscan_hip4_markets` (the YES/NO asset ids default from it)
   - weekend `week`: a `fridayCloseTs` from `flowscan_weekend_weeks`, or any YYYY-MM-DD date in that weekend
4. Several tools resolve names for you:
   - validators: `flowscan_validator_stakers` and `flowscan_staking_events` take a validator name or address; an ambiguous name returns candidates.
   - markets: `flowscan_perp_positions` is case-insensitive and resolves a bare HIP-3 symbol (`TSLA` to `xyz:TSLA`) when unique; otherwise the error lists candidates. `flowscan_weekend_coin_changes` also resolves bare symbols.
   - HIP-3 DEXs: see "DEX names" below.
5. Addresses must be `0x` plus 40 hex characters. If the user gives an ENS-style name or a partial address, ask for the full address.
6. Times: `startTime`/`endTime` are Unix milliseconds. `startDate`/`endDate` are `YYYY-MM-DD` (UTC). The revenue series tools accept either form.

## DEX names

HIP-3 DEXs have a display name (used on the /hip-3 page) and an on-chain prefix (used in market symbols like `xyz:TSLA`, address data and deployer fees): XYZ=`xyz`, FLX=`flx`, Hyena=`hyna`, KM=`mkts` (formerly `km`), VNTL=`vntl`, Dreamcash=`cash`, Paragon=`para`, Entropy=`io`. Every `dex` parameter accepts either form. `flowscan_hip3_dex` and `flowscan_address_summary` reject unknown names with the list of valid ones.

## Builder names are ambiguous

Builder names are not unique on Flowscan. For example, there are two "fomo" builders: a small one with id `fomo` (address `0xb838e4d1c8bcf71fa8e63299d5aa3258c83d6adb`), and a much larger Social-trading builder named "fomo" whose id is its address, `0x2a2b6b093a9813fbd8cddae800c3d17d46460d17`. Because one builder's id is the other's name, a bare `"fomo"` is ambiguous by design. So for any question about a named builder:

1. Call `flowscan_builder_lookup` with `query` set to the name first.
2. If it returns one clear match, use that match.
3. If `ambiguous` is true or several matches look plausible, show the candidates to the user (name, id, address, category, headline revenue) and ask which one they mean. Do not silently pick one. If the user clearly means "the big one", you may pick the match with the much larger revenue, but say which one you used.
4. Pass the builder to `flowscan_builder_revenue` or `flowscan_builder_dashboard` as its 0x `address` (preferred) or as `id:<id>` (for example `id:fomo`). A bare name only works when it is unambiguous; otherwise these tools return `ambiguous: true` with candidates.

### Worked example: "How much revenue did FOMO make in the past 45 days?"

1. `flowscan_builder_lookup` with `query: "fomo"`. Both builders come back as exact matches with `ambiguous: true` (the large Social-trading builder at `0x2a2b6b...0d17` and the small one with id `fomo`), each with revenue per window to help the user choose. Show both and ask which one, unless the user already made it clear.
2. `flowscan_builder_revenue` with `days: 45` and `builder` set to the chosen builder's address (`0x2a2b6b093a9813fbd8cddae800c3d17d46460d17` for the large one), or `builder: "id:fomo"` for the small one. The range ends yesterday (UTC).
3. Report `totalRevenueUsd` together with `range.startDate` to `range.endDate`, and cite the `source` URL from the result envelope (a www.flowscan.xyz route). If the `revenue` block shows the two Flowscan sources disagreeing, or a `note` is present, mention it.

The leaderboard (`flowscan_builders_leaderboard`) and dashboard only have fixed windows (1d/7d/30d/90d/all_time and 7d/30d/90d/all). Use `flowscan_builder_revenue` for any other range. A future start date or a start after the end is an error; an end date of today or later is clamped to yesterday.

## Recipes

| Question | Tool and arguments |
| --- | --- |
| How much did Hyperliquid make yesterday / last week / last 30 days? | `flowscan_revenue_summary`. `windows` covers the last 1, 7 and 30 complete UTC days (the 1-day window is yesterday; see `from`/`to`). Flowscan's headline "Combined" revenue = native HyperCore fees + HIP-3 HyperCore fees + priority gas at the HYPE price; deployer fees are not part of it. This server cannot get the HYPE price, so report `totalUsdcExcludingGas` (USDC) and `priorityGasHype` (HYPE) separately and say the gas is not converted. Today so far: `currentDayPartial`. |
| Daily revenue for a period | `flowscan_revenue_hypercore_fees` with `days`, or `startDate`/`endDate`; `rangeTotals` has the sums. Add `flowscan_revenue_priority_gas` for gas. |
| Annualized revenue run-rate? | `flowscan_revenue_summary`, field `annualizedFrom7d`. |
| Which HIP-3 deployer earns the most fees? | `flowscan_revenue_deployer_fees` with `days: 30` (`rangeTotals` per DEX), or `dex: "KM"` / `dex: "mkts"` for one DEX (`dexTotalFee` per day). These fees go to deployers, not to the protocol. |
| Show me 0x...'s positions / account | `flowscan_address_summary` with `address`. Use `include: ["perpState"]` for just positions, `["pnlSummary"]` for lifetime PnL, `["role"]` to check whether it is a vault or sub-account. HIP-3 positions: add `dex` (e.g. `"xyz"`), or use `flowscan_address_perp_positions` for all markets from the snapshot. |
| 0x...'s trades / orders / funding / deposits | `flowscan_address_fills`, `flowscan_address_orders` (`kind: "open"`, `"openDetailed"` or `"historical"`), `flowscan_address_ledger` (`kind: "funding"` or `"ledger"`). |
| All of a busy account's fills (or ledger rows) over a period | `flowscan_address_fills` with `startTime` (and `endTime`). If the result has `capped: true`, the rows are the OLDEST 2000 in the window (see `coveredRange`). Call again with `startTime` set to the returned `nextStartTime`, and repeat until `capped` is false. Same for `flowscan_address_ledger`. Without `startTime` you only get the most recent ~2000. |
| Who does 0x... stake with? | `flowscan_address_staking` (`totalDelegatedHype`, delegations with validator name, commission and lock-up). |
| 0x...'s vaults, sub-accounts, approved builders | `flowscan_address_vaults_subaccounts`; `flowscan_address_extras` with `kind: "approvedBuilders"`. |
| Biggest BTC longs (or shorts) | `flowscan_perp_positions` with `market: "BTC"`, `side: "long"`, `limit: 10`. |
| What's the OI on X? Long/short ratio? | `flowscan_perp_markets` with `market: "X"` (e.g. `"BTC"` or `"xyz:TSLA"`). Flowscan's `openInterest` is two-sided: long notional + short notional, about twice the one-sided OI many exchanges quote. Say which you report (halve it for one-sided). Quote `snapshotIso`. |
| Which builder makes the most? | `flowscan_builders_leaderboard` with `metric: "revenue"` and `window` (`1d`, `7d`, `30d`, `90d`, `all_time`), `limit: 10`. For revenue per user, use `metric: "avg_revenue_per_user_all_time"` with a `minUsers` floor. |
| How much did builder X make in the last N days / between two dates? | `flowscan_builder_lookup` (`query: "X"`), then `flowscan_builder_revenue` with the address or `id:<id>` and `days: N` or `startDate`/`endDate`. See the worked example above. |
| Builder X's volume, traders, top assets | `flowscan_builder_lookup`, then `flowscan_builder_dashboard` with the address and `window`. |
| Revenue per day across all builders | `flowscan_builders_daily_revenue` (`top` for the leaders). |
| Deep dive on one builder (retention, user status) | `flowscan_builder_intelligence_detail` with `builderId` and only the `sections` you need. |
| How much HYPE is staked? Largest or cheapest validators? | `flowscan_staking_overview` (`limit: 10`). Cheapest active: `sortBy: "commission_bps"`, `order: "asc"`, `excludeJailed: true`. Delegators of one validator: `flowscan_validator_stakers` with its name or address. |
| HIP-3 market share / total volume | `flowscan_hip3_overview` with `fields: ["overview", "market_share"]`. Time series: `flowscan_hip3_daily`. |
| Which HIP-3 DEXs list TSLA (or GOLD)? | `flowscan_hip3_markets` with `symbol: "TSLA"`. |
| How does HIP-3 compare with Binance for RWAs? | `flowscan_hip3_binance_comparison` (with `symbol` for one asset). |
| HIP-4 prediction markets on sports / crypto | `flowscan_hip4_markets` with `category` or `search`; `yesMark` is the implied probability (0 to 1). Candles: `flowscan_hip4_outcome` with just `outcomeId`. |
| How did stocks trade on Hyperliquid this weekend? | `flowscan_weekend_prices` (latest weekend by default, or `week: "YYYY-MM-DD"`), `flowscan_weekend_positions` for positioning. One market over many weekends: `flowscan_weekend_coin_changes` with `coin: "TSLA"` or `"xyz:TSLA"`. |
| Tokenized stock volume, holders, liquidity (xStocks, Dinari) | `flowscan_spot_stocks` with `token` and `section`. Liquidity buckets (2/5/10/25 bps) are cumulative; `latestDepthUsd` gives USD. |
| How much USDC/USDT is on Hyperliquid? | `flowscan_stablecoin_margin`. |
| How many nodes are on the network, where are they? | `flowscan_peers` (default summary). Node lists: `section: "nodes"` with `country` (exact ISO code like `"JP"` or exact name like `"Japan"`), `role` or `state`. |

## Keep outputs small

Results are compact JSON capped at about 60,000 characters.

- Pass `limit` (for example 10 or 20) when you only need the top of a list. Use `offset` and the returned `paging.hasMore` to page.
- Pass `fields` to keep only the keys of `data` you need, as keys or dotted paths, for example `["overview", "market_share"]` or `["by_token.USDC"]`. On tools that return rows, `fields` applies to each row.
- Leave optional bulk flags off unless needed (`includeTopUsers`, `includeMarketDaily`, `includePerDex`, `includeTopAddressChanges`, `includeExcludedBuilders`, `includeContexts`, `includeDescription`, `full`, `section: "all"`).
- If a result has `_truncated`, the listed arrays were shortened to their first items (`originalLength` vs `kept`). The JSON is still valid, but the lists are incomplete: do not compute totals from them. Call again with `fields`, a smaller `limit`, `offset` or a narrower tool. In the rare case of a plain `[TRUNCATED: ...]` marker at the end of non-JSON text, do the same.

## Not available

These are visible on flowscan.xyz but the browser loads them directly from Hyperliquid hosts, not from Flowscan's servers, so this MCP cannot return them:

- block details and transaction details (lookups by block height or tx hash)
- the live block/transaction feed
- live market prices (HYPE/USD, BTC, ...), candles and order books
- an address's portfolio chart, EVM balance and Unit bridge operations

When asked for one of these, say plainly that the Flowscan MCP cannot fetch it because Flowscan's own servers do not serve it, and suggest opening the page in a browser (for example `https://www.flowscan.xyz/tx/<hash>` or `https://www.flowscan.xyz/block/<height>`). Do not invent values. Related data that is available: an address's fills include tx hashes (`flowscan_address_fills`); positions include entry and liquidation prices; `flowscan_weekend_prices` has HIP-3 TradFi closes and live prices; `flowscan_spot_stocks` has tokenized-stock marks; `flowscan_hip4_*` has outcome prices and candles; `flowscan_hip3_binance_comparison` has Binance last prices.

## Errors

Failed calls return `{error, status, route, source}`. `status` and `route` are null when the server rejected the input itself (bad date range, unknown DEX, unknown validator); fix the arguments. An unknown market in `flowscan_perp_positions` returns a 404 whose message lists candidate symbols. A Flowscan 400/404 is not retried. The routes are undocumented, so a 404 or a changed shape on a valid request usually means Flowscan changed that route. Tell the user which route failed rather than retrying the same call repeatedly.

## Installing this skill

Copy the `skills/flowscan` folder into your agent's skills directory:

- Claude Code, all projects: `~/.claude/skills/flowscan/`
- Claude Code, one project: `.claude/skills/flowscan/` in that project

```sh
mkdir -p ~/.claude/skills
cp -r skills/flowscan ~/.claude/skills/
```

The skill only helps if the `flowscan` MCP server is also configured; see the README for client setup.

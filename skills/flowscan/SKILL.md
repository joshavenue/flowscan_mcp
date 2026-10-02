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
- **Cite the source.** Every result has a `source` URL. Mention that the figures come from Flowscan, and give the date or snapshot time when the result includes one (`latestCompleteDay`, `range`, `timestamp`, `generated_at`, `crawledAt`).

## Picking a tool

1. If you are not sure which tool fits, call `flowscan_coverage` first. Pass `topic` (for example `revenue`, `address`, `hip-3`, `builders`) to filter the page to tool map.
2. Prefer the narrowest tool. For example, use `flowscan_hip3_dex` for one DEX instead of `flowscan_hip3_overview` plus filtering.
3. Some tools need an id that another tool provides. Look it up first instead of guessing:
   - validator address: `flowscan_staking_overview` (use `search` with the validator name)
   - builder id or 0x address for `flowscan_builder_revenue` and `flowscan_builder_dashboard`: `flowscan_builder_lookup` (see "Builder names are ambiguous" below)
   - builder id for Builder Intelligence (`phantom`, `pvp`, ...): `flowscan_builder_intelligence_list`
   - exact market symbol for `flowscan_perp_positions` (`BTC`, `xyz:TSLA`): `flowscan_perp_markets`
   - HIP-4 `outcomeId`, `yesAssetId`, `noAssetId`: `flowscan_hip4_markets`
   - weekend `week` (a `fridayCloseTs`): `flowscan_weekend_weeks`
4. Addresses must be `0x` plus 40 hex characters. If the user gives an ENS-style name or a partial address, ask for the full address.
5. Times: `startTime`/`endTime` are Unix milliseconds. `startDate`/`endDate` are `YYYY-MM-DD`. Days are UTC.

## Builder names are ambiguous

Builder names are not unique on Flowscan. For example, there are two "fomo" builders: a small one with id `fomo` (address `0xb838e4d1c8bcf71fa8e63299d5aa3258c83d6adb`), and a much larger Social-trading builder whose id is its address, `0x2a2b6b093a9813fbd8cddae800c3d17d46460d17`. So for any question about a named builder:

1. Call `flowscan_builder_lookup` with `query` set to the name first.
2. If it returns one clear match, use that match's exact `id` or `address`.
3. If `ambiguous` is true or several matches look plausible, show the candidates to the user (name, id, address, category, headline revenue) and ask which one they mean. Do not silently pick one. If the user clearly means "the big one", you may pick the match with the much larger revenue, but say which one you used.
4. Pass the exact `id` or `address` (prefer the address) to `flowscan_builder_revenue` or `flowscan_builder_dashboard`. The dashboard needs the 0x address.

`flowscan_builder_revenue` also returns `ambiguous: true` with a candidate list if you pass it a name that matches more than one builder.

### Worked example: "How much revenue did FOMO make in the past 45 days?"

1. `flowscan_builder_lookup` with `query: "fomo"`. Both builders come back as exact matches with `ambiguous: true` (the large Social-trading builder at `0x2a2b6b...0d17` and the small `fomo` id), each with revenue per window to help the user choose. Show both and ask which one, unless the user already made it clear.
2. `flowscan_builder_revenue` with `builder` set to the chosen id or address and `days: 45`. The range ends yesterday (UTC).
3. Report `totalRevenueUsd` together with `range.startDate` to `range.endDate`, and cite the `source` URL from the result envelope (a www.flowscan.xyz route). If the `revenue` block shows the two Flowscan sources disagreeing, or a `note` is present, mention it.

The leaderboard (`flowscan_builders_leaderboard`) only has fixed windows: 1d, 7d, 30d, 90d and all_time. Use `flowscan_builder_revenue` for any other range.

## Recipes

| Question | Tool and arguments |
| --- | --- |
| What did Hyperliquid earn yesterday / this week / this month? | `flowscan_revenue_summary`: windows of the last 1, 7 and 30 complete UTC days (the 1-day window is yesterday; check `latestCompleteDay`), plus `currentDayPartial` for today so far. For day-by-day rows: `flowscan_revenue_hypercore_fees` with `days: 8` (the last row is today, still accumulating). Add `flowscan_revenue_deployer_fees` and `flowscan_revenue_priority_gas` for the other revenue lines. |
| Annualized revenue run-rate? | `flowscan_revenue_summary`, field `annualizedFrom7d`. |
| Which HIP-3 deployer earns the most fees? | `flowscan_revenue_deployer_fees` with `days: 30`, or `dex: "xyz"` for one DEX. |
| Show me 0x...'s positions / account | `flowscan_address_summary` with `address`. Use `include: ["perpState"]` for just positions, `["pnlSummary"]` for lifetime PnL, `["role"]` to check whether it is a vault or sub-account. |
| 0x...'s trades / orders / funding / deposits | `flowscan_address_fills`, `flowscan_address_orders` (`kind: "open"` or `"historical"`), `flowscan_address_ledger` (`kind: "funding"` or `"ledger"`). |
| Who does 0x... stake with? | `flowscan_address_staking`. |
| 0x...'s vaults, sub-accounts, approved builders | `flowscan_address_vaults_subaccounts`; `flowscan_address_extras` with `kind: "approvedBuilders"`. |
| Biggest BTC longs (or shorts) | `flowscan_perp_positions` with `market: "BTC"`, `side: "long"`, `limit: 10`. |
| Long/short ratio or OI by market | `flowscan_perp_markets` with `market` filter and `sortBy`. |
| Which builder makes the most? | `flowscan_builders_leaderboard` with `metric: "revenue"` and `window` (`1d`, `7d`, `30d`, `90d`, `all_time`), `limit: 10`. |
| How much did builder X make in the last N days / between two dates? | `flowscan_builder_lookup` (`query: "X"`), then `flowscan_builder_revenue` with the exact id/address and `days: N` or `startDate`/`endDate`. See the worked example above. |
| Builder X's volume, traders, top assets | `flowscan_builder_lookup`, then `flowscan_builder_dashboard` with the 0x address and `window`. |
| Revenue per day across all builders | `flowscan_builders_daily_revenue` (`top` for the leaders). |
| Deep dive on one builder (retention, user status) | `flowscan_builder_intelligence_detail` with `builderId` and only the `sections` you need. |
| How much HYPE is staked? Largest validators? | `flowscan_staking_overview` (`limit: 10`). Delegators of one validator: `flowscan_validator_stakers`. |
| HIP-3 market share / total volume | `flowscan_hip3_overview` with `fields: ["overview", "market_share"]`. Time series: `flowscan_hip3_daily`. |
| Which HIP-3 DEXs list TSLA (or GOLD)? | `flowscan_hip3_markets` with `symbol: "TSLA"`. |
| How does HIP-3 compare with Binance for RWAs? | `flowscan_hip3_binance_comparison`. |
| HIP-4 prediction markets on sports / crypto | `flowscan_hip4_markets` with `category` or `search`. Candles: `flowscan_hip4_outcome`. |
| How did stocks trade on Hyperliquid this weekend? | `flowscan_weekend_prices` (latest weekend by default), `flowscan_weekend_positions` for positioning. One market over many weekends: `flowscan_weekend_coin_changes` with a DEX-prefixed symbol such as `xyz:TSLA`. |
| Tokenized stock volume, holders, liquidity (xStocks, Dinari) | `flowscan_spot_stocks` with `token` and `section`. |
| How much USDC/USDT is on Hyperliquid? | `flowscan_stablecoin_margin`. |
| How many nodes are on the network, where are they? | `flowscan_peers` (default summary). Node lists: `section: "nodes"` with `country`, `role` or `state`. |

## Keep outputs small

Large Flowscan payloads are trimmed, and results over about 60,000 characters are cut with a `[TRUNCATED: ...]` marker (the cut result is not valid JSON).

- Pass `limit` (for example 10 or 20) when you only need the top of a list. Use `offset` and the returned `paging.hasMore` to page.
- Pass `fields` to keep only the keys you need, as top-level keys or dotted paths, for example `["overview", "market_share"]` or `["by_token.USDC"]`. On tools that return rows, `fields` applies to each row.
- Leave optional bulk flags off unless needed (`includeTopUsers`, `includeMarketDaily`, `includePerDex`, `includeTopAddressChanges`, `includeExcludedBuilders`, `section: "all"`).
- If you see a truncation marker, call again with narrower arguments instead of reasoning from partial JSON.

## Not available

These are visible on flowscan.xyz but the browser loads them directly from Hyperliquid hosts, not from Flowscan's servers, so this MCP cannot return them:

- block details and transaction details (lookups by block height or tx hash)
- the live block/transaction feed
- market prices, candles and order books
- an address's portfolio chart, EVM balance and Unit bridge operations

When asked for one of these, say plainly that the Flowscan MCP cannot fetch it because Flowscan's own servers do not serve it, and suggest opening the page in a browser (for example `https://www.flowscan.xyz/tx/<hash>` or `https://www.flowscan.xyz/block/<height>`). Do not invent values. Related data that is available: an address's fills include tx hashes (`flowscan_address_fills`); `flowscan_weekend_prices` has current vs Friday-close prices for HIP-3 TradFi markets; `flowscan_spot_stocks` has mark/mid prices for tokenized stocks.

## Errors

Failed calls return `{error, status, route, source}`. The routes are undocumented, so a 404 or a changed shape usually means Flowscan changed that route. Tell the user which route failed rather than retrying the same call repeatedly.

## Installing this skill

Copy the `skills/flowscan` folder into your agent's skills directory:

- Claude Code, all projects: `~/.claude/skills/flowscan/`
- Claude Code, one project: `.claude/skills/flowscan/` in that project

```sh
mkdir -p ~/.claude/skills
cp -r skills/flowscan ~/.claude/skills/
```

The skill only helps if the `flowscan` MCP server is also configured; see the README for client setup.

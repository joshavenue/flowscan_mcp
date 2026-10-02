# flowscan-mcp

An MCP server that exposes the data shown on [flowscan.xyz](https://www.flowscan.xyz) as tools for AI agents. Flowscan is a real-time explorer and analytics site for the Hyperliquid blockchain (HyperCore, HIP-3 perp DEXs and HIP-4 outcome markets). It is not related to the Flow blockchain. With this server an agent can answer questions such as "what did Hyperliquid earn in fees yesterday", "who holds the largest BTC longs", "which builder code earned the most this week" or "what positions does 0x... have open", using the same numbers a person would see on the site.

- 44 read-only tools, grouped by Flowscan page
- Hyperliquid mainnet only (Flowscan has no testnet mode)
- No API key
- stdio transport, Node.js 20 or newer

## Design rule: only flowscan.xyz

The server sends requests to exactly one host: `https://www.flowscan.xyz`. It calls the same `/api/*` routes the Flowscan web frontend calls. It never contacts `api.hyperliquid.xyz`, `rpc.hyperliquid.xyz`, `api-ui.hyperliquid.xyz`, `api.hyperunit.xyz`, Hydromancer or any other upstream directly. (The address tools use Flowscan's own `/api/hydromancer/info` route. That route is served by www.flowscan.xyz; whatever Flowscan's backend does behind it is not visible to, or called by, this server.)

This rule has a cost: some things you can see on Flowscan are fetched by your browser straight from Hyperliquid hosts, not from Flowscan's servers, so this MCP cannot return them. See [Not covered](#not-covered).

These `/api/*` routes are undocumented. Flowscan can change them at any time. When a route breaks, the tool returns a structured error that names the route (see [Errors](#errors)) instead of guessing.

## Quick start

Pick one of three ways to run it.

**1. From GitHub with npx (no clone).** `package.json` has a `prepare` script, so npm builds the TypeScript on install:

```sh
npx -y github:joshavenue/flowscan_mcp
```

**2. From a local clone.**

```sh
git clone https://github.com/joshavenue/flowscan_mcp
cd flowscan_mcp
npm install
npm run build
node dist/index.js
```

Then point your MCP client at `node /absolute/path/to/flowscan_mcp/dist/index.js`.

**3. From npm (once published).** The package has not been published to npm yet. After it is, this will work:

```sh
npx -y flowscan-mcp
```

Started by hand, the server waits for MCP messages on stdin and prints `flowscan-mcp ready (stdio)` to stderr. You normally let the MCP client start it. To poke at the tools interactively, use the MCP Inspector:

```sh
npx @modelcontextprotocol/inspector node dist/index.js
```

## Client configuration

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`) and restart Claude Desktop.

Using a local clone (same as [examples/claude_desktop_config.json](examples/claude_desktop_config.json)):

```json
{
  "mcpServers": {
    "flowscan": {
      "command": "node",
      "args": ["/absolute/path/to/flowscan_mcp/dist/index.js"]
    }
  }
}
```

Using npx from GitHub:

```json
{
  "mcpServers": {
    "flowscan": {
      "command": "npx",
      "args": ["-y", "github:joshavenue/flowscan_mcp"]
    }
  }
}
```

After the npm release, the args become `["-y", "flowscan-mcp"]`.

### Claude Code

Add it from the command line:

```sh
claude mcp add flowscan -- npx -y github:joshavenue/flowscan_mcp
```

or, from a local clone:

```sh
claude mcp add flowscan -- node /absolute/path/to/flowscan_mcp/dist/index.js
```

To share it with a project, commit a `.mcp.json` at the project root (same as [examples/mcp.json](examples/mcp.json)):

```json
{
  "mcpServers": {
    "flowscan": {
      "command": "node",
      "args": ["/absolute/path/to/flowscan_mcp/dist/index.js"]
    }
  }
}
```

For a portable project file, use `"command": "npx"` and `"args": ["-y", "github:joshavenue/flowscan_mcp"]` instead.

In Claude Code the tools show up as `mcp__flowscan__<tool name>`, for example `mcp__flowscan__flowscan_revenue_summary`.

### Cursor

Cursor reads `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for all projects). The shape is the same `mcpServers` object as above:

```json
{
  "mcpServers": {
    "flowscan": {
      "command": "npx",
      "args": ["-y", "github:joshavenue/flowscan_mcp"]
    }
  }
}
```

### Passing environment variables

Any client config above accepts an `env` object, for example:

```json
"flowscan": {
  "command": "node",
  "args": ["/absolute/path/to/flowscan_mcp/dist/index.js"],
  "env": { "FLOWSCAN_MAX_RESULT_CHARS": "30000" }
}
```

### Agent skill

[skills/flowscan/SKILL.md](skills/flowscan/SKILL.md) is an optional agent skill that tells a model which tool to use for common questions. For Claude Code, copy the folder to `~/.claude/skills/flowscan` (or `.claude/skills/flowscan` inside a project).

## Tools

All 44 tools are read-only (annotated `readOnlyHint`). Required parameters are in **bold**. "fields/limit/offset" means the tool accepts the standard [output-shaping](#output-shaping) parameters; "fields" alone means it only accepts `fields`. Default page sizes are noted where a tool pages a list. Each tool's description names the Flowscan page it mirrors; the route is in the `source` field of every result.

### Start here

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_coverage` | Map of Flowscan pages to tools, what is not served, HIP-3 DEX display names vs on-chain prefixes (`hip3DexNames`), the mainnet-only rule and output conventions. With `topic`, also `notServedMatches` and `servedByThisServer` (false when the topic only matches something this server cannot serve). No network call. | `topic` (keywords, e.g. `revenue`, `hip-3`, `tx hash`) |

### Homepage (`/`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_stablecoin_margin` | "Stablecoin Perp Margin" panel: stablecoin value on HyperCore split into spot balances and perp margin, overall and per token (USDC, USDT, USDE, USDH): balances, holders/traders, average/median, total value, market share. USD. | fields |
| `flowscan_perp_markets` | Perp positioning snapshot for every perp market (about 330, including HIP-3 markets like `xyz:TSLA`): long/short counts and notional, ratios, open interest, average entry, median leverage, unique addresses, `snapshotIso`/`snapshotAgeSeconds`. | `market`, `sortBy` (default `openInterest`), fields/limit/offset (default 60) |
| `flowscan_perp_positions` | Open positions in one market, largest first: address, signed size, notional, side, entry, leverage, liquidation price, account value, funding PnL, all-time PnL, size change since the previous snapshot; `total`/`totalPages`, `snapshotIso`/`snapshotAgeSeconds` and a summary of the filtered set. A bare HIP-3 symbol (`TSLA`) resolves to `xyz:TSLA` when unique; otherwise the error lists candidates. | **`market`** (case-insensitive), `side`, `sort` (`notional` default, `size`), `dir`, `minSize`/`maxSize`, `minNotional`/`maxNotional`, `minEntry`/`maxEntry`, `minLiq`/`maxLiq`, `minReturn`/`maxReturn`, `markPx`, `limit` (default 50, max 200), `page` (1-based), fields |
| `flowscan_address_perp_positions` | One address's open perp positions across all markets (including HIP-3) from the latest snapshot, sorted by notional, with `totalNotional` and `totalPositions`. | **`address`**, `market`, `side`, fields/limit/offset (default 50) |

`openInterest` in the perp snapshot (and OI in the HIP-3 tools) is Flowscan's two-sided figure: long notional + short notional. That is twice the one-sided OI some other interfaces show. The homepage "24h Revenue" card is served by the revenue tools below.

### Revenue (`/revenue`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_revenue_hypercore_fees` | One row per UTC day, oldest first: `nativeHypercoreFee` (non-HIP-3 markets) and `hip3HypercoreFee` (HIP-3 markets), USDC, plus `rangeTotals`. History starts 2026-03. Today's row has `partial: true`. | `days` (default 90 without a range), or `startDate`/`endDate` (YYYY-MM-DD), or `startTime`/`endTime` (Unix ms), fields/limit/offset (default 400) |
| `flowscan_revenue_deployer_fees` | Daily HIP-3 deployer fees (`totalFee`) with `byDex` per on-chain DEX name, plus `rangeTotals` (overall and per DEX). With `dex`, rows also have `dexTotalFee` and `allDexTotalFee`. USDC. Paid to deployers, not protocol revenue. | `days` (default 90), or `startDate`/`endDate`, or `startTime`/`endTime`, `dex` (on-chain name like `xyz`, or display name like `KM`), fields/limit/offset (default 400) |
| `flowscan_revenue_priority_gas` | Daily write/read priority gas (`totalGas` in HYPE, `count`), `rangeTotals`, optionally the top 5 gas-paying users per day. Today's row has `partial: true`. | `days` (default 90), or `startDate`/`endDate`, or `startTime`/`endTime`, `includeTopUsers` (default false), fields/limit/offset (default 400) |
| `flowscan_revenue_summary` | For the last 1, 7 and 30 complete UTC days: native fees, HIP-3 fees, their sum `totalUsdcExcludingGas`, deployer fees (USDC) and priority gas (HYPE); the current partial day separately; annualized run-rate from the trailing 7 days; a note on how Flowscan's headline figure is built. Computed by this server from the three series above. | fields |

Flowscan's headline "Combined" revenue is native HyperCore fees + HIP-3 HyperCore fees + priority gas converted at the live HYPE price. Deployer fees are not part of it. Flowscan's routes do not expose the HYPE price and this server does not fetch it, so gas is reported in HYPE and the USDC part is `totalUsdcExcludingGas`.

### Address (`/address/{address}`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_address_summary` | Account role (user/vault/subAccount/agent/missing), lifetime PnL summary (PnL, win rate, trades, hold time, volume, fees, funding, days active, `tradedPairs` as `{count, first30}`), live perp state (account value, notional, margin, withdrawable, positions with size, entry, leverage, liquidation, uPnL, ROE, funding; largest first) and non-zero spot balances. | **`address`**, `include` (any of `role`, `pnlSummary`, `perpState`, `spotBalances`; default all), `dex` (HIP-3 DEX for perp state, display name or prefix; unknown names are rejected; default main DEX), `positionsLimit` (default 50), `balancesLimit` (default 50), fields |
| `flowscan_address_orders` | `open`: resting orders on every DEX. `openDetailed`: main-DEX orders with trigger/TP-SL/reduce-only/TIF details (upstream max 100, then `capped`). `historical`: the newest ~2000 orders with final status, with `coveredRange`/`capped`. | **`address`**, `kind` (`open` default, `openDetailed`, `historical`), `coin`, fields/limit/offset (default 100; 50 for `historical`) |
| `flowscan_address_fills` | Fills, newest first: coin, price, size, side, direction, start position, closed PnL, fee, tx hash, oid, time. Without `startTime`: the most recent ~2000. With `startTime`: the oldest 2000 from that time; `capped`, `coveredRange`, and when capped `nextStartTime` + `capNote`. | **`address`**, `startTime`, `endTime` (Unix ms), `aggregateByTime` (default true), `coin`, fields/limit/offset (default 100) |
| `flowscan_address_ledger` | `ledger`: deposits, withdrawals, transfers, vault flows, liquidations. `funding`: hourly funding payments. Newest first, same `capped`/`coveredRange`/`nextStartTime` handling as fills. | **`address`**, `kind` (`ledger` default, `funding`), `startTime` (default 30 days ago for ledger, 7 days for funding), `endTime`, `coin`, fields/limit/offset (default 100) |
| `flowscan_address_staking` | `totalDelegatedHype`, `validatorCount`, delegations `{validator, validatorName, commission_bps, is_jailed, amountHype, lockedUntil, lockedUntilIso}` and staking history, newest first. | **`address`**, `historyLimit` (default 50, max 500), fields |
| `flowscan_address_vaults_subaccounts` | Vault equities (vault, equity, lock-up) and sub-accounts (name, address, account value, notional, withdrawable, open positions, non-zero spot balances). | **`address`**, fields |
| `flowscan_address_extras` | Smaller widgets: approved builders (with max fee), HyperCore borrow/lend state and health, API rate limit, TWAP slice fills. | **`address`**, **`kind`** (`approvedBuilders`, `borrowLend`, `rateLimit`, `twapSliceFills`), fields/limit/offset (default 100 for lists) |

`flowscan_address_perp_positions` (homepage section) also takes an address. For orders, fills and ledger, `paging.rowsReturned` counts the rows in the (possibly capped) upstream response, not every row in the period.

### Staking (`/validators`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_staking_overview` | Total HYPE staked, delegator and validator counts, and every validator (about 35) with name, address, commission (bps), total delegated, staker count, jailed flag; `sortedBy`. | `search`, `sortBy` (`total_delegated` default, `staker_count`, `commission_bps`, `name`), `order` (`desc` default, `asc` default for `name`), `excludeJailed`, `includeDescription` (default false), fields/limit/offset (default 50) |
| `flowscan_validator_stakers` | One validator's summary plus its delegators `{address, amount}` (HYPE), largest first. | **`validator`** (0x address or name; an ambiguous name returns candidates), `search`, fields/limit/offset (default 100) |
| `flowscan_staking_events` | Recent delegation/undelegation events, newest first: user, amount (HYPE), `isUndelegate`, tx hash, time (ms and `timeIso`). | **`validator`** (address or name), `limit` (default 50, max 500), fields |

### Peers (`/peers`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_peers` | Crawl of the Hyperliquid gossip network (about 600 nodes). Default: meta (crawl time, counts, reachability, states), footprint (top countries, ASNs) and sentries. `nodes`, `edges` and `all` are paged (`all` returns `nodesPaging`/`edgesPaging`). | `section` (`summary` default, `nodes`, `edges`, `all`), `country` (exact ISO code like `JP` or exact name like `Japan`), `state` (`syncing`, `full`, `unreachable`, `no_resp`, `other`), `role` (`hub`, `sentry`, `fringe`, `private`, `scraper`), `operator`, `nodeId`, fields/limit/offset (default 50 nodes, 500 edges; 50 nodes and 200 edges with `all`) |

### HIP-3 perp DEXs (`/hip-3`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_hip3_overview` | Totals across all HIP-3 DEXs (volume all-time/30d/90d, trades, traders, new users, OI), per-DEX and per-collateral market share, DEX list with collateral, builder-routed share of volume (top 3 builders per DEX), and `dexAliases`. | fields |
| `flowscan_hip3_daily` | Daily series per DEX for one metric, with `lastDayPartial` + `partialNote` when the last date is today. | `metric` (`volume` default, `trades`, `traders`, `new_users`, `oi`, `oi_by_market`, `collateral_traders`, `collateral_oi`), `dex` (display name or prefix), `days` (default 30), fields |
| `flowscan_hip3_markets` | All HIP-3 markets (dex, symbol, canonical underlying, asset class). With `symbol`: per listing DEX the OI, DAU, volume, spread, slippage, plus OI/DAU history trimmed to `days`. | `symbol`, `dex`, `assetClass`, `search`, `days` (default 30), fields/limit/offset (default 100) |
| `flowscan_hip3_dex` | One DEX: collateral, totals, every market with all-time volume, traders and current OI (sorted by volume), daily totals with `lastDayPartial`. Unknown DEX names are an error that lists the valid ones. | **`dex`** (display name or prefix, case-insensitive), `days` (default 30), `includeMarketDaily`, `search`, fields/limit/offset (default 50) |
| `flowscan_hip3_builders` | Share of HIP-3 volume routed through builder codes, per-DEX builder volume with top builders, and 800+ builders ranked by HIP-3 volume only. | `search`, `window` (`total` default, `30d`, `90d`), `dex` (rank by volume on one DEX), `includePerDex`, fields/limit/offset (default 50) |
| `flowscan_hip3_binance_comparison` | About 240 real-world-asset symbols with the matching Binance USDT-M futures: Binance OI, 24h volume, last price. With `symbol`: Binance daily history (trimmed to `days`) and the HIP-3 side per DEX (OI, DAU, volume, spread, slippage). | `symbol`, `underlyingType` (`EQUITY`, `HK_EQUITY`, `KR_EQUITY`, `CN_EQUITY`, `COMMODITY`, `INDEX`, `FX`, `PREMARKET`), `sortBy` (`oi` default, `volume24h`, `lastPrice`), `days` (default 30), fields/limit/offset (default 50) |

### HIP-4 outcome markets (`/hip-4`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_hip4_markets` | `active` (about 250): YES/NO outcomes with outcomeId, asset ids, market type, underlying/target/expiry, `yesMark`/`noMark` (0 to 1, implied probability), `yesPrevDayPx`, `noPrevDayPx`, `yesDayNtlVlm`, volume, deployer, question link. `settled`: resolved outcomes. `questions`: question groups. `all`: all three. | `section` (`active` default, `settled`, `questions`, `all`), `search`, `category`, `settledLimit` (default 100), `includeContexts` (full spot contexts, default false), fields/limit/offset (default 20; 10 per list with `all`) |
| `flowscan_hip4_outcome` | YES and NO candles for one outcome (`[openTime, open, high, low, close, volume, trades]`), per-side trade stats, and the settlement record for settled outcomes. | **`outcomeId`**, `yesAssetId`/`noAssetId` (default `#<outcomeId>0` / `#<outcomeId>1`; `#` is added if missing), `interval` (`1m`, `5m`, `15m`, `1h` default, `4h`, `1d`), `days` (default 7, max 90), `settled`, fields |
| `flowscan_hip4_labels` | Readable labels for HIP-4 asset ids such as `#14730`. | **`assets`** (1 to 100 ids) |

### Spot stocks (`/spot-stocks`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_spot_stocks` | Tokenized stocks on spot (xStocks, Dinari). `current`: summary and per-token price, supply, volume, holders, traders, value, depth. `timeseries`: daily volume/holders/traders/value. `liquidity`: latest depth within 2/5/10/25 bps of mid (cumulative buckets, plus a 25-500 bps band) in tokens and as `latestDepthUsd`, with a sampled history when `token` or `days` is given. `topHolders`: largest holders per token. | `section` (`current` default, `timeseries`, `liquidity`, `topHolders`), `token`, `days` (timeseries default 30; liquidity history default 1 with `token`), fields/limit/offset (top holders: default 25 per token with `token`, 10 without) |

### Weekend trading (`/weekend-trading`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_weekend_weeks` | Tracked weekends, newest first (`fridayCloseTs` is the week id, `sundayCloseTs`, ISO twins, status, average % change, risers/fallers), optionally the next ~12 weekend/holiday sessions. | `includeSchedule`, fields/limit/offset (default 26) |
| `flowscan_weekend_prices` | For HIP-3 TradFi perps (`xyz:TSLA`, `xyz:GOLD`, ...): Friday-close, Sunday-close (after the weekend) and live prices (during it), with % and dollar change. | `week` (`fridayCloseTs` in ms or a YYYY-MM-DD date in that weekend; default latest), `market`, fields |
| `flowscan_weekend_positions` | Per perp market: long/short counts and notional at Friday close vs the latest snapshot, new/closed positions, net changes, optionally the top 5 address changes. | `week`, `market`, `sortBy`, `includeTopAddressChanges`, fields/limit/offset (default 50) |
| `flowscan_weekend_coin_changes` | One HIP-3 TradFi market's Friday-to-Sunday move for every tracked weekend, with ISO timestamps. A bare symbol (`TSLA`) resolves to `xyz:TSLA`; crypto has no weekend data. | **`coin`** (e.g. `xyz:TSLA` or `TSLA`), fields |

### Builders (`/builders`, `/builders/{id}`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_builder_lookup` | Resolves a builder name, id or address (substring) to candidates with id, name, category, address, revenue and volume per window, total users, and `aliasIds` where present. Exact matches first; `ambiguous` is true when more than one fits. | **`query`**, `limit` (default 20) |
| `flowscan_builder_revenue` | One builder's total and daily revenue (USD) over any range, cross-checked between `/api/builders/all-daily-revenue` and `/api/dashboard/builder-daily-series` (both totals with the dates each covers; `perKeyTotals`/`usedKeys` when revenue appears under several keys). An ambiguous name returns `ambiguous: true` with candidates. Dates are checked before any request: a future start or start after end is an error, and the end is clamped to yesterday (UTC). | **`builder`** (0x address preferred, `id:<id>`, or an unambiguous name), `days` (default 30, ending yesterday UTC) or `startDate`/`endDate`, fields/limit/offset (default 60 daily rows, newest first) |
| `flowscan_builders_leaderboard` | "Builder Arena": about 1800 builders ranked by one metric over a fixed window. Compact rows `{rank, id, name, category, value, <metric>, revenueAllTime, totalUsers}`, or every metric with `full`; `sortedBy`. | `metric` (`revenue` default, `volume`, `new_users`, `total_users`, `avg_revenue_per_user_all_time`), `window` (`1d`, `7d` default, `30d`, `90d`, `all_time`), `category`, `search`, `minUsers` (default 0), `full`, fields/limit/offset (default 25) |
| `flowscan_builders_summary` | All-time builder revenue, volume, users and avg revenue per user, overall and per category, plus the per-builder all-time list. | fields/limit/offset (default 50) |
| `flowscan_builders_daily_revenue` | Revenue per builder per UTC day for a date range, with per-builder and grand totals (top 20 builders by default). Invalid dates are an error; a future end date is clamped with a note. | `startDate`, `endDate` (YYYY-MM-DD; default last 30 days ending yesterday), `builder` (id/address substring), `top` (default 20), fields |
| `flowscan_builders_user_series` | Daily active traders and new traders since 2025-07-27, overall or per builder. | `builder`, `days` (default 30), `metric` (`both` default, `traders`, `newTraders`), fields |
| `flowscan_builder_dashboard` | One builder's dashboard over a fixed window ending yesterday (UTC): stats (volume, revenue, fills, unique/new traders, volume shares, run-rate), daily series, volume/revenue by asset; `resolvedBuilder` when a name or id was resolved. | **`builder`** (0x address preferred, `id:<id>`, or a name; ambiguous names return candidates), `window` (`30d` default, `7d`, `90d`, `all`), `section` (`all` default, `stats`, `daily`, `assets`), `days` (daily series length, default 90), `assetsLimit` (default 40), fields |

The leaderboard and dashboard only offer fixed windows (1d/7d/30d/90d/all_time and 7d/30d/90d/all). For any other range, such as "the past 45 days", use `flowscan_builder_revenue`. Builder names are not unique on Flowscan (there are two "fomo" builders, and one's id is the other's name), so resolve names with `flowscan_builder_lookup` first and pass the `address` or `id:<id>`.

### Builder Intelligence (`/builder-intelligence`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_builder_intelligence_list` | The roughly 120 analysed builders (id, name, category, total/active users, revenue, volume, 7d new users) and the categories. | `search`, `category`, `sortBy` (`total_revenue` default), `includeCategories` (default true), fields/limit/offset (default 50) |
| `flowscan_builder_intelligence_detail` | One builder's report: user status, revenue, cohorts, lifecycle, retention, daily activity, top users, heatmap, daily revenue. Address lists are reduced to `{count, sample}`. | **`builderId`** (as shown by `flowscan_builder_intelligence_list`, case-insensitive), `sections` (default `metadata`, `key_metrics`, `user_status_metrics`, `revenue_metrics`), `startDate`, `endDate`, fields/limit/offset (default 50 top-level, 20 nested) |
| `flowscan_builder_intelligence_summary` | Aggregates for a category or `overall`: builders included, totals (users, active users, revenue, fees 24h/7d/30d/90d, retention) and user-weighted averages. | `category` (default `overall`), `startDate`, `endDate`, `includeExcludedBuilders`, fields |

"7d new users" in the leaderboard, the user series and Builder Intelligence come from different Flowscan datasets and can differ.

Addresses must be `0x` followed by 40 hex characters. Exact parameter descriptions are in the tool schemas the server advertises (`src/tools/*.ts`).

## DEX names

The `/hip-3` analytics use display names, while market symbols (`xyz:TSLA`), address data and deployer fees use the on-chain DEX prefix. Tools that take a `dex` (the HIP-3 tools, `flowscan_revenue_deployer_fees` and `flowscan_address_summary`) accept either form, case-insensitively. `flowscan_hip3_dex` and `flowscan_address_summary` reject an unknown name with an error that lists the valid ones; in the other tools an unknown name simply matches nothing.

| Display name | On-chain prefix |
| --- | --- |
| XYZ | `xyz` |
| FLX | `flx` |
| Hyena | `hyna` |
| KM | `mkts` (was `km` until 2026-06) |
| VNTL | `vntl` |
| Dreamcash | `cash` |
| Paragon | `para` |
| Entropy | `io` |

`flowscan_coverage` (`hip3DexNames`) and `flowscan_hip3_overview` (`dexAliases`) return the same table.

## Output shaping

Several Flowscan routes return megabytes of JSON. Tool results are shaped so they stay usable by a model.

**Envelope.** A successful result is one compact JSON text block. Pretty-printed and abridged, it looks like this:

```json
{
  "source": "https://www.flowscan.xyz/api/perp-snapshot/markets",
  "network": "mainnet",
  "paging": { "total": 330, "offset": 0, "limit": 60, "hasMore": true },
  "data": { "...": "..." }
}
```

`source` is the Flowscan route the data came from. For POST routes it is the route path only, without the request body (such as `{type: "hypercoreFeeSummary"}`). Some tools add other top-level keys such as `units`, `kind`, `window`, `capped`, `coveredRange`, `nextStartTime` or `note`. `flowscan_coverage` returns the coverage map directly, without the envelope.

**`fields`.** A list of keys or dotted paths of `data` to keep, for example `["summary", "by_token.USDC"]`. Everything else in `data` is dropped. When `data` is a list of rows (revenue series, orders, fills, ledger), `fields` applies to each row.

**`limit` / `offset`.** Page through the tool's main list. Each tool has its own default page size (see the tools table). `paging.hasMore` tells you whether there is more. The address orders, fills and ledger tools report `paging.rowsReturned` instead of `paging.total`, because the upstream response may itself be capped. Some tools have a `limit` with a different meaning, such as the number of positions or events Flowscan returns; their descriptions say so.

**Size cap.** If the serialized result is longer than `FLOWSCAN_MAX_RESULT_CHARS` (default 60,000 characters), the server shortens the largest lists (keeping their first items) until it fits, and the result stays valid JSON. It then carries two extra top-level keys:

```json
{
  "_truncated": [{ "path": "data.markets", "originalLength": 330, "kept": 120 }],
  "_truncatedNote": "[TRUNCATED: response was 152345 chars; the lists in _truncated were shortened to their first items to stay under 60000. Use `fields`, `limit`/`offset` or a narrower query for the rest.]"
}
```

(If the top-level value was a list, it is wrapped as `{"items": [...]}` first.) Only if that is still not enough, for example because of one huge string, is the text cut at the limit and followed by a plain `[TRUNCATED: ...]` marker; that last-resort output is not valid JSON. In either case, ask again with `fields`, a smaller `limit` or a narrower tool.

### Errors

Failures come back as an MCP tool error (`isError: true`) with this body:

```json
{"error":"Flowscan returned HTTP 404 for /api/...","status":404,"route":"/api/...","source":"www.flowscan.xyz"}
```

`status` is `null` for timeouts and network errors. `status` and `route` are both `null` for errors the server raises itself before calling Flowscan, such as an invalid date range, an unknown DEX name or an unknown validator. An unknown market in `flowscan_perp_positions` is a 404 whose message lists candidate symbols.

Only transient failures are retried, up to twice with backoff: HTTP 429, HTTP 5xx, timeouts and network errors. HTTP 400/404 and the deterministic HTTP 500 that Flowscan's address route returns for a malformed query (body containing "Check your request body") are returned immediately.

## Environment variables

All are optional.

| Variable | Default | Effect |
| --- | --- | --- |
| `FLOWSCAN_BASE_URL` | `https://www.flowscan.xyz` | Base URL for requests. Only useful for testing against a mirror or a mock; the `source` field in results always shows `https://www.flowscan.xyz`. |
| `FLOWSCAN_TIMEOUT_MS` | `45000` | Per-request timeout in milliseconds. |
| `FLOWSCAN_MAX_CONCURRENCY` | `4` | Maximum simultaneous requests to Flowscan. Extra calls wait. |
| `FLOWSCAN_CACHE_TTL_MS` | `20000` | In-memory cache lifetime for ordinary responses. Identical requests within this window reuse the cached result. |
| `FLOWSCAN_LONG_CACHE_TTL_MS` | `300000` | Cache lifetime for large, slow-changing payloads (HIP-3 snapshot, per-DEX and builder stats, Binance comparison, builders leaderboard and all-time summary, builders user series, builder intelligence). |
| `FLOWSCAN_MAX_RESULT_CHARS` | `60000` | Maximum characters in one tool result before truncation. |

## Not covered

These appear on flowscan.xyz but are not served by Flowscan's servers. The Flowscan page fetches them in your browser directly from Hyperliquid hosts (`rpc.hyperliquid.xyz`, `api.hyperliquid.xyz`, `api-ui.hyperliquid.xyz`, `api.hyperunit.xyz`). Because this server only talks to www.flowscan.xyz, it cannot return them:

- Block details (`/block/{height}`)
- Transaction details (`/tx/{hash}`)
- The live block and transaction feed on the homepage
- Live market prices (HYPE/USD, BTC and so on), candles and order books
- On the address page: the portfolio chart, the EVM balance and Unit bridge operations

Also not available:

- Testnet. Flowscan only shows Hyperliquid mainnet, so every result is mainnet.
- Any write action. All tools are read-only; nothing places orders or moves funds.

Some prices are available because Flowscan serves them: entry and liquidation prices in position data, tokenized-stock marks (`flowscan_spot_stocks`), HIP-4 outcome prices and candles (`flowscan_hip4_*`), weekend TradFi closes (`flowscan_weekend_prices`) and Binance last prices for RWA symbols (`flowscan_hip3_binance_comparison`). Because the HYPE price is not available, priority gas is reported in HYPE, not USD.

For anything in the list above, open the page on flowscan.xyz in a browser or use a separate Hyperliquid tool.

## Data freshness

Data is as fresh as Flowscan's own backend, plus this server's cache:

- Perp positioning snapshot (`flowscan_perp_*`, `flowscan_address_perp_positions`): refreshed by Flowscan every few minutes. The perp tools return `snapshotIso` and `snapshotAgeSeconds`.
- Address tools: live account state as Flowscan serves it at request time.
- Revenue series: one row per UTC day. Today's row is still accumulating and has `partial: true`; `flowscan_revenue_summary` reports complete days separately from the partial current day.
- HIP-3 daily series: `lastDayPartial` is true when the last date is today (UTC).
- Builder revenue and dashboard: daily, ending yesterday (UTC). The dashboard routes only have data from mid-2026 on.
- Peers: an hourly network crawl. `meta.crawledAt` says when.
- Builder Intelligence: roughly daily.
- HIP-3, HIP-4 and builder payloads carry their own `generated_at` / `generatedAt` where Flowscan provides one.

This server caches responses in memory for 20 seconds (60 seconds for the HIP-4 market list, 5 minutes for the large payloads listed under `FLOWSCAN_LONG_CACHE_TTL_MS`). Restarting the server clears the cache.

## Development

```sh
npm install          # also builds, via the prepare script
npm run typecheck    # tsc --noEmit
npm run build        # compile src/ to dist/
npm test             # offline unit tests, no network
npm run smoke        # live smoke test against www.flowscan.xyz (uses dist/, so build first)
npx tsx scripts/qa/scenarios.ts   # live QA scenarios, run from src/
npm run dev          # run the server from source with tsx
```

`npm run smoke` and the QA scenarios hit the real site, so they need network access and can fail when Flowscan changes a route. CI runs typecheck, build and unit tests on Node 20 and 22; the live checks only run when the workflow is started by hand. See [CONTRIBUTING.md](CONTRIBUTING.md) for how routes were found and how to add a tool.

Layout:

- `src/index.ts`: stdio entry point
- `src/server.ts`: creates the MCP server and registers tool groups
- `src/client.ts`: the only module that does network I/O (timeouts, retries, cache, concurrency limit)
- `src/dex.ts`: HIP-3 DEX display name to on-chain prefix table
- `src/shape.ts`: `fields`/`limit`/`offset`, envelope, truncation, errors
- `src/coverage.ts`: page to tool map, used by `flowscan_coverage`
- `src/tools/*.ts`: one file per Flowscan page area, plus shared resolvers (`builderDirectory.ts`, `validators.ts`)
- `test/`: offline unit tests (`npm test`)
- `scripts/smoke.ts`: live smoke test that calls every tool
- `scripts/qa/`: live agent-style scenario harness (see `scripts/qa/README.md`)

## License

MIT. See [LICENSE](LICENSE).

This project is not affiliated with Flowscan or Hyperliquid.

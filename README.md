# flowscan-mcp

An MCP server that exposes the data shown on [flowscan.xyz](https://www.flowscan.xyz) as tools for AI agents. Flowscan is a real-time explorer and analytics site for the Hyperliquid blockchain (HyperCore, HIP-3 perp DEXs and HIP-4 outcome markets). It is not related to the Flow blockchain. With this server an agent can answer questions such as "what did Hyperliquid earn in fees yesterday", "who holds the largest BTC longs", "which builder code earned the most this week" or "what positions does 0x... have open", using the same numbers a person would see on the site.

- 44 read-only tools, grouped by Flowscan page; 58 with the opt-in [Hyperliquid-direct mode](#two-modes)
- Hyperliquid mainnet only (Flowscan has no testnet mode)
- No API key
- stdio transport, Node.js 20 or newer (22 or newer for the three WebSocket tools of direct mode)

## Two modes

The server has two modes. The default is strict; the second is opt-in.

| | Strict (default) | Hyperliquid-direct (opt-in) |
| --- | --- | --- |
| Enable | nothing to set | `FLOWSCAN_HYPERLIQUID_DIRECT=1` (or `true`) in the server's environment |
| Tools | 44 | 58: the same 44 plus 14 [Hyperliquid-direct tools](#hyperliquid-direct-tools-opt-in) |
| Hosts contacted | only `https://www.flowscan.xyz` | `www.flowscan.xyz` plus exactly `api.hyperliquid.xyz`, `rpc.hyperliquid.xyz`, `api-ui.hyperliquid.xyz` and `api.hyperunit.xyz` (HTTPS, and WSS to the two Hyperliquid WebSocket endpoints) |
| Adds | | block and transaction lookups, the live block/tx feed, prices, candles, order books, recent trades, spot token directory, perp DEX list, validator APR/uptime, borrow/lend APYs, and the address page's portfolio chart, HyperEVM balance and Unit bridge operations |
| Tool list size (JSON schemas the client loads) | about 59,700 characters | about 74,300 characters |

The tool list is loaded into the model's context, so direct mode costs roughly a quarter more context on every conversation. Enable it only if you need the extra panels.

### Strict mode: only flowscan.xyz

The server sends requests to exactly one host: `https://www.flowscan.xyz`. It calls the same `/api/*` routes the Flowscan web frontend calls. It never contacts `api.hyperliquid.xyz`, `rpc.hyperliquid.xyz`, `api-ui.hyperliquid.xyz`, `api.hyperunit.xyz`, Hydromancer or any other upstream directly. This is enforced in code: the Flowscan client (`src/client.ts`) refuses any URL that is not `https://www.flowscan.xyz`, so `FLOWSCAN_BASE_URL` cannot point it anywhere else, and the upstream client refuses every request while the switch is off. (The address tools use Flowscan's own `/api/hydromancer/info` route. That route is served by www.flowscan.xyz; whatever Flowscan's backend does behind it is not visible to, or called by, this server.)

This rule has a cost: some things you can see on Flowscan are fetched by your browser straight from Hyperliquid hosts, not from Flowscan's servers, so strict mode cannot return them. See [Not covered](#not-covered).

### Hyperliquid-direct mode (opt-in)

With `FLOWSCAN_HYPERLIQUID_DIRECT=1`, the server also serves those in-browser panels by making exactly the requests the Flowscan page makes (the same request bodies and WebSocket subscriptions, found in Flowscan's JavaScript bundles) to exactly the hosts the page uses. Hard limits, in `src/upstream.ts` and unit-tested:

- Allowlist: `api.hyperliquid.xyz`, `rpc.hyperliquid.xyz`, `api-ui.hyperliquid.xyz`, `api.hyperunit.xyz`; `https://` or `wss://` only, default port only. Anything else is refused before any I/O.
- Mainnet only (these are the mainnet hosts Flowscan uses).
- At most 2 upstream requests at a time (WebSockets have their own limit of 2).
- Short caches: prices 5 s, metadata (spot/perp metas, validator summaries, reserves) 60 s, explorer blocks/txs and Unit operations 30 s, portfolio 20 s; the HyperEVM balance is not cached.
- HTTP 429 from Hyperliquid is never retried; the error carries a `hint` with how long to wait. Other 4xx are not retried; 5xx, timeouts and network errors are retried up to twice.
- `flowscan_live_feed`, `flowscan_order_book` and `flowscan_recent_trades` use WebSockets and need Node.js 22 or newer (global `WebSocket`). On Node 20 they return an error; everything else works.

Results from these tools use a different envelope (see [Output shaping](#output-shaping)): `source` is the upstream URL that was called, `shownOn` is the Flowscan page where the same data appears, and `mode` is `"hyperliquid-direct"`.

These `/api/*` routes and upstream requests are undocumented. Flowscan or Hyperliquid can change them at any time. When one breaks, the tool returns a structured error that names the route (see [Errors](#errors)) instead of guessing.

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

Any client config above accepts an `env` object. To turn on [Hyperliquid-direct mode](#two-modes):

```json
{
  "mcpServers": {
    "flowscan": {
      "command": "node",
      "args": ["/absolute/path/to/flowscan_mcp/dist/index.js"],
      "env": { "FLOWSCAN_HYPERLIQUID_DIRECT": "1" }
    }
  }
}
```

The same block works in `claude_desktop_config.json`, a project `.mcp.json` and `.cursor/mcp.json`; see [examples/claude_desktop_config.direct.json](examples/claude_desktop_config.direct.json) and [examples/mcp.direct.json](examples/mcp.direct.json). With the Claude Code CLI:

```sh
claude mcp add flowscan -e FLOWSCAN_HYPERLIQUID_DIRECT=1 -- npx -y github:joshavenue/flowscan_mcp
```

Other variables (see [Environment variables](#environment-variables)) go in the same `env` object, for example `"FLOWSCAN_MAX_RESULT_CHARS": "30000"`. Restart the client after changing them; the mode is fixed when the server starts.

### Agent skill

[skills/flowscan/SKILL.md](skills/flowscan/SKILL.md) is an optional agent skill that tells a model which tool to use for common questions. For Claude Code, copy the folder to `~/.claude/skills/flowscan` (or `.claude/skills/flowscan` inside a project).

## Tools

These 44 tools are available in both modes. All tools are read-only (annotated `readOnlyHint`). Required parameters are in **bold**. "fields/limit/offset" means the tool accepts the standard [output-shaping](#output-shaping) parameters; "fields" alone means it only accepts `fields`. Default page sizes are noted where a tool pages a list. Each tool's description names the Flowscan page it mirrors; the route is in the `source` field of every result.

### Start here

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_coverage` | Map of Flowscan pages to tools, what is not served, HIP-3 DEX display names vs on-chain prefixes (`hip3DexNames`), the mainnet-only rule and output conventions. With `topic`, also `notServedMatches` and `servedByThisServer` (false when the topic only matches something this server cannot serve). No network call. | `topic` (keywords, e.g. `revenue`, `hip-3`, `tx hash`) |

### Homepage (`/`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_stablecoin_margin` | "Stablecoin Perp Margin" panel: stablecoin value on HyperCore split into spot balances and perp margin, overall and per token (USDC, USDT, USDE, USDH): balances, holders/traders, average/median, total value, market share. USD. | fields |
| `flowscan_perp_markets` | Perp positioning snapshot for every perp market (about 330, including HIP-3 markets like `xyz:TSLA`): long/short counts and notional, ratios, open interest, average entry, median leverage, unique addresses, `snapshotIso`/`snapshotAgeSeconds`. | `market`, `sortBy` (default `openInterest`), fields/limit/offset (default 60) |
| `flowscan_perp_positions` | Open positions in one market, largest first: address, signed size, notional, side, entry, leverage, liquidation price, account value, funding PnL, all-time PnL, size change since the previous snapshot; `total`/`totalPages`, `snapshotIso`/`snapshotAgeSeconds`; `marketSummary` (whole market, unfiltered: long/short counts and notional, OI, median leverage, average entry) and `filteredSideSummary` (only the rows matching the filters, with the applied `filter`). A bare HIP-3 symbol (`TSLA`) resolves to `xyz:TSLA` when unique; otherwise the error lists candidates. | **`market`** (case-insensitive), `side`, `sort` (`notional` default, `size`), `dir`, `minSize`/`maxSize`, `minNotional`/`maxNotional`, `minEntry`/`maxEntry`, `minLiq`/`maxLiq`, `minReturn`/`maxReturn`, `markPx`, `limit` (default 50, max 200), `page` (1-based), fields |
| `flowscan_address_perp_positions` | One address's open perp positions across all markets (including HIP-3) from the latest snapshot, sorted by notional, with `totalNotional` and `totalPositions`. | **`address`**, `market`, `side`, fields/limit/offset (default 50) |

`openInterest` in the perp snapshot (and OI in the HIP-3 tools) is Flowscan's two-sided figure: long notional + short notional. That is twice the one-sided OI some other interfaces show. In direct mode, `flowscan_prices` returns Hyperliquid's own figure, which is on the same two-sided basis (`openInterestUsdTwoSided`, directly comparable), and `openInterestUsdOneSided` (half). Always say which one you quote. The homepage "24h Revenue" card is served by the revenue tools below.

### Revenue (`/revenue`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_revenue_hypercore_fees` | One row per UTC day, oldest first: `nativeHypercoreFee` (non-HIP-3 markets) and `hip3HypercoreFee` (HIP-3 markets), USDC, plus `rangeTotals`. History starts 2026-03. Today's row (only with `includeToday`, or an explicit range that reaches today) has `partial: true`. | `days` (last N complete UTC days ending yesterday, default 90), or `startDate`/`endDate`, or `startTime`/`endTime` (Unix ms), `includeToday` (append today's partial row), fields/limit/offset (default 400) |
| `flowscan_revenue_deployer_fees` | Daily HIP-3 deployer fees (`totalFee`) with `byDex` per on-chain DEX name, plus `rangeTotals` (overall and per DEX). With `dex`, rows also have `dexTotalFee` and `allDexTotalFee`. USDC. Paid to deployers, not protocol revenue. | `days` (last N complete UTC days ending yesterday, default 90), or `startDate`/`endDate`, or `startTime`/`endTime` (Unix ms), `includeToday` (append today's partial row), `dex` (on-chain name like `xyz`, or display name like `KM`), fields/limit/offset (default 400) |
| `flowscan_revenue_priority_gas` | Daily write/read priority gas (`totalGas` in HYPE, `count`), `rangeTotals`, optionally the top 5 gas-paying users per day. | `days` (last N complete UTC days ending yesterday, default 90), or `startDate`/`endDate`, or `startTime`/`endTime` (Unix ms), `includeToday` (append today's partial row), `includeTopUsers` (default false), fields/limit/offset (default 400) |
| `flowscan_revenue_summary` | For the last 1, 7 and 30 complete UTC days: native fees, HIP-3 fees, their sum `totalUsdcExcludingGas`, deployer fees (USDC) and priority gas (HYPE); the current partial day separately; annualized run-rate from the trailing 7 days; a note on how Flowscan's headline figure is built. Computed by this server from the three series above. | fields |

Flowscan's headline "Combined" revenue is native HyperCore fees + HIP-3 HyperCore fees + priority gas converted at the live HYPE price. Deployer fees are not part of it. Flowscan's routes do not expose the HYPE price and this server does not fetch it, so gas is reported in HYPE and the USDC part is `totalUsdcExcludingGas`.

### Address (`/address/{address}`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_address_summary` | Account role (user/vault/subAccount/agent/missing), lifetime PnL summary (PnL, win rate, trades, hold time, volume, fees, funding, days active, `tradedPairs` as `{count, first30}`), live perp state (account value, notional, margin, withdrawable, positions with size, entry, leverage, liquidation, uPnL, ROE, funding; largest first) and non-zero spot balances. | **`address`**, `include` (any of `role`, `pnlSummary`, `perpState`, `spotBalances`; default all), `dex` (HIP-3 DEX for perp state, display name or prefix; unknown names are rejected; default main DEX), `positionsLimit` (default 50), `balancesLimit` (default 50), fields |
| `flowscan_address_orders` | `open`: resting orders on every DEX. `openDetailed`: main-DEX orders with trigger/TP-SL/reduce-only/TIF details (upstream max 100, then `capped`). `historical`: the newest ~2000 orders with final status, `countsByStatus` over all of them, and `coveredRange`/`capped`. Always `count` of matching orders; times have ISO twins. | **`address`**, `kind` (`open` default, `openDetailed`, `historical`), `coin`, fields/limit/offset (default 100 for `open`, 50 otherwise) |
| `flowscan_address_fills` | Fills, newest first: coin, price, size, side, direction, closed PnL, fee, tx hash, time and `timeIso`. `totals` over ALL matched fills in `coveredRange` (not just the page): `count`, `closedPnlUsdc`, `feesUsdc`, `feesByToken`, `volumeUsd` (px x sz), `byCoin`. Without `startTime`: the latest ~2000 fills. With `startTime`: follows pages past the upstream 2000-row cap (up to `maxPages`); if still `capped`, `nextStartTime` + `capNote`. | **`address`**, `startTime`, `endTime` (Unix ms), `aggregateByTime` (default true), `coin` (applied before totals), `maxPages` (default 5, max 10), fields/limit/offset (default 50) |
| `flowscan_address_ledger` | Newest first, rows with `timeIso`. `ledger`: deposits, withdrawals, sends, transfers, vault and staking moves; `totals.byType` `{count, sumUsdc, inUsdc, outUsdc}`. `funding`: hourly payments; `totals` `{count, netUsdc, paidUsdc, receivedUsdc, byCoin}` (netUsdc > 0 means received). Totals cover ALL matched rows in `coveredRange`. Same `maxPages`/`capped`/`nextStartTime` handling as fills. | **`address`**, `kind` (`ledger` default, `funding`), `startTime` (default 30 days ago for ledger, 7 days for funding), `endTime`, `coin` (applied before totals), `maxPages` (default 5, max 10), fields/limit/offset (default 50 for ledger, 100 for funding) |
| `flowscan_address_staking` | `totalDelegatedHype`, `validatorCount`, delegations `{validator, validatorName, commission_bps, is_jailed, amountHype, lockedUntil, lockedUntilIso}` and staking history, newest first. | **`address`**, `historyLimit` (default 50, max 500), fields |
| `flowscan_address_vaults_subaccounts` | Vault equities (vault, equity, lock-up) and sub-accounts (name, address, account value, notional, withdrawable, open positions, non-zero spot balances). | **`address`**, fields |
| `flowscan_address_extras` | Smaller widgets: approved builders (with max fee), HyperCore borrow/lend state and health, API rate limit, TWAP slice fills. | **`address`**, **`kind`** (`approvedBuilders`, `borrowLend`, `rateLimit`, `twapSliceFills`), fields/limit/offset (default 100 for lists) |

`flowscan_address_perp_positions` (homepage section) also takes an address. For orders, fills and ledger, quote `count`, `countsByStatus` and `totals` rather than adding rows; `paging.rowsReturned` counts the rows in the (possibly capped) upstream response, not every row in the period.

### Staking (`/validators`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_staking_overview` | Total HYPE staked, delegator and validator counts, and every validator (about 35) with name, address, commission (bps), total delegated, staker count, jailed flag; `sortedBy`. | `search`, `sortBy` (`total_delegated` default, `staker_count`, `commission_bps`, `name`), `order` (`desc` default, `asc` default for `name`), `excludeJailed`, `includeDescription` (default false), fields/limit/offset (default 50) |
| `flowscan_validator_stakers` | One validator's summary plus its delegators `{address, amount}` (HYPE), largest first. | **`validator`** (0x address or name; an ambiguous name returns candidates), `search`, fields/limit/offset (default 100) |
| `flowscan_staking_events` | Recent delegation/undelegation events, newest first: user, amount (HYPE), `isUndelegate`, tx hash, time (ms and `timeIso`). | **`validator`** (address or name), `limit` (default 50, max 500), fields |

### Peers (`/peers`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_peers` | Crawl of the Hyperliquid gossip network (about 600 nodes). Default: meta (crawl time, counts, reachability, states), footprint (top countries, ASNs) and sentries. `nodes`, `edges` and `all` are paged (`all` returns `nodesPaging`/`edgesPaging`). | `section` (`summary` default, `nodes`, `edges`, `all`), `country` (exact ISO code like `JP` or exact name like `Japan`), `state` (`syncing`, `full`, `unreachable`, `no_resp`, `other`), `role` (`hub`, `sentry`, `fringe`, `private`, `scraper`), `operator`, `nodeId`, fields/limit/offset (default 50 nodes, 500 edges; 30 nodes and 100 edges with `all`) |

### HIP-3 perp DEXs (`/hip-3`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_hip3_overview` | Totals across all HIP-3 DEXs (volume all-time/30d/90d, trades, traders, new users, OI), per-DEX and per-collateral market share, DEX list with collateral, builder-routed share of volume (top 3 builders per DEX), and `dexAliases`. | fields |
| `flowscan_hip3_daily` | Daily values per DEX for one metric as dated rows `[{date, XYZ: v, KM: v, ...}]` (today's row flagged partial), with `lastDayPartial`/`partialNote`. `raw: true` returns the positional `{dates, series}` form instead. | `metric` (`volume` default, `trades`, `traders`, `new_users`, `oi`, `oi_by_market`, `collateral_traders`, `collateral_oi`), `dex` (display name or prefix), `days` (default 30, may include today), `raw`, fields |
| `flowscan_hip3_markets` | All HIP-3 markets (dex, symbol, canonical underlying, asset class). With `symbol`: per listing DEX the OI, DAU, volume, spread, slippage, plus OI/DAU history trimmed to `days`. | `symbol`, `dex`, `assetClass`, `search`, `days` (default 30), fields/limit/offset (default 100) |
| `flowscan_hip3_dex` | One DEX: collateral, totals, every market with all-time volume, traders and current OI (sorted by volume), dated daily-total rows (today flagged partial). Unknown DEX names are an error that lists the valid ones. | **`dex`** (display name or prefix, case-insensitive), `days` (default 30), `includeMarketDaily`, `search`, fields/limit/offset (default 50) |
| `flowscan_hip3_builders` | Share of HIP-3 volume routed through builder codes, per-DEX builder volume with top builders, and 800+ builders ranked by HIP-3 volume only. | `search`, `window` (`total` default, `30d`, `90d`), `dex` (rank by volume on one DEX), `includePerDex`, fields/limit/offset (default 50) |
| `flowscan_hip3_binance_comparison` | About 240 real-world-asset symbols with the matching Binance USDT-M futures: Binance OI, 24h volume, last price. With `symbol`: Binance daily history (trimmed to `days`) and the HIP-3 side per DEX (OI, DAU, volume, spread, slippage). | `symbol`, `underlyingType` (`EQUITY`, `HK_EQUITY`, `KR_EQUITY`, `CN_EQUITY`, `COMMODITY`, `INDEX`, `FX`, `PREMARKET`), `sortBy` (`oi` default, `volume24h`, `lastPrice`), `days` (default 30), fields/limit/offset (default 50) |

### HIP-4 outcome markets (`/hip-4`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_hip4_markets` | `active`: slim rows (outcomeId, name, market type, asset ids, underlying/target/expiry, `yesMark`/`noMark` = implied probability 0 to 1, `yesChange24h`, `volume24h`, `totalVolume`, deployer, question), sorted by `sortBy`. `settled`: resolved outcomes. `questions`: question groups. `all`: all three. `full: true` for complete rows (descriptions, prev-day prices). | `section` (`active` default, `settled`, `questions`, `all`), `search`, `category`, `sortBy` (`volume24h` default, `totalVolume`, `yesMark`, `change24h`), `order` (`desc` default, `asc`), `full`, `includeContexts` (with `full`: raw spot contexts), `settledLimit` (default 100), fields/limit/offset (default 20; 10 per list with `all`) |
| `flowscan_hip4_outcome` | YES and NO candles for one outcome (`[openTime, open, high, low, close, volume, trades]`), per-side trade stats, and the settlement record for settled outcomes. | **`outcomeId`**, `yesAssetId`/`noAssetId` (default `#<outcomeId>0` / `#<outcomeId>1`; `#` is added if missing), `interval` (`1m`, `5m`, `15m`, `1h` default, `4h`, `1d`), `days` (default 7, max 90), `settled`, fields |
| `flowscan_hip4_labels` | Readable labels for HIP-4 asset ids such as `#14730`. | **`assets`** (1 to 100 ids) |

### Spot stocks (`/spot-stocks`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_spot_stocks` | Tokenized stocks on Hyperliquid spot: xStocks NVDAX, SPYX, QQQX, SKHYX, MUX, SNDKX, SPCXX, TSLAX, AAPLX, CRCLX and Dinari SPCXD. `current`: summary and per-token price, 24h/all-time volume, holders, traders, value, depth. `timeseries`: daily volume/holders/traders/value per token. `liquidity`: cumulative depth within 2/5/10/25 bps of mid in tokens and USD (`latestDepthUsd`), with a sampled history when `token` or `days` is given. `topHolders`: largest holders per token. | `section` (`current` default, `timeseries`, `liquidity`, `topHolders`), `token` (ticker or underlying substring, e.g. `MUX`, `NVDA`), `days` (timeseries default 30; liquidity history default 1 with `token`), fields/limit/offset (top holders: default 25 per token with `token`, 10 without) |

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

## Hyperliquid-direct tools (opt-in)

Registered only when `FLOWSCAN_HYPERLIQUID_DIRECT=1` (see [Two modes](#two-modes)). Each mirrors a Flowscan panel that the Flowscan page loads from Hyperliquid in the browser; "Shown on" is the page, and the result's `shownOn` field links it. Same conventions as above: required parameters in **bold**, "fields/limit/offset" = the standard shaping parameters.

| Tool | Shown on | Upstream | Returns | Key params |
| --- | --- | --- | --- | --- |
| `flowscan_block` | `/block/{height}` | `rpc.hyperliquid.xyz/explorer` (`blockDetails`) | Height, time, hash, proposer, tx count, success rate, failed count, transaction breakdown by action type, and the transactions table (hash, user, type, status, one-line summary). | **`height`**, `type` (action type, e.g. `order`), `status` (`success`, `error`), `user`, `includeAction` (raw actions, large), fields/limit/offset (default 50 txs) |
| `flowscan_transaction` | `/tx/{hash}` | `rpc.hyperliquid.xyz/explorer` (`txDetails`) | Hash, block, time, user, status/error, action type and Flowscan label, a one-line summary (asset, side, size, price, notional, amount, destination) and the full action payload. | **`hash`**, fields |
| `flowscan_live_feed` | `/` (Live Block Activity, Recent Blocks, Recent Transactions) | `wss://rpc.hyperliquid.xyz/ws` | Listens for `seconds`, then returns `latestBlock`, `blocks` `{count, heightRange, rowsReturned, rows}` (height, time, hash, proposer, tx count) and `txs` `{count, countsByType, timeSpanMs, timeSpanIso, rowsReturned, rows}` (user, action summary, status), newest first; counts and time span cover the whole sample received (a sample of the explorer's stream, not every tx). Plus blocks/s, txs/s and block-interval stats. Node 22+. | `seconds` (default 5, max 15), `include` (`blocks`, `txs`, `both` default), `limit` (default 20, max 120; transactions max 50) |
| `flowscan_prices` | `/` (perp positioning), `/revenue` (HYPE price) | `api.hyperliquid.xyz/info` (`allMids`, `metaAndAssetCtxs`) | Mark, mid, oracle, 24h change, hourly funding and APR, premium, open interest as `openInterestTwoSided`/`openInterestUsdTwoSided` (long + short: Hyperliquid's `openInterest` is two-sided, the same basis as Flowscan's perp snapshot `openInterest`, so directly comparable) and `openInterestUsdOneSided` (half), explained in `oiNote`; 24h notional volume, max leverage. With `coins`: those coins (HIP-3 as `xyz:TSLA`; spot pairs/tokens give the mid only). Without: the top markets of one DEX, with `totals` (including `openInterestUsdTwoSided`). | `coins` (e.g. `["HYPE","BTC","xyz:TSLA"]`), `dex` (prefix or display name; default main), `sortBy` (`volume` default, `openInterest` = two-sided USD, `change`, `funding`), `includeDelisted`, fields/limit/offset (default 20) |
| `flowscan_candles` | `/address/{address}` (position price chart) | `api.hyperliquid.xyz/info` (`candleSnapshot`) | OHLCV rows `{t, tIso, o, h, l, c, v, n}`, oldest first, with an open/close/high/low/change/volume summary. Coin: perp (`BTC`), HIP-3 (`xyz:TSLA`), spot pair (`@107`) or spot token (`NVDAX`). | **`coin`**, `interval` (`1m`, `3m`, `5m`, `15m`, `30m`, `1h` default, `2h`, `4h`, `8h`, `12h`, `1d`, `3d`, `1w`, `1M`), `bars` (default 100, max 500, counted back from `endTime`), `startTime`, `endTime` (Unix ms; default now) |
| `flowscan_order_book` | `/hip-4` (outcome order books) | `wss://api.hyperliquid.xyz/ws` (`l2Book`) | One L2 snapshot: top bids/asks with size, order count, cumulative size and USD, best bid/ask, mid, spread (bps). Coin: `BTC`, `xyz:TSLA`, `@107`, `NVDAX` or an outcome side like `#14730`. Node 22+. | **`coin`**, `depth` (default 10, max 20), `nSigFigs` (2 to 5, aggregates levels), `mantissa` (1, 2 or 5; only with `nSigFigs: 5`) |
| `flowscan_recent_trades` | `/hip-4` (outcome trades) | `wss://api.hyperliquid.xyz/ws` (`trades`) | The most recent trades (Hyperliquid sends the last 30): time, side (buy = taker bought), price, size, USD notional, hash, buyer, seller, plus buy/sell volume and VWAP. Node 22+. | **`coin`**, `limit` (default and max 30), fields |
| `flowscan_spot_tokens` | `/address/{address}` (spot balance names and values) | `api.hyperliquid.xyz/info` (`spotMetaAndAssetCtxs`) | Spot directory per pair: pair id (`@702`), base/quote token, token index, decimals, mark/mid, 24h change and volume, circulating/total supply, market cap. Maps `@702` to `NVDAX`. | `search` (name, full name, pair id or token index), `sortBy` (`volume` default, `marketCap`, `name`), fields/limit/offset (default 50) |
| `flowscan_perp_dexs` | `/weekend-trading` | `api.hyperliquid.xyz/info` (`allPerpMetas`, `spotMeta`) | Every perp DEX (main + HIP-3): index, on-chain prefix, Flowscan display name, collateral token, active/delisted market counts and market names. | `dex` (prefix, display name, or `main`), `includeDelisted`, `namesLimit` (default 40; all with `dex`) |
| `flowscan_validator_summaries` | `/validators` (APR, uptime, recent blocks columns) | `api.hyperliquid.xyz/info` (`validatorSummaries`) | Per validator: stake (HYPE), commission, jailed/active, recent blocks proposed, uptime % and predicted APR % for the window, plus average APR. | `window` (`day`, `week` default, `month`), `sortBy` (`stake` default, `apr`, `uptime`, `commission`, `recentBlocks`, `name`), `order` (`asc`, `desc`), `search`, `excludeJailed`, fields/limit/offset (default 50) |
| `flowscan_borrow_lend_reserves` | `/address/{address}` (Borrow/Lend tab APYs) | `api.hyperliquid.xyz/info` (`allBorrowLendReserveStates`, `spotMeta`) | Per token: supply APY, borrow APY, utilization, total supplied/borrowed, available, oracle price, LTV. | `token` (e.g. `USDC`, `HYPE`) |
| `flowscan_address_portfolio` | `/address/{address}` (portfolio chart) | `api-ui.hyperliquid.xyz/info` (`portfolio`) | Account value and PnL history for a window, downsampled with ISO times, latest/min/max and window volume; `windows` summarises every window (latest account value, PnL, volume). | **`address`**, `window` (`day`, `week`, `month`, `allTime` default, `perpDay`, `perpWeek`, `perpMonth`, `perpAllTime`), `series` (`accountValue`, `pnl`, `both` default), `maxPoints` (default 200) |
| `flowscan_address_evm_balance` | `/address/{address}` (EVM balance) | `rpc.hyperliquid.xyz/evm` (`eth_getBalance`) | HyperEVM HYPE balance: exact wei, HYPE decimal string and a float. HyperCore balances are in `flowscan_address_summary`. | **`address`** |
| `flowscan_address_unit_operations` | `/address/{address}` (Unit table) | `api.hyperunit.xyz/operations/{address}` (USD values priced with `metaAndAssetCtxs`/`spotMetaAndAssetCtxs`) | Unit bridge operations between Hyperliquid and Bitcoin/Ethereum/Solana, newest first: time, asset, chains, direction, amount, USD value at current prices, state, tx hashes and addresses; totals by direction and asset. | **`address`**, `direction` (`deposit`, `withdrawal`), fields/limit/offset (default 50) |

In direct mode `flowscan_coverage` reports `mode: "hyperliquid-direct"` and lists these tools on their pages.

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

The [Hyperliquid-direct tools](#hyperliquid-direct-tools-opt-in) use this envelope instead (illustrative block height, abridged):

```json
{
  "source": "https://rpc.hyperliquid.xyz/explorer",
  "shownOn": "https://www.flowscan.xyz/block/812345678",
  "mode": "hyperliquid-direct",
  "network": "mainnet",
  "fetchedAt": 1790924498621,
  "fetchedAtIso": "2026-10-02T07:41:38.621Z",
  "request": { "height": 812345678, "type": "blockDetails" },
  "data": { "...": "..." }
}
```

`source` is the upstream URL that was called, `shownOn` the Flowscan page where the same data is shown, `fetchedAt`/`fetchedAtIso` when the result was built (quote it as the snapshot time for prices and other live figures), and `request` the body or WebSocket subscription that was sent (a list when several requests were combined). Some add `shownOnNote`, `oiNote`, `paging` or `totals`.

**`fields`.** A list of keys or dotted paths to keep, relative to `data`, for example `["summary", "by_token.USDC"]`. A leading `data.` is accepted and stripped. Everything else in `data` is dropped. When `data` is a list of rows (revenue series, orders, fills, ledger), paths are relative to each row (`delta.usdc`, not `data.delta.usdc`). A path that matches nothing is never silent: the result gets `_fieldsNotFound` (the paths that missed) and `_availableFields` (the keys that do exist, from `data` or its first row), so a typo cannot be mistaken for "no data".

**`limit` / `offset`.** Page through the tool's main list. Each tool has its own default page size (see the tools table). `paging.hasMore` tells you whether there is more. The address orders, fills and ledger tools report `paging.rowsReturned` instead of `paging.total`, because the upstream response may itself be capped. Some tools have a `limit` with a different meaning, such as the number of positions or events Flowscan returns; their descriptions say so.

**Totals.** Tools that return many rows also return totals computed over every matched row, not just the current page: `rangeTotals` (revenue series), `totals` (fills, ledger and funding), `count`/`countsByStatus` (orders), `marketSummary`/`filteredSideSummary` (positions). Quote these instead of adding rows.

**Size cap.** If the serialized result is longer than `FLOWSCAN_MAX_RESULT_CHARS` (default 40,000 characters; dense JSON results of about 51,000 characters were too large for Claude Code's MCP output limit in the eval below), the server shortens the largest lists (keeping their first items) until it fits, and the result stays valid JSON. It then carries two extra top-level keys:

```json
{
  "_truncated": [{ "path": "data.markets", "originalLength": 330, "kept": 120 }],
  "_truncatedNote": "[TRUNCATED: response was 152345 chars; the lists in _truncated were shortened to their first items to stay under 40000. Use `fields`, `limit`/`offset` or a narrower query for the rest.]"
}
```

(If the top-level value was a list, it is wrapped as `{"items": [...]}` first.) Only if that is still not enough, for example because of one huge string, is the text cut at the limit and followed by a plain `[TRUNCATED: ...]` marker; that last-resort output is not valid JSON. In either case, ask again with `fields`, a smaller `limit` or a narrower tool.

### Errors

Failures come back as an MCP tool error (`isError: true`) with this body:

```json
{"error":"Flowscan returned HTTP 404 for /api/...","status":404,"route":"/api/...","source":"www.flowscan.xyz"}
```

For the Hyperliquid-direct tools, `source` is the upstream host and `route` the URL plus request type, for example `"https://api.hyperliquid.xyz/info {type:candleSnapshot}"`. A 429 from Hyperliquid also has a `hint` with how long to wait; it is not retried. A block or transaction that does not exist is a 404 ("Block not found" / "Transaction not found").

`status` is `null` for timeouts and network errors. `status` and `route` are both `null` for errors the server raises itself before calling Flowscan, such as an invalid date range, an unknown DEX name or an unknown validator. An unknown market in `flowscan_perp_positions` is a 404 whose message lists candidate symbols.

Only transient failures are retried, up to twice with backoff: HTTP 429, HTTP 5xx, timeouts and network errors. HTTP 400/404 and the deterministic HTTP 500 that Flowscan's address route returns for a malformed query (body containing "Check your request body") are returned immediately.

## Environment variables

All are optional.

| Variable | Default | Effect |
| --- | --- | --- |
| `FLOWSCAN_HYPERLIQUID_DIRECT` | unset (strict mode) | `1` or `true` turns on [Hyperliquid-direct mode](#two-modes): 14 more tools and the four allowlisted upstream hosts. |
| `FLOWSCAN_BASE_URL` | `https://www.flowscan.xyz` | Kept for tests only. The client refuses any URL that is not `https://www.flowscan.xyz`, so it cannot point the server at another host. |
| `FLOWSCAN_TIMEOUT_MS` | `45000` (Flowscan), `30000` (upstream) | Per-request timeout in milliseconds. When set, it applies to both. |
| `FLOWSCAN_MAX_CONCURRENCY` | `4` | Maximum simultaneous requests to Flowscan. Extra calls wait. |
| `FLOWSCAN_CACHE_TTL_MS` | `20000` | In-memory cache lifetime for ordinary responses. Identical requests within this window reuse the cached result. |
| `FLOWSCAN_LONG_CACHE_TTL_MS` | `300000` | Cache lifetime for large, slow-changing payloads (HIP-3 snapshot, per-DEX and builder stats, Binance comparison, builders leaderboard and all-time summary, builders user series, builder intelligence). |
| `FLOWSCAN_MAX_RESULT_CHARS` | `40000` | Maximum characters in one tool result before lists are shortened (see [Size cap](#output-shaping)). Raising it can make results too large for some MCP clients. |

## Not covered

### Not covered in strict mode (available in direct mode)

These appear on flowscan.xyz but are not served by Flowscan's servers. The Flowscan page fetches them in your browser directly from Hyperliquid hosts (`rpc.hyperliquid.xyz`, `api.hyperliquid.xyz`, `api-ui.hyperliquid.xyz`, `api.hyperunit.xyz`). In strict mode the server only talks to www.flowscan.xyz, so it cannot return them. With `FLOWSCAN_HYPERLIQUID_DIRECT=1` they are served by the tool in brackets:

- Block details, `/block/{height}` (`flowscan_block`)
- Transaction details, `/tx/{hash}` (`flowscan_transaction`)
- The homepage live block and transaction feed (`flowscan_live_feed`)
- Live market prices such as HYPE/USD or BTC, funding and 24h volume (`flowscan_prices`), candles (`flowscan_candles`), order books (`flowscan_order_book`) and recent trades (`flowscan_recent_trades`)
- The spot token directory and perp DEX market lists (`flowscan_spot_tokens`, `flowscan_perp_dexs`)
- Validator APR, uptime and recent blocks on `/validators` (`flowscan_validator_summaries`)
- Borrow/lend supply and borrow APYs (`flowscan_borrow_lend_reserves`)
- On the address page: the portfolio chart (`flowscan_address_portfolio`), the HyperEVM balance (`flowscan_address_evm_balance`) and Unit bridge operations (`flowscan_address_unit_operations`)

Some prices are available in strict mode because Flowscan serves them: entry and liquidation prices in position data, tokenized-stock marks (`flowscan_spot_stocks`), HIP-4 outcome prices and candles (`flowscan_hip4_*`), weekend TradFi closes (`flowscan_weekend_prices`) and Binance last prices for RWA symbols (`flowscan_hip3_binance_comparison`). Because the HYPE price is not available in strict mode, priority gas is reported in HYPE, not USD.

### Not covered in either mode

- Flowscan's hard-coded address label book (the names the site shows for known addresses).
- Live streaming updates. The WebSocket tools return a snapshot (or what arrived during a few seconds), not a continuous stream.
- Testnet. Flowscan only shows Hyperliquid mainnet, so every result is mainnet.
- Any write action. All tools are read-only; nothing places orders or moves funds.

## Dates and windows

- All days are UTC.
- `days: N` means the last N complete UTC days, ending yesterday, in the revenue series tools (`flowscan_revenue_hypercore_fees`, `_deployer_fees`, `_priority_gas`) and `flowscan_builder_revenue`. The `flowscan_revenue_summary` windows, the `flowscan_builders_daily_revenue` default range and the `flowscan_builder_dashboard` windows also end yesterday. Today's partial row is only added to the revenue series with `includeToday: true` (or an explicit range that reaches today), and is flagged `partial: true`.
- The HIP-3 series (`flowscan_hip3_daily`, `flowscan_hip3_dex`) end at Flowscan's latest date, which can be today; `lastDayPartial` and the row's `partial` flag say so.
- Builder date ranges are checked before any request: a start date in the future, or after the end date, is an error, and an end date of today or later is clamped to yesterday with a note.
- Results state the range they cover (`rangeTotals`, `range`, `windows[].from`/`to`, `coveredRange`). Quote it with the figure.

## Data freshness

Data is as fresh as Flowscan's own backend, plus this server's cache:

- Perp positioning snapshot (`flowscan_perp_*`, `flowscan_address_perp_positions`): refreshed by Flowscan every few minutes. The perp tools return `snapshotIso` and `snapshotAgeSeconds`.
- Address tools: live account state as Flowscan serves it at request time.
- Revenue series: one row per UTC day, complete days by default (see [Dates and windows](#dates-and-windows)); `flowscan_revenue_summary` reports the partial current day separately.
- HIP-3 daily series: `lastDayPartial` is true when the last date is today (UTC).
- Builder revenue and dashboard: daily, ending yesterday (UTC). The dashboard routes only have data from mid-2026 on.
- Peers: an hourly network crawl. `meta.crawledAt` says when.
- Builder Intelligence: roughly daily.
- HIP-3, HIP-4 and builder payloads carry their own `generated_at` / `generatedAt` where Flowscan provides one.

This server caches Flowscan responses in memory for 20 seconds (60 seconds for the HIP-4 market list, 5 minutes for the large payloads listed under `FLOWSCAN_LONG_CACHE_TTL_MS`). In direct mode, upstream responses are cached briefly (prices 5 s, metadata 60 s, blocks/txs 30 s; see [Two modes](#hyperliquid-direct-mode-opt-in)), and the WebSocket tools always open a fresh connection. Restarting the server clears the caches.

## Evaluation

The tools and the skill were tested with a model-in-the-loop eval: 220 natural-language prompts (revenue, builders, addresses, staking, HIP-3, HIP-4, spot stocks, weekend trading, perps, not-served, out-of-scope and adversarial requests) answered by a Sonnet agent in Claude Code that had only this server's tools and the skill, then graded by an Opus judge against a rubric, the tool results and directly computed ground truth. Before this round of fixes it scored 197 PASS (89.5%), 20 PARTIAL and 3 FAIL, and all 362 outbound requests went to www.flowscan.xyz. The failures drove the changes above: the lower result cap, server-side totals, `_fieldsNotFound`, ISO timestamps on rows, dated HIP-3 rows, `filteredSideSummary`/`marketSummary`, spot-stock tickers in the tool description, and the skill's rules on arithmetic, made-up numbers and other hosts.

- Report of the first run, with failure analysis: [docs/eval-2026-10-02.md](docs/eval-2026-10-02.md)
- Harness, prompts and how to re-run it: [scripts/eval/README.md](scripts/eval/README.md)

## Development

```sh
npm install          # also builds, via the prepare script
npm run typecheck    # tsc --noEmit
npm run build        # compile src/ to dist/
npm test             # offline unit tests, no network
npm run smoke        # live smoke test against www.flowscan.xyz (uses dist/, so build first)
npx tsx scripts/qa/scenarios.ts   # live QA scenarios, run from src/
FLOWSCAN_HYPERLIQUID_DIRECT=1 npm run smoke     # smoke test including the 14 direct-mode tools
npx tsx scripts/qa/scenarios.ts --upstream      # direct-mode QA scenarios (101-106)
npm run dev          # run the server from source with tsx
```

`npm run smoke` and the QA scenarios hit the real site, so they need network access and can fail when Flowscan changes a route. CI runs typecheck, build and unit tests on Node 20 and 22; the live checks only run when the workflow is started by hand. See [CONTRIBUTING.md](CONTRIBUTING.md) for how routes were found and how to add a tool.

Layout:

- `src/index.ts`: stdio entry point
- `src/server.ts`: creates the MCP server and registers tool groups
- `src/client.ts`: the www.flowscan.xyz client (host guard, timeouts, retries, cache, concurrency limit)
- `src/upstream.ts`: the direct-mode client (mode switch, host allowlist, HTTPS and WebSocket, concurrency 2, caches, 429 handling)
- `src/hyperliquid.ts`: the upstream request bodies, each the one Flowscan's own JavaScript sends
- `src/http.ts`: shared fetch, retry, cache and semaphore helpers
- `src/dex.ts`: HIP-3 DEX display name to on-chain prefix table
- `src/shape.ts`: `fields`/`limit`/`offset`, envelope, truncation, errors
- `src/coverage.ts`: page to tool map, used by `flowscan_coverage`
- `src/tools/*.ts`: one file per Flowscan page area, plus shared resolvers (`builderDirectory.ts`, `validators.ts`); the direct-mode tools are in `explorer.ts`, `markets.ts` and `accountDirect.ts`, registered by `direct.ts`
- `test/`: offline unit tests (`npm test`)
- `scripts/smoke.ts`: live smoke test that calls every tool
- `scripts/qa/`: live agent-style scenario harness (see `scripts/qa/README.md`)
- `scripts/eval/`: model-in-the-loop eval with a real agent and a judge (see `scripts/eval/README.md`)

## License

MIT. See [LICENSE](LICENSE).

This project is not affiliated with Flowscan or Hyperliquid.

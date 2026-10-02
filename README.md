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

All 44 tools are read-only and annotated as such. Required parameters are in **bold**. "fields/limit/offset" means the tool accepts the standard [output-shaping](#output-shaping) parameters; "fields" alone means it only accepts `fields`. Default page sizes are noted where a tool pages a list.

### Start here

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_coverage` | Map of Flowscan pages to tools, what is not served, the mainnet-only rule and output conventions. No network call. | `topic` (keyword filter, e.g. `revenue`, `hip-3`) |

### Homepage (`/`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_stablecoin_margin` | "Stablecoin Perp Margin" panel: stablecoin value on HyperCore split into spot balances and perp margin, overall and per token (USDC, USDT, USDE, USDH): balances, holders/traders, average/median, total value, market share. USD. | fields |
| `flowscan_perp_markets` | Perp positioning snapshot for every perp market, including HIP-3 markets like `xyz:TSLA`: long/short counts and notional, long/short ratios, open interest, average entry, median leverage, unique addresses. | `market`, `sortBy` (default `openInterest`), fields/limit/offset (default 60) |
| `flowscan_perp_positions` | Individual open positions in one market from the snapshot, largest first: address, signed size, notional, side, entry, leverage, liquidation price, account value, funding PnL, all-time PnL, size change since the previous snapshot; plus `total`/`totalPages` and a summary of the filtered set. | **`market`**, `side`, `sort` (`notional` default, `size`), `dir`, `minSize`/`maxSize`, `minNotional`/`maxNotional`, `minEntry`/`maxEntry`, `minLiq`/`maxLiq`, `minReturn`/`maxReturn`, `markPx`, `limit` (default 50, max 200), `page` (1-based), fields |
| `flowscan_address_perp_positions` | One address's open perp positions across all markets (including HIP-3) from the latest snapshot, sorted by notional, with `totalNotional` and `totalPositions`. | **`address`**, `market`, `side`, fields/limit/offset (default 50) |

The homepage "24h Revenue" card is served by the revenue tools below.

### Revenue (`/revenue`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_revenue_hypercore_fees` | One row per UTC day, oldest first: `nativeHypercoreFee` (non-HIP-3 markets) and `hip3HypercoreFee` (HIP-3 markets), USDC. History starts 2026-03. The last row is the current, still-accumulating day. | `startTime`, `endTime` (Unix ms), `days` (default 90 without a time range), fields/limit/offset (default 400) |
| `flowscan_revenue_deployer_fees` | Daily HIP-3 deployer fees (`totalFee`) with a per-DEX breakdown (`byDex`), USDC. | `startTime`, `endTime`, `days` (default 90), `dex` (exact, e.g. `xyz`), fields/limit/offset (default 400) |
| `flowscan_revenue_priority_gas` | Daily write/read priority gas (`totalGas` in HYPE, `count`), optionally with the top 5 gas-paying users per day. | `startTime`, `endTime`, `days` (default 90), `includeTopUsers` (default false), fields/limit/offset (default 400) |
| `flowscan_revenue_summary` | Totals over the last 1, 7 and 30 complete UTC days for native fees, HIP-3 fees, deployer fees (USDC) and priority gas (HYPE); the current partial day separately; annualized run-rate from the trailing 7 complete days. Computed by this server from the three series above. | fields |

### Address (`/address/{address}`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_address_summary` | Account role (user/vault/subAccount/agent/missing), lifetime PnL summary (PnL, win/loss rate, trades, median hold time, volume, fees, funding, days active), live perp state (account value, notional, margin, withdrawable, open positions with entry, leverage, liquidation, unrealized PnL, ROE) and non-zero spot balances. | **`address`**, `include` (any of `role`, `pnlSummary`, `perpState`, `spotBalances`; default all), `dex` (HIP-3 DEX for perp state, e.g. `xyz`; default main DEX), `positionsLimit` (default 50), fields |
| `flowscan_address_orders` | Open orders across all DEXs; open orders on the main DEX with trigger/TP-SL/TIF details; or recent order history (up to about 2000) with final status. | **`address`**, `kind` (`open` default, `openDetailed`, `historical`), `coin`, fields/limit/offset (default 100; 50 for `historical`) |
| `flowscan_address_fills` | Trade fills, newest first: coin, price, size, side, direction, closed PnL, fee, tx hash, order id, time. Most recent fills, or a time window (upstream returns at most 2000 per call; see `capped`/`coveredRange`). | **`address`**, `startTime`, `endTime`, `aggregateByTime` (default true), `coin`, fields/limit/offset (default 100) |
| `flowscan_address_ledger` | Non-funding ledger updates (deposits, withdrawals, transfers, vault flows, liquidations) or hourly funding payments, newest first. At most 2000 rows per call (see `capped`/`coveredRange`). | **`address`**, `kind` (`ledger` default, `funding`), `startTime` (default 30 days ago for ledger, 7 days for funding), `endTime`, `coin`, fields/limit/offset (default 100) |
| `flowscan_address_staking` | Current HYPE delegations per validator and delegation history. | **`address`**, `historyLimit` (default 50, max 500), fields |
| `flowscan_address_vaults_subaccounts` | Vault equities (vault, equity, lock-up) and sub-accounts (name, address, account value, notional, withdrawable, position count, spot balances). | **`address`**, fields |
| `flowscan_address_extras` | Smaller widgets: approved builders (with max fee), HyperCore borrow/lend state and health, API rate limit, TWAP slice fills. | **`address`**, **`kind`** (`approvedBuilders`, `borrowLend`, `rateLimit`, `twapSliceFills`), fields/limit/offset (default 100 for lists) |

`flowscan_address_perp_positions` (homepage section) also takes an address.

### Staking (`/validators`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_staking_overview` | Total HYPE staked, delegator and validator counts, and every validator with name, address, description, commission (bps), total delegated, effective stake, staker count, jailed flag. | `search`, `sortBy` (`total_delegated` default, `staker_count`, `commission_bps`, `name`), fields/limit/offset (default 50) |
| `flowscan_validator_stakers` | One validator's summary plus its delegators `{address, amount}` (HYPE), largest first. | **`validator`** (0x address), `search`, fields/limit/offset (default 100) |
| `flowscan_staking_events` | Recent delegation/undelegation events for a validator, newest first: user, amount (HYPE), undelegate flag, tx hash, time. | **`validator`**, `limit` (default 50, max 500), fields |

### Peers (`/peers`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_peers` | Crawl of the Hyperliquid gossip network. Default: meta (crawl time, node/edge counts, reachability, state counts), footprint (top countries, ASNs) and sentries. Nodes and edges on request. | `section` (`summary` default, `nodes`, `edges`, `all`), `country`, `state` (`syncing`, `full`, `unreachable`, `no_resp`, `other`), `role` (`hub`, `sentry`, `fringe`, `private`, `scraper`), `operator`, `nodeId`, fields/limit/offset (default 50 nodes, 500 edges) |

### HIP-3 perp DEXs (`/hip-3`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_hip3_overview` | Totals across all HIP-3 DEXs (volume all-time/30d/90d, trades, traders, new users, OI), per-DEX market share, DEX list with collateral token, collateral market share, builder-routed share of volume. | fields |
| `flowscan_hip3_daily` | Daily series per DEX for one metric. | `metric` (`volume` default, `trades`, `traders`, `new_users`, `oi`, `oi_by_market`, `collateral_traders`, `collateral_oi`), `dex`, `days` (default 30), fields |
| `flowscan_hip3_markets` | All HIP-3 markets (dex, symbol, canonical underlying, asset class), or with `symbol` the DEXs that list it plus OI/DAU history per DEX. | `symbol`, `dex`, `assetClass`, `search`, `days` (default 30), fields/limit/offset (default 100) |
| `flowscan_hip3_dex` | One DEX: collateral, totals, every market with volume/traders/OI, daily totals. | **`dex`**, `days` (default 30), `includeMarketDaily`, `search`, fields/limit/offset (default 50) |
| `flowscan_hip3_builders` | Share of HIP-3 volume routed through builder codes, per-DEX builder volume with top builders, and a builder leaderboard (address, name, total/30d/90d volume, shares). | `search`, `window` (`total` default, `30d`, `90d`), `dex` (rank by volume on one DEX), `includePerDex`, fields/limit/offset (default 50) |
| `flowscan_hip3_binance_comparison` | Real-world-asset symbols with the matching Binance USDT-M futures: Binance OI, 24h volume, last price. With `symbol`: Binance daily history plus the HIP-3 side (per-DEX OI, DAU, volume, spread, slippage). | `symbol`, `underlyingType` (`EQUITY`, `HK_EQUITY`, `KR_EQUITY`, `CN_EQUITY`, `COMMODITY`, `INDEX`, `FX`, `PREMARKET`), `sortBy` (`oi` default, `volume24h`, `lastPrice`), `days` (default 30), fields/limit/offset (default 50) |

### HIP-4 outcome markets (`/hip-4`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_hip4_markets` | Active YES/NO outcomes (ids, market type, underlying/target/expiry for price markets, YES/NO marks, 24h change, volume, deployer), recently settled outcomes, or question groups. | `section` (`active` default, `settled`, `questions`, `all`), `search`, `category`, `settledLimit` (default 100), fields/limit/offset (default 25; 10 per list with `all`) |
| `flowscan_hip4_outcome` | YES and NO candles for one outcome (`[openTime, open, high, low, close, volume, trades]`), per-side trade stats, and the settlement record for settled outcomes. | **`outcomeId`**, **`yesAssetId`**, **`noAssetId`** (from `flowscan_hip4_markets`), `interval` (`1m`, `5m`, `15m`, `1h` default, `4h`, `1d`), `days` (default 7, max 90), `settled`, fields |
| `flowscan_hip4_labels` | Readable labels for HIP-4 asset ids such as `#14730`. | **`assets`** (1 to 100 ids) |

### Spot stocks (`/spot-stocks`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_spot_stocks` | Tokenized stocks on spot (xStocks, Dinari). `current`: summary and per-token price, supply, volume, holders, traders, value, order-book depth. `timeseries`: daily volume/holders/traders/value. `liquidity`: latest depth within 2/5/10/25 bps plus sampled depth history. `topHolders`: largest holders per token. | `section` (`current` default, `timeseries`, `liquidity`, `topHolders`), `token`, `days` (timeseries default 30; liquidity history default 1), fields/limit/offset (top holders: default 25 per token with `token`, 10 without) |

### Weekend trading (`/weekend-trading`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_weekend_weeks` | Tracked weekends, newest first (`fridayCloseTs` is the week id, status, average % change, risers/fallers), optionally the session calendar. | `includeSchedule`, fields/limit/offset (default 26) |
| `flowscan_weekend_prices` | For HIP-3 TradFi perps (`xyz:TSLA`, `xyz:GOLD`, ...): Friday-close, Sunday-close (after the weekend) and live prices (during it), with % and dollar change. | `week` (a `fridayCloseTs`; default latest), `market`, fields |
| `flowscan_weekend_positions` | Per perp market: long/short counts and notional at Friday close vs the latest snapshot, new/closed positions, net changes, optionally the top 5 address changes. | `week`, `market`, `sortBy`, `includeTopAddressChanges`, fields/limit/offset (default 50) |
| `flowscan_weekend_coin_changes` | One HIP-3 TradFi market's Friday-to-Sunday move for every tracked weekend. Only DEX-prefixed symbols have data. | **`coin`** (e.g. `xyz:TSLA`), fields |

### Builders (`/builders`, `/builders/{id}`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_builder_lookup` | Resolves a builder name, id or address (substring) to candidates with id, name, category, address, revenue and volume per window, total users. Exact matches first; `ambiguous` is true when more than one fits. | **`query`**, `limit` (default 20) |
| `flowscan_builder_revenue` | One builder's total and daily revenue (USD) over any range, cross-checked between `/api/builders/all-daily-revenue` and `/api/dashboard/builder-daily-series` (both totals returned with the dates each covers). Returns candidates with `ambiguous: true` if the name is not unique. | **`builder`** (exact id or 0x address), `days` (default 30, ending yesterday UTC) or `startDate`/`endDate`, fields/limit/offset (default 60 daily rows, newest first) |
| `flowscan_builders_leaderboard` | "Builder Arena" table: about 1800 builder codes with id, name, category and revenue, volume, new/total users, avg revenue per user for the fixed windows 1d/7d/30d/90d/all_time, plus previous-period values. | `metric` (`revenue` default), `window` (`7d` default), `category`, `search`, fields/limit/offset (default 25) |
| `flowscan_builders_summary` | All-time builder revenue, volume, users and avg revenue per user, by category. | fields/limit/offset |
| `flowscan_builders_daily_revenue` | Revenue per builder per UTC day for a date range, with per-builder and grand totals (top 20 builders by default). | `startDate`, `endDate` (YYYY-MM-DD; default last 30 days ending yesterday), `builder` (id/address substring), `top` (default 20), fields |
| `flowscan_builders_user_series` | Daily active traders and new traders, overall or per builder. | `builder`, `days` (default 30), `metric` (`both` default, `traders`, `newTraders`), fields |
| `flowscan_builder_dashboard` | One builder's dashboard over a fixed window: stats (volume, revenue, fills, traders, volume share, run-rate), daily series, volume/revenue by asset. | **`builder`** (0x address), `window` (`30d` default, `7d`, `90d`, `all`), `section` (`all` default, `stats`, `daily`, `assets`), `assetsLimit` (default 40), fields |

The leaderboard and dashboard only offer fixed windows (1d/7d/30d/90d/all_time and 7d/30d/90d/all). For any other range, such as "the past 45 days", use `flowscan_builder_revenue`. Builder names are not unique on Flowscan (there are two "fomo" builders, for example), so resolve names with `flowscan_builder_lookup` first.

### Builder Intelligence (`/builder-intelligence`)

| Tool | Returns | Key params |
| --- | --- | --- |
| `flowscan_builder_intelligence_list` | The roughly 120 builders with intelligence reports (id, name, category, total/active users, revenue, volume, 7d new users) and the category list. | `search`, `category`, `sortBy` (`total_revenue` default), `includeCategories` (default true), fields/limit/offset (default 50) |
| `flowscan_builder_intelligence_detail` | One builder's report: user status, revenue metrics, cohorts, lifecycle, retention, daily activity, top users, heatmap, daily revenue. Address lists are reduced to `{count, sample}`. | **`builderId`** (e.g. `phantom`), `sections` (default `metadata`, `key_metrics`, `user_status_metrics`, `revenue_metrics`), `startDate`, `endDate`, fields/limit/offset (default 50) |
| `flowscan_builder_intelligence_summary` | Aggregates for a category or `overall`: builders included, totals (users, active users, revenue, fees 24h/7d/30d/90d, retention) and user-weighted averages. | `category` (default `overall`), `startDate`, `endDate`, `includeExcludedBuilders`, fields |

Addresses must be `0x` followed by 40 hex characters. Exact parameter descriptions are in the tool schemas the server advertises (`src/tools/*.ts`).

## Output shaping

Several Flowscan routes return megabytes of JSON. Tool results are shaped so they stay usable by a model.

**Envelope.** A successful result is one JSON text block (abridged):

```json
{
  "source": "https://www.flowscan.xyz/api/perp-snapshot/markets",
  "network": "mainnet",
  "paging": { "total": 230, "offset": 0, "limit": 60, "hasMore": true },
  "data": { "...": "..." }
}
```

`source` is the Flowscan route the data came from (for POST routes it is the route path; the request body, such as `{type: "hypercoreFeeSummary"}`, is named in the tool description). Some tools add `paging`, `units`, `kind`, `window` or `note`. `flowscan_coverage` returns the coverage map directly, without the envelope.

**`fields`.** A list of top-level keys or dotted paths to keep, for example `["summary", "by_token.USDC"]`. Everything else is dropped. When `data` is a list of rows (revenue series, orders, fills, ledger), `fields` applies to each row.

**`limit` / `offset`.** Page through the tool's main list. Each tool has its own default page size (see the tools table). `paging.hasMore` tells you whether there is more. Some tools have their own `limit` with a different meaning, such as the number of positions or events Flowscan returns; their descriptions say so.

**Size cap.** If the serialized result is still longer than `FLOWSCAN_MAX_RESULT_CHARS` (default 60,000 characters), it is cut and ends with a marker like:

```
[TRUNCATED: response was 412,345 chars; showing first 60,000. Narrow it with `fields`, `limit`/`offset` or a more specific tool.]
```

A truncated result is not valid JSON. Ask again with `fields`, a smaller `limit` or a narrower tool.

### Errors

Failures come back as an MCP tool error (`isError: true`) with this body:

```json
{ "error": "Flowscan returned HTTP 404 for /api/...", "status": 404, "route": "/api/...", "source": "www.flowscan.xyz" }
```

`status` is `null` for timeouts and network errors. Transient failures (HTTP 429, HTTP 5xx, timeouts, network errors) are retried up to twice with backoff before an error is returned.

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
- Market prices, candles and order books
- On the address page: the portfolio chart, the EVM balance and Unit bridge operations

Also not available:

- Testnet. Flowscan only shows Hyperliquid mainnet, so every result is mainnet.
- Any write action. All tools are read-only; nothing places orders or moves funds.

If you need those, open the page on flowscan.xyz in a browser or use a separate Hyperliquid tool.

## Data freshness

Data is as fresh as Flowscan's own backend, plus this server's cache:

- Perp positioning snapshot (`flowscan_perp_*`, `flowscan_address_perp_positions`): refreshed by Flowscan every few minutes. `flowscan_perp_markets` returns the snapshot `timestamp`.
- Address tools: live account state as Flowscan serves it at request time.
- Revenue series: one row per UTC day. The last row is the current day and is still accumulating; `flowscan_revenue_summary` reports complete days separately from the partial current day.
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
npm run smoke        # live smoke test: calls the tools against www.flowscan.xyz
npm run dev          # run the server from source with tsx
```

`npm run smoke` hits the real site, so it needs network access and can fail when Flowscan changes a route. CI runs typecheck, build and unit tests on Node 20 and 22; the smoke test only runs when the workflow is started by hand. See [CONTRIBUTING.md](CONTRIBUTING.md) for how routes were found and how to add a tool.

Layout:

- `src/index.ts`: stdio entry point
- `src/server.ts`: creates the MCP server and registers tool groups
- `src/client.ts`: the only module that does network I/O (timeouts, retries, cache, concurrency limit)
- `src/shape.ts`: `fields`/`limit`/`offset`, envelope, truncation, errors
- `src/coverage.ts`: page to tool map, used by `flowscan_coverage`
- `src/tools/*.ts`: one file per Flowscan page area

## License

MIT. See [LICENSE](LICENSE).

This project is not affiliated with Flowscan or Hyperliquid.

# Flowscan coverage matrix

Every page, tab, chart, table and filter found on www.flowscan.xyz on 2026-10-23, the tool that serves it, and its status before and after this change. The audit read each page in a browser, every JavaScript bundle the pages load (73 files) and every `/api` call they make, then called those routes directly.

Status:

- **covered**: served in strict mode (www.flowscan.xyz only).
- **partial**: some of it is served; the note says what is missing.
- **missing**: Flowscan has a route for it, but no tool used it.
- **direct**: the Flowscan page loads it in the browser from Hyperliquid, so it is served only with `FLOWSCAN_HYPERLIQUID_DIRECT=1`.
- **none**: no route this server may use (browser storage, or a non-Flowscan, non-Hyperliquid host).

## Summary

107 features in total.

| Status | Before | After |
| --- | --- | --- |
| covered | 56 | 87 |
| partial | 11 | 3 |
| missing | 23 | 0 |
| direct | 15 | 15 |
| none | 2 | 2 |

- Strict mode: **56 of 107 covered before, 87 of 107 after** (3 partial, 0 missing).
- With `FLOWSCAN_HYPERLIQUID_DIRECT=1`: 71 of 107 before, 102 of 107 after.
- 2 features cannot be served by any mode (see the notes).

New tools: `flowscan_search`, `flowscan_wallet_labels`, `flowscan_perp_market_detail`, `flowscan_position_changes`, `flowscan_twaps`, `flowscan_liquidations`, `flowscan_order_flow`, `flowscan_terminal_status`, `flowscan_address_completed_trades`. Extended: `flowscan_market_history` (open interest), `flowscan_perp_markets` and `flowscan_perp_positions` (cohorts, more filters, names and tags), `flowscan_builders_leaderboard` (change vs previous window), `flowscan_builder_dashboard` (top users), `flowscan_weekend_coin_changes` (funding), `flowscan_hip4_markets` (Price/Events/Canonical and deployer filters), `flowscan_address_summary` (label), every `dex` parameter (brand names).

## What the previous version missed

Compared with the server's previous coverage map (last verified 2026-10-02):

- The perp positioning snapshot is no longer on the homepage; it is part of `/terminal`, which also has footprint, flow and realized-PnL indicators, open-interest history, liquidations, Changes, Distribution and TWAPs tabs, trader cohorts and trader tags. None of these extra panels were served.
- The `/hip-3` page shows DEX brand names (TradeXYZ, Kinetiq, Felix, HyENA, Ventuals, Entropy.io) that the tools did not accept.
- `/builders` Weekly Champions and Market Movers (change vs the previous window) and the `/builders/{id}` Audience panel (top users) were not served.
- The address page's closed-trade view (Fills tab, aggregated into trades) and Flowscan's address names were not served.
- Weekend funding (`/weekend-trading` single-market chart) and the HIP-4 Price/Events/Canonical filter were not served.

## Matrix

### Site-wide

| Feature | Tool and params | Before | After | Note |
| --- | --- | --- | --- | --- |
| Search box: addresses, tx hashes, blocks, markets, names | `flowscan_search` {query} | missing | covered | Classifies the query and names the next tool. Tx and block details still need direct mode. |
| Names for known addresses (funds, market makers, deployers, vaults, bridges) | `flowscan_wallet_labels` {addresses \| search}; `label` in `flowscan_address_summary`; `name` in terminal rows | missing | covered | Three sources: /api/perp-snapshot/wallets/names, /wallets/lookup, and the known-address list in the site's JavaScript (read from www.flowscan.xyz). |
| Trader tags (scalper ... position, market maker, new wallet; profitability level; delta neutral) | `flowscan_wallet_labels`; `tag` in `flowscan_perp_positions`, `flowscan_position_changes`, `flowscan_twaps`, `flowscan_perp_market_detail` | missing | covered | Decoded from the `cls` array the same way the site's tag chip does. |
| Saved addresses / custom names in the search box | - | none | none | Stored in the browser's local storage, not on Flowscan's servers. |

### /

| Feature | Tool and params | Before | After | Note |
| --- | --- | --- | --- | --- |
| Live Block Activity grid | `flowscan_live_feed` | direct | direct | Loaded in the browser from rpc.hyperliquid.xyz. |
| 24h revenue chart (daily combined revenue, last 14 days) | `flowscan_revenue_hypercore_fees` {days:14}, `flowscan_revenue_summary` | covered | covered |  |
| Stablecoin perp margin by issuer | `flowscan_stablecoin_margin` | covered | covered |  |
| Recent Blocks | `flowscan_live_feed` {include:"blocks"} | direct | direct |  |
| Recent Transactions | `flowscan_live_feed` | direct | direct |  |

### /terminal

| Feature | Tool and params | Before | After | Note |
| --- | --- | --- | --- | --- |
| Market header: mark, oracle, 24h change and volume, OI, funding and countdown | `flowscan_prices` (direct); OI also in `flowscan_perp_markets`, funding in `flowscan_market_history` | direct | direct | Live prices come from api.hyperliquid.xyz in the browser. |
| Price chart (candles) | `flowscan_candles` | direct | direct |  |
| Indicator: footprint and advanced footprint (buy/sell volume, delta, POC, per-price levels) | `flowscan_order_flow` {kind:"footprint", includeLevels} | missing | covered | About 100 markets, intervals 1m to 1h, up to 500 candles. |
| Indicator: flow (USD opened vs closed) | `flowscan_order_flow` {kind:"flow"} | missing | covered |  |
| Indicator: realized PnL | `flowscan_order_flow` {kind:"flow"} (`realizedPnlUsd`) | missing | covered |  |
| Indicator: open interest | `flowscan_market_history` {kind:"openInterest", range, interval} | missing | covered | Up to 1 year. |
| Indicator: liquidations overlay | `flowscan_liquidations` {view:"history"} | missing | covered | Per minute, Flowscan keeps about 2-3 days. |
| Indicator: hot candles | `flowscan_order_flow` (the per-candle volumes it highlights) | missing | partial | The highlight itself is computed in the browser; the underlying volume per candle is served. |
| Chart view: Liqs (positions that would be liquidated by price) | `flowscan_perp_positions` {minLiq,maxLiq}; `flowscan_perp_market_detail` (clusters) | partial | covered |  |
| Chart view: Depth (liquidation depth by price) | `flowscan_perp_market_detail` (`liquidationClusters`, `liquidationTotals`) | missing | covered |  |
| Chart view: Data (funding and slippage history) | `flowscan_market_history` {kind:"funding" \| "slippage"} | covered | covered | Funding and slippage go back 14 days (the route caps rows). |
| Side panel: order book, ladder, depth | `flowscan_order_book` | direct | direct |  |
| Side panel: trades | `flowscan_recent_trades` | direct | direct |  |
| Side panel: Liqs feed (recent liquidations) | `flowscan_liquidations` {view:"recent", market?} | missing | covered |  |
| L4 order book (orders by address) | - | none | none | Streamed from a third-party host (api.flossington.com) with a token from /api/l4-book/token. |
| Positions tab (largest positions, filters, sort) | `flowscan_perp_positions` | partial | covered | Added leverage, margin type, address and more sort keys; rows now carry names and tags. |
| Cohort filter (all, top 10k accounts, top 30d/7d/all-time PnL, best 30d win rate) | `traderFilter` on `flowscan_perp_markets`, `flowscan_perp_positions`, `flowscan_position_changes` | missing | covered |  |
| All markets view (positioning per market) | `flowscan_perp_markets` | covered | covered |  |
| Changes tab (opened/closed/increased/reduced/flipped vs prev, 1h, 4h, 24h, 7d) | `flowscan_position_changes` | missing | covered |  |
| Distribution tab (leverage, size, account value buckets; whales) | `flowscan_perp_market_detail` | missing | covered |  |
| TWAPs tab | `flowscan_twaps` | missing | covered |  |
| Address lookup in the positions panel | `flowscan_address_perp_positions` | covered | covered | "Watch" lists are kept in the browser. |
| Snapshot age / refresh | `snapshotIso` in every snapshot tool; `flowscan_terminal_status` | partial | covered |  |
| Price spike alerts | `flowscan_terminal_status` {include:["spikes"]} | missing | covered | Usually empty; alerts are short-lived. |
| PAPER valuation panel (para:PAPER) | `flowscan_perp_market_detail` {market:"para:PAPER"} (`paperValuation`) | missing | covered | On 2026-10-23 the route itself reported "PAPER data source unavailable"; the tool passes that through. |

### /revenue

| Feature | Tool and params | Before | After | Note |
| --- | --- | --- | --- | --- |
| Protocol revenue headline (total, annualized, daily average, split) | `flowscan_revenue_summary` | covered | covered |  |
| HyperCore fees: native vs HIP-3, daily, stacked/split | `flowscan_revenue_hypercore_fees` | covered | covered |  |
| Priority gas: write/read totals, daily, counts | `flowscan_revenue_priority_gas` | covered | covered |  |
| Priority gas top users | `flowscan_revenue_priority_gas` {includeTopUsers} | covered | covered |  |
| Gas valued in USD | `flowscan_prices` (HYPE price, direct) | direct | direct | Strict mode reports gas in HYPE. |

### /address/{a}

| Feature | Tool and params | Before | After | Note |
| --- | --- | --- | --- | --- |
| Header: Flowscan name and tag | `flowscan_address_summary` (`label`) | missing | covered |  |
| Performance chart (account value, PnL) | `flowscan_address_portfolio` | direct | direct |  |
| Portfolio panel: total value, available, unrealized/total PnL, health, leverage, margin used | `flowscan_address_summary` | covered | covered |  |
| Positions | `flowscan_address_summary` {include:["perpState"]}, `flowscan_address_perp_positions` | covered | covered |  |
| Open orders | `flowscan_address_orders` | covered | covered |  |
| Balances | `flowscan_address_summary` (`spotBalances`) | covered | covered |  |
| Earn (borrow/lend) | `flowscan_address_extras` {kind:"borrowLend"}; APYs `flowscan_borrow_lend_reserves` (direct) | covered | covered |  |
| Fills | `flowscan_address_fills` | covered | covered |  |
| Fill stats (total trades, win rate, average win/loss, profit factor, fees) | `flowscan_address_completed_trades` (`summary`) | partial | covered | Before: only the lifetime PnL summary. |
| Aggregate into trades (closed positions) | `flowscan_address_completed_trades` | missing | covered |  |
| Transactions (deposits, withdrawals, transfers, vaults, staking, liquidations, rewards) | `flowscan_address_ledger` {kind:"ledger"} | covered | covered |  |
| Funding payments | `flowscan_address_ledger` {kind:"funding"} | covered | covered |  |
| Unit deposits | `flowscan_address_unit_operations` | direct | direct |  |
| Vaults and sub-accounts | `flowscan_address_vaults_subaccounts` | covered | covered |  |
| Staking | `flowscan_address_staking` | covered | covered |  |
| Builders (approved builder fees) | `flowscan_address_extras` {kind:"approvedBuilders"} | covered | covered |  |
| EVM tab (HyperEVM balance) | `flowscan_address_evm_balance` | direct | direct |  |
| Rate limit, TWAP slice fills | `flowscan_address_extras` | covered | covered |  |

### /block/{h}

| Feature | Tool and params | Before | After | Note |
| --- | --- | --- | --- | --- |
| Block details | `flowscan_block` | direct | direct |  |

### /tx/{hash}

| Feature | Tool and params | Before | After | Note |
| --- | --- | --- | --- | --- |
| Transaction details | `flowscan_transaction` | direct | direct |  |

### /validators

| Feature | Tool and params | Before | After | Note |
| --- | --- | --- | --- | --- |
| Totals: staked, validators, delegators | `flowscan_staking_overview` | covered | covered |  |
| Average APR; APR, uptime, blocks per validator (24h/7d/30d) | `flowscan_validator_summaries` | direct | direct |  |
| Validator list (delegated, stakers, network share, commission, jailed) | `flowscan_staking_overview` | covered | covered |  |
| Validator detail: top delegators | `flowscan_validator_stakers` | covered | covered |  |
| Validator detail: recent activity | `flowscan_staking_events` | covered | covered |  |

### /peers

| Feature | Tool and params | Before | After | Note |
| --- | --- | --- | --- | --- |
| Summary: sentries, direct peers, multi-sentry, crawl time | `flowscan_peers` | covered | covered |  |
| Sentry peering and clusters, filters (role, country, connectable) | `flowscan_peers` {section:"nodes" \| "edges", role, country, state} | covered | covered |  |

### /hip-3

| Feature | Tool and params | Before | After | Note |
| --- | --- | --- | --- | --- |
| Overview totals (volume, trades, traders) | `flowscan_hip3_overview` | covered | covered |  |
| Daily volume (daily/cumulative), market share by volume, trades, traders, OI | `flowscan_hip3_daily`, `flowscan_hip3_overview` | covered | covered |  |
| Trades and traders, new users, open interest over time | `flowscan_hip3_daily` {metric} | covered | covered |  |
| Deployer revenue and daily deployer fees | `flowscan_revenue_deployer_fees` | covered | covered |  |
| Collateral distribution and collateral over time | `flowscan_hip3_overview`, `flowscan_hip3_daily` {metric:"collateral_*"} | covered | covered |  |
| Market comparisons tab | `flowscan_hip3_markets` {symbol} | covered | covered |  |
| Binance comparison tab | `flowscan_hip3_binance_comparison` | covered | covered |  |
| Builders tab | `flowscan_hip3_builders` | covered | covered |  |
| One DEX view | `flowscan_hip3_dex` | covered | covered | Its per-market OI comes from Flowscan's HIP-3 stats dataset, which can lag the live snapshot (on 2026-10-23 it showed 0 for xyz:NVDA). |
| DEX brand names (TradeXYZ, Kinetiq, Felix, HyENA, Ventuals, Entropy.io) | every `dex` parameter | partial | covered | Brand names are accepted since this change. |

### /weekend-trading

| Feature | Tool and params | Before | After | Note |
| --- | --- | --- | --- | --- |
| Session status, countdown, schedule | `flowscan_weekend_weeks` {includeSchedule} | covered | covered |  |
| Weekend heatmap (Friday close to Sunday close per asset) | `flowscan_weekend_prices` | covered | covered |  |
| Single market: history across weekends | `flowscan_weekend_coin_changes` | covered | covered |  |
| Single market: weekend funding | `flowscan_weekend_coin_changes` {includeFunding} | missing | covered |  |
| Positioning changes since Friday close | `flowscan_weekend_positions` | covered | covered |  |

### /hip-4

| Feature | Tool and params | Before | After | Note |
| --- | --- | --- | --- | --- |
| Header: 24h volume, active/price/event counts | `flowscan_hip4_markets` (`totals.volume24h`, `totals.outcomes` per filter) | partial | covered |  |
| Filters: Price / Events / Canonical, deployer | `flowscan_hip4_markets` {marketKind, deployer} | partial | covered |  |
| Market cards (outcomes, implied probability, volume, 24h change) | `flowscan_hip4_markets` | covered | covered |  |
| Question groups | `flowscan_hip4_markets` {section:"questions"} | covered | covered |  |
| Settled markets | `flowscan_hip4_markets` {section:"settled"} | covered | covered |  |

### /hip-4/{id}

| Feature | Tool and params | Before | After | Note |
| --- | --- | --- | --- | --- |
| Outcome page: YES/NO candles, trade stats, settlement | `flowscan_hip4_outcome` | covered | covered |  |
| Outcome page: live order book and trades | `flowscan_order_book`, `flowscan_recent_trades` | direct | direct |  |

### /spot-stocks

| Feature | Tool and params | Before | After | Note |
| --- | --- | --- | --- | --- |
| Summary (24h volume, holdings, holders, traders) | `flowscan_spot_stocks` | covered | covered |  |
| Volume and holdings mix, daily volume, holders, daily traders | `flowscan_spot_stocks` {section:"timeseries"} | covered | covered |  |
| Markets table and top holders | `flowscan_spot_stocks` {section:"current" \| "topHolders"} | covered | covered |  |
| Liquidity: spread, depth within 2/5/10/25 bps, depth over time | `flowscan_spot_stocks` {section:"liquidity"} | covered | covered |  |
| Deployer filter (xStocks, Dinari) | `flowscan_spot_stocks` {token} (tickers end in X or D) | covered | covered |  |

### /builders

| Feature | Tool and params | Before | After | Note |
| --- | --- | --- | --- | --- |
| Headline: all-time and this week's revenue | `flowscan_builders_leaderboard` (`totals`), `flowscan_builders_summary` | partial | covered |  |
| Headline: builders up / down this week (counts) | `flowscan_builders_leaderboard` {rankBy:"change"} (per-builder change) | missing | partial | Per-builder change is served; the site's up/down counts use rules not visible in the data, so they are not reproduced. |
| Weekly champions (top 3 by 7d revenue, WoW, share) | `flowscan_builders_leaderboard` {window:"7d", limit:3} | partial | covered | Before: no WoW change or share. |
| Market movers (biggest change / fastest %, revenue/volume/users, 7d/30d) | `flowscan_builders_leaderboard` {rankBy, metric, window} | missing | covered |  |
| Ecosystem pulse (daily revenue by builder, 30d) | `flowscan_builders_daily_revenue` | covered | covered |  |
| Onboarding timeline (new and active traders per builder) | `flowscan_builders_user_series` | covered | covered | Event markers ("HIP-3 launch", ...) are text in the page, not data. |
| Rankings (7d/30d/90d, sort by revenue/volume/growth/users, change vs previous) | `flowscan_builders_leaderboard` | partial | covered |  |
| By category | `flowscan_builders_summary` | covered | covered |  |

### /builders/{id}

| Feature | Tool and params | Before | After | Note |
| --- | --- | --- | --- | --- |
| Volume share, ARR, totals, period snapshot | `flowscan_builder_dashboard` {section:"stats"} | covered | covered |  |
| Daily revenue and users | `flowscan_builder_dashboard` {section:"daily"}, `flowscan_builder_revenue` | covered | covered |  |
| Trade mix, top assets, markets table | `flowscan_builder_dashboard` {section:"assets"} | covered | covered |  |
| Audience: top users by builder fees | `flowscan_builder_dashboard` {section:"topUsers"} | missing | covered | Flowscan does not report the exact start/end dates of this window. |
| Audience: weekly cohort retention | `flowscan_builder_intelligence_detail` {sections:["weekly_retention_cohorts"]} | partial | partial | Only for the ~120 builders Builder Intelligence tracks. |

### /builder-intelligence

| Feature | Tool and params | Before | After | Note |
| --- | --- | --- | --- | --- |
| Overview, Users and Categories tabs | `flowscan_builder_intelligence_list`, `_detail`, `_summary` | covered | covered | The routes ignored startDate/endDate on 2026-10-23 (full reports only); the tools say so in `dateRangeNote`. |

## Routes found in the site's JavaScript

All `/api` routes the pages call, and the tool that uses each. Routes only the site's own analytics or dev tools use are listed as not data.

| Route | Used by |
| --- | --- |
| `/api/perp-snapshot/status` | flowscan_terminal_status (and market resolution for order flow) |
| `/api/perp-snapshot/markets?traderFilter=` | flowscan_perp_markets |
| `/api/perp-snapshot/markets/{m}` | flowscan_perp_market_detail |
| `/api/perp-snapshot/markets/{m}/positions` | flowscan_perp_positions |
| `/api/perp-snapshot/markets/{m}/changes` | flowscan_position_changes |
| `/api/perp-snapshot/address/{a}/positions` | flowscan_address_perp_positions |
| `/api/perp-snapshot/twaps/{m}` | flowscan_twaps |
| `/api/perp-snapshot/liquidations/recent, /liquidations/{m}/recent, /liquidations/{m}?start&end` | flowscan_liquidations |
| `/api/perp-snapshot/footprint/{m}, /footprint/{m}/flow` | flowscan_order_flow |
| `/api/perp-snapshot/spikes` | flowscan_terminal_status |
| `/api/perp-snapshot/leaderboard/status` | flowscan_terminal_status |
| `/api/perp-snapshot/wallets/names, /wallets/lookup` | flowscan_wallet_labels and every tool that adds names/tags |
| `POST /terminal/api/market-history (fundingHistory, slippageHistory, openInterestHistory)` | flowscan_market_history |
| `/api/paper` | flowscan_perp_market_detail (para:PAPER) |
| `/api/l4-book/token` | not used: only a token for a third-party WebSocket |
| `POST /api/gossip/info (hypercoreFeeSummary, deployerFeeSummary, priorityGasSummary)` | flowscan_revenue_* |
| `POST /api/hydromancer/info (user state, fills, orders, ledger, staking, vaults, userCompletedTrades, ...)` | flowscan_address_* |
| `/api/hydromancer/builder-top-users` | flowscan_builder_dashboard (topUsers) |
| `POST /api/staking/info (stakingOverview, stakingValidatorStakers, stakingEvents)` | flowscan_staking_overview, flowscan_validator_stakers, flowscan_staking_events |
| `/api/stablecoin/current` | flowscan_stablecoin_margin |
| `/api/peers` | flowscan_peers |
| `/api/dex-stats/snapshot, /per-dex, /builders` | flowscan_hip3_* |
| `/api/binance-rwa/comparison` | flowscan_hip3_binance_comparison |
| `/api/hip-4, /api/hip-4/{id}, /api/hip-4/labels` | flowscan_hip4_* |
| `/api/spot-stocks/current, /timeseries, /liquidity, /top-holders` | flowscan_spot_stocks |
| `/api/weekend/weeks, /schedule, /prices, /positions, /coin-changes, /funding` | flowscan_weekend_* |
| `/api/buildersv2/landing/metrics-table, /all-time-summary` | flowscan_builders_leaderboard, flowscan_builders_summary, flowscan_builder_lookup |
| `/api/builders/all-daily-revenue` | flowscan_builders_daily_revenue, flowscan_builder_revenue |
| `/api/builders-user-series/user-series` | flowscan_builders_user_series |
| `/api/dashboard/builder-stats, /builder-daily-series, /builder-volume-by-asset` | flowscan_builder_dashboard, flowscan_builder_revenue |
| `/api/intelligence/builders, /builders/{id}, /categories, /summary/{category}, /summary/overall` | flowscan_builder_intelligence_* |
| `/api/weekend/dev/run` | not data (site maintenance) |
| `/api/surveys, /api/web_experiments, /api/product_tours, /api/early_access_features` | not data (product analytics) |

Routes may change without notice; the site has no public API documentation. See CONTRIBUTING.md for how they were found.

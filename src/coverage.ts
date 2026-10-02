/**
 * Human/agent-readable map of what flowscan.xyz shows and which tool serves it.
 * Kept in one place so the README, the `flowscan_coverage` tool and the skill
 * file stay in sync.
 */
export const COVERAGE = {
  site: "https://www.flowscan.xyz",
  what: "Flowscan is a real-time Hyperliquid (HyperCore + HIP-3 + HIP-4) blockchain explorer and analytics site.",
  network: "mainnet only (Flowscan has no testnet mode; this server therefore never serves testnet data)",
  pages: [
    { path: "/", shows: "Live block activity, recent blocks & transactions, 24h revenue chart, stablecoin perp margin, perp positioning snapshot", tools: ["flowscan_stablecoin_margin", "flowscan_perp_markets", "flowscan_perp_positions", "flowscan_address_perp_positions", "flowscan_revenue_summary", "flowscan_revenue_hypercore_fees"] },
    { path: "/revenue", shows: "Daily HyperCore revenue (native vs HIP-3), deployer fees by DEX, priority gas (write/read) with top users", tools: ["flowscan_revenue_hypercore_fees", "flowscan_revenue_deployer_fees", "flowscan_revenue_priority_gas", "flowscan_revenue_summary"] },
    { path: "/address/{address}", shows: "Account overview, positions, balances, orders, trades, funding, ledger, staking, vaults, sub-accounts, approved builders, borrow/lend", tools: ["flowscan_address_summary", "flowscan_address_orders", "flowscan_address_fills", "flowscan_address_ledger", "flowscan_address_staking", "flowscan_address_vaults_subaccounts", "flowscan_address_extras", "flowscan_address_perp_positions"] },
    { path: "/validators", shows: "Staking overview, validator list, validator stakers and events", tools: ["flowscan_staking_overview", "flowscan_validator_stakers", "flowscan_staking_events"] },
    { path: "/peers", shows: "Gossip network crawl: nodes, edges, sentries, geography", tools: ["flowscan_peers"] },
    { path: "/hip-3", shows: "HIP-3 perp DEX analytics: overview, market share, daily series, markets, per-DEX detail, builder-routed volume, Binance RWA comparison", tools: ["flowscan_hip3_overview", "flowscan_hip3_daily", "flowscan_hip3_markets", "flowscan_hip3_dex", "flowscan_hip3_builders", "flowscan_hip3_binance_comparison"] },
    { path: "/hip-4", shows: "HIP-4 prediction/outcome markets, settled outcomes, question groups, outcome candles", tools: ["flowscan_hip4_markets", "flowscan_hip4_outcome", "flowscan_hip4_labels"] },
    { path: "/spot-stocks", shows: "Tokenized stocks on spot (xStocks, Dinari): prices, volume, holders, liquidity, top holders", tools: ["flowscan_spot_stocks"] },
    { path: "/weekend-trading", shows: "TradFi markets over the weekend: price moves since Friday close, positioning changes", tools: ["flowscan_weekend_weeks", "flowscan_weekend_prices", "flowscan_weekend_positions", "flowscan_weekend_coin_changes"] },
    { path: "/builders", shows: "Builder Arena leaderboard, all-time summary, daily revenue, user growth", tools: ["flowscan_builders_leaderboard", "flowscan_builders_summary", "flowscan_builders_daily_revenue", "flowscan_builders_user_series", "flowscan_builder_lookup", "flowscan_builder_revenue"] },
    { path: "/builders/{id}", shows: "Builder dashboard: window stats, daily series, volume by asset, intelligence report; any-range revenue for one builder (resolve names first: they can be ambiguous)", tools: ["flowscan_builder_lookup", "flowscan_builder_revenue", "flowscan_builder_dashboard", "flowscan_builder_intelligence_detail"] },
    { path: "/builder-intelligence", shows: "Builder/category user-status, retention and revenue analytics", tools: ["flowscan_builder_intelligence_list", "flowscan_builder_intelligence_detail", "flowscan_builder_intelligence_summary"] },
  ],
  notServed: [
    {
      item: "Block details (/block/{height}), transaction details (/tx/{hash}), the live block/tx feed, and the address page's portfolio chart, EVM balance and Unit (bridge) operations",
      why: "Flowscan's own servers do not serve these. The Flowscan web page fetches them in your browser directly from Hyperliquid's public endpoints (rpc.hyperliquid.xyz, api.hyperliquid.xyz, api-ui.hyperliquid.xyz, api.hyperunit.xyz). This MCP is restricted to flowscan.xyz, so it does not call those hosts.",
    },
    { item: "Market prices / candles / order books", why: "Same reason: rendered in-browser from api.hyperliquid.xyz, not from a flowscan.xyz route." },
    { item: "Testnet", why: "Flowscan has no testnet mode." },
  ],
  rules: [
    "Only https://www.flowscan.xyz is contacted. No Hyperliquid, Hydromancer or other hosts.",
    "All tools are read-only. Responses are trimmed; use `fields`, `limit`, `offset` or a narrower tool for more.",
    "Data freshness varies by page: perp snapshot ~minutes, builder intelligence ~daily, peers ~hourly crawl.",
  ],
} as const;

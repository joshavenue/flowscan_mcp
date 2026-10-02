import { DEX_ALIASES } from "./dex.js";
import { DIRECT_ENV, hyperliquidDirectEnabled, UPSTREAM_HOSTS } from "./upstream.js";

type Page = { path: string; shows: string; tools: string[] };
type NotServed = { item: string; why: string; availableWith?: string };

const BLOCK_TX_TOOLS = ["flowscan_block", "flowscan_transaction", "flowscan_live_feed", "flowscan_address_portfolio", "flowscan_address_evm_balance", "flowscan_address_unit_operations"];
const PRICE_TOOLS = ["flowscan_prices", "flowscan_candles", "flowscan_order_book", "flowscan_recent_trades", "flowscan_spot_tokens", "flowscan_perp_dexs"];
const EXTRA_TOOLS = ["flowscan_validator_summaries", "flowscan_borrow_lend_reserves"];
const ENABLE = `${DIRECT_ENV}=1`;

/**
 * Human/agent-readable map of what flowscan.xyz shows and which tool serves it.
 * Kept in one place so the README, the `flowscan_coverage` tool and the skill
 * file stay in sync. Mode-aware: with ${ENABLE} the panels Flowscan loads in the
 * browser from Hyperliquid hosts move from notServed into the pages.
 */
export function getCoverage(direct: boolean = hyperliquidDirectEnabled()) {
  const pages: Page[] = [
    {
      path: "/",
      shows: direct
        ? "24h revenue panel, stablecoin perp margin, perp positioning snapshot (per-market long/short, largest positions, per-address positions), the live block/transaction feed (Live Block Activity, Recent Blocks, Recent Transactions) and live perp prices"
        : "24h revenue panel, stablecoin perp margin, perp positioning snapshot (per-market long/short, largest positions, per-address positions). The homepage's live block/transaction feed is not served (see notServed)",
      tools: ["flowscan_stablecoin_margin", "flowscan_perp_markets", "flowscan_perp_positions", "flowscan_address_perp_positions", "flowscan_revenue_summary", "flowscan_revenue_hypercore_fees", ...(direct ? ["flowscan_live_feed", "flowscan_prices"] : [])],
    },
    { path: "/revenue", shows: `Daily HyperCore revenue (native vs HIP-3), deployer fees by DEX, priority gas (write/read) with top users${direct ? "; the HYPE/USD price used to value priority gas" : ""}`, tools: ["flowscan_revenue_hypercore_fees", "flowscan_revenue_deployer_fees", "flowscan_revenue_priority_gas", "flowscan_revenue_summary", ...(direct ? ["flowscan_prices"] : [])] },
    {
      path: "/address/{address}",
      shows: direct
        ? "Account overview, positions, balances, orders, trades, funding, ledger, staking, vaults, sub-accounts, approved builders, borrow/lend (with reserve APYs), portfolio chart (account value / PnL history), HyperEVM HYPE balance, Unit bridge operations, spot token names/prices and the position price chart (candles)"
        : "Account overview, positions, balances, orders, trades, funding, ledger, staking, vaults, sub-accounts, approved builders, borrow/lend",
      tools: [
        "flowscan_address_summary", "flowscan_address_orders", "flowscan_address_fills", "flowscan_address_ledger", "flowscan_address_staking", "flowscan_address_vaults_subaccounts", "flowscan_address_extras", "flowscan_address_perp_positions",
        ...(direct ? ["flowscan_address_portfolio", "flowscan_address_evm_balance", "flowscan_address_unit_operations", "flowscan_borrow_lend_reserves", "flowscan_spot_tokens", "flowscan_candles"] : []),
      ],
    },
    ...(direct
      ? [
          { path: "/block/{height}", shows: "Block height, time, hash, proposer, tx count, success rate, failed count, transaction breakdown by type, transactions table", tools: ["flowscan_block"] },
          { path: "/tx/{hash}", shows: "Transaction hash, block, time, user, action type, action details and payload, status/error", tools: ["flowscan_transaction"] },
        ]
      : []),
    { path: "/validators", shows: `Staking overview, validator list, validator stakers and events${direct ? "; per-validator APR, uptime and recent blocks (24h/7d/30d)" : ""}`, tools: ["flowscan_staking_overview", "flowscan_validator_stakers", "flowscan_staking_events", ...(direct ? ["flowscan_validator_summaries"] : [])] },
    { path: "/peers", shows: "Gossip network crawl: nodes, edges, sentries, geography", tools: ["flowscan_peers"] },
    { path: "/hip-3", shows: "HIP-3 perp DEX analytics: overview, market share, daily series, markets, per-DEX detail, builder-routed volume, Binance RWA comparison", tools: ["flowscan_hip3_overview", "flowscan_hip3_daily", "flowscan_hip3_markets", "flowscan_hip3_dex", "flowscan_hip3_builders", "flowscan_hip3_binance_comparison", ...(direct ? ["flowscan_perp_dexs"] : [])] },
    { path: "/hip-4", shows: `HIP-4 prediction/outcome markets, settled outcomes, question groups, outcome candles${direct ? "; live outcome order books and recent trades" : ""}`, tools: ["flowscan_hip4_markets", "flowscan_hip4_outcome", "flowscan_hip4_labels", ...(direct ? ["flowscan_order_book", "flowscan_recent_trades"] : [])] },
    { path: "/spot-stocks", shows: "Tokenized stocks on Hyperliquid SPOT (xStocks tickers end in X, Dinari in D): NVDAX, SPYX, QQQX, SKHYX, MUX, SNDKX, SPCXX, TSLAX, AAPLX, CRCLX, SPCXD. Per-token price (mark/mid/prev-day), 24h and all-time volume, daily volume history, holders, traders, liquidity/order-book depth and top holders ARE served", tools: ["flowscan_spot_stocks"] },
    { path: "/weekend-trading", shows: `TradFi markets over the weekend: price moves since Friday close, positioning changes${direct ? "; perp DEX market lists" : ""}`, tools: ["flowscan_weekend_weeks", "flowscan_weekend_prices", "flowscan_weekend_positions", "flowscan_weekend_coin_changes", ...(direct ? ["flowscan_perp_dexs"] : [])] },
    { path: "/builders", shows: "Builder Arena leaderboard, all-time summary, daily revenue, user growth", tools: ["flowscan_builders_leaderboard", "flowscan_builders_summary", "flowscan_builders_daily_revenue", "flowscan_builders_user_series", "flowscan_builder_lookup", "flowscan_builder_revenue"] },
    { path: "/builders/{id}", shows: "Builder dashboard: window stats, daily series, volume by asset, intelligence report; any-range revenue for one builder (resolve names first: they can be ambiguous)", tools: ["flowscan_builder_lookup", "flowscan_builder_revenue", "flowscan_builder_dashboard", "flowscan_builder_intelligence_detail"] },
    { path: "/builder-intelligence", shows: "Builder/category user-status, retention and revenue analytics", tools: ["flowscan_builder_intelligence_list", "flowscan_builder_intelligence_detail", "flowscan_builder_intelligence_summary"] },
  ];

  const notServed: NotServed[] = direct
    ? [{ item: "Testnet", why: "Flowscan has no testnet mode." }]
    : [
        {
          item: "Block details (/block/{height}), transaction details (/tx/{hash}), the live block/tx feed, and the address page's portfolio chart, EVM balance and Unit (bridge) operations",
          why: "Flowscan's own servers do not serve these. The Flowscan web page fetches them in your browser directly from Hyperliquid's public endpoints (rpc.hyperliquid.xyz, api.hyperliquid.xyz, api-ui.hyperliquid.xyz, api.hyperunit.xyz). This server is in strict mode (flowscan.xyz only), so it does not call those hosts.",
          availableWith: `available when ${ENABLE} (tools: ${BLOCK_TX_TOOLS.join(", ")})`,
        },
        {
          item: "Live prices such as HYPE/USD or BTC, perp/spot candles, order books and recent trades (except tokenized stocks on spot, see flowscan_spot_stocks), spot token directory, perp DEX market lists",
          why: "Same reason: rendered in-browser from api.hyperliquid.xyz, not from a flowscan.xyz route. Prices that ARE available in strict mode: perp entry/liquidation prices in position data, tokenized-stock marks (flowscan_spot_stocks), HIP-4 outcome prices and candles (flowscan_hip4_*), weekend TradFi closes (flowscan_weekend_prices) and Binance RWA last prices (flowscan_hip3_binance_comparison). Priority gas is therefore reported in HYPE, not USD.",
          availableWith: `available when ${ENABLE} (tools: ${PRICE_TOOLS.join(", ")})`,
        },
        {
          item: "Validator APR, uptime and recent blocks (/validators), borrow/lend reserve supply/borrow APYs (/address Borrow/Lend tab)",
          why: "Loaded in-browser from api.hyperliquid.xyz (validatorSummaries, allBorrowLendReserveStates).",
          availableWith: `available when ${ENABLE} (tools: ${EXTRA_TOOLS.join(", ")})`,
        },
        { item: "Testnet", why: "Flowscan has no testnet mode." },
      ];

  return {
    site: "https://www.flowscan.xyz",
    what: "Flowscan is a real-time Hyperliquid (HyperCore + HIP-3 + HIP-4) blockchain explorer and analytics site.",
    network: "mainnet only (Flowscan has no testnet mode; this server therefore never serves testnet data)",
    mode: direct ? "hyperliquid-direct" : "strict",
    pages,
    notServed,
    hip3DexNames: {
      note: "The /hip-3 analytics use display names; market symbols, address data and deployer fees use on-chain dex prefixes. Tools accept either.",
      aliases: DEX_ALIASES.map((d) => ({ name: d.name, prefix: d.prefix, ...(d.formerPrefixes.length ? { formerPrefixes: d.formerPrefixes } : {}) })),
    },
    rules: [
      direct
        ? `Mode hyperliquid-direct (${ENABLE}): www.flowscan.xyz plus exactly ${UPSTREAM_HOSTS.join(", ")} are contacted (HTTPS, and WSS to rpc/api.hyperliquid.xyz), making the same requests the Flowscan page makes in the browser. Results from those hosts carry mode="hyperliquid-direct", source = the upstream URL and shownOn = the Flowscan page. No other hosts.`
        : `Strict mode: only https://www.flowscan.xyz is contacted. No Hyperliquid, Hydromancer or other hosts. Set ${ENABLE} to also serve the panels Flowscan loads from Hyperliquid in the browser (see notServed).`,
      "All tools are read-only. Responses are trimmed; use `fields`, `limit`, `offset` or a narrower tool for more.",
      "Data freshness varies by page: perp snapshot ~minutes, builder intelligence ~daily, peers ~hourly crawl.",
      ...(direct ? ["Hyperliquid limits requests per IP: upstream calls run 2 at a time, prices are cached 5s and metadata 60s; HTTP 429 is reported (not retried) with a wait hint."] : []),
    ],
  };
}

export type Coverage = ReturnType<typeof getCoverage>;

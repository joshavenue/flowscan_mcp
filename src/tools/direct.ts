/** Registers the opt-in Hyperliquid-direct tools (FLOWSCAN_HYPERLIQUID_DIRECT=1). */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountDirectTools } from "./accountDirect.js";
import { registerExplorerTools } from "./explorer.js";
import { registerMarketTools } from "./markets.js";

/** Tool names added by the direct mode, in registration order. */
export const DIRECT_TOOLS = [
  "flowscan_block",
  "flowscan_transaction",
  "flowscan_live_feed",
  "flowscan_prices",
  "flowscan_candles",
  "flowscan_order_book",
  "flowscan_recent_trades",
  "flowscan_spot_tokens",
  "flowscan_perp_dexs",
  "flowscan_validator_summaries",
  "flowscan_borrow_lend_reserves",
  "flowscan_address_portfolio",
  "flowscan_address_evm_balance",
  "flowscan_address_unit_operations",
] as const;

export function registerDirectTools(server: McpServer): void {
  registerExplorerTools(server);
  registerMarketTools(server);
  registerAccountDirectTools(server);
}

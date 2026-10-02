import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAddressTools } from "./tools/address.js";
import { registerBuilderTools } from "./tools/builders.js";
import { registerHip3Tools } from "./tools/hip3.js";
import { registerHip4Tools } from "./tools/hip4.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerNetworkTools } from "./tools/network.js";
import { registerPerpTools } from "./tools/perp.js";
import { registerRevenueTools } from "./tools/revenue.js";
import { registerSpotStockTools } from "./tools/spotStocks.js";
import { registerWeekendTools } from "./tools/weekend.js";

export const SERVER_NAME = "flowscan-mcp";
export const SERVER_VERSION = "0.1.0";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for everything shown on https://www.flowscan.xyz, the Hyperliquid explorer: revenue, staking, peers, HIP-3 perp DEXs, HIP-4 prediction markets, tokenized stocks, weekend trading, builders, and per-address account data. Data is Hyperliquid MAINNET only and comes exclusively from flowscan.xyz routes. Block/transaction lookups are not available (Flowscan renders those in-browser from Hyperliquid directly). Call flowscan_coverage first if unsure which tool fits.",
    },
  );
  registerMetaTools(server);
  registerNetworkTools(server);
  registerRevenueTools(server);
  registerPerpTools(server);
  registerAddressTools(server);
  registerSpotStockTools(server);
  registerWeekendTools(server);
  registerHip4Tools(server);
  registerHip3Tools(server);
  registerBuilderTools(server);
  return server;
}

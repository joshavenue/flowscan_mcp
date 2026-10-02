#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { hyperliquidDirectEnabled, UPSTREAM_HOSTS } from "./upstream.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel; everything diagnostic goes to stderr.
  const hosts = hyperliquidDirectEnabled() ? `https://www.flowscan.xyz + ${UPSTREAM_HOSTS.join(", ")} (hyperliquid-direct mode)` : "https://www.flowscan.xyz (strict mode)";
  process.stderr.write(`flowscan-mcp ready (stdio). Source: ${hosts}\n`);
}

main().catch((err) => {
  process.stderr.write(`flowscan-mcp failed to start: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});

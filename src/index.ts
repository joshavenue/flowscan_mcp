#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel; everything diagnostic goes to stderr.
  process.stderr.write(`flowscan-mcp ready (stdio). Source: https://www.flowscan.xyz\n`);
}

main().catch((err) => {
  process.stderr.write(`flowscan-mcp failed to start: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});

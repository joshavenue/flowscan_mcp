#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { parseCli, USAGE } from "./cli.js";
import { isLoopback, startHttpServer } from "./httpServer.js";
import { hyperliquidDirectEnabled, UPSTREAM_HOSTS } from "./upstream.js";

let shuttingDown = false;
/** Run `fn` once on SIGINT/SIGTERM (or when called), then exit 0; force-exit after 3s. */
function shutdownHandler(fn: () => Promise<void>): (why: string) => void {
  const stop = (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`flowscan-mcp: ${why}, shutting down\n`);
    setTimeout(() => process.exit(0), 3000).unref();
    void fn()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  return stop;
}

async function main(): Promise<void> {
  let cli: ReturnType<typeof parseCli>;
  try {
    cli = parseCli(process.argv.slice(2), process.env);
  } catch (err) {
    process.stderr.write(`flowscan-mcp: ${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  // --help / --version are the only things ever written to stdout outside the protocol.
  if (cli === "help") return void process.stdout.write(USAGE);
  if (cli === "version") return void process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);

  // stdout is the stdio protocol channel: route any stray console output (ours or a dependency's) to stderr.
  for (const k of ["log", "info", "debug"] as const) console[k] = (...a: unknown[]) => console.error(...a);

  const hosts = hyperliquidDirectEnabled() ? `https://www.flowscan.xyz + ${UPSTREAM_HOSTS.join(", ")} (hyperliquid-direct mode)` : "https://www.flowscan.xyz (strict mode)";

  if (cli.transport === "stdio") {
    const server = createServer();
    await server.connect(new StdioServerTransport());
    const stop = shutdownHandler(() => server.close());
    // The client closing our stdin ends the session.
    process.stdin.on("end", () => stop("stdin closed"));
    process.stderr.write(`flowscan-mcp ready (stdio). Source: ${hosts}\n`);
    return;
  }

  const running = await startHttpServer(cli);
  shutdownHandler(running.close);
  if (!isLoopback(cli.host)) {
    process.stderr.write(`flowscan-mcp WARNING: listening on ${cli.host} with NO authentication; put it behind a reverse proxy that adds auth and TLS.\n`);
  }
  process.stderr.write(`flowscan-mcp ready (streamable HTTP, ${cli.stateful ? "stateful" : "stateless"}) at ${running.url} (legacy SSE: /sse, health: /healthz). Source: ${hosts}\n`);
}

main().catch((err) => {
  process.stderr.write(`flowscan-mcp failed to start: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});

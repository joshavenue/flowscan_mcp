/** Command-line / environment parsing for the flowscan-mcp binary (kept separate so it is unit-testable). */
export const USAGE = `Usage: flowscan-mcp [--stdio | --http] [--port <n>] [--host <addr>] [--stateful]

  (no flags)        stdio transport (default; for clients that spawn the server)
  --http            Streamable HTTP on http://<host>:<port>/mcp (plus legacy SSE on /sse)
  --port <n>        HTTP port (default 8787; env PORT); implies --http
  --host <addr>     HTTP bind address (default 127.0.0.1; env HOST); implies --http
  --stateful        HTTP: keep Mcp-Session-Id sessions (default stateless)
  --help, --version

Environment:
  FLOWSCAN_MCP_TRANSPORT=stdio|http   same as --stdio / --http
  PORT, HOST                          HTTP port and bind address
  FLOWSCAN_MCP_STATEFUL=1             same as --stateful
  FLOWSCAN_MCP_CORS=<origins>         comma-separated browser origins allowed (or *); default none
  FLOWSCAN_MCP_ALLOWED_HOSTS=<names>  extra Host header names accepted (e.g. your proxy's hostname)
  FLOWSCAN_HYPERLIQUID_DIRECT=1       hyperliquid-direct mode (58 tools instead of 44)
  FLOWSCAN_TOOLS=<names>              only register these tools (comma-separated, * wildcards)
`;

export type Cli = { transport: "stdio" | "http"; port: number; host: string; stateful: boolean; corsOrigins: string[]; allowedHosts: string[] };

const truthy = (v: string | undefined) => /^(1|true|yes)$/i.test((v ?? "").trim());
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** CLI flags win over environment variables, which win over defaults. Throws on bad input. */
export function parseCli(argv: string[], env: NodeJS.ProcessEnv): Cli | "help" | "version" {
  let transport: Cli["transport"] | undefined;
  let port: number | undefined;
  let host: string | undefined;
  let stateful = truthy(env.FLOWSCAN_MCP_STATEFUL);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const inline = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : undefined;
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--help" || flag === "-h") return "help";
    else if (flag === "--version" || flag === "-v") return "version";
    else if (flag === "--http") transport = "http";
    else if (flag === "--stdio") transport = "stdio";
    else if (flag === "--stateful") stateful = true;
    else if (flag === "--port") {
      port = Number(value());
      transport ??= "http";
    } else if (flag === "--host") {
      host = value();
      transport ??= "http";
    } else throw new Error(`unknown argument: ${a}`);
  }
  const envTransport = (env.FLOWSCAN_MCP_TRANSPORT ?? "").trim().toLowerCase();
  if (envTransport && envTransport !== "http" && envTransport !== "stdio") throw new Error(`FLOWSCAN_MCP_TRANSPORT must be stdio or http, got '${envTransport}'`);
  transport ??= (envTransport || "stdio") as Cli["transport"];
  port ??= env.PORT?.trim() ? Number(env.PORT) : 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${port}`);
  return {
    transport,
    port,
    host: host ?? (env.HOST?.trim() || "127.0.0.1"),
    stateful,
    corsOrigins: list(env.FLOWSCAN_MCP_CORS),
    allowedHosts: list(env.FLOWSCAN_MCP_ALLOWED_HOSTS),
  };
}

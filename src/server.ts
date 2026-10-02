import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getCoverage } from "./coverage.js";
import { GUIDE_DESCRIPTION, GUIDE_MD } from "./guide.js";
import { rawSchemasRequested, sanitizeInputSchema } from "./sanitize.js";
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
import { registerDirectTools } from "./tools/direct.js";
import { hyperliquidDirectEnabled, UPSTREAM_HOSTS } from "./upstream.js";

export const SERVER_NAME = "flowscan-mcp";
export const SERVER_VERSION = "0.1.0";

export const GUIDE_PROMPT = "flowscan_guide";
export const GUIDE_URI = "flowscan://guide";
export const COVERAGE_URI = "flowscan://coverage";
const GUIDE_LINE = `For tool-selection rules call the prompt ${GUIDE_PROMPT} or read resource ${GUIDE_URI}.`;

/** Server instructions (<= 600 chars: some clients truncate or drop longer ones). */
export function serverInstructions(direct: boolean): string {
  const body = direct
    ? `Read-only tools for what www.flowscan.xyz (Hyperliquid explorer) shows: revenue, staking, peers, HIP-3/HIP-4 markets, tokenized stocks, weekend trading, builders, address data, plus (hyperliquid-direct mode) blocks, txs, live feed, prices, candles, order books, trades, validator APR, borrow/lend APYs. MAINNET only. Hosts: flowscan.xyz plus exactly ${UPSTREAM_HOSTS.join(", ")}.`
    : "Read-only tools for what www.flowscan.xyz (Hyperliquid explorer) shows: revenue, staking, peers, HIP-3 perp DEXs, HIP-4 outcome markets, tokenized stocks, weekend trading, builders and per-address account data. MAINNET only; data comes exclusively from flowscan.xyz routes (no block/tx lookups or live prices in this mode).";
  return `${body} Call flowscan_coverage first if unsure which tool fits.\n${GUIDE_LINE}`;
}

/**
 * tools/list returns portable schemas (see sanitize.ts). The SDK installs its
 * tools/list handler on the first registerTool call; wrapping setRequestHandler
 * (public API) before any tool is registered lets us post-process its output
 * without reimplementing it. Argument validation still uses the zod schemas.
 */
function installPortableToolList(server: McpServer): void {
  if (rawSchemasRequested()) return;
  const inner = server.server;
  const original = inner.setRequestHandler.bind(inner);
  inner.setRequestHandler = ((schema: unknown, handler: (...a: any[]) => unknown) => {
    if (schema !== ListToolsRequestSchema) return original(schema as any, handler as any);
    return original(ListToolsRequestSchema, async (req: any, extra: any) => {
      const res = (await handler(req, extra)) as { tools: Array<{ inputSchema: unknown; execution?: unknown; _meta?: unknown }> };
      return {
        ...res,
        tools: res.tools.map((t) => {
          const { execution: _execution, ...rest } = t; // {taskSupport: "forbidden"} is the spec default, so dropping it changes nothing
          return { ...rest, inputSchema: sanitizeInputSchema(t.inputSchema) };
        }),
      };
    });
  }) as typeof inner.setRequestHandler;
}

export function createServer(): McpServer {
  // Read once per server: the opt-in Hyperliquid-direct mode adds tools and a second, allowlisted transport.
  const direct = hyperliquidDirectEnabled();
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: serverInstructions(direct) });
  installPortableToolList(server);
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
  if (direct) registerDirectTools(server);
  registerGuide(server, direct);
  return server;
}

/**
 * Guidance for clients that cannot load Claude skills: the same SKILL.md as an
 * MCP prompt and resource, plus the coverage map as JSON. Clients without
 * prompt/resource support simply never call these.
 */
function registerGuide(server: McpServer, direct: boolean): void {
  server.registerPrompt(
    GUIDE_PROMPT,
    {
      title: "Flowscan tool-selection guide",
      description: `Rules for answering Hyperliquid questions with the flowscan_* tools (which tool fits, modes, numbers, citations). ${GUIDE_DESCRIPTION}`.slice(0, 1000),
    },
    () => ({
      description: "Flowscan tool-selection guide (from skills/flowscan/SKILL.md)",
      messages: [{ role: "user", content: { type: "text", text: GUIDE_MD } }],
    }),
  );
  server.registerResource(
    "flowscan_guide",
    GUIDE_URI,
    { title: "Flowscan tool-selection guide", description: "Same text as the flowscan_guide prompt (skills/flowscan/SKILL.md).", mimeType: "text/markdown" },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE_MD }] }),
  );
  server.registerResource(
    "flowscan_coverage",
    COVERAGE_URI,
    { title: "Flowscan coverage map", description: `Pages -> tools map, what is not served and the rules for this server's mode (${direct ? "hyperliquid-direct" : "strict"}). Same data as the flowscan_coverage tool.`, mimeType: "application/json" },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(getCoverage(direct), null, 2) }] }),
  );
}

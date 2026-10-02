import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { errorResult } from "./shape.js";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Optional allowlist (FLOWSCAN_TOOLS) for clients that cap the number of tools. */
export const TOOLS_ENV = "FLOWSCAN_TOOLS";
/** Always registered, whatever FLOWSCAN_TOOLS says: it is the map to everything else. */
const ALWAYS = new Set(["flowscan_coverage"]);

/**
 * Parse FLOWSCAN_TOOLS: comma/space separated tool names, `*` wildcards allowed
 * (e.g. "flowscan_revenue_*,flowscan_address_summary"). Unset or empty = all tools.
 */
export function toolFilter(env: NodeJS.ProcessEnv = process.env): ((name: string) => boolean) | null {
  const raw = (env[TOOLS_ENV] ?? "").trim();
  if (!raw) return null;
  const res = raw
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
  return (name) => ALWAYS.has(name) || res.some((r) => r.test(name));
}

const registered = new WeakMap<McpServer, { names: string[]; filter: ((name: string) => boolean) | null }>();

/** Names of the tools defineTool registered on this server (after FLOWSCAN_TOOLS filtering). */
export function registeredToolNames(server: McpServer): string[] {
  return [...(registered.get(server)?.names ?? [])];
}

/**
 * Thin wrapper over McpServer.registerTool that adds uniform error handling and
 * marks every Flowscan tool as read-only/idempotent (they only ever GET or POST
 * read queries to flowscan.xyz).
 */
export function defineTool<Shape extends ZodRawShapeCompat>(
  server: McpServer,
  name: string,
  opts: { title: string; description: string; inputSchema: Shape; openWorld?: boolean },
  handler: (args: any) => Promise<ToolResult>,
): void {
  let entry = registered.get(server);
  if (!entry) registered.set(server, (entry = { names: [], filter: toolFilter() }));
  if (entry.filter && !entry.filter(name)) return;
  entry.names.push(name);
  server.registerTool(
    name,
    {
      title: opts.title,
      description: opts.description,
      inputSchema: opts.inputSchema,
      // destructive/idempotent hints only apply when readOnlyHint is false (MCP spec), so they are omitted.
      annotations: { readOnlyHint: true, openWorldHint: opts.openWorld ?? true },
    },
    (async (args: unknown) => {
      try {
        return await handler(args ?? {});
      } catch (err) {
        return errorResult(err);
      }
    }) as any,
  );
}

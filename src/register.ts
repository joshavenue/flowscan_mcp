import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { errorResult } from "./shape.js";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

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
  server.registerTool(
    name,
    {
      title: opts.title,
      description: opts.description,
      inputSchema: opts.inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: opts.openWorld ?? true },
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

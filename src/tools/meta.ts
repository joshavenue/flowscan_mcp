import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { COVERAGE } from "../coverage.js";
import { defineTool } from "../register.js";
import { result } from "../shape.js";

export function registerMetaTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_coverage",
    {
      title: "What Flowscan shows and which tool to use",
      description:
        "Start here when unsure. Returns the map of flowscan.xyz pages -> tools, what Flowscan does NOT serve (block/tx lookups, prices), the mainnet-only rule and output-shaping conventions. Optionally filter by a keyword (e.g. 'revenue', 'address', 'hip-3').",
      inputSchema: { topic: z.string().optional().describe("Keyword to filter pages/tools by.") },
      openWorld: false,
    },
    async (args) => {
      if (!args.topic) return result(COVERAGE);
      const t = String(args.topic).toLowerCase();
      const pages = COVERAGE.pages.filter((p) => JSON.stringify(p).toLowerCase().includes(t));
      return result({ ...COVERAGE, pages });
    },
  );
}

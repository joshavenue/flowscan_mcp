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
        "Start here when unsure. Returns the map of flowscan.xyz pages -> tools, what Flowscan does NOT serve (block/tx lookups, prices), the mainnet-only rule and output-shaping conventions. Optionally filter by a keyword (e.g. 'revenue', 'address', 'hip-3'): matching pages plus matching notServed items, with servedByThisServer=false when only notServed matches. Also lists HIP-3 dex display names vs on-chain prefixes.",
      inputSchema: { topic: z.string().optional().describe("Keyword to filter pages/tools by.") },
      openWorld: false,
    },
    async (args) => {
      if (!args.topic) return result(COVERAGE);
      const words = String(args.topic).toLowerCase().split(/[\s,/]+/).filter((w) => w.length >= 2);
      const hit = (x: unknown) => {
        const j = JSON.stringify(x).toLowerCase();
        return words.length > 0 && words.every((w) => j.includes(w));
      };
      const pages = COVERAGE.pages.filter(hit);
      const notServedMatches = COVERAGE.notServed.filter(hit);
      return result({
        ...COVERAGE,
        topic: args.topic,
        pages,
        notServedMatches,
        servedByThisServer: pages.length > 0 ? true : notServedMatches.length > 0 ? false : null,
      });
    },
  );
}

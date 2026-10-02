/**
 * Vercel AI SDK with the flowscan MCP server, using Grok (xAI) as the model.
 * Swap `xai(...)` for any other AI SDK provider.
 *
 *   npm install ai @ai-sdk/mcp @ai-sdk/xai
 *   export XAI_API_KEY=...
 *   npx tsx examples/vercel-ai.ts
 *
 * Streamable HTTP instead of stdio:
 *   createMCPClient({ transport: { type: "http", url: "http://127.0.0.1:8787/mcp" } })
 *
 * Docs: https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools
 *       https://ai-sdk.dev/providers/ai-sdk-providers/xai
 */
import { generateText, isStepCount } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport as StdioClientTransport } from "@ai-sdk/mcp/mcp-stdio";
import { xai } from "@ai-sdk/xai";

async function main(): Promise<void> {
  const mcpClient = await createMCPClient({
    transport: new StdioClientTransport({
      command: "npx",
      args: ["-y", "github:joshavenue/flowscan_mcp"],
      // env: { FLOWSCAN_HYPERLIQUID_DIRECT: "1" }, // opt-in direct mode
    }),
  });
  try {
    const tools = await mcpClient.tools();
    const { text } = await generateText({
      model: xai(process.env.XAI_MODEL ?? "grok-4.7"),
      tools,
      stopWhen: isStepCount(8),
      system:
        "Answer Hyperliquid questions only with the flowscan_* tools (mainnet only). Quote tool totals and the UTC date range.",
      prompt: "Which HIP-3 deployer earned the most fees over the last 30 days?",
    });
    console.log(text);
  } finally {
    await mcpClient.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

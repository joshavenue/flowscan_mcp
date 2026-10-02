// Vercel AI SDK MCP client against flowscan-mcp: stdio, Streamable HTTP and legacy SSE. No model is called:
// we fetch the AI SDK tool set (what generateText/streamText would receive) and execute tools directly.
import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const VER = `ai ${require("ai/package.json").version}, @ai-sdk/mcp ${require("@ai-sdk/mcp/package.json").version}`;
const url = process.env.FLOWSCAN_MCP_URL;
const transports = {
  stdio: () => new StdioMCPTransport({ command: process.env.FLOWSCAN_MCP_NODE, args: [process.env.FLOWSCAN_MCP_ENTRY], env: process.env }),
  "streamable-http": () => ({ type: "http", url }),
  "sse (legacy)": () => ({ type: "sse", url: url.replace(/\/mcp$/, "/sse") }),
};

const text = (r) => (r?.content ?? []).map((c) => c.text ?? "").join("");
let ok = true;
for (const [name, make] of Object.entries(transports)) {
  const row = { client: "vercel-ai-sdk", version: VER, transport: name, tools: 0, prompts_resources: false, call: false };
  let client;
  try {
    client = await createMCPClient({ transport: make() });
    const tools = await client.tools();
    row.tools = Object.keys(tools).length;
    const opts = { toolCallId: "probe", messages: [] };
    const lookup = await tools.flowscan_builder_lookup.execute({ query: "fomo" }, opts);
    const cov = JSON.parse(text(await tools.flowscan_coverage.execute({}, opts)));
    row.call = text(lookup).toLowerCase().includes("fomo") && cov.pages.length > 0;
    const prompts = await client.experimental_listPrompts();
    const guide = await client.experimental_getPrompt({ name: "flowscan_guide" });
    const res = await client.readResource({ uri: "flowscan://guide" });
    row.prompts_resources = prompts.prompts.some((p) => p.name === "flowscan_guide") && guide.messages[0].content.text.includes("flowscan_coverage") && res.contents[0].text.includes("flowscan_coverage");
  } catch (err) {
    row.error = String(err?.stack ?? err).slice(0, 300);
  } finally {
    await client?.close().catch(() => {});
  }
  ok &&= row.tools > 0 && row.call && row.prompts_resources;
  console.log(`RESULT ${JSON.stringify(row)}`);
}
process.exit(ok ? 0 : 1);

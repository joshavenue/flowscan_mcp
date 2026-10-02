// MCP Inspector CLI (npx @modelcontextprotocol/inspector --cli) against flowscan-mcp over stdio and Streamable HTTP.
// Each method runs as its own inspector process; outputs are saved under $OUT_DIR for inspection.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const VERSION = process.env.INSPECTOR_VERSION ?? "2.9.0";
const OUT = process.env.OUT_DIR;
mkdirSync(OUT, { recursive: true });
// The inspector spawns stdio servers with a minimal environment; forward proxy/CA settings explicitly.
const passEnv = ["NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "FLOWSCAN_HYPERLIQUID_DIRECT"].filter((k) => process.env[k]).flatMap((k) => ["-e", `${k}=${process.env[k]}`]);
const targets = {
  // -e must come after the server command (before it, inspector 2.9 misparses the target).
  stdio: [process.env.FLOWSCAN_MCP_NODE, process.env.FLOWSCAN_MCP_ENTRY, ...passEnv],
  "streamable-http": ["--transport", "http", "--server-url", process.env.FLOWSCAN_MCP_URL],
};
const methods = [
  ["tools-list", ["--method", "tools/list"], (j) => j.tools.length > 0 && j.tools.every((t) => !JSON.stringify(t.inputSchema).includes("$schema"))],
  ["prompts-list", ["--method", "prompts/list"], (j) => j.prompts.some((p) => p.name === "flowscan_guide")],
  ["prompts-get", ["--method", "prompts/get", "--prompt-name", "flowscan_guide"], (j) => j.messages[0].content.text.includes("flowscan_coverage")],
  ["resources-list", ["--method", "resources/list"], (j) => ["flowscan://guide", "flowscan://coverage"].every((u) => j.resources.some((r) => r.uri === u))],
  ["resources-read", ["--method", "resources/read", "--uri", "flowscan://coverage"], (j) => Array.isArray(JSON.parse(j.contents[0].text).pages)],
  ["call-coverage", ["--method", "tools/call", "--tool-name", "flowscan_coverage", "--tool-arg", "topic=builders"], (j) => !j.isError && JSON.parse(j.content[0].text).servedByThisServer === true],
  ["call-builder-lookup", ["--method", "tools/call", "--tool-name", "flowscan_builder_lookup", "--tool-arg", "query=fomo"], (j) => !j.isError && j.content[0].text.toLowerCase().includes("fomo")],
];

let allOk = true;
for (const [transport, target] of Object.entries(targets)) {
  const row = { client: "mcp-inspector-cli", version: `@modelcontextprotocol/inspector ${VERSION}`, transport, tools: 0, prompts_resources: true, call: true, failed: [] };
  for (const [label, args, check] of methods) {
    let out = "";
    try {
      out = execFileSync("npx", ["-y", `@modelcontextprotocol/inspector@${VERSION}`, "--cli", ...target, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
      writeFileSync(path.join(OUT, `${transport}-${label}.json`), out);
      const j = JSON.parse(out.slice(out.indexOf("{")));
      if (label === "tools-list") row.tools = j.tools.length;
      if (!check(j)) throw new Error("check failed");
    } catch (err) {
      row.failed.push(`${label}: ${String(err.message ?? err).split("\n")[0].slice(0, 160)}`);
      if (label.startsWith("call")) row.call = false;
      else if (label !== "tools-list") row.prompts_resources = false;
    }
  }
  if (!row.failed.length) delete row.failed;
  allOk &&= row.tools > 0 && row.call && row.prompts_resources && !row.failed;
  console.log(`RESULT ${JSON.stringify(row)}`);
}
process.exit(allOk ? 0 : 1);

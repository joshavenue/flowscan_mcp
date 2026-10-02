/**
 * Cross-client protocol tests: run every probe in scripts/clients/<name>/run.sh against
 * the built server (stdio: spawned by each client; HTTP: one shared `--http --port 0`
 * server started here), collect their RESULT lines and write scripts/clients/RESULTS.md.
 *
 * Usage: npm run build && npm run clients
 *        npm run clients -- --only python-sdk,vercel-ai-sdk   # subset
 *        npm run clients -- --no-write                         # do not rewrite RESULTS.md
 *        FLOWSCAN_HYPERLIQUID_DIRECT=1 npm run clients        # direct mode (58 tools)
 *
 * Needs network (npm/PyPI installs and www.flowscan.xyz), python3 (uv optional) and npx.
 * No model API keys: these are protocol-level checks. Exits 1 if any client fails.
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ENTRY = path.join(ROOT, "dist", "index.js");
const CLIENTS = ["inspector", "python-sdk", "openai-agents", "langchain", "vercel-ai-sdk"];
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const only = arg("--only")?.split(",");
const write = !process.argv.includes("--no-write");
const DIRECT = /^(1|true)$/i.test((process.env.FLOWSCAN_HYPERLIQUID_DIRECT ?? "").trim());

type Row = { client: string; version: string; transport: string; tools: number; prompts_resources: boolean; call: boolean; error?: string; failed?: string[]; [k: string]: unknown };

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += String(b);
      for (const line of String(b).split("\n")) if (line.startsWith("RESULT ")) process.stdout.write(`  ${line}\n`);
    });
    child.stderr.on("data", (b) => (stderr += String(b)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function startHttp(): Promise<{ url: string; stop: () => Promise<number | null> }> {
  const child = spawn(process.execPath, [ENTRY, "--http", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let err = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${err}`)), 15_000);
    child.stderr.on("data", (b) => {
      err += String(b);
      const m = err.match(/at (http:\/\/\S+\/mcp)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.once("exit", (code) => reject(new Error(`server exited (${code}): ${err}`)));
  });
  return {
    url,
    stop: () =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(null);
        }, 5_000);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.kill("SIGTERM");
      }),
  };
}

const NOTES = `## Notes

- **Python MCP SDK (stdio)** passes only a minimal environment (PATH, HOME, USER, ...) to the server process. Behind a proxy or with a custom CA (\`NODE_EXTRA_CA_CERTS\`, \`HTTPS_PROXY\`), pass \`env=\` explicitly, or tool calls fail with fetch errors while tools/list still works. The probes forward the full environment.
- **langchain-mcp-adapters 0.3.1** declares \`mcp>=1.24\` but imports \`mcp.shared.context.RequestContext\`, which mcp 2.x removed: a fresh install resolves mcp 2.x and fails at import. Pin \`mcp<2\` until a newer adapter release.
- **MCP Inspector CLI 2.9**: \`-e KEY=VALUE\` must come after the server command; before it the target is misparsed.
- **OpenAI Agents SDK**: every tool converts to a FunctionTool, and every input schema also passes \`ensure_strict_json_schema\` (OpenAI strict mode). No API key is needed to list or call MCP tools.
- **Vercel AI SDK**: since AI SDK 6 the MCP client is in \`@ai-sdk/mcp\` (\`createMCPClient\`, also exported as \`experimental_createMCPClient\`); stdio transport from \`@ai-sdk/mcp/mcp-stdio\`. Legacy SSE (\`/sse\`) is exercised too.
- **Stateless HTTP** (the default) issues no \`Mcp-Session-Id\`; every client above accepted that, including the SDKs' optional GET stream getting 405.
`;

async function main(): Promise<void> {
  if (!existsSync(ENTRY)) {
    console.error("dist/index.js missing: run `npm run build` first");
    process.exit(1);
  }
  const http = await startHttp();
  console.log(`flowscan-mcp HTTP at ${http.url} (${DIRECT ? "hyperliquid-direct" : "strict"} mode)`);
  const env = { ...process.env, FLOWSCAN_MCP_URL: http.url, FLOWSCAN_MCP_NODE: process.execPath, FLOWSCAN_MCP_ENTRY: ENTRY };
  const rows: Row[] = [];
  const failures: string[] = [];
  for (const name of CLIENTS.filter((c) => !only || only.includes(c))) {
    console.log(`\n== ${name}`);
    const t0 = Date.now();
    const r = await run("bash", [path.join(HERE, name, "run.sh")], env, 15 * 60_000);
    const got = r.stdout.split("\n").filter((l) => l.startsWith("RESULT ")).map((l) => JSON.parse(l.slice(7)) as Row);
    rows.push(...got);
    console.log(`   exit ${r.code} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (r.code !== 0 || got.length === 0) {
      failures.push(`${name}: exit ${r.code}${got.length ? "" : " (no RESULT lines)"}`);
      process.stderr.write(r.stderr.slice(-3000));
    }
  }
  const exitCode = await http.stop();
  if (exitCode !== 0) failures.push(`HTTP server exit code on SIGTERM: ${exitCode}`);

  const yes = (b: boolean) => (b ? "yes" : "**NO**");
  const table = [
    "| client | version | transport | tools listed | prompts + resources | tool call | notes |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((r) => {
      const notes = [r.strict_convertible !== undefined ? `${r.strict_convertible}/${r.tools} strict-convertible` : "", r.schemas_ok === false ? "schema issue" : "", r.error ?? "", ...(r.failed ?? [])].filter(Boolean).join("; ");
      return `| ${r.client} | ${r.version} | ${r.transport} | ${r.tools} | ${yes(r.prompts_resources)} | ${yes(r.call)} | ${notes.replace(/\|/g, "\\|")} |`;
    }),
  ].join("\n");
  console.log(`\n${table}`);

  if (write && !only) {
    const md = `# Cross-client results

Generated by \`npm run clients\` (scripts/clients/run-all.ts) on ${new Date().toISOString().slice(0, 10)}: flowscan-mcp in ${DIRECT ? "hyperliquid-direct" : "strict"} mode, Node ${process.version}, ${os.type()} ${os.arch()}.
Each client lists tools, calls \`flowscan_coverage\` and \`flowscan_builder_lookup {query: "fomo"}\` (live www.flowscan.xyz), gets the \`flowscan_guide\` prompt and reads a \`flowscan://\` resource. No model or API key is involved: these are protocol-level checks.

${table}

HTTP server: \`node dist/index.js --http --port 0\` (stateless Streamable HTTP; legacy SSE on \`/sse\`), stopped with SIGTERM (exit code ${exitCode}).

${NOTES}`;
    writeFileSync(path.join(HERE, "RESULTS.md"), md);
    console.log(`\nwrote scripts/clients/RESULTS.md`);
  }
  if (failures.length || rows.some((r) => !r.call || !r.prompts_resources || r.tools === 0)) {
    console.error(`\nCLIENTS FAILED:\n${failures.map((f) => ` - ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log("\nCLIENTS OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

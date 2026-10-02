import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { createServer, serverInstructions } from "../src/server.js";
import { sanitizeInputSchema, sanitizeSchema } from "../src/sanitize.js";
import { GUIDE_MD, GUIDE_SHA256 } from "../src/guide.js";
import { parseCli } from "../src/cli.js";
import { startHttpServer } from "../src/httpServer.js";
import { toolFilter } from "../src/register.js";
import { DIRECT_ENV } from "../src/upstream.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_KEYS = [DIRECT_ENV, "FLOWSCAN_TOOLS", "FLOWSCAN_RAW_SCHEMAS"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function connect(): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer().connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return client;
}

// ---------- schema sanitization ----------

test("sanitizeSchema: drops $schema and zod's safe-integer bounds, keeps real bounds", () => {
  const out = sanitizeInputSchema({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      t: { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991, description: "ms" },
      n: { type: "integer", minimum: 1, maximum: 500, description: "n" },
    },
  });
  assert.deepEqual(out, { type: "object", properties: { t: { type: "integer", description: "ms" }, n: { type: "integer", minimum: 1, maximum: 500, description: "n" } } });
});

test("sanitizeSchema: const and anyOf-of-consts become enum", () => {
  assert.deepEqual(sanitizeSchema({ const: "x" }), { enum: ["x"], type: "string" });
  assert.deepEqual(sanitizeSchema({ description: "m", anyOf: [{ type: "number", const: 1 }, { type: "number", const: 2 }, { type: "number", const: 5 }] }), { description: "m", type: "integer", enum: [1, 2, 5] });
  // mixed-type unions are left alone (anyOf of distinct types is portable)
  const mixed = { anyOf: [{ type: "integer" }, { type: "string" }] };
  assert.deepEqual(sanitizeSchema(mixed), mixed);
});

test("sanitizeSchema: exclusive bounds become inclusive (exact for integers, noted for numbers)", () => {
  assert.deepEqual(sanitizeSchema({ type: "integer", exclusiveMinimum: 0, exclusiveMaximum: 10 }), { type: "integer", minimum: 1, maximum: 9 });
  assert.deepEqual(sanitizeSchema({ type: "number", exclusiveMinimum: 0, description: "Size." }), { type: "number", minimum: 0, description: "Size. Must be > 0." });
});

test("sanitizeSchema: recurses into properties, items and anyOf; top level always has type object + properties", () => {
  const out = sanitizeInputSchema({ properties: { a: { type: "array", items: { $schema: "x", const: 3 } } } });
  assert.deepEqual(out, { properties: { a: { type: "array", items: { enum: [3], type: "integer" } } }, type: "object" });
  assert.deepEqual(sanitizeInputSchema(undefined), { type: "object", properties: {} });
});

test("tools/list is portable in both modes; FLOWSCAN_RAW_SCHEMAS=1 restores the SDK output", async () => {
  for (const direct of [false, true]) {
    if (direct) process.env[DIRECT_ENV] = "1";
    else delete process.env[DIRECT_ENV];
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();
    const text = JSON.stringify(tools);
    assert.ok(!text.includes("$schema"), "no $schema");
    assert.ok(!text.includes("9007199254740991"), "no safe-int bounds");
    assert.ok(!/"const"|exclusiveM/.test(text), "no const / exclusive bounds");
    for (const t of tools) {
      assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/);
      assert.ok((t.description ?? "").length <= 1024, `${t.name} description too long for OpenAI`);
      assert.equal(t.inputSchema.type, "object");
      for (const [p, s] of Object.entries(t.inputSchema.properties ?? {})) assert.ok((s as any).description, `${t.name}.${p} has no description`);
    }
  }
  process.env.FLOWSCAN_RAW_SCHEMAS = "1";
  const client = await connect();
  const raw = JSON.stringify((await client.listTools()).tools);
  await client.close();
  assert.ok(raw.includes("$schema"));
});

test("tool calls still validate against the zod schema (sanitization is listing-only)", async () => {
  delete process.env[DIRECT_ENV];
  const client = await connect();
  const r: any = await client.callTool({ name: "flowscan_coverage", arguments: { topic: 42 } });
  await client.close();
  assert.equal(r.isError, true);
});

test("FLOWSCAN_TOOLS keeps only matching tools (plus flowscan_coverage)", async () => {
  delete process.env[DIRECT_ENV];
  process.env.FLOWSCAN_TOOLS = "flowscan_revenue_*, flowscan_peers";
  const client = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  await client.close();
  assert.deepEqual(names, ["flowscan_coverage", "flowscan_peers", "flowscan_revenue_deployer_fees", "flowscan_revenue_hypercore_fees", "flowscan_revenue_priority_gas", "flowscan_revenue_summary"]);
  assert.equal(toolFilter({}), null);
});

// ---------- guide embedding ----------

test("src/guide.ts embeds the current skills/flowscan/SKILL.md body", () => {
  const raw = readFileSync(path.join(ROOT, "skills/flowscan/SKILL.md"), "utf8").replace(/\r\n/g, "\n");
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim() + "\n";
  assert.equal(GUIDE_MD, body, "src/guide.ts is stale: run `npm run guide`");
  assert.match(GUIDE_SHA256, /^[0-9a-f]{64}$/);
  execFileSync(process.execPath, [path.join(ROOT, "scripts/gen-guide.mjs"), "--check"], { stdio: "pipe" });
});

test("guide prompt, guide resource and coverage resource are served; instructions <= 600 chars", async () => {
  for (const direct of [false, true]) {
    if (direct) process.env[DIRECT_ENV] = "1";
    else delete process.env[DIRECT_ENV];
    const client = await connect();
    const caps = client.getServerCapabilities();
    assert.ok(caps?.prompts && caps?.resources && caps?.tools);
    assert.deepEqual((await client.listPrompts()).prompts.map((p) => p.name), ["flowscan_guide"]);
    const prompt = await client.getPrompt({ name: "flowscan_guide" });
    assert.equal((prompt.messages[0].content as any).text, GUIDE_MD);
    const resources = (await client.listResources()).resources;
    assert.deepEqual(resources.map((r) => [r.uri, r.mimeType]), [["flowscan://guide", "text/markdown"], ["flowscan://coverage", "application/json"]]);
    const guide = await client.readResource({ uri: "flowscan://guide" });
    assert.equal((guide.contents[0] as any).text, GUIDE_MD);
    const cov = JSON.parse((await client.readResource({ uri: "flowscan://coverage" })).contents[0].text as string);
    assert.equal(cov.mode, direct ? "hyperliquid-direct" : "strict");
    const instructions = client.getInstructions() ?? "";
    assert.equal(instructions, serverInstructions(direct));
    assert.ok(instructions.length <= 600, `instructions ${instructions.length} chars`);
    assert.match(instructions, /For tool-selection rules call the prompt flowscan_guide or read resource flowscan:\/\/guide\./);
    await client.close();
  }
});

// ---------- CLI ----------

test("parseCli: stdio by default, --http/--port/--host and env", () => {
  assert.deepEqual(parseCli([], {}), { transport: "stdio", port: 8787, host: "127.0.0.1", stateful: false, corsOrigins: [], allowedHosts: [] });
  const h = parseCli(["--http", "--port", "9000", "--host=0.0.0.0", "--stateful"], {});
  assert.ok(typeof h === "object" && h.transport === "http" && h.port === 9000 && h.host === "0.0.0.0" && h.stateful);
  const e = parseCli([], { FLOWSCAN_MCP_TRANSPORT: "http", PORT: "1234", HOST: "::1", FLOWSCAN_MCP_CORS: "https://a.example, https://b.example" });
  assert.ok(typeof e === "object" && e.transport === "http" && e.port === 1234 && e.host === "::1" && e.corsOrigins.length === 2);
  const p = parseCli(["--port", "5"], {});
  assert.ok(typeof p === "object" && p.transport === "http", "--port implies --http");
  const s = parseCli(["--stdio"], { FLOWSCAN_MCP_TRANSPORT: "http" });
  assert.ok(typeof s === "object" && s.transport === "stdio", "flag beats env");
  assert.equal(parseCli(["--help"], {}), "help");
  assert.throws(() => parseCli(["--bogus"], {}), /unknown argument/);
  assert.throws(() => parseCli([], { FLOWSCAN_MCP_TRANSPORT: "ws" }), /stdio or http/);
  assert.throws(() => parseCli(["--port", "x"], {}), /invalid port/);
});

// ---------- HTTP transport (offline: only flowscan_coverage is called) ----------

/** GET with an arbitrary Host header (fetch() does not let you override Host). */
function rawGet(port: number, pathname: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

async function viaHttp(url: string, transport: "streamable" | "sse" = "streamable") {
  const client = new Client({ name: "t-http", version: "0" });
  await client.connect(transport === "sse" ? new SSEClientTransport(new URL(url)) : new StreamableHTTPClientTransport(new URL(url)));
  const tools = (await client.listTools()).tools;
  const cov: any = await client.callTool({ name: "flowscan_coverage", arguments: { topic: "revenue" } });
  const prompt = await client.getPrompt({ name: "flowscan_guide" });
  return { client, tools, cov: JSON.parse(cov.content[0].text), prompt };
}

test("HTTP stateless: SDK client lists tools, calls a tool, reads the guide; GET is 405; bad Host/Origin are 403", async () => {
  delete process.env[DIRECT_ENV];
  const srv = await startHttpServer({ port: 0, host: "127.0.0.1", log: () => {} });
  try {
    const { client, tools, cov, prompt } = await viaHttp(srv.url);
    assert.equal(tools.length, 44);
    assert.equal(cov.servedByThisServer, true);
    assert.equal((prompt.messages[0].content as any).text, GUIDE_MD);
    assert.equal((client.transport as StreamableHTTPClientTransport).sessionId, undefined, "stateless: no session id");
    await client.close();

    const base = srv.url.replace(/\/mcp$/, "");
    const health = await (await fetch(`${base}/healthz`)).json();
    assert.deepEqual([health.ok, health.mode, health.tools, health.stateful], [true, "strict", 44, false]);
    assert.equal((await fetch(srv.url)).status, 405);
    assert.equal(await rawGet(srv.port, "/healthz", { Host: "evil.example" }), 403);
    assert.equal(await rawGet(srv.port, "/healthz", { Host: `localhost:${srv.port}` }), 200);
    const badOrigin = await fetch(`${base}/healthz`, { headers: { Origin: "https://evil.example" } });
    assert.equal(badOrigin.status, 403);
    const localOrigin = await fetch(`${base}/healthz`, { headers: { Origin: "http://localhost:6274" } });
    assert.equal(localOrigin.status, 200);
    assert.equal(localOrigin.headers.get("access-control-allow-origin"), "http://localhost:6274");
    assert.match(localOrigin.headers.get("access-control-expose-headers") ?? "", /Mcp-Session-Id/);
  } finally {
    await srv.close();
  }
});

test("HTTP stateful sessions, CORS allowlist and legacy SSE", async () => {
  process.env[DIRECT_ENV] = "1";
  const srv = await startHttpServer({ port: 0, host: "127.0.0.1", stateful: true, corsOrigins: ["https://app.example"], log: () => {} });
  try {
    const { client, tools } = await viaHttp(srv.url);
    assert.equal(tools.length, 58);
    const t = client.transport as StreamableHTTPClientTransport;
    assert.match(t.sessionId ?? "", /^[0-9a-f-]{36}$/);
    await t.terminateSession();
    await client.close();

    const pre = await fetch(srv.url, { method: "OPTIONS", headers: { Origin: "https://app.example", "Access-Control-Request-Method": "POST" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://app.example");
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /Mcp-Session-Id/);
    const noSession = await fetch(srv.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(noSession.status, 400);

    const sse = await viaHttp(srv.url.replace(/\/mcp$/, "/sse"), "sse");
    assert.equal(sse.tools.length, 58);
    await sse.client.close();
  } finally {
    await srv.close();
  }
});

test("HTTP on 0.0.0.0 accepts any Host unless FLOWSCAN_MCP_ALLOWED_HOSTS is set", async () => {
  const open = await startHttpServer({ port: 0, host: "0.0.0.0", log: () => {} });
  const pinned = await startHttpServer({ port: 0, host: "0.0.0.0", allowedHosts: ["mcp.example.com"], log: () => {} });
  try {
    assert.equal(await rawGet(open.port, "/healthz", { Host: "anything.example" }), 200);
    assert.equal(await rawGet(pinned.port, "/healthz", { Host: "mcp.example.com:443" }), 200);
    assert.equal(await rawGet(pinned.port, "/healthz", { Host: "anything.example" }), 403);
  } finally {
    await open.close();
    await pinned.close();
  }
});

// ---------- process hygiene (stdio) ----------


function runStdio(stop: "SIGTERM" | "SIGINT" | "stdin-close"): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(ROOT, "src/index.ts")], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, FLOWSCAN_HYPERLIQUID_DIRECT: "" } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no exit after ${stop}: ${stderr}`));
    }, 20_000);
    child.stderr.on("data", (b) => (stderr += String(b)));
    child.stdout.on("data", (b) => {
      stdout += String(b);
      if (stdout.includes('"id":2')) {
        if (stop === "stdin-close") child.stdin.end();
        else child.kill(stop);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "prompts/list" });
  });
}

for (const stop of ["SIGTERM", "SIGINT", "stdin-close"] as const) {
  test(`stdio: stdout carries only JSON-RPC and the process exits 0 on ${stop}`, async () => {
    const { code, stdout, stderr } = await runStdio(stop);
    assert.equal(code, 0, stderr);
    const lines = stdout.split("\n").filter(Boolean);
    assert.ok(lines.length >= 2);
    for (const line of lines) assert.equal(JSON.parse(line).jsonrpc, "2.0", `non-protocol stdout: ${line}`);
    assert.match(stderr, /flowscan-mcp ready \(stdio\)/);
  });
}

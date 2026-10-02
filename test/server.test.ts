import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { getCoverage } from "../src/coverage.js";
import { DIRECT_TOOLS } from "../src/tools/direct.js";
import { DIRECT_ENV } from "../src/upstream.js";

const saved = process.env[DIRECT_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[DIRECT_ENV];
  else process.env[DIRECT_ENV] = saved;
});

async function listTools(): Promise<{ names: string[]; schemaChars: number; instructions?: string }> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  const tools = (await client.listTools()).tools;
  const instructions = client.getInstructions();
  await client.close();
  return { names: tools.map((t) => t.name), schemaChars: tools.reduce((a, t) => a + JSON.stringify(t).length, 0), instructions };
}

test("strict mode registers exactly the 44 flowscan.xyz tools", async () => {
  delete process.env[DIRECT_ENV];
  const { names, schemaChars, instructions } = await listTools();
  assert.equal(names.length, 44);
  for (const t of DIRECT_TOOLS) assert.ok(!names.includes(t), t);
  assert.ok(schemaChars < 60_000, `schema ${schemaChars}`);
  assert.match(instructions ?? "", /exclusively from flowscan\.xyz/);
});

test("direct mode adds the 14 Hyperliquid-direct tools", async () => {
  process.env[DIRECT_ENV] = "true";
  const { names, instructions } = await listTools();
  assert.equal(names.length, 44 + DIRECT_TOOLS.length);
  for (const t of DIRECT_TOOLS) assert.ok(names.includes(t), t);
  assert.match(instructions ?? "", /api\.hyperunit\.xyz/);
});

test("coverage is mode-aware", () => {
  const strict = getCoverage(false);
  assert.equal(strict.mode, "strict");
  const advertisedStrict = new Set(strict.pages.flatMap((p) => p.tools));
  for (const t of DIRECT_TOOLS) assert.ok(!advertisedStrict.has(t), t);
  const pointers = strict.notServed.map((n) => n.availableWith ?? "").join(" ");
  for (const t of DIRECT_TOOLS) assert.ok(pointers.includes(t), `notServed should point to ${t}`);
  assert.match(pointers, /FLOWSCAN_HYPERLIQUID_DIRECT=1/);

  const direct = getCoverage(true);
  assert.equal(direct.mode, "hyperliquid-direct");
  const advertised = new Set(direct.pages.flatMap((p) => p.tools));
  for (const t of DIRECT_TOOLS) assert.ok(advertised.has(t), t);
  assert.ok(direct.pages.some((p) => p.path === "/block/{height}") && direct.pages.some((p) => p.path === "/tx/{hash}"));
  assert.match(direct.rules[0], /api\.hyperliquid\.xyz, rpc\.hyperliquid\.xyz, api-ui\.hyperliquid\.xyz, api\.hyperunit\.xyz/);
  assert.deepEqual(direct.notServed.map((n) => n.item), ["Testnet"]);
});

test("live feed: parses the homepage's message shapes, de-duplicates, sorts newest first and closes the socket", async () => {
  process.env[DIRECT_ENV] = "1";
  const realWs = globalThis.WebSocket;
  const sockets: Array<{ sent: string[]; closed: boolean; url: string }> = [];
  const block = (h: number) => ({ height: h, blockTime: 1_790_000_000_000 + h * 70, hash: `0x${h}`, proposer: "0xp", numTxs: 10 });
  class FakeWs {
    sent: string[] = [];
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(public url: string) {
      sockets.push(this);
      setTimeout(() => {
        this.onopen?.();
        const send = (m: unknown) => this.onmessage?.({ data: JSON.stringify(m) });
        send({ channel: "subscriptionResponse", data: { method: "subscribe", subscription: { type: "explorerBlock" } } });
        send([block(3), block(1), block(2)]); // bare array backlog
        send({ channel: "explorerBlock", data: [block(4), block(3)] }); // channel-wrapped, duplicate 3
        send([{ not: "a block" }]);
      }, 5);
    }
    send(s: string) {
      this.sent.push(s);
    }
    close() {
      this.closed = true;
    }
  }
  globalThis.WebSocket = FakeWs as unknown as typeof WebSocket;
  try {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer().connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const r: any = await client.callTool({ name: "flowscan_live_feed", arguments: { seconds: 1, include: "blocks" } });
    await client.close();
    const out = JSON.parse(r.content[0].text);
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].url, "wss://rpc.hyperliquid.xyz/ws");
    assert.deepEqual(sockets[0].sent.map((x) => JSON.parse(x)), [{ method: "subscribe", subscription: { type: "explorerBlock" } }]);
    assert.equal(sockets[0].closed, true);
    assert.deepEqual(out.data.blocks.map((b: any) => b.height), [4, 3, 2, 1]);
    assert.equal(out.data.latestBlock, 4);
    assert.equal(out.data.stats.medianBlockIntervalMs, 70);
    assert.equal(out.data.blocks[0].blockTimeIso, new Date(block(4).blockTime).toISOString());
    assert.equal(out.mode, "hyperliquid-direct");
  } finally {
    globalThis.WebSocket = realWs;
  }
});

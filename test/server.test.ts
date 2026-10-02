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
        const tx = (h: string, time: number, type: string) => ({ time, user: "0xu", block: 4, hash: h, error: null, action: { type } });
        send([tx("0xa", 1000, "noop"), tx("0xb", 1300, "evmRawTx"), tx("0xc", 1200, "noop")]);
        send({ channel: "explorerTxs", data: [tx("0xb", 1300, "evmRawTx")] }); // duplicate
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
    const r: any = await client.callTool({ name: "flowscan_live_feed", arguments: { seconds: 1, limit: 2 } });
    await client.close();
    const out = JSON.parse(r.content[0].text);
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].url, "wss://rpc.hyperliquid.xyz/ws");
    assert.deepEqual(sockets[0].sent.map((x) => JSON.parse(x)), [
      { method: "subscribe", subscription: { type: "explorerBlock" } },
      { method: "subscribe", subscription: { type: "explorerTxs" } },
    ]);
    assert.equal(sockets[0].closed, true);
    assert.equal(out.data.blocks.count, 4);
    assert.deepEqual(out.data.blocks.heightRange, { from: 1, to: 4 });
    assert.deepEqual(out.data.blocks.rows.map((b: any) => b.height), [4, 3]); // limit 2
    assert.equal(out.data.latestBlock, 4);
    assert.equal(out.data.stats.medianBlockIntervalMs, 70);
    assert.equal(out.data.blocks.rows[0].blockTimeIso, new Date(block(4).blockTime).toISOString());
    // txs: de-duplicated, newest first, counted over the whole sample and over the rows returned
    assert.equal(out.data.txs.count, 3);
    assert.deepEqual(out.data.txs.countsByType, { noop: 2, evmRawTx: 1 });
    assert.equal(out.data.txs.timeSpanMs, 300);
    assert.deepEqual(out.data.txs.timeSpanIso, { from: new Date(1000).toISOString(), to: new Date(1300).toISOString() });
    assert.deepEqual(out.data.txs.rows.map((t: any) => t.hash), ["0xb", "0xc"]);
    assert.deepEqual(out.data.txs.rowsCountsByType, { evmRawTx: 1, noop: 1 });
    assert.equal(out.mode, "hyperliquid-direct");
    assert.ok(Math.abs(Date.now() - out.fetchedAt) < 60_000 && out.fetchedAtIso === new Date(out.fetchedAt).toISOString());
  } finally {
    globalThis.WebSocket = realWs;
  }
});

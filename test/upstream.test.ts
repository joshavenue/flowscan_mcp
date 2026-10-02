import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { clearCache, get } from "../src/client.js";
import { assertUpstreamAllowed, clearUpstreamCache, DIRECT_ENV, ENDPOINTS, hyperliquidDirectEnabled, upstreamGet, upstreamPost, UpstreamError, UPSTREAM_HOSTS, wsCollect } from "../src/upstream.js";
import { blockDetails } from "../src/hyperliquid.js";

const realFetch = globalThis.fetch;
const realWs = globalThis.WebSocket;
const savedEnv = process.env[DIRECT_ENV];

function setDirect(on: boolean | string): void {
  if (on === false) delete process.env[DIRECT_ENV];
  else process.env[DIRECT_ENV] = on === true ? "1" : on;
}

beforeEach(() => setDirect(false));
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = realWs;
  if (savedEnv === undefined) delete process.env[DIRECT_ENV];
  else process.env[DIRECT_ENV] = savedEnv;
  clearUpstreamCache();
  clearCache();
});

function mockFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>): { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { calls };
}

test("switch: only '1' or 'true' (any case) enables direct mode", () => {
  for (const v of ["1", "true", "TRUE", " True "]) assert.equal(hyperliquidDirectEnabled({ [DIRECT_ENV]: v }), true, v);
  for (const v of [undefined, "", "0", "false", "yes", "on", "2"]) assert.equal(hyperliquidDirectEnabled({ [DIRECT_ENV]: v }), false, String(v));
});

test("strict mode (default): every upstream host is refused before any I/O", async () => {
  const m = mockFetch([{ status: 200, body: {} }]);
  for (const url of [ENDPOINTS.info, ENDPOINTS.uiInfo, ENDPOINTS.explorer, ENDPOINTS.evm]) {
    await assert.rejects(upstreamPost(url, { type: "allMids" }), (e: unknown) => e instanceof UpstreamError && /mode is off/.test(e.message));
  }
  await assert.rejects(upstreamGet(ENDPOINTS.unitOperations("0x0000000000000000000000000000000000000000")), /mode is off/);
  await assert.rejects(wsCollect({ url: ENDPOINTS.explorerWs, subscriptions: [], durationMs: 10, onMessage: () => {} }), /mode is off/);
  assert.equal(m.calls.length, 0);
});

test("strict mode: the Flowscan client still only contacts www.flowscan.xyz", async () => {
  const m = mockFetch([{ status: 200, body: { ok: true } }]);
  await get("/api/strict-host");
  assert.equal(new URL(m.calls[0]).host, "www.flowscan.xyz");
});

test("direct mode: exactly the four Hyperliquid/Unit hosts are allowed", async () => {
  setDirect(true);
  const m = mockFetch([{ status: 200, body: { ok: 1 } }]);
  await upstreamPost(ENDPOINTS.info, { type: "allMids" });
  await upstreamPost(ENDPOINTS.uiInfo, { type: "portfolio", user: "0x0" });
  await upstreamPost(ENDPOINTS.explorer, { type: "x" }, { ttlMs: 0 });
  await upstreamPost(ENDPOINTS.evm, { jsonrpc: "2.0" });
  await upstreamGet(ENDPOINTS.unitOperations("0x0000000000000000000000000000000000000000"));
  assert.deepEqual([...new Set(m.calls.map((u) => new URL(u).host))].sort(), [...UPSTREAM_HOSTS].sort());
});

test("direct mode: other hosts, schemes, ports and look-alikes are refused without I/O", async () => {
  setDirect(true);
  const m = mockFetch([{ status: 200, body: {} }]);
  const bad = [
    "https://example.com/info",
    "https://hydromancer.xyz/info",
    "https://api.hydromancer.xyz/info",
    "https://www.flowscan.xyz/api/x", // Flowscan traffic goes through src/client.ts only
    "https://api.hyperliquid.xyz.evil.com/info",
    "https://evil.com/api.hyperliquid.xyz/info",
    "https://user@api.hyperliquid.xyz/info",
    "http://api.hyperliquid.xyz/info",
    "https://api.hyperliquid.xyz:8443/info",
    "https://api.hyperliquid-testnet.xyz/info",
    "not a url",
  ];
  for (const url of bad) {
    await assert.rejects(upstreamPost(url, { type: "allMids" }), (e: unknown) => e instanceof UpstreamError, url);
    await assert.rejects(upstreamGet(url), (e: unknown) => e instanceof UpstreamError, url);
  }
  assert.throws(() => assertUpstreamAllowed("wss://rpc.hyperliquid.xyz/ws"), /Refusing wss:/); // https only for HTTP calls
  assert.equal(assertUpstreamAllowed("wss://rpc.hyperliquid.xyz/ws", ["wss:"]).host, "rpc.hyperliquid.xyz");
  assert.throws(() => assertUpstreamAllowed("wss://example.com/ws", ["wss:"]), /allowed upstream hosts/);
  assert.equal(m.calls.length, 0);
});

test("direct mode: HTTP 429 is not retried and carries a wait hint", async () => {
  setDirect(true);
  const m = mockFetch([{ status: 429, body: "rate limited", headers: { "retry-after": "12" } }]);
  await assert.rejects(upstreamPost(ENDPOINTS.info, { type: "l2Book", coin: "BTC" }), (e: unknown) => {
    assert.ok(e instanceof UpstreamError);
    assert.equal(e.status, 429);
    assert.equal(e.retryable, false);
    assert.match(e.message, /Rate limited by api\.hyperliquid\.xyz/);
    assert.match(e.hint ?? "", /12s/);
    assert.equal(e.source, "api.hyperliquid.xyz");
    return true;
  });
  assert.equal(m.calls.length, 1);
});

test("direct mode: other 4xx are not retried; 5xx are", async () => {
  setDirect(true);
  const m4 = mockFetch([{ status: 422, body: "Failed to deserialize" }]);
  await assert.rejects(upstreamPost(ENDPOINTS.info, { type: "bogus" }), (e: unknown) => e instanceof UpstreamError && e.status === 422);
  assert.equal(m4.calls.length, 1);
  const m5 = mockFetch([
    { status: 502, body: "bad gateway" },
    { status: 200, body: { fine: true } },
  ]);
  assert.deepEqual(await upstreamPost(ENDPOINTS.info, { type: "meta" }), { fine: true });
  assert.equal(m5.calls.length, 2);
});

test("explorer error payloads (HTTP 200 {type:'error'}) become 404s and are not cached", async () => {
  setDirect(true);
  const m = mockFetch([
    { status: 200, body: { type: "error", message: "invalid block height: 5" } },
    { status: 200, body: { type: "blockDetails", blockDetails: { height: 5, txs: [] } } },
  ]);
  await assert.rejects(blockDetails(5), (e: unknown) => e instanceof UpstreamError && e.status === 404 && /Block not found/.test(e.message));
  assert.deepEqual(await blockDetails(5), { height: 5, txs: [] });
  assert.equal(m.calls.length, 2);
});

class FakeWs {
  static instances: FakeWs[] = [];
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWs.instances.push(this);
    setTimeout(() => {
      this.onopen?.();
      setTimeout(() => this.onmessage?.({ data: JSON.stringify([{ height: 1 }]) }), 5);
    }, 5);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.closed = true;
  }
}

test("WebSocket: refused hosts never construct a socket; allowed ones subscribe, collect and always close", async () => {
  setDirect(true);
  FakeWs.instances = [];
  globalThis.WebSocket = FakeWs as unknown as typeof WebSocket;
  await assert.rejects(wsCollect({ url: "wss://example.com/ws", subscriptions: [], durationMs: 10, onMessage: () => {} }), UpstreamError);
  await assert.rejects(wsCollect({ url: "wss://hydromancer.xyz/ws", subscriptions: [], durationMs: 10, onMessage: () => {} }), UpstreamError);
  assert.equal(FakeWs.instances.length, 0);

  const got: unknown[] = [];
  const r = await wsCollect({ url: ENDPOINTS.explorerWs, subscriptions: [{ type: "explorerBlock" }, { type: "explorerTxs" }], durationMs: 50, onMessage: (m) => void got.push(m) });
  assert.equal(FakeWs.instances.length, 1);
  const ws = FakeWs.instances[0];
  assert.equal(ws.url, "wss://rpc.hyperliquid.xyz/ws");
  assert.deepEqual(ws.sent.map((s) => JSON.parse(s)), [
    { method: "subscribe", subscription: { type: "explorerBlock" } },
    { method: "subscribe", subscription: { type: "explorerTxs" } },
  ]);
  assert.deepEqual(got, [[{ height: 1 }]]);
  assert.equal(r.ended, "duration");
  assert.equal(ws.closed, true);

  // Early stop via onMessage returning true also closes.
  const r2 = await wsCollect({ url: ENDPOINTS.infoWs, subscriptions: [{ type: "l2Book", coin: "BTC" }], durationMs: 5_000, onMessage: () => true });
  assert.equal(r2.ended, "done");
  assert.equal(FakeWs.instances[1].closed, true);
});

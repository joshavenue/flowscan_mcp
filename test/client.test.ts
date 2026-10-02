import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { clearCache, FlowscanError, get } from "../src/client.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearCache();
});

function mockFetch(responses: Array<{ status: number; body: unknown }>): { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls };
}

test("only www.flowscan.xyz is contacted", async () => {
  const m = mockFetch([{ status: 200, body: { ok: true } }]);
  assert.deepEqual(await get("/api/test-host", { a: 1, skip: undefined }), { ok: true });
  assert.equal(m.calls.length, 1);
  assert.equal(new URL(m.calls[0]).host, "www.flowscan.xyz");
  assert.equal(new URL(m.calls[0]).search, "?a=1");
});

test("4xx is thrown immediately without retries", async () => {
  const m = mockFetch([{ status: 404, body: { error: "Builder not found" } }]);
  await assert.rejects(get("/api/test-404"), (err: unknown) => {
    assert.ok(err instanceof FlowscanError);
    assert.equal(err.status, 404);
    assert.equal(err.message, "Builder not found");
    assert.equal(err.retryable, false);
    return true;
  });
  assert.equal(m.calls.length, 1);
});

test("5xx is retried and can recover", async () => {
  const m = mockFetch([
    { status: 503, body: { error: "busy" } },
    { status: 200, body: { fine: 1 } },
  ]);
  assert.deepEqual(await get("/api/test-503"), { fine: 1 });
  assert.equal(m.calls.length, 2);
});

test("persistent 5xx gives up after the retry budget", async () => {
  const m = mockFetch([{ status: 500, body: "oops" }]);
  await assert.rejects(get("/api/test-500"), (err: unknown) => err instanceof FlowscanError && err.status === 500 && err.retryable);
  assert.equal(m.calls.length, 3);
});

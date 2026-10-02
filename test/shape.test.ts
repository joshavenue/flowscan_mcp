import assert from "node:assert/strict";
import { test } from "node:test";
import { compactAddressLists, MAX_RESULT_CHARS, page, pick, tail, toText } from "../src/shape.js";

test("pick keeps top-level keys and dotted paths, drops the rest", () => {
  const v = { a: 1, b: { c: 2, d: 3 }, e: [1, 2] };
  assert.deepEqual(pick(v, ["a", "b.c"]), { a: 1, b: { c: 2 } });
  assert.deepEqual(pick(v, ["missing", "b.zzz"]), {});
  assert.equal(pick(v, undefined), v);
  assert.equal(pick(v, []), v);
  assert.equal(pick(42, ["a"]), 42);
});

test("page slices with limit/offset and reports paging", () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual(page(items, {}, 3), { items: [0, 1, 2], paging: { total: 10, offset: 0, limit: 3, hasMore: true } });
  assert.deepEqual(page(items, { limit: 4, offset: 8 }, 3), { items: [8, 9], paging: { total: 10, offset: 8, limit: 4, hasMore: false } });
  assert.deepEqual(page([], {}, 5).paging, { total: 0, offset: 0, limit: 5, hasMore: false });
});

test("tail returns the most recent n items", () => {
  assert.deepEqual(tail([1, 2, 3, 4], 2), [3, 4]);
  assert.deepEqual(tail([1, 2], 5), [1, 2]);
  assert.deepEqual(tail([1, 2], undefined), [1, 2]);
});

test("toText returns JSON when small and a marked prefix when too big", () => {
  const small = { x: [1, 2, 3] };
  assert.deepEqual(JSON.parse(toText(small)), small);

  const big = { blob: "y".repeat(MAX_RESULT_CHARS + 1000) };
  const text = toText(big);
  assert.ok(text.includes("[TRUNCATED: response was"), "has truncation marker");
  assert.ok(text.length < MAX_RESULT_CHARS + 500, "capped near the limit");
  assert.ok(text.startsWith("{"), "still starts as JSON");
});

test("compactAddressLists replaces long address arrays only", () => {
  const addrs = Array.from({ length: 12 }, (_, i) => `0x${String(i).padStart(40, "0")}`);
  const out = compactAddressLists({ cohorts: [{ size: 12, user_addresses: addrs, other: [1, 2, 3] }], few: addrs.slice(0, 3) }) as any;
  assert.equal(out.cohorts[0].user_addresses.count, 12);
  assert.equal(out.cohorts[0].user_addresses.sample.length, 5);
  assert.deepEqual(out.cohorts[0].other, [1, 2, 3]);
  assert.equal(out.few.length, 3);
});

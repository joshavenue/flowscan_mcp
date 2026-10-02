import assert from "node:assert/strict";
import { test } from "node:test";
import { compactAddressLists, isValidYmd, MAX_RESULT_CHARS, page, pick, pickRows, tail, toText } from "../src/shape.js";

test("pick keeps top-level keys and dotted paths, drops the rest", () => {
  const v = { a: 1, b: { c: 2, d: 3 }, e: [1, 2] };
  assert.deepEqual(pick(v, ["a", "b.c"]), { a: 1, b: { c: 2 } });
  assert.deepEqual(pick(v, ["missing", "b.zzz"]), { _fieldsNotFound: ["missing", "b.zzz"], _availableFields: ["a", "b", "e"] });
  assert.deepEqual(pick(v, ["a", "nope"]), { a: 1, _fieldsNotFound: ["nope"], _availableFields: ["a", "b", "e"] });
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

  // a single giant string cannot be shortened structurally -> last-resort string cut
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

test("toText shortens the largest arrays and stays valid JSON", () => {
  const big = { meta: { a: 1 }, rows: Array.from({ length: 5000 }, (_, i) => ({ i, pad: "x".repeat(40) })), small: [1, 2, 3] };
  const text = toText(big);
  assert.ok(text.length <= MAX_RESULT_CHARS);
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.meta, { a: 1 });
  assert.deepEqual(parsed.small, [1, 2, 3]);
  assert.ok(parsed.rows.length < 5000 && parsed.rows.length > 100);
  assert.deepEqual(parsed._truncated[0].path, "rows");
  assert.equal(parsed._truncated[0].originalLength, 5000);
  assert.equal(parsed._truncated[0].kept, parsed.rows.length);
  assert.match(parsed._truncatedNote, /TRUNCATED/);
});

test("toText output is compact JSON", () => {
  assert.equal(toText({ a: [1, 2], b: { c: "d" } }), '{"a":[1,2],"b":{"c":"d"}}');
});

test("isValidYmd rejects impossible dates", () => {
  assert.equal(isValidYmd("2026-02-28"), true);
  assert.equal(isValidYmd("2026-02-30"), false);
  assert.equal(isValidYmd("2026-13-45"), false);
  assert.equal(isValidYmd("Sept 1"), false);
});

test("pick accepts a leading data. prefix and walks arrays", () => {
  const v = { generatedAt: 1, activeOutcomes: [{ outcomeId: 1, name: "a" }, { outcomeId: 2, name: "b" }] };
  assert.deepEqual(pick(v, ["data.generatedAt"]), { generatedAt: 1 });
  assert.deepEqual(pick(v, ["activeOutcomes.outcomeId"]), { activeOutcomes: [{ outcomeId: 1 }, { outcomeId: 2 }] });
  assert.deepEqual(pick(v, ["activeOutcomes.outcomeId", "activeOutcomes.name"]), { activeOutcomes: [{ outcomeId: 1, name: "a" }, { outcomeId: 2, name: "b" }] });
});

test("pickRows applies fields per row and reports paths that match no row", () => {
  const rows = [{ coin: "BTC", delta: { usdc: "1" } }, { coin: "ETH" }];
  const { rows: out, report } = pickRows(rows, ["data.coin", "delta.usdc", "nope"]);
  assert.deepEqual(out, [{ coin: "BTC", delta: { usdc: "1" } }, { coin: "ETH" }]);
  assert.deepEqual(report, { _fieldsNotFound: ["nope"], _availableFields: ["coin", "delta"] });
  assert.deepEqual(pickRows(rows, undefined).report, {});
});

test("default result cap is 40k", () => {
  if (!process.env.FLOWSCAN_MAX_RESULT_CHARS) assert.equal(MAX_RESULT_CHARS, 40_000);
});

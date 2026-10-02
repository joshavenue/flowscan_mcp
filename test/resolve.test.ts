import assert from "node:assert/strict";
import { test } from "node:test";
import { dexPrefixes, findDex } from "../src/dex.js";
import { resolveBuilder, type BuilderEntry } from "../src/tools/builderDirectory.js";

const entry = (id: string, name: string, address: string | null, allTime: number): BuilderEntry => ({
  id,
  name,
  category: null,
  address,
  revenue: { all_time: allTime },
  volume: null,
  total_users: 1,
  intelligenceTracked: false,
});
const BIG = "0x2a2b6b093a9813fbd8cddae800c3d17d46460d17";
const SMALL = "0xb838e4d1c8bcf71fa8e63299d5aa3258c83d6adb";
const dir = [entry(BIG, "fomo", BIG, 2_000_000), entry("fomo", "FOMO", SMALL, 25_000), entry("phantom", "Phantom", "0xb84168cf3be63c6b8dad05ff5d755e97432ff80b", 1)];

test("a name shared by two builders is ambiguous", () => {
  const r = resolveBuilder(dir, "fomo");
  assert.equal(r.status, "ambiguous");
});

test("id: prefix matches ids only", () => {
  const r = resolveBuilder(dir, "id:fomo");
  assert.ok(r.status === "resolved" && r.builder.address === SMALL);
});

test("addresses resolve, including a slug builder's mapped address", () => {
  const r = resolveBuilder(dir, SMALL.toUpperCase().replace("0X", "0x"));
  assert.ok(r.status === "resolved" && r.builder.id === "fomo");
  const u = resolveBuilder(dir, "0x" + "1".repeat(40));
  assert.ok(u.status === "resolved" && u.via === "unlisted-address");
});

test("unique names resolve case-insensitively", () => {
  const r = resolveBuilder(dir, "PHANTOM");
  assert.ok(r.status === "resolved" && r.builder.id === "phantom");
  assert.equal(resolveBuilder(dir, "nothing-like-this").status, "notFound");
});

test("HIP-3 dex aliases map display names and prefixes", () => {
  assert.equal(findDex("KM")?.prefix, "mkts");
  assert.equal(findDex("km")?.name, "KM");
  assert.equal(findDex("Paragon")?.prefix, "para");
  assert.equal(findDex("io")?.name, "Entropy");
  assert.deepEqual(dexPrefixes("KM"), ["mkts", "km"]);
  assert.equal(findDex("nope"), undefined);
});

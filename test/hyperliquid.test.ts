import assert from "node:assert/strict";
import { test } from "node:test";
import { actionAssetIds, assetName, deriveCandleWindow, downsample, formatUnits, INTERVAL_MS, summarizeAction, weiToHype, type AssetNames } from "../src/hyperliquid.js";

test("weiToHype: exact 18-decimal conversion from eth_getBalance hex", () => {
  assert.deepEqual(weiToHype("0x0"), { wei: "0", hype: "0", hypeFloat: 0 });
  assert.deepEqual(weiToHype("0x"), { wei: "0", hype: "0", hypeFloat: 0 });
  assert.deepEqual(weiToHype("0xde0b6b3a7640000"), { wei: "1000000000000000000", hype: "1", hypeFloat: 1 });
  assert.equal(weiToHype("0x694d470666400").hype, "0.00185249");
  const big = weiToHype("0x7ce42ffacad2b9a8"); // 8999370709584230824 wei
  assert.equal(big.wei, "8999370709584230824");
  assert.equal(big.hype, "8.999370709584230824");
  assert.ok(Math.abs(big.hypeFloat - 8.999370709584231) < 1e-12);
  assert.equal(weiToHype("0x1").hype, "0.000000000000000001");
  assert.throws(() => weiToHype("123"), /hex/);
});

test("formatUnits handles negatives and zero decimals", () => {
  assert.equal(formatUnits(-150000000n, 8), "-1.5");
  assert.equal(formatUnits(42n, 0), "42");
});

test("candle window: start = end - bars * interval unless startTime given", () => {
  const end = 1_790_000_000_000;
  assert.deepEqual(deriveCandleWindow({ interval: "1h", bars: 100, endTime: end }), { startTime: end - 100 * 3_600_000, endTime: end, bars: 100 });
  assert.equal(deriveCandleWindow({ interval: "15m", endTime: end }).startTime, end - 100 * 15 * 60_000); // default 100 bars
  assert.equal(deriveCandleWindow({ interval: "1M", bars: 2, endTime: end }).startTime, end - 2 * 30 * 86_400_000); // Flowscan: month = 30d
  assert.equal(deriveCandleWindow({ interval: "1w", bars: 3, now: end }).startTime, end - 21 * 86_400_000);
  assert.equal(deriveCandleWindow({ interval: "1d", bars: 5, startTime: end - 1000, endTime: end }).startTime, end - 1000);
  assert.throws(() => deriveCandleWindow({ interval: "1d", startTime: end, endTime: end }), /before endTime/);
  assert.equal(Object.keys(INTERVAL_MS).length, 14);
});

test("downsample keeps first and last and caps the length", () => {
  const xs = Array.from({ length: 1000 }, (_, i) => i);
  const d = downsample(xs, 200);
  assert.equal(d.length, 200);
  assert.equal(d[0], 0);
  assert.equal(d[199], 999);
  assert.deepEqual(downsample([1, 2, 3], 200), [1, 2, 3]);
});

const NAMES: AssetNames = {
  perp: [{ name: "BTC" }, { name: "ETH" }],
  spot: { universe: [{ name: "@702", index: 702, tokens: [845, 0] }], tokens: [{ name: "USDC", index: 0 }, { name: "NVDAX", index: 845 }] },
  allPerp: [{ universe: [{ name: "BTC" }] }, { universe: Array.from({ length: 30 }, (_, i) => ({ name: i === 26 ? "xyz:SILVER" : `xyz:M${i}` })) }],
};

test("asset ids: perp index, spot 10000+pair, HIP-3 100000+dex*10000+i, unknown fallback", () => {
  assert.deepEqual(assetName(1, NAMES), { name: "ETH", market: "perp" });
  assert.deepEqual(assetName(10702, NAMES), { name: "NVDAX", market: "spot" });
  assert.deepEqual(assetName(110026, NAMES), { name: "xyz:SILVER", market: "hip3" });
  assert.deepEqual(assetName(77, NAMES), { name: "Asset 77", market: "unknown" });
});

test("action summary mirrors the homepage Action / Details column", () => {
  const order = { type: "order", orders: [{ a: 110026, b: false, p: "61.067", s: "33.76", r: false, t: { limit: { tif: "Alo" } } }], grouping: "na" };
  assert.deepEqual(actionAssetIds(order), [110026]);
  const s = summarizeAction(order, NAMES);
  assert.equal(s.summary, "Order • xyz:SILVER • Short $2,061.62 (33.76 @ 61.067)");
  assert.equal(s.side, "sell");
  assert.equal(s.notionalUsd, 2061.62);
  assert.equal(summarizeAction({ type: "cancel", cancels: [{ a: 0, o: 1 }, { a: 0, o: 2 }] }, NAMES).summary, "Cancel Order • BTC • 2 orders");
  assert.equal(summarizeAction({ type: "usdClassTransfer", amount: "5", toPerp: true }, NAMES).summary, "Transfer to Perp • to Perp • $5");
  assert.equal(summarizeAction({ type: "evmRawTx", data: "0xabcd" }, NAMES).summary, "EVM Raw Tx");
  assert.equal(summarizeAction({ type: "tokenDelegate", validator: "0xv", wei: 150000000, isUndelegate: false }, NAMES).amountHype, "1.5");
  assert.equal(summarizeAction({ type: "somethingNew" }, NAMES).summary, "somethingNew");
});

# QA scenarios

Agent-style scenario tests for flowscan-mcp against the live www.flowscan.xyz.
They run the server from source, so they always test the current `src/`.

```sh
npx tsx scripts/qa/scenarios.ts                  # strict mode: scenarios 1-27 (~30 s)
npx tsx scripts/qa/scenarios.ts --only 1,5,26    # a subset
npx tsx scripts/qa/scenarios.ts --json out.json  # also write results as JSON
npx tsx scripts/qa/scenarios.ts --upstream       # Hyperliquid-direct mode: scenarios 101-106
```

The two modes are separate runs:

- The default run spawns the server with `FLOWSCAN_HYPERLIQUID_DIRECT` forced off (even if your shell sets it), runs scenarios 1-27, and exits 1 if any host other than `www.flowscan.xyz` is contacted.
- `--upstream` spawns it with `FLOWSCAN_HYPERLIQUID_DIRECT=1`, runs only the direct-mode scenarios (101-106), and allows exactly `www.flowscan.xyz`, `api.hyperliquid.xyz`, `rpc.hyperliquid.xyz`, `api-ui.hyperliquid.xyz` and `api.hyperunit.xyz`. Scenario 101 (`flowscan_live_feed`) uses a WebSocket, so run it on Node 22 or newer.

Direct-mode scenarios:

| id | scenario |
| --- | --- |
| 101 | "What are the latest blocks?" via `flowscan_live_feed` |
| 102 | Block lookup: `flowscan_block` field by field against the raw `blockDetails` response (header, success rate, breakdown, tx table) |
| 103 | Tx lookup: `flowscan_transaction` field by field against the raw `txDetails` response (uses a tx from 102) |
| 104 | "What is the HYPE price?" via `flowscan_prices` |
| 105 | Candles: BTC 1h, last 24 bars, against the raw `candleSnapshot` response |
| 106 | Direct-mode hygiene: 58 tools (44 + 14), coverage in direct mode, 8 parallel direct calls (prices, spot tokens, perp DEXs, validator summaries, reserves, portfolio, EVM balance, Unit operations) all succeed, upstream concurrency at most 2, every result has `source`, `shownOn` and `mode` |

Scenarios 101-103 pass state forward (a block height, then a tx hash), so run them together.

This harness is deliberately not wired into `package.json`. Invoke it with `npx tsx` as shown above.

How it works:

- `lib.ts` spawns `npx tsx src/index.ts` over stdio with the MCP SDK client. It preloads `fetch-spy.mjs` through `NODE_OPTIONS=--import`. The spy wraps `fetch` and `WebSocket` and logs every outbound request's host to stderr, including WebSocket connections (`group=ws`). In-flight counts are kept per group: `flowscan` (www.flowscan.xyz, limited by `FLOWSCAN_MAX_CONCURRENCY`, default 4) and `upstream` (the allowlisted Hyperliquid/Unit hosts, limit 2). The harness uses this to check which hosts are contacted, that each group's concurrency limit is respected, and that errors are not retried.
- Ground truth for direct-mode scenarios comes from calling the same upstream request directly (`rawUpstream()` in `lib.ts`).
- Ground truth comes from the raw Flowscan routes (`raw()` in `lib.ts`). It is fetched at test time, so the checks follow live data. Scenario 1 pins one fixed historical figure: FOMO (0x2a2b...) revenue for 2026-08-18..2026-10-01 = 1,649,115.56 USD.
- Each check is either **MUST** or **SHOULD**. A MUST check covers correctness, and any MUST failure makes the run exit 1. A SHOULD check covers a usability or output-quality fix recommended in the QA report and is reported as `warn`. When a fix lands, its SHOULD check turns `ok`.
- The run also exits 1 if any host outside the mode's allowlist is contacted.

Ad-hoc helpers:

- `npx tsx scripts/qa/explore.ts '[["flowscan_builder_lookup",{"query":"fomo"}]]' 3000` calls tools and prints the size, time, fetch count, hosts and the first N chars.
- `npx tsx scripts/qa/explore-tail.ts '<same>' 800 600` prints the head and tail of each result, which is useful for checking truncation.
- `npx tsx scripts/qa/list-tools.ts [--full]` prints each tool with its required params and description size.

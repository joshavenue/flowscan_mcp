# QA scenarios

Agent-style scenario tests for flowscan-mcp against the live www.flowscan.xyz.
They run the server from source, so they always test the current `src/`.

```sh
npx tsx scripts/qa/scenarios.ts                  # all 27 scenarios (~30 s)
npx tsx scripts/qa/scenarios.ts --only 1,5,26    # a subset
npx tsx scripts/qa/scenarios.ts --json out.json  # also write results as JSON
```

This harness is deliberately not wired into `package.json`. Invoke it with `npx tsx` as shown above.

How it works:

- `lib.ts` spawns `npx tsx src/index.ts` over stdio with the MCP SDK client. It preloads `fetch-spy.mjs` through `NODE_OPTIONS=--import`, and that spy logs every outbound request's host and the number of requests in flight to stderr. The harness uses this to check that only `www.flowscan.xyz` is contacted, that `FLOWSCAN_MAX_CONCURRENCY` (default 4) is respected, and that errors are not retried.
- Ground truth comes from the raw Flowscan routes (`raw()` in `lib.ts`). It is fetched at test time, so the checks follow live data. Scenario 1 pins one fixed historical figure: FOMO (0x2a2b...) revenue for 2026-08-18..2026-10-01 = 1,649,115.56 USD.
- Each check is either **MUST** or **SHOULD**. A MUST check covers correctness, and any MUST failure makes the run exit 1. A SHOULD check covers a usability or output-quality fix recommended in the QA report and is reported as `warn`. When a fix lands, its SHOULD check turns `ok`.
- The run also exits 1 if any host other than `www.flowscan.xyz` is contacted.

Ad-hoc helpers:

- `npx tsx scripts/qa/explore.ts '[["flowscan_builder_lookup",{"query":"fomo"}]]' 3000` calls tools and prints the size, time, fetch count, hosts and the first N chars.
- `npx tsx scripts/qa/explore-tail.ts '<same>' 800 600` prints the head and tail of each result, which is useful for checking truncation.
- `npx tsx scripts/qa/list-tools.ts [--full]` prints each tool with its required params and description size.

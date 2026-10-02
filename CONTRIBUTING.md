# Contributing

## How the routes were found

Flowscan has no public API documentation. The routes this server uses were found by reading the site's Next.js JavaScript bundles (`/_next/static/chunks/*.js` on www.flowscan.xyz) and the `fetch` calls each page makes, then calling those `/api/*` routes directly to confirm the request shape (GET query parameters, or the POST JSON body such as `{"type": "hypercoreFeeSummary"}`) and the response shape. The browser's network tab on each page shows the same calls.

Because the routes are undocumented, they can change without notice. When one breaks, the tool returns an error naming the route; fix it by re-checking what the page now requests.

## Network rules

There are two network clients, and no other module may call `fetch` or open a WebSocket:

- `src/client.ts` (`get`/`post`): talks only to `https://www.flowscan.xyz`. Its host guard refuses every other URL, so `FLOWSCAN_BASE_URL` cannot redirect it. This is the only client the default (strict) mode uses.
- `src/upstream.ts` (`upstreamGet`/`upstreamPost`/`wsCollect`): used only by the opt-in Hyperliquid-direct tools. It refuses every request unless `FLOWSCAN_HYPERLIQUID_DIRECT` is `1`/`true`, and then allows only `api.hyperliquid.xyz`, `rpc.hyperliquid.xyz`, `api-ui.hyperliquid.xyz` and `api.hyperunit.xyz` over `https://`/`wss://` on the default port. The request bodies live in `src/hyperliquid.ts`.

Rules for new tools:

- A strict-mode tool must get its data from a `www.flowscan.xyz` route.
- A direct-mode tool may only make a request that the Flowscan page itself makes in the browser, with the same body or WebSocket subscription. Show where that request is in Flowscan's JavaScript bundle (file and the code that builds it) in the pull request and in a comment next to the helper in `src/hyperliquid.ts`. Do not add hosts to `UPSTREAM_HOSTS` unless the Flowscan page contacts them.
- Never add Hydromancer or any other host. Data the Flowscan page does not show does not belong in this server.

## Adding a tool

1. Add it to the matching file in `src/tools/` with `defineTool` (from `src/register.ts`). Accept the standard `fields`/`limit`/`offset` inputs from `src/shape.ts` when the result can be large. Wrap a Flowscan result with `envelope(route, data)`; wrap a direct-mode result with `upstreamEnvelope(upstreamUrl, flowscanPageUrl, data, { request })` and add the tool name to `DIRECT_TOOLS` in `src/tools/direct.ts`.
2. Say in the description which Flowscan page the data mirrors and when to prefer this tool. Do not add a "Source: ..." sentence; the route is reported in the `source` field of every result.
3. Add the tool to its page in `src/coverage.ts` (direct-mode tools only in the `direct` branch, and remove the item from that mode's `notServed`).
4. Add it to the right tools table in `README.md` (strict tools, or "Hyperliquid-direct tools") and, if it answers a common question, to `skills/flowscan/SKILL.md`.
5. Add a call to the smoke test in `scripts/smoke.ts` (it fails if any tool is untested; direct tools go in `directCases`), and a scenario in `scripts/qa/scenarios.ts` if the tool answers a typical agent question (direct-mode scenarios are marked `upstream: true` and numbered from 101).

## Checks

All of these must pass before a change is merged:

```sh
npm install
npm run typecheck
npm run build
npm test                          # offline unit tests (test/)
npm run smoke                     # live: calls every tool against www.flowscan.xyz using dist/, so build first
npx tsx scripts/qa/scenarios.ts   # live: agent-style QA scenarios, run from src/

# Hyperliquid-direct mode (needs Node 22 for the WebSocket tools)
FLOWSCAN_HYPERLIQUID_DIRECT=1 npm run smoke     # smoke test, also calls the 14 direct-mode tools
npx tsx scripts/qa/scenarios.ts --upstream      # direct-mode scenarios 101-106
```

The QA harness is described in `scripts/qa/README.md`. It runs the server from source over stdio, compares answers with the raw Flowscan routes, checks that no host other than www.flowscan.xyz is contacted (with `--upstream`: www.flowscan.xyz plus the four allowlisted hosts), that the concurrency limits hold and that errors are not retried. Any MUST failure, or any other host being contacted, makes it exit 1; SHOULD checks are reported as warnings. Use `--only 1,5` to run a subset and `--json out.json` to save results. It is deliberately not an npm script.

The smoke test and the QA scenarios need network access and depend on the live site, so CI does not run them on every push. To run them in GitHub Actions, open the CI workflow in the Actions tab and use "Run workflow"; that starts the `smoke` job, which runs both in strict mode. Run the direct-mode checks locally.

## Model-in-the-loop eval

For changes to tool descriptions, output shapes or `skills/flowscan/SKILL.md`, also re-run the eval in `scripts/eval/` (a Sonnet agent answers 220 prompts with only these tools; an Opus judge grades them). It needs the `claude` CLI and costs about $16 per full run, so it is not part of CI. `scripts/eval/system.md` is a copy of the skill body: regenerate it after editing the skill (the command is in `scripts/eval/README.md`), then run under a new `--run-id` and compare with `scripts/eval/results/full/REPORT.md`. Keep the rules that came out of the first run: tools return totals so the agent never adds rows, `fields` misses are reported, and results stay under the 40,000-character default cap.

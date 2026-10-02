# Contributing

## How the routes were found

Flowscan has no public API documentation. The routes this server uses were found by reading the site's Next.js JavaScript bundles (`/_next/static/chunks/*.js` on www.flowscan.xyz) and the `fetch` calls each page makes, then calling those `/api/*` routes directly to confirm the request shape (GET query parameters, or the POST JSON body such as `{"type": "hypercoreFeeSummary"}`) and the response shape. The browser's network tab on each page shows the same calls.

Because the routes are undocumented, they can change without notice. When one breaks, the tool returns an error naming the route; fix it by re-checking what the page now requests.

## Rule for new tools

Add a tool only if its data comes from a `www.flowscan.xyz` route. Do not add calls to `api.hyperliquid.xyz`, `rpc.hyperliquid.xyz`, Hydromancer or any other host, even when the Flowscan page itself loads that data from there in the browser (block and tx details, prices, candles and similar). Those belong in the "Not covered" section of the README instead.

All network I/O goes through `get`/`post` in `src/client.ts`. Do not call `fetch` elsewhere.

## Adding a tool

1. Add it to the matching file in `src/tools/` with `defineTool` (from `src/register.ts`). Accept the standard `fields`/`limit`/`offset` inputs from `src/shape.ts` when the result can be large, and wrap the result with `envelope(route, data)`.
2. Say in the description which Flowscan page the data mirrors and when to prefer this tool. Do not add a "Source: ..." sentence; the route is reported in the `source` field of every result.
3. Add the tool to its page in `src/coverage.ts`.
4. Add it to the tools table in `README.md` and, if it answers a common question, to `skills/flowscan/SKILL.md`.
5. Add a call to the smoke test in `scripts/smoke.ts` (it fails if any tool is untested), and a scenario in `scripts/qa/scenarios.ts` if the tool answers a typical agent question.

## Checks

All of these must pass before a change is merged:

```sh
npm install
npm run typecheck
npm run build
npm test                          # offline unit tests (test/)
npm run smoke                     # live: calls every tool against www.flowscan.xyz using dist/, so build first
npx tsx scripts/qa/scenarios.ts   # live: agent-style QA scenarios, run from src/
```

The QA harness is described in `scripts/qa/README.md`. It runs the server from source over stdio, compares answers with the raw Flowscan routes, checks that no host other than www.flowscan.xyz is contacted, that the concurrency limit holds and that errors are not retried. Any MUST failure, or any other host being contacted, makes it exit 1; SHOULD checks are reported as warnings. Use `--only 1,5` to run a subset and `--json out.json` to save results. It is deliberately not an npm script.

The smoke test and the QA scenarios need network access and depend on the live site, so CI does not run them on every push. To run them in GitHub Actions, open the CI workflow in the Actions tab and use "Run workflow"; that starts the `smoke` job, which runs both.

## Model-in-the-loop eval

For changes to tool descriptions, output shapes or `skills/flowscan/SKILL.md`, also re-run the eval in `scripts/eval/` (a Sonnet agent answers 220 prompts with only these tools; an Opus judge grades them). It needs the `claude` CLI and costs about $16 per full run, so it is not part of CI. `scripts/eval/system.md` is a copy of the skill body: regenerate it after editing the skill (the command is in `scripts/eval/README.md`), then run under a new `--run-id` and compare with `scripts/eval/results/full/REPORT.md`. Keep the rules that came out of the first run: tools return totals so the agent never adds rows, `fields` misses are reported, and results stay under the 40,000-character default cap.

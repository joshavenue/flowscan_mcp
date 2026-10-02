# Contributing

## How the routes were found

Flowscan has no public API documentation. The routes this server uses were found by reading the site's Next.js JavaScript bundles (`/_next/static/chunks/*.js` on www.flowscan.xyz) and the `fetch` calls each page makes, then calling those `/api/*` routes directly to confirm the request shape (GET query parameters, or the POST JSON body such as `{"type": "hypercoreFeeSummary"}`) and the response shape. The browser's network tab on each page shows the same calls.

Because the routes are undocumented, they can change without notice. When one breaks, the tool returns an error naming the route; fix it by re-checking what the page now requests.

## Rule for new tools

Add a tool only if its data comes from a `www.flowscan.xyz` route. Do not add calls to `api.hyperliquid.xyz`, `rpc.hyperliquid.xyz`, Hydromancer or any other host, even when the Flowscan page itself loads that data from there in the browser (block and tx details, prices, candles and similar). Those belong in the "Not covered" section of the README instead.

All network I/O goes through `get`/`post` in `src/client.ts`. Do not call `fetch` elsewhere.

## Adding a tool

1. Add it to the matching file in `src/tools/` with `defineTool` (from `src/register.ts`). Accept the standard `fields`/`limit`/`offset` inputs from `src/shape.ts` when the result can be large, and wrap the result with `envelope(route, data)`.
2. Mention the Flowscan page and the route in the description, as the existing tools do.
3. Add the tool to its page in `src/coverage.ts`.
4. Add it to the tools table in `README.md` and, if it answers a common question, to `skills/flowscan/SKILL.md`.
5. Add a call to the smoke test in `scripts/smoke.ts`.

## Checks

```sh
npm install
npm run typecheck
npm run build
npm test           # offline unit tests
npm run smoke      # live: calls www.flowscan.xyz
```

The smoke test needs network access and depends on the live site, so CI does not run it on every push. To run it in GitHub Actions, open the CI workflow in the Actions tab and use "Run workflow"; that starts the `smoke` job.

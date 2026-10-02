# Cross-client protocol tests

What breaks in practice between MCP servers and non-Claude clients is protocol-level:
transports, session handling, schema dialects, prompts/resources support, environment
passing. These probes drive the built server with real client libraries, without any
model or API key, and fail (non-zero exit) if anything does not work.

```bash
npm run build
npm run clients                                   # all probes, rewrites RESULTS.md
npm run clients -- --only python-sdk,langchain    # a subset (RESULTS.md untouched)
FLOWSCAN_HYPERLIQUID_DIRECT=1 npm run clients -- --no-write
```

`run-all.ts` starts one `node dist/index.js --http --port 0` server for the HTTP
transports; every probe also spawns its own stdio server. Each probe prints one
`RESULT {...}` JSON line per transport.

| folder | client | transports |
|---|---|---|
| [inspector](inspector/) | MCP Inspector CLI (`npx @modelcontextprotocol/inspector --cli`) | stdio, Streamable HTTP |
| [python-sdk](python-sdk/) | official MCP Python SDK, 2.x and last 1.x | stdio, Streamable HTTP |
| [openai-agents](openai-agents/) | OpenAI Agents SDK (`MCPServerStdio`, `MCPServerStreamableHttp`) | stdio, Streamable HTTP |
| [langchain](langchain/) | `langchain-mcp-adapters` `MultiServerMCPClient` | stdio, Streamable HTTP |
| [vercel-ai-sdk](vercel-ai-sdk/) | Vercel AI SDK MCP client (`@ai-sdk/mcp`) | stdio, Streamable HTTP, legacy SSE |

Every probe: lists tools, calls `flowscan_coverage` and `flowscan_builder_lookup
{query: "fomo"}` (live www.flowscan.xyz), gets the `flowscan_guide` prompt and reads a
`flowscan://` resource.

Requirements: network (npm, PyPI, www.flowscan.xyz), `python3` (with `uv` if available,
else venv + pip), `npx`. Installs are cached in `node_modules/.cache/flowscan-clients/`
(override with `FLOWSCAN_CLIENTS_CACHE`). Versions are pinned in each `run.sh` and can
be overridden with the env var named there.

Latest results: [RESULTS.md](RESULTS.md).

Schema-level conformance (JSON Schema drafts, OpenAI/Gemini rules) is a separate,
offline check: `npm run conformance` (scripts/conformance.ts).

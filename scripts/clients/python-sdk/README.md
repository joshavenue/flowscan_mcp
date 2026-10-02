# Official MCP Python SDK

Proves a non-TypeScript client works. `client.py` connects to flowscan-mcp over
**stdio** (spawning `node dist/index.js`) and over **Streamable HTTP**
(`$FLOWSCAN_MCP_URL`), then lists tools, calls `flowscan_coverage` and
`flowscan_builder_lookup {query: "fomo"}`, gets the `flowscan_guide` prompt and
reads the `flowscan://guide` resource. No model and no API key are involved.

```bash
npm run build
node dist/index.js --http --port 8787 &          # or let `npm run clients` start it
FLOWSCAN_MCP_URL=http://127.0.0.1:8787/mcp scripts/clients/python-sdk/run.sh
```

The venv is created under `node_modules/.cache/flowscan-clients/` (uv if available,
else `python3 -m venv` + pip). It runs twice: on mcp 2.x and on the last 1.x release (override with `MCP_PY_REQS="mcp==X mcp==Y"`).
Exit status is non-zero if any transport fails.

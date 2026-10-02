# MCP Inspector CLI

`probe.mjs` runs `npx @modelcontextprotocol/inspector --cli` once per method, over stdio
(`node dist/index.js`) and Streamable HTTP (`--transport http --server-url $FLOWSCAN_MCP_URL`):

- `tools/list` (and checks no `$schema` is left in any input schema)
- `prompts/list`, `prompts/get --prompt-name flowscan_guide`
- `resources/list`, `resources/read --uri flowscan://coverage`
- `tools/call --tool-name flowscan_coverage --tool-arg topic=builders`
- `tools/call --tool-name flowscan_builder_lookup --tool-arg query=fomo`

Raw outputs are saved to `$OUT_DIR` (default `node_modules/.cache/flowscan-clients/inspector-out/`).

```bash
FLOWSCAN_MCP_URL=http://127.0.0.1:8787/mcp scripts/clients/inspector/run.sh
# or by hand:
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
npx @modelcontextprotocol/inspector --cli --transport http --server-url http://127.0.0.1:8787/mcp --method prompts/get --prompt-name flowscan_guide
```

Inspector 2.9 spawns stdio servers with a minimal environment; pass `-e KEY=VALUE`
(after the server command) for proxy/CA variables. Override the version with
`INSPECTOR_VERSION`.

# OpenAI Agents SDK (Python)

`client.py` opens flowscan-mcp with `MCPServerStdio` and `MCPServerStreamableHttp`,
calls `list_tools()`, converts every MCP tool into the `FunctionTool` the Agents SDK
would send to the Responses API (non-strict, the SDK default) and checks each input
schema with `ensure_strict_json_schema` (what `convert_schemas_to_strict=True` uses),
then calls `flowscan_builder_lookup` and `flowscan_coverage` directly and reads the
`flowscan_guide` prompt and `flowscan://coverage` resource.

No OpenAI API key is needed for any of this (`run.sh` sets a dummy `OPENAI_API_KEY`
so nothing could reach the real API by accident). Running an actual agent would need a key.

```bash
FLOWSCAN_MCP_URL=http://127.0.0.1:8787/mcp scripts/clients/openai-agents/run.sh
```

Override the version with `OPENAI_AGENTS_REQ="openai-agents==X"`.

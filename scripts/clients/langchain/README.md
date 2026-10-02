# LangChain MCP adapters (Python)

`client.py` builds a `MultiServerMCPClient` with a stdio connection and a
`streamable_http` connection, calls `get_tools()` for each, invokes
`flowscan_builder_lookup` and `flowscan_coverage` through the LangChain tool objects
(`ainvoke`, no model), loads the `flowscan_guide` prompt and the `flowscan://guide`
resource.

```bash
FLOWSCAN_MCP_URL=http://127.0.0.1:8787/mcp scripts/clients/langchain/run.sh
```

Note: `langchain-mcp-adapters` 0.3.1 declares `mcp>=1.24` but fails to import with
mcp 2.x (`mcp.shared.context.RequestContext` was removed), so `run.sh` pins `mcp<2`.
Override with `LANGCHAIN_MCP_REQ="langchain-mcp-adapters==X mcp==Y"`.

#!/usr/bin/env bash
# LangChain MCP adapters (https://pypi.org/project/langchain-mcp-adapters/): MultiServerMCPClient over stdio + Streamable HTTP.
source "$(dirname "$0")/../_common.sh"
# 0.3.1 declares mcp>=1.24 but imports mcp.shared.context.RequestContext, removed in mcp 2.x: pin mcp 1.x.
PY=$(py_env langchain ${LANGCHAIN_MCP_REQ:-langchain-mcp-adapters==0.3.1 "mcp>=1.24,<2"})
exec "$PY" "$CLIENTS_DIR/langchain/client.py"

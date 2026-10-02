#!/usr/bin/env bash
# OpenAI Agents SDK for Python (https://pypi.org/project/openai-agents/): MCPServerStdio + MCPServerStreamableHttp.
source "$(dirname "$0")/../_common.sh"
PY=$(py_env openai-agents "${OPENAI_AGENTS_REQ:-openai-agents==0.22.3}")
# Constructing MCP servers and converting tools needs no key; set a dummy so nothing ever tries a real one.
OPENAI_API_KEY="${OPENAI_API_KEY:-sk-not-used}" exec "$PY" "$CLIENTS_DIR/openai-agents/client.py"

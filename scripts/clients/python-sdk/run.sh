#!/usr/bin/env bash
# Official MCP Python SDK (https://pypi.org/project/mcp/): stdio + Streamable HTTP, on the 2.x line and the last 1.x.
source "$(dirname "$0")/../_common.sh"
status=0
for req in ${MCP_PY_REQS:-mcp==2.2.0 mcp==1.30.0}; do
  PY=$(py_env "python-sdk-${req//[^a-zA-Z0-9.]/_}" "$req")
  "$PY" "$CLIENTS_DIR/python-sdk/client.py" || status=1
done
exit $status

# Shared helpers for scripts/clients/*/run.sh (sourced, not executed).
# Inputs (set by run-all.ts, or by hand):
#   FLOWSCAN_MCP_URL    Streamable HTTP endpoint of a running server, e.g. http://127.0.0.1:8787/mcp
#   FLOWSCAN_MCP_NODE   node binary used to spawn the stdio server (default: node)
#   FLOWSCAN_MCP_ENTRY  stdio server entry point (default: <repo>/dist/index.js)
set -euo pipefail
CLIENTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$CLIENTS_DIR/../.." && pwd)"
export FLOWSCAN_MCP_NODE="${FLOWSCAN_MCP_NODE:-$(command -v node)}"
export FLOWSCAN_MCP_ENTRY="${FLOWSCAN_MCP_ENTRY:-$REPO_ROOT/dist/index.js}"
CACHE_DIR="${FLOWSCAN_CLIENTS_CACHE:-$REPO_ROOT/node_modules/.cache/flowscan-clients}"
mkdir -p "$CACHE_DIR"

# py_env <name> <pip requirement>...: create/reuse a venv and print its python path.
py_env() {
  local name="$1"; shift
  local venv="$CACHE_DIR/venv-$name"
  local stamp="$venv/.reqs"
  if [[ ! -x "$venv/bin/python" || "$(cat "$stamp" 2>/dev/null)" != "$*" ]]; then
    rm -rf "$venv"
    if command -v uv >/dev/null 2>&1; then
      uv venv -q "$venv" >&2 && VIRTUAL_ENV="$venv" uv pip install -q "$@" >&2
    else
      python3 -m venv "$venv" >&2 && "$venv/bin/pip" install -q "$@" >&2
    fi
    echo "$*" > "$stamp"
  fi
  echo "$venv/bin/python"
}

# node_env <name> <npm package@version>...: install into a private prefix and print its path.
node_env() {
  local name="$1"; shift
  local dir="$CACHE_DIR/node-$name"
  local stamp="$dir/.reqs"
  if [[ ! -d "$dir/node_modules" || "$(cat "$stamp" 2>/dev/null)" != "$*" ]]; then
    rm -rf "$dir" && mkdir -p "$dir"
    echo '{"name":"flowscan-client-probe","private":true,"type":"module"}' > "$dir/package.json"
    (cd "$dir" && npm install -s --no-audit --no-fund "$@" >&2)
    echo "$*" > "$stamp"
  fi
  echo "$dir"
}

: "${FLOWSCAN_MCP_URL:?set FLOWSCAN_MCP_URL to the /mcp endpoint of a running server (npm run clients does this)}"

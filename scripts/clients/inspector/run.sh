#!/usr/bin/env bash
# MCP Inspector CLI (https://github.com/modelcontextprotocol/inspector): tools/prompts/resources over stdio + Streamable HTTP.
source "$(dirname "$0")/../_common.sh"
export OUT_DIR="${OUT_DIR:-$CACHE_DIR/inspector-out}"
exec node "$CLIENTS_DIR/inspector/probe.mjs"

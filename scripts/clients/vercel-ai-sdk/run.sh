#!/usr/bin/env bash
# Vercel AI SDK (https://ai-sdk.dev) MCP client: stdio, Streamable HTTP and legacy SSE, tools executed without a model.
# Since AI SDK 6 the MCP client lives in @ai-sdk/mcp (createMCPClient, also exported as experimental_createMCPClient).
source "$(dirname "$0")/../_common.sh"
DIR=$(node_env vercel-ai-sdk ${AI_SDK_PKGS:-ai@7.0.127 @ai-sdk/mcp@2.0.66})
cp "$CLIENTS_DIR/vercel-ai-sdk/client.mjs" "$DIR/client.mjs"
exec node "$DIR/client.mjs"

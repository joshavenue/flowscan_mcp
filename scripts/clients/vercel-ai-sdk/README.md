# Vercel AI SDK (TypeScript)

`client.mjs` creates an AI SDK MCP client three times (stdio via
`Experimental_StdioMCPTransport`, `{type: "http"}` Streamable HTTP, `{type: "sse"}`
legacy SSE on `/sse`), gets `await client.tools()` (the tool set `generateText` /
`streamText` would receive) and executes `flowscan_builder_lookup` and
`flowscan_coverage` directly with `tool.execute(...)`: no model, no key. It also calls
`experimental_listPrompts`, `experimental_getPrompt` and `readResource`.

```bash
FLOWSCAN_MCP_URL=http://127.0.0.1:8787/mcp scripts/clients/vercel-ai-sdk/run.sh
```

Since AI SDK 6 the MCP client is the `@ai-sdk/mcp` package (`createMCPClient`, also
exported as `experimental_createMCPClient`); `ai` no longer exports it. Packages are
installed into a private cache directory, not this repo's package.json. Override with
`AI_SDK_PKGS="ai@X @ai-sdk/mcp@Y"`.

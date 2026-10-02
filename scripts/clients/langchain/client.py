"""LangChain MCP adapters (langchain-mcp-adapters) against flowscan-mcp: stdio + Streamable HTTP, no model."""
import asyncio, json, os, sys
from importlib.metadata import version
from langchain_mcp_adapters.client import MultiServerMCPClient

VER = f"langchain-mcp-adapters {version('langchain-mcp-adapters')} (langchain-core {version('langchain-core')}, mcp {version('mcp')})"
CONNECTIONS = {
    "stdio": {"transport": "stdio", "command": os.environ["FLOWSCAN_MCP_NODE"], "args": [os.environ["FLOWSCAN_MCP_ENTRY"]], "env": dict(os.environ)},
    "streamable-http": {"transport": "streamable_http", "url": os.environ["FLOWSCAN_MCP_URL"]},
}

def text_of(out) -> str:
    # Tool output is a string, a list of content blocks, or (content, artifact) depending on version.
    if isinstance(out, tuple):
        out = out[0]
    if isinstance(out, list):
        return "".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in out)
    return str(out)

async def probe(client: MultiServerMCPClient, name: str) -> dict:
    tools = await client.get_tools(server_name=name)
    by_name = {t.name: t for t in tools}
    lookup = text_of(await by_name["flowscan_builder_lookup"].ainvoke({"query": "fomo"}))
    cov = json.loads(text_of(await by_name["flowscan_coverage"].ainvoke({})))
    msgs = await client.get_prompt(name, "flowscan_guide")
    blobs = await client.get_resources(name, uris=["flowscan://guide"])
    ok_call = "fomo" in lookup.lower() and bool(cov["pages"])
    ok_pr = "flowscan_coverage" in str(msgs[0].content) and "flowscan_coverage" in blobs[0].as_string()
    # The schema LangChain hands to model integrations (tool.args_schema is the MCP JSON schema).
    schemas_ok = all(isinstance(t.args_schema, dict) and t.args_schema.get("type") == "object" for t in tools)
    return {"client": "langchain-mcp-adapters", "version": VER, "transport": name, "tools": len(tools), "schemas_ok": schemas_ok, "prompts_resources": bool(ok_pr), "call": bool(ok_call)}

async def main() -> int:
    client = MultiServerMCPClient(CONNECTIONS)
    ok = True
    for name in CONNECTIONS:
        try:
            r = await probe(client, name)
        except Exception as e:  # noqa: BLE001
            r = {"client": "langchain-mcp-adapters", "version": VER, "transport": name, "tools": 0, "prompts_resources": False, "call": False, "error": repr(e)[:300]}
        ok &= r["tools"] > 0 and r["call"] and r["prompts_resources"]
        print("RESULT " + json.dumps(r), flush=True)
    return 0 if ok else 1

sys.exit(asyncio.run(main()))

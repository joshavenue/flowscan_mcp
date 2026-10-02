"""Official MCP Python SDK against flowscan-mcp over stdio AND Streamable HTTP (no model, no API key)."""
import asyncio, json, os, sys
from importlib.metadata import version
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client

# The SDK passes only a minimal env (PATH, HOME, ...) to the child; forward ours so proxy/CA settings reach the server.
STDIO = StdioServerParameters(command=os.environ["FLOWSCAN_MCP_NODE"], args=[os.environ["FLOWSCAN_MCP_ENTRY"]], env=dict(os.environ))
URL = os.environ["FLOWSCAN_MCP_URL"]

async def probe(transport: str, streams) -> dict:
    async with streams as (read, write, *_):
        async with ClientSession(read, write) as s:
            await s.initialize()
            tools = (await s.list_tools()).tools
            cov = await s.call_tool("flowscan_coverage", {"topic": "builders"})
            lookup = await s.call_tool("flowscan_builder_lookup", {"query": "fomo"})
            prompts = [p.name for p in (await s.list_prompts()).prompts]
            guide = await s.get_prompt("flowscan_guide")
            res = await s.read_resource("flowscan://guide")
            err = lambda r: getattr(r, "is_error", getattr(r, "isError", False))  # 2.x snake_case, 1.x camelCase
            ok_call = not err(cov) and not err(lookup) and "fomo" in lookup.content[0].text.lower() and json.loads(cov.content[0].text)["pages"]
            ok_pr = "flowscan_guide" in prompts and "flowscan_coverage" in guide.messages[0].content.text and "flowscan_coverage" in res.contents[0].text
            return {"client": "python-sdk", "version": f"mcp {version('mcp')}", "transport": transport, "tools": len(tools), "prompts_resources": bool(ok_pr), "call": bool(ok_call)}

async def main() -> int:
    ok = True
    for name, streams in (("stdio", lambda: stdio_client(STDIO)), ("streamable-http", lambda: streamable_http_client(URL))):
        try:
            r = await probe(name, streams())
        except Exception as e:  # noqa: BLE001 - report any failure as a failed row
            r = {"client": "python-sdk", "version": f"mcp {version('mcp')}", "transport": name, "tools": 0, "prompts_resources": False, "call": False, "error": repr(e)[:300]}
        ok &= r["tools"] > 0 and r["call"] and r["prompts_resources"]
        print("RESULT " + json.dumps(r), flush=True)
    return 0 if ok else 1

sys.exit(asyncio.run(main()))

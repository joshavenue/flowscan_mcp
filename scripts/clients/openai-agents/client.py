"""OpenAI Agents SDK (openai-agents) MCP servers against flowscan-mcp: stdio + Streamable HTTP.

No OpenAI API key is needed: we never run a model. We list tools, convert every MCP
tool into the FunctionTool the Agents SDK would send to the Responses API (non-strict,
the SDK default, and strict), call one tool directly, and read the guide prompt/resource.
"""
import asyncio, json, os, sys
from importlib.metadata import version
from agents.mcp import MCPServerStdio, MCPServerStreamableHttp
from agents.mcp.util import MCPUtil
from agents.strict_schema import ensure_strict_json_schema

VER = f"openai-agents {version('openai-agents')} (mcp {version('mcp')})"

def servers():
    yield "stdio", MCPServerStdio(name="flowscan", params={"command": os.environ["FLOWSCAN_MCP_NODE"], "args": [os.environ["FLOWSCAN_MCP_ENTRY"]], "env": dict(os.environ)}, client_session_timeout_seconds=120)
    yield "streamable-http", MCPServerStreamableHttp(name="flowscan", params={"url": os.environ["FLOWSCAN_MCP_URL"], "timeout": 60}, client_session_timeout_seconds=120)

async def probe(transport: str, server) -> dict:
    async with server:
        tools = await server.list_tools()
        fn = [MCPUtil.to_function_tool(t, server, convert_schemas_to_strict=False) for t in tools]
        assert all(f.params_json_schema.get("type") == "object" for f in fn)
        strict_ok = 0
        for t in tools:
            try:
                ensure_strict_json_schema(dict(getattr(t, "input_schema", None) or t.inputSchema))
                strict_ok += 1
            except Exception:  # noqa: BLE001 - counted, not fatal (MCP hosts use non-strict tools)
                pass
        lookup = await server.call_tool("flowscan_builder_lookup", {"query": "fomo"})
        cov = await server.call_tool("flowscan_coverage", {})
        prompts = [p.name for p in (await server.list_prompts()).prompts]
        guide = await server.get_prompt("flowscan_guide")
        res = await server.read_resource("flowscan://coverage")
        ok_call = not getattr(lookup, "is_error", getattr(lookup, "isError", False)) and "fomo" in lookup.content[0].text.lower() and json.loads(cov.content[0].text)["pages"]
        ok_pr = "flowscan_guide" in prompts and "flowscan_coverage" in guide.messages[0].content.text and json.loads(res.contents[0].text)["mode"] in ("strict", "hyperliquid-direct")
        return {"client": "openai-agents", "version": VER, "transport": transport, "tools": len(tools), "function_tools": len(fn), "strict_convertible": strict_ok, "prompts_resources": bool(ok_pr), "call": bool(ok_call)}

async def main() -> int:
    ok = True
    for name, server in servers():
        try:
            r = await probe(name, server)
        except Exception as e:  # noqa: BLE001
            r = {"client": "openai-agents", "version": VER, "transport": name, "tools": 0, "prompts_resources": False, "call": False, "error": repr(e)[:300]}
        ok &= r["tools"] > 0 and r["call"] and r["prompts_resources"]
        print("RESULT " + json.dumps(r), flush=True)
    return 0 if ok else 1

sys.exit(asyncio.run(main()))

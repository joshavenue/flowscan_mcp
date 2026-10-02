"""OpenAI Agents SDK (Python) with the flowscan MCP server.

Local stdio (default):
    pip install openai-agents
    export OPENAI_API_KEY=...
    python examples/agents-sdk.py

Streamable HTTP (server started with `flowscan-mcp --http`, or the Docker image):
    FLOWSCAN_MCP_URL=http://127.0.0.1:8787/mcp python examples/agents-sdk.py

Docs: https://openai.github.io/openai-agents-python/mcp/
"""
import asyncio
import os

from agents import Agent, Runner
from agents.mcp import MCPServerStdio, MCPServerStreamableHttp

INSTRUCTIONS = (
    "Answer Hyperliquid questions only with the flowscan_* tools. Data is mainnet only. "
    "Call flowscan_coverage first if unsure which tool fits. Quote the totals the tools "
    "return, never add rows yourself, and state the UTC date range or snapshot time."
)


def make_server():
    url = os.environ.get("FLOWSCAN_MCP_URL")
    # The SDK's default per-request timeout is 5 s; Flowscan calls can take longer.
    if url:
        return MCPServerStreamableHttp(
            name="flowscan",
            params={"url": url, "timeout": 60},
            cache_tools_list=True,
            client_session_timeout_seconds=60,
        )
    return MCPServerStdio(
        name="flowscan",
        params={
            "command": "npx",
            "args": ["-y", "github:joshavenue/flowscan_mcp"],
            # "env": {"FLOWSCAN_HYPERLIQUID_DIRECT": "1"},  # opt-in direct mode
        },
        cache_tools_list=True,
        client_session_timeout_seconds=60,
    )


async def main() -> None:
    async with make_server() as server:
        agent = Agent(name="Flowscan analyst", instructions=INSTRUCTIONS, mcp_servers=[server])
        result = await Runner.run(agent, "Which builder earned the most revenue over the last 7 days?")
        print(result.final_output)


asyncio.run(main())

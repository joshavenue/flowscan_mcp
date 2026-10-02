"""LangChain / LangGraph agent with the flowscan MCP server.

Uses LangChain's built-in MCP adapter (langchain[mcp] >= 1.4.0, beta), which
replaces the older langchain-mcp-adapters package. Any chat model LangChain
supports works here, including Grok (xai:...) and OpenAI-compatible endpoints.

    pip install "langchain[mcp]" "langchain[openai]"
    export OPENAI_API_KEY=...
    export LANGCHAIN_MODEL=openai:<model>     # e.g. a provider:model string
    python examples/langchain-mcp.py

For Streamable HTTP, replace the server entry with {"url": "http://127.0.0.1:8787/mcp"}.

Docs: https://docs.langchain.com/oss/python/langchain/mcp
      https://docs.langchain.com/oss/python/migrate/langchain-mcp-adapters
"""
import asyncio
import os

from langchain.agents import create_agent
from langchain.mcp import MCPAdapter

CONFIG = {
    "mcpServers": {
        "flowscan": {
            "command": "npx",
            "args": ["-y", "github:joshavenue/flowscan_mcp"],
            # "env": {"FLOWSCAN_HYPERLIQUID_DIRECT": "1"},  # opt-in direct mode
        },
    }
}


async def main() -> None:
    async with MCPAdapter(CONFIG) as adapter:
        tools = await adapter.list_tools()
        agent = create_agent(os.environ["LANGCHAIN_MODEL"], tools)
        result = await agent.ainvoke(
            {"messages": "What is the open interest on BTC on Hyperliquid right now? Say which basis."}
        )
        print(result["messages"][-1].content)


asyncio.run(main())

"""OpenAI Responses API with flowscan as a remote MCP tool.

OpenAI's servers call the MCP server, so FLOWSCAN_MCP_URL must be a public
HTTPS Streamable HTTP endpoint (the Docker image behind TLS, or a tunnel to
`flowscan-mcp --http`), for example https://flowscan.example.com/mcp.
http://127.0.0.1:8787/mcp is not reachable from OpenAI.

    pip install openai
    export OPENAI_API_KEY=...
    export FLOWSCAN_MCP_URL=https://flowscan.example.com/mcp
    export OPENAI_MODEL=<a model that supports the mcp tool>
    python examples/openai-responses.py

Docs: https://developers.openai.com/api/docs/guides/tools-connectors-mcp
"""
import os

from openai import OpenAI

client = OpenAI()

resp = client.responses.create(
    model=os.environ["OPENAI_MODEL"],
    tools=[
        {
            "type": "mcp",
            "server_label": "flowscan",
            "server_description": "Read-only Hyperliquid mainnet data shown on flowscan.xyz: revenue, staking, builders, HIP-3/HIP-4, addresses.",
            "server_url": os.environ["FLOWSCAN_MCP_URL"],
            # Every flowscan tool is read-only, so skipping approval is reasonable.
            "require_approval": "never",
            # Optional: import only the tools you need to keep the tool list small.
            "allowed_tools": [
                "flowscan_coverage",
                "flowscan_revenue_summary",
                "flowscan_builder_lookup",
                "flowscan_builder_revenue",
                "flowscan_perp_positions",
                "flowscan_address_summary",
            ],
        },
    ],
    input="How much revenue did Hyperliquid make over the last 7 complete UTC days? Cite the date range.",
)

print(resp.output_text)

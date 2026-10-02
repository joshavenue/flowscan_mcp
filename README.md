# flowscan-mcp

Give your AI agent the Hyperliquid data from [flowscan.xyz](https://www.flowscan.xyz).

Flowscan is a real-time explorer for the Hyperliquid blockchain. (It has nothing to do with the Flow blockchain.) This [MCP](https://modelcontextprotocol.io) server turns the numbers on Flowscan into tools, so you can ask your agent things like:

- *"How much did Hyperliquid earn in fees yesterday?"*
- *"Who holds the biggest BTC longs right now?"*
- *"Which builder code made the most revenue this week?"*
- *"What positions does 0x… have open?"*

**Free, no API key, read-only, Hyperliquid mainnet.**

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer.

**Claude Code**

```sh
claude mcp add flowscan -- npx -y github:joshavenue/flowscan_mcp
```

**Claude Desktop, Cursor, Gemini CLI and most other clients:** add this to the client's MCP config file, then restart the client:

```json
{
  "mcpServers": {
    "flowscan": {
      "command": "npx",
      "args": ["-y", "github:joshavenue/flowscan_mcp"]
    }
  }
}
```

The first start can take a minute while npm builds the server. Then ask your agent a question about Hyperliquid.

**Other clients** (Codex, VS Code, ChatGPT, Zed, Cline, LangChain and more): see [docs/clients.md](docs/clients.md) for setup steps, and [examples/](examples/) for config files you can copy.

## What it covers

44 tools, grouped by the Flowscan page they mirror:

| Area | What you can ask about |
| --- | --- |
| **Revenue** | Daily protocol fees, HIP-3 deployer fees, priority gas, 1/7/30-day totals |
| **Perps** | Open interest, long/short ratios, the largest positions in any market |
| **Addresses** | Positions, PnL, trades, orders, funding, deposits, staking, vaults |
| **Builders** | Builder-code leaderboards, revenue over any date range, user stats |
| **HIP-3** | Perp DEX market share, volume, markets, comparison with Binance |
| **HIP-4** | Outcome (prediction) markets, prices and candles |
| **Staking** | Total HYPE staked, validators, delegators |
| **More** | Tokenized stocks, weekend trading, stablecoins, network nodes |

Every result says which Flowscan page and date range the numbers come from.

## Optional: live market data

Some Flowscan panels (live prices, candles, order books, blocks and transactions) are loaded in your browser straight from Hyperliquid, not from Flowscan. To get these too, set one environment variable:

```json
"env": { "FLOWSCAN_HYPERLIQUID_DIRECT": "1" }
```

This adds 14 tools (58 in total). By default the server only talks to `www.flowscan.xyz`. With this setting it also calls Hyperliquid's public API.

## Good to know

- **Unofficial.** The server uses the same internal routes the Flowscan website uses. If Flowscan changes them, a tool may break until it is updated.
- **Mainnet only.** Flowscan doesn't show testnet.
- **Works with any MCP client**, locally over stdio or remotely over HTTP (`npx -y github:joshavenue/flowscan_mcp --http`).
- **Better answers with the guide.** Give your agent [skills/flowscan](skills/flowscan/SKILL.md) (Claude) or [AGENTS.md](AGENTS.md) (most other agents). These tell it which tool to use for each kind of question.

## Documentation

- [Full reference](docs/reference.md): every tool and parameter, output format, errors and settings
- [Client setup](docs/clients.md): step-by-step for 20+ MCP clients, HTTP and Docker
- [Evaluation](docs/eval-2026-10-02.md): how the tools were tested with 220 real questions

## Development

```sh
git clone https://github.com/joshavenue/flowscan_mcp
cd flowscan_mcp
npm install    # also builds
npm test       # offline unit tests
npm run smoke  # live test against flowscan.xyz
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to add a tool.

## License

MIT. Not affiliated with Flowscan or Hyperliquid.

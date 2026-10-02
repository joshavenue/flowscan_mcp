# Using flowscan-mcp from any MCP client

This page lists, client by client, how to connect the flowscan MCP server, whether the client can reach the server's guidance prompt, and the quirks worth knowing. Each section names the vendor documentation the snippet was checked against (checked 2026-10-02). MCP client config formats change often; if a snippet stops working, the linked page is the authority.

The server speaks two transports:

- **stdio** (default). The client starts the server as a subprocess. Every snippet below uses the npx-from-GitHub form, `npx -y github:joshavenue/flowscan_mcp`, which needs Node.js 20 or newer and git. Once the package is published to npm, `npx -y flowscan-mcp` will work in the same place.
- **Streamable HTTP**. You start the server yourself with `--http`, and the client connects to `http://127.0.0.1:8787/mcp` (or a public HTTPS URL for cloud clients). See [Running over HTTP](#running-over-http).

Protocol-level checks (list tools, call tools, get the `flowscan_guide` prompt, read a resource, over stdio and HTTP) with the MCP Inspector CLI, the Python MCP SDK, the OpenAI Agents SDK, langchain-mcp-adapters and the Vercel AI SDK are in [scripts/clients/RESULTS.md](../scripts/clients/RESULTS.md) (`npm run clients`). The IDE and chat clients below were not run; their sections follow the vendor docs.

Environment variables (for example `FLOWSCAN_HYPERLIQUID_DIRECT=1` for the 58-tool [direct mode](../README.md#two-modes)) go in the client's `env` block for stdio. Over HTTP they are set on the server process instead.

Contents: [Support table](#support-table) · [Running over HTTP](#running-over-http) · [Guidance for non-Claude agents](#guidance-for-non-claude-agents) · [Anthropic](#anthropic-claude-desktop-and-claude-code) · [OpenAI](#openai) · [Cursor](#cursor) · [VS Code](#vs-code-github-copilot) · [Devin Desktop (Windsurf)](#devin-desktop-formerly-windsurf) · [Cline](#cline) · [Roo Code](#roo-code) · [Continue](#continue) · [Zed](#zed) · [JetBrains](#jetbrains-ai-assistant) · [Google](#google) · [xAI Grok](#xai-grok) · [Nous Research Hermes](#nous-research-hermes) · [Frameworks](#agent-frameworks) · [Unverified points](#what-could-not-be-verified)

## Support table

"Prompts" means the client can call the MCP prompt `flowscan_guide`; "resources" means it can read `flowscan://guide` and `flowscan://coverage`. Where neither is available, put the guidance in the file named in the "Guidance" column (see [Guidance for non-Claude agents](#guidance-for-non-claude-agents)). "Not documented" means the vendor docs do not say either way.

| Client | stdio | Streamable HTTP | Prompts | Resources | Guidance | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | yes | yes (`--transport http`) | yes, `/mcp__flowscan__flowscan_guide` | yes, `@` mentions | skill `~/.claude/skills/flowscan` | see README |
| Claude Desktop | yes | HTTPS URL via custom connector | not checked | not checked | project instructions | private networks need an MCP tunnel |
| Codex CLI / IDE extension | yes | yes (`url`) | no | yes, via Codex's resource tools (source, not docs) | `AGENTS.md` | startup timeout 10 s by default; raise it for npx |
| ChatGPT (developer mode) | no | public HTTPS or Secure MCP Tunnel | not documented | not documented | paste into the chat or instructions | read-only tools skip confirmation |
| OpenAI Responses API | no | public URL (Streamable HTTP or SSE) | not documented | not documented | `instructions` parameter | `require_approval`, `allowed_tools` |
| OpenAI Agents SDK (Python, JS) | yes | yes | yes (`list_prompts` / `get_prompt`) | not documented | agent `instructions` | Python: 5 s default session timeout |
| Cursor | yes | yes (`url`) | yes | yes | `.cursor/rules/*.mdc` or `AGENTS.md` | a 40-tool cap was reported; see [FLOWSCAN_TOOLS](#limiting-the-tool-list) |
| VS Code (GitHub Copilot) | yes (`servers`, `type: stdio`) | yes (`type: http`) | yes, `/flowscan.flowscan_guide` | yes, attach as context | `.github/copilot-instructions.md` or `AGENTS.md` | trust prompt on first start |
| Devin Desktop (formerly Windsurf), Cascade agent | yes | yes (`serverUrl`) | yes | yes | `.devin/rules/*.md`, `.windsurfrules` or `AGENTS.md` | 100-tool cap |
| Cline | yes | yes (`type: streamableHttp`) | not documented | not documented | `.clinerules/` (also reads `AGENTS.md`) | `autoApprove` list |
| Roo Code | yes | yes (`type: streamable-http`) | not documented | not documented | not checked | `alwaysAllow`, `disabledTools` |
| Continue | yes | yes (`type: streamable-http`) | not documented | not documented | `.continue/rules/*.md` | MCP only in agent mode |
| Zed | yes | yes (`url`) | yes | no (tools and prompts only) | `AGENTS.md` or `.rules` (first match wins) | `agent.tool_permissions` |
| JetBrains AI Assistant | yes | yes (`url`) | not documented | not documented | `.aiassistant/rules/*.md` | add via Settings, as JSON |
| Gemini CLI | yes | yes (`httpUrl`) | yes, slash commands | yes, `@flowscan://guide` | `GEMINI.md` | tools appear as `mcp_flowscan_<tool>` |
| Gemini Code Assist (VS Code agent mode) | yes | yes (`httpUrl`) | not documented | not documented | `GEMINI.md` | IntelliJ uses a separate `mcp.json` |
| Google Antigravity | yes | yes (`serverUrl` only) | not documented | not documented | not documented on the MCP page | `~/.gemini/config/mcp_config.json` |
| Grok (grok.com connectors) | no | public URL | not documented | not documented | paste into the chat | needs a tunnel for a local server |
| Grok Build (CLI) | yes | yes (`url`) | not documented | not documented | not documented | also loads `.mcp.json` and `.cursor/mcp.json` |
| xAI API (remote MCP tools) | no | public URL (Streaming HTTP or SSE) | not documented | not documented | system prompt | no `require_approval` |
| Hermes Agent (Nous Research) | yes | yes (`url`) | yes, via `mcp_flowscan_get_prompt` | yes, via `mcp_flowscan_read_resource` | `AGENTS.md` (or `.hermes.md`) | tools appear as `mcp_flowscan_<tool>` |
| LangChain / LangGraph | yes | yes | via `adapter.client` (FastMCP) | via `adapter.client` (FastMCP) | system prompt | `langchain[mcp]` replaces `langchain-mcp-adapters` |
| Vercel AI SDK | yes | yes | experimental | yes | `system` | works with the xAI provider |
| Google ADK | yes | yes | not documented | yes | agent `instruction` | |
| Pydantic AI | yes | yes | not documented | yes | agent instructions | |
| CrewAI | yes | yes | no (tools only) | no (tools only) | agent backstory or task | |
| smolagents | yes | yes | not documented | not documented | system prompt | `structured_output` flag |

## Running over HTTP

Cloud clients (ChatGPT, the OpenAI Responses API, grok.com, the xAI API, Claude custom connectors) cannot start a local process; they need a URL. Local clients can use either transport.

### Start the HTTP server

```sh
npx -y github:joshavenue/flowscan_mcp --http
# stderr: flowscan-mcp ready (streamable HTTP, stateless) at http://127.0.0.1:8787/mcp (legacy SSE: /sse, health: /healthz) ...
curl http://127.0.0.1:8787/healthz
# {"ok":true,"name":"flowscan-mcp","version":"0.1.0","mode":"strict","tools":44,"transport":"streamable-http","endpoint":"/mcp","stateful":false,"legacySse":"/sse"}
```

From a clone, `npm run start:http` (or `node dist/index.js --http`) does the same.

| Flag | Environment variable | Default | Effect |
| --- | --- | --- | --- |
| `--http` / `--stdio` | `FLOWSCAN_MCP_TRANSPORT=http` / `stdio` | stdio | Transport. |
| `--port <n>` | `PORT` | `8787` | HTTP port. `--port` alone implies `--http`. |
| `--host <addr>` | `HOST` | `127.0.0.1` | Bind address. `--host` alone implies `--http`. |
| `--stateful` | `FLOWSCAN_MCP_STATEFUL=1` | stateless | Keep `Mcp-Session-Id` sessions (GET stream, DELETE). The default stateless mode issues no session id. |
| | `FLOWSCAN_MCP_CORS` | none | Comma-separated browser origins allowed to call the server (`*` for any). |
| | `FLOWSCAN_MCP_ALLOWED_HOSTS` | none | Extra `Host` header names to accept, for example a proxy's or tunnel's public hostname. |

Flags win over environment variables. The other settings (`FLOWSCAN_HYPERLIQUID_DIRECT`, `FLOWSCAN_TOOLS`, timeouts, ...) are read from the server process's environment as usual. `flowscan-mcp --help` prints the list.

Endpoints: `POST /mcp` (Streamable HTTP), `GET /sse` plus `POST /messages` (the legacy HTTP+SSE transport, for older clients), and `GET /healthz`. Responses to `POST /mcp` are sent as `text/event-stream`, as the MCP SDK does by default.

Security: there is no authentication. Bound to `127.0.0.1` (the default), the server accepts only `Host` headers naming `localhost`, `127.0.0.1` or `[::1]` (plus `FLOWSCAN_MCP_ALLOWED_HOSTS`), which blocks DNS rebinding, and browser `Origin`s other than local ones are refused unless listed in `FLOWSCAN_MCP_CORS`. Bound to any other address, it prints a warning, checks `Host` only if `FLOWSCAN_MCP_ALLOWED_HOSTS` is set, and refuses every browser `Origin` not in `FLOWSCAN_MCP_CORS`. Anyone who can reach the port can use the tools (read-only, but every call makes requests to Flowscan from your server), so do not expose it without a proxy you control.

### Docker

The repository has a `Dockerfile` (Node 22 on Alpine, runs as the `node` user, health check on `/healthz`). No image is published to a registry; build it yourself:

```sh
git clone https://github.com/joshavenue/flowscan_mcp
cd flowscan_mcp
docker build -t flowscan-mcp .
docker run --rm -p 127.0.0.1:8787:8787 flowscan-mcp
# direct mode:
docker run --rm -p 127.0.0.1:8787:8787 -e FLOWSCAN_HYPERLIQUID_DIRECT=1 flowscan-mcp
```

Inside the container the server listens on `0.0.0.0:8787` (`FLOWSCAN_MCP_TRANSPORT=http`, `HOST=0.0.0.0`, `PORT=8787`). Publishing the port on `127.0.0.1` as above keeps it local; the MCP endpoint is then `http://127.0.0.1:8787/mcp`. Behind a reverse proxy, pass `-e FLOWSCAN_MCP_ALLOWED_HOSTS=flowscan.example.com` so only requests for your hostname are served.

### A public HTTPS URL for cloud clients

ChatGPT, the OpenAI Responses API, grok.com connectors, the xAI API and Claude custom connectors call the server from the vendor's infrastructure, so `http://127.0.0.1:8787/mcp` does not work for them. Two ways to get an HTTPS URL:

1. **Host it.** Run the Docker image on a server and put a reverse proxy with TLS in front (Caddy, nginx, a cloud load balancer). Set `FLOWSCAN_MCP_ALLOWED_HOSTS` to the public hostname. The proxy must not buffer streamed responses; the server sends `X-Accel-Buffering: no`, which nginx honours. The URL to give clients is `https://<your-host>/mcp`.
2. **Tunnel to your machine** while you test. Start the server locally with `FLOWSCAN_MCP_ALLOWED_HOSTS` set to the tunnel's hostname, because tunnels forward the public `Host` header (the server answers `403 Forbidden: Host '...' not allowed` otherwise):
   - ngrok: `ngrok http 8787`, then restart the server with `FLOWSCAN_MCP_ALLOWED_HOSTS=<the ngrok hostname>` and use `https://<the ngrok hostname>/mcp`. Docs: <https://ngrok.com/docs/universal-gateway/http/>.
   - Cloudflare Tunnel: use a named tunnel. Cloudflare's docs say Quick Tunnels (`cloudflared tunnel --url ...`) do not support Server-Sent Events, and this server streams its `POST /mcp` responses as `text/event-stream`, so a Quick Tunnel is likely to fail (not tested). Docs: <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/>.
   - OpenAI's Secure MCP Tunnel (ChatGPT developer mode, Responses API) and Anthropic's MCP tunnels (Claude connectors) connect a private server without a public URL; see the vendors' docs linked in their sections below.

Cloud clients that send a static header (the Responses API's `authorization` field and `headers`, the xAI API's `authorization` and `headers`) can be put behind a proxy that checks a token. ChatGPT supports OAuth or no authentication, so with ChatGPT the URL itself is the only secret unless you add OAuth at the proxy.

## Guidance for non-Claude agents

Claude Code loads [skills/flowscan/SKILL.md](../skills/flowscan/SKILL.md) as a skill. Other clients get the same rules (which tool fits which question, mainnet only, Flowscan only, quote computed totals, how to say something is not served) in one of three ways:

1. **MCP prompt `flowscan_guide`.** Returns SKILL.md as a user message. In clients that show prompts as slash commands, run it at the start of a conversation: `/mcp__flowscan__flowscan_guide` (Claude Code), `/flowscan.flowscan_guide` (VS Code), `/flowscan_guide` (Gemini CLI).
2. **MCP resource `flowscan://guide`** (Markdown) and **`flowscan://coverage`** (JSON coverage map, same data as the `flowscan_coverage` tool). Attach it as context where the client supports resources.
3. **A rules file.** Copy [AGENTS.md](../AGENTS.md) (a shortened version of SKILL.md) or the body of SKILL.md into the file your client reads automatically:

| Client | File |
| --- | --- |
| Codex (CLI, IDE, ChatGPT desktop) | `AGENTS.md` in the project root, or `~/.codex/AGENTS.md` for all projects |
| Cursor | `AGENTS.md` in the project root, or `.cursor/rules/flowscan.mdc` with `alwaysApply: true` in its frontmatter |
| VS Code (GitHub Copilot) | `.github/copilot-instructions.md`, or `AGENTS.md` with the `chat.useAgentsMdFile` setting on |
| Devin Desktop (Windsurf) | `.devin/rules/flowscan.md` (preferred), `.windsurf/rules/flowscan.md`, `.windsurfrules`, or `AGENTS.md` |
| Cline | `.clinerules/flowscan.md` (Cline also detects `AGENTS.md`, `.cursorrules` and `.windsurfrules`) |
| Continue | `.continue/rules/flowscan.md` (with YAML frontmatter) |
| Zed | `AGENTS.md`, or `.rules`; Zed uses the first match among `.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` |
| JetBrains AI Assistant | `.aiassistant/rules/flowscan.md` |
| Gemini CLI, Gemini Code Assist | `GEMINI.md` (it can import another file: a line `@./AGENTS.md`), or set `"context": {"fileName": ["AGENTS.md", "GEMINI.md"]}` in settings.json |
| Hermes Agent | `AGENTS.md` (`.hermes.md` wins if both exist) |
| ChatGPT, grok.com | paste AGENTS.md into the conversation or the assistant's custom instructions |
| API and framework code | pass the text as the system prompt / agent instructions; fetch it with the client's `get_prompt("flowscan_guide")` where available |

This repository ships an [AGENTS.md](../AGENTS.md) and a [GEMINI.md](../GEMINI.md) (which imports AGENTS.md) at its root, so agents opened inside a clone pick them up. In your own project, copy them. Nothing in `.github/` is shipped for Copilot; copy AGENTS.md to `.github/copilot-instructions.md` yourself if you use Copilot.

Every client also receives the server's MCP `instructions` field on connect (a short summary that names `flowscan_coverage` and the `flowscan_guide` prompt). Codex documents that it reads it; other clients may or may not pass it to the model.

### Limiting the tool list

Strict mode registers 44 tools, direct mode 58. For a client that caps the number of tools, or to save context, set `FLOWSCAN_TOOLS` in the server's environment to a comma-separated list of tool names (`*` wildcards allowed). `flowscan_coverage` is always kept. Example: `"FLOWSCAN_TOOLS": "flowscan_revenue_*,flowscan_builder*,flowscan_address_*"`.

## Anthropic: Claude Desktop and Claude Code

Covered in the [README](../README.md#client-configuration). Over HTTP, Claude Code takes:

```sh
claude mcp add --transport http flowscan http://127.0.0.1:8787/mcp
```

Claude Code shows MCP prompts as `/mcp__<server>__<prompt>` and resources through `@` mentions; it warns at 10,000 tokens of tool output and caps at 25,000 by default (`MAX_MCP_OUTPUT_TOKENS`). Flowscan results are capped at about 40,000 characters, below that limit. Docs: <https://code.claude.com/docs/en/mcp>.

Claude Desktop (and claude.ai) custom connectors take an HTTPS remote MCP URL: Customize, Connectors, Add custom connector, then the URL and **No sign-in** (this server has no authentication). For a server on a private network, Anthropic documents MCP tunnels instead. Docs: <https://claude.com/docs/connectors/custom/add-unlisted>.

## OpenAI

### Codex CLI and Codex IDE extension

Config: `~/.codex/config.toml` (all projects) or `.codex/config.toml` (trusted projects only). The Codex CLI, the IDE extension and the ChatGPT desktop app share it. See [examples/codex.config.toml](../examples/codex.config.toml).

```toml
[mcp_servers.flowscan]
command = "npx"
args = ["-y", "github:joshavenue/flowscan_mcp"]
startup_timeout_sec = 120
tool_timeout_sec = 120

# Direct mode:
# [mcp_servers.flowscan.env]
# FLOWSCAN_HYPERLIQUID_DIRECT = "1"
```

From the command line:

```sh
codex mcp add flowscan -- npx -y github:joshavenue/flowscan_mcp
codex mcp add flowscan --env FLOWSCAN_HYPERLIQUID_DIRECT=1 -- npx -y github:joshavenue/flowscan_mcp
```

Over HTTP:

```toml
[mcp_servers.flowscan]
url = "http://127.0.0.1:8787/mcp"
```

Quirks:

- `startup_timeout_sec` defaults to 10 and `tool_timeout_sec` to 60. The first `npx -y github:...` run clones and compiles the package, which can take longer than 10 s, and a Flowscan request may take up to 45 s, so raise both as above. `codex mcp add` does not set them; edit the file afterwards.
- `enabled_tools` / `disabled_tools` filter tools per server, an alternative to `FLOWSCAN_TOOLS`.
- Prompts: not documented, and Codex's MCP client source has no prompt support, so put the guidance in `AGENTS.md`. Resources: Codex's source includes `list_mcp_resources` and `read_mcp_resource` tools the model can call, so `flowscan://guide` is reachable, but the Codex MCP docs do not mention it.
- In the IDE extension, the gear menu has an **MCP servers** list showing which servers are enabled.

Docs: <https://learn.chatgpt.com/docs/extend/mcp?surface=cli> (formerly developers.openai.com/codex/mcp), <https://developers.openai.com/codex/guides/agents-md>.

### ChatGPT (developer mode)

ChatGPT connects to MCP servers from OpenAI's infrastructure, so it needs a URL it can reach: a public HTTPS endpoint (Streamable HTTP, usually at `/mcp`) or OpenAI's Secure MCP Tunnel. It cannot start a local stdio server.

1. Turn on developer mode: Settings, Security and login, Developer mode (Pro, Plus, Business, Enterprise and Education accounts on the web; workspace policy may restrict it).
2. Make the server reachable over HTTPS: run the Docker image behind a reverse proxy with TLS, or run `flowscan-mcp --http` locally with a tunnel (see [Running over HTTP](#running-over-http)).
3. In ChatGPT's Plugins settings, select the plus button, enter a name and description, choose **Public endpoint**, enter `https://<your-host>/mcp`, and choose no authentication.
4. Review the discovered tools.

ChatGPT treats tools without `readOnlyHint` as write actions that need confirmation. Every flowscan tool is annotated `readOnlyHint: true`, so calls run without a confirmation step. The server has no authentication, so anyone with the URL can use it; keep the URL private or put an authenticating proxy in front.

Docs: <https://developers.openai.com/api/docs/guides/developer-mode>, <https://developers.openai.com/apps-sdk/deploy/connect-chatgpt>.

### OpenAI Responses API

The `mcp` tool type lets OpenAI call a remote MCP server during a response. The URL must be reachable from OpenAI (public, or via Secure MCP Tunnel). Full example: [examples/openai-responses.py](../examples/openai-responses.py).

```python
resp = client.responses.create(
    model=MODEL,
    tools=[{
        "type": "mcp",
        "server_label": "flowscan",
        "server_url": "https://flowscan.example.com/mcp",
        "require_approval": "never",
        "allowed_tools": ["flowscan_coverage", "flowscan_revenue_summary"],
    }],
    input="How much revenue did Hyperliquid make over the last 7 days?",
)
```

- `require_approval` is `"always"`, `"never"`, or an object such as `{"never": {"tool_names": ["flowscan_coverage"]}}`. By default OpenAI asks for approval before sending data to a remote server. All flowscan tools are read-only.
- `allowed_tools` imports only the listed tools, which keeps the tool list (and token cost) small.
- Supported transports: Streamable HTTP and HTTP/SSE.
- Once an `mcp_list_tools` item is in the context, the API does not fetch the tool list again on later turns.
- Prompts and resources are not part of this tool; put the guidance in `instructions`.

Docs: <https://developers.openai.com/api/docs/guides/tools-connectors-mcp>.

### OpenAI Agents SDK

Python, stdio or Streamable HTTP. Full example: [examples/agents-sdk.py](../examples/agents-sdk.py).

```python
from agents import Agent, Runner
from agents.mcp import MCPServerStdio, MCPServerStreamableHttp

async with MCPServerStdio(
    name="flowscan",
    params={"command": "npx", "args": ["-y", "github:joshavenue/flowscan_mcp"]},
    cache_tools_list=True,
    client_session_timeout_seconds=60,
) as server:
    agent = Agent(name="Flowscan analyst", instructions="...", mcp_servers=[server])
    result = await Runner.run(agent, "Top builders by revenue this week?")

# HTTP: MCPServerStreamableHttp(name="flowscan", params={"url": "http://127.0.0.1:8787/mcp"},
#                               client_session_timeout_seconds=60)
```

- `client_session_timeout_seconds` defaults to 5 seconds in the SDK source. Flowscan calls can take longer; set it to 60.
- `MCPServerStdio` (like the Python MCP SDK it uses) starts the server with a minimal environment plus your `env`. Behind an HTTPS proxy or with a custom CA, pass `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` in `env`, or tool calls fail while the tool list still loads (see [RESULTS.md](../scripts/clients/RESULTS.md)).
- `tool_filter=create_static_tool_filter(allowed_tool_names=[...])` limits the tools.
- `await server.list_prompts()` and `await server.get_prompt("flowscan_guide")` return the guide, which you can put in the agent's `instructions`.
- `HostedMCPTool(tool_config={"type": "mcp", "server_label": "flowscan", "server_url": ..., "require_approval": "never"})` uses the Responses API's hosted MCP tool instead (public URL required).

JavaScript (`@openai/agents`):

```ts
import { Agent, run, MCPServerStdio, MCPServerStreamableHttp } from "@openai/agents";

const flowscan = new MCPServerStdio({ name: "flowscan", fullCommand: "npx -y github:joshavenue/flowscan_mcp" });
// or: new MCPServerStreamableHttp({ name: "flowscan", url: "http://127.0.0.1:8787/mcp" });
await flowscan.connect();
try {
  const agent = new Agent({ name: "Flowscan analyst", instructions: "...", mcpServers: [flowscan] });
  console.log((await run(agent, "Top builders by revenue this week?")).finalOutput);
} finally {
  await flowscan.close();
}
```

Docs: <https://openai.github.io/openai-agents-python/mcp/>, <https://openai.github.io/openai-agents-js/guides/mcp/>.

## Cursor

Config: `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for all projects. See [examples/cursor.mcp.json](../examples/cursor.mcp.json).

```json
{
  "mcpServers": {
    "flowscan": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:joshavenue/flowscan_mcp"],
      "env": { "FLOWSCAN_HYPERLIQUID_DIRECT": "1" }
    }
  }
}
```

Drop the `env` line for strict mode. Over HTTP:

```json
{
  "mcpServers": {
    "flowscan": { "url": "http://127.0.0.1:8787/mcp" }
  }
}
```

- Supports tools, prompts, resources, roots and elicitation, over stdio, SSE and Streamable HTTP. Config values can use `${env:NAME}`, `${userHome}` and `${workspaceFolder}`; stdio servers also accept `envFile`.
- Cursor asks for approval before MCP tool calls by default.
- Tool count: Cursor's forum reported that only the first 40 MCP tools across all servers reach the agent (threads from 2025). The current docs page states no number. Strict mode has 44 tools, so if your Cursor still applies a cap, use [`FLOWSCAN_TOOLS`](#limiting-the-tool-list) to pick the ones you need.
- Guidance: `AGENTS.md` at the project root, or `.cursor/rules/flowscan.mdc` (frontmatter `alwaysApply: true`). Plain `.md` files in `.cursor/rules` are ignored.

Docs: <https://cursor.com/docs/context/mcp>, <https://cursor.com/docs/context/rules>, forum: <https://forum.cursor.com/t/tools-limited-to-40-total/67976>.

## VS Code (GitHub Copilot)

Config: `.vscode/mcp.json` in the workspace (top-level key `servers`, not `mcpServers`), or the user configuration opened with the **MCP: Open User Configuration** command. VS Code also reads a portable `.mcp.json` at the project root with `mcpServers`. See [examples/vscode.mcp.json](../examples/vscode.mcp.json).

```json
{
  "servers": {
    "flowscan": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:joshavenue/flowscan_mcp"],
      "env": { "FLOWSCAN_HYPERLIQUID_DIRECT": "1" }
    }
  }
}
```

Over HTTP:

```json
{
  "servers": {
    "flowscan": { "type": "http", "url": "http://127.0.0.1:8787/mcp" }
  }
}
```

From the command line:

```sh
code --add-mcp "{\"name\":\"flowscan\",\"command\":\"npx\",\"args\":[\"-y\",\"github:joshavenue/flowscan_mcp\"]}"
```

- MCP prompts appear as slash commands `/<server>.<prompt>` (here `/flowscan.flowscan_guide`); resources can be attached to a chat request as context.
- Workspace servers follow Workspace Trust; other servers ask for trust when they first start.
- Guidance: `.github/copilot-instructions.md`, or `AGENTS.md` with `chat.useAgentsMdFile` enabled.

Docs: <https://code.visualstudio.com/docs/copilot/customization/mcp-servers>, <https://code.visualstudio.com/docs/copilot/reference/mcp-configuration>, <https://code.visualstudio.com/docs/copilot/customization/custom-instructions>.

## Devin Desktop (formerly Windsurf)

Windsurf became Devin Desktop on 2026-06-02. Its MCP page covers the Cascade agent, which the FAQ says remains available through July 2026; the new default agent, Devin Local, uses a different configuration that the desktop docs do not describe yet. Devin CLI's MCP config (below) is documented separately.

Cascade config: `~/.config/devin/mcp_config.json` (macOS, Linux; `$XDG_CONFIG_HOME/devin/mcp_config.json` if set) or `%APPDATA%\devin\mcp_config.json` (Windows). Older Windsurf releases used `~/.codeium/windsurf/mcp_config.json`. See [examples/windsurf.mcp_config.json](../examples/windsurf.mcp_config.json).

```json
{
  "mcpServers": {
    "flowscan": {
      "command": "npx",
      "args": ["-y", "github:joshavenue/flowscan_mcp"],
      "env": { "FLOWSCAN_HYPERLIQUID_DIRECT": "1" }
    }
  }
}
```

Over HTTP, Cascade uses `serverUrl` (a `url` key is also accepted per the docs):

```json
{
  "mcpServers": {
    "flowscan": { "serverUrl": "http://127.0.0.1:8787/mcp" }
  }
}
```

- Cascade supports tools, resources and prompts, and has a limit of 100 tools in total across servers.
- Values can use `${env:VAR}` and `${file:/path}`.
- Guidance: `.devin/rules/*.md` (preferred), `.windsurf/rules/*.md`, `.windsurfrules`, or `AGENTS.md` in any directory.

Devin CLI: `devin mcp add flowscan -- npx -y github:joshavenue/flowscan_mcp`, or `.devin/mcp_config.json` with the same `mcpServers` shape; HTTP entries use `"url"` there. Devin CLI turns MCP prompts into `/mcp__<server>__<prompt>` slash commands.

Docs: <https://docs.devin.ai/desktop/cascade/mcp>, <https://docs.devin.ai/desktop/devin-desktop-faq>, <https://docs.devin.ai/desktop/cascade/memories>, <https://docs.devin.ai/cli/extensibility/mcp/configuration>.

## Cline

Open the Cline panel, click the **MCP Servers** icon, the **Configure** tab, then **Configure MCP Servers**; that opens the extension's settings JSON (`cline_mcp_settings.json`). The Cline CLI reads `~/.cline/mcp.json`. See [examples/cline_mcp_settings.json](../examples/cline_mcp_settings.json).

```json
{
  "mcpServers": {
    "flowscan": {
      "command": "npx",
      "args": ["-y", "github:joshavenue/flowscan_mcp"],
      "env": { "FLOWSCAN_HYPERLIQUID_DIRECT": "1" },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Over HTTP:

```json
{
  "mcpServers": {
    "flowscan": {
      "type": "streamableHttp",
      "url": "http://127.0.0.1:8787/mcp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

- `autoApprove` lists tool names that run without asking. All flowscan tools are read-only, so listing the ones you use is reasonable.
- Guidance: `.clinerules/` (or `.cline/rules/`); Cline also detects `AGENTS.md`, `.cursorrules` and `.windsurfrules`.

Docs: <https://docs.cline.bot/mcp/configuring-mcp-servers>, <https://docs.cline.bot/customization/cline-rules>.

## Roo Code

Global `mcp_settings.json` (from Roo's MCP settings view) or `.roo/mcp.json` in the project (project wins on name clashes).

```json
{
  "mcpServers": {
    "flowscan": {
      "command": "npx",
      "args": ["-y", "github:joshavenue/flowscan_mcp"],
      "alwaysAllow": [],
      "disabled": false
    }
  }
}
```

Over HTTP: `{"type": "streamable-http", "url": "http://127.0.0.1:8787/mcp"}` in place of `command`/`args`. Note the different spelling from Cline (`streamable-http` vs `streamableHttp`). `alwaysAllow` auto-approves tools; `disabledTools` hides them.

Docs: <https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo> (formerly docs.roocode.com).

## Continue

Add a block file `.continue/mcpServers/flowscan.yaml` (it needs `name`, `version` and `schema`), or put the `mcpServers` entry in `config.yaml`. See [examples/continue.config.yaml](../examples/continue.config.yaml).

```yaml
name: Flowscan MCP
version: 0.0.1
schema: v1
mcpServers:
  - name: flowscan
    type: stdio
    command: npx
    args:
      - "-y"
      - "github:joshavenue/flowscan_mcp"
    env:
      FLOWSCAN_HYPERLIQUID_DIRECT: "1"
```

Over HTTP:

```yaml
mcpServers:
  - name: flowscan
    type: streamable-http
    url: http://127.0.0.1:8787/mcp
```

- MCP is only used in agent mode.
- Guidance: a Markdown rule in `.continue/rules/` with YAML frontmatter (for example `alwaysApply: true`).

Docs: <https://docs.continue.dev/customize/deep-dives/mcp>, <https://docs.continue.dev/reference>, <https://docs.continue.dev/customize/deep-dives/rules>.

## Zed

Settings: `context_servers` in Zed's `settings.json` (Settings, AI, MCP Servers, Add Server writes the same entries). See [examples/zed.settings.json](../examples/zed.settings.json).

```json
{
  "context_servers": {
    "flowscan": {
      "command": "npx",
      "args": ["-y", "github:joshavenue/flowscan_mcp"],
      "env": { "FLOWSCAN_HYPERLIQUID_DIRECT": "1" }
    }
  }
}
```

Over HTTP:

```json
{
  "context_servers": {
    "flowscan": { "url": "http://127.0.0.1:8787/mcp" }
  }
}
```

- Zed supports MCP tools and prompts, not resources. Zed's docs say that when a remote server has no `Authorization` header configured, Zed prompts you to authenticate with the MCP OAuth flow. This server has no authentication; how Zed behaves when the server offers no OAuth was not tested.
- Tool approval: `agent.tool_permissions.default` (`"confirm"` by default, `"allow"`, `"deny"`); MCP tools are named `mcp:<server>:<tool>` there.
- Guidance: `AGENTS.md` (Zed's primary instruction file) or `.rules`. Zed loads only the first match among `.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`.

Docs: <https://zed.dev/docs/ai/mcp>, <https://zed.dev/docs/ai/rules> (source: zed-industries/zed `docs/src/ai/`).

## JetBrains AI Assistant

Settings, Tools, AI Assistant, Model Context Protocol (MCP), **Add**, then paste JSON:

```json
{
  "mcpServers": {
    "flowscan": {
      "command": "npx",
      "args": ["-y", "github:joshavenue/flowscan_mcp"],
      "env": { "FLOWSCAN_HYPERLIQUID_DIRECT": "1" }
    }
  }
}
```

Over HTTP (Streamable HTTP; legacy SSE is also available): `{"mcpServers": {"flowscan": {"url": "http://127.0.0.1:8787/mcp"}}}`. Prompts and resources are not documented. Guidance: a Markdown file in `.aiassistant/rules/`. (Separately, JetBrains IDEs can act as an MCP server for other clients; that is unrelated.)

Docs: <https://www.jetbrains.com/help/ai-assistant/mcp.html>, <https://www.jetbrains.com/help/ai-assistant/configure-project-rules.html>.

## Google

### Gemini CLI

Config: `~/.gemini/settings.json` (user) or `.gemini/settings.json` (project). See [examples/gemini.settings.json](../examples/gemini.settings.json).

```json
{
  "mcpServers": {
    "flowscan": {
      "command": "npx",
      "args": ["-y", "github:joshavenue/flowscan_mcp"],
      "env": { "FLOWSCAN_HYPERLIQUID_DIRECT": "1" }
    }
  }
}
```

Over HTTP, use `httpUrl` (in Gemini CLI, `url` means the legacy SSE transport):

```json
{
  "mcpServers": {
    "flowscan": { "httpUrl": "http://127.0.0.1:8787/mcp" }
  }
}
```

From the command line (`--scope` defaults to `project`; arguments after `--` go to the server):

```sh
gemini mcp add --scope user flowscan npx -- -y github:joshavenue/flowscan_mcp
gemini mcp add --scope user -e FLOWSCAN_HYPERLIQUID_DIRECT=1 flowscan npx -- -y github:joshavenue/flowscan_mcp
gemini mcp add --scope user --transport http flowscan http://127.0.0.1:8787/mcp
```

- Tools get the fully qualified name `mcp_flowscan_<tool>` (for example `mcp_flowscan_flowscan_revenue_summary`). Names over 63 characters are truncated; the longest here is 50.
- Gemini CLI strips `$schema` and `additionalProperties` from tool schemas for the Gemini API. The server already lists portable schemas without `$schema`.
- Prompts become slash commands; resources can be referenced with `@flowscan://guide`.
- `includeTools` / `excludeTools` filter tools; `trust: true` skips confirmations.
- Guidance: `GEMINI.md` is the default context file, not `AGENTS.md`. Use a `GEMINI.md` containing the line `@./AGENTS.md`, or add `"context": {"fileName": ["AGENTS.md", "GEMINI.md"]}` to settings.json.

Docs: <https://geminicli.com/docs/tools/mcp-server/>, <https://geminicli.com/docs/cli/gemini-md/>.

### Gemini Code Assist

In VS Code agent mode, Gemini Code Assist reads MCP servers from the same `~/.gemini/settings.json` (`mcpServers`, `httpUrl` for remote). In IntelliJ it reads an `mcp.json` in the IDE's configuration directory. Context: `GEMINI.md` (IntelliJ: `GEMINI.md` or `AGENT.md`). Docs: <https://docs.cloud.google.com/gemini/docs/codeassist/use-agentic-chat-pair-programmer>.

### Google Antigravity

Config: `~/.gemini/config/mcp_config.json` (global) or `.agents/mcp_config.json` (workspace). In the IDE: agent panel menu, MCP Servers, Manage MCP Servers, View raw config.

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

Over HTTP, only `serverUrl` is accepted (not `url` or `httpUrl`): `{"mcpServers": {"flowscan": {"serverUrl": "http://127.0.0.1:8787/mcp"}}}`. Docs: <https://antigravity.google/docs/mcp>.

### Google ADK

```python
from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StdioConnectionParams, StreamableHTTPConnectionParams
from mcp import StdioServerParameters

flowscan = McpToolset(
    connection_params=StdioConnectionParams(
        server_params=StdioServerParameters(command="npx", args=["-y", "github:joshavenue/flowscan_mcp"]),
    ),
    # connection_params=StreamableHTTPConnectionParams(url="http://127.0.0.1:8787/mcp"),
)
root_agent = LlmAgent(model="gemini-flash-latest", name="flowscan_analyst", instruction="...", tools=[flowscan])
```

`McpToolset` can read resources (`use_mcp_resources=True`). Docs: <https://adk.dev/tools-custom/mcp-tools/>.

## xAI Grok

Grok can use MCP servers directly in three places.

**grok.com connectors.** Go to grok.com/connectors, New Connector, Custom, and enter the server URL. The server must be reachable over the public internet, so a local server needs a tunnel (see [Running over HTTP](#running-over-http)). On Grok Business and Enterprise, an admin provisions connectors first. Docs: <https://docs.x.ai/grok/connectors>.

**Grok Build (CLI).** Config: `~/.grok/config.toml` (`%USERPROFILE%\.grok\config.toml` on Windows; `$GROK_HOME` moves it).

```toml
[mcp_servers.flowscan]
command = "npx"
args = ["-y", "github:joshavenue/flowscan_mcp"]
startup_timeout_sec = 120
# env = { FLOWSCAN_HYPERLIQUID_DIRECT = "1" }

# Over HTTP instead:
# [mcp_servers.flowscan]
# url = "http://127.0.0.1:8787/mcp"
```

or `grok mcp add flowscan -- npx -y github:joshavenue/flowscan_mcp` (`grok mcp add --transport http flowscan http://127.0.0.1:8787/mcp` for HTTP). Grok Build also loads servers from `~/.claude.json`, `.cursor/mcp.json` and the project `.mcp.json` (below `config.toml` in priority), so an existing Claude Code or Cursor setup is picked up as is. Tools are named `flowscan__<tool>`. `startup_timeout_sec` defaults to 30; the first npx build may need more. `/mcps` in the TUI toggles servers; `grok mcp doctor` diagnoses them; stdio server stderr goes to `~/.grok/logs/mcp/<server>.stderr.log`. Docs: <https://docs.x.ai/build/features/mcp-servers>.

**xAI API (remote MCP tools).** Grok calls a remote MCP server server-side. Only Streaming HTTP and SSE are supported; `require_approval` and `connector_id` are not. The xAI docs do not say whether the URL must be public, but xAI's servers make the call, so assume it must be.

```python
import os
from xai_sdk import Client
from xai_sdk.chat import user
from xai_sdk.tools import mcp

client = Client(api_key=os.getenv("XAI_API_KEY"))
chat = client.chat.create(
    model="grok-4.7",  # the model named in xAI's remote MCP docs
    tools=[mcp(server_url="https://flowscan.example.com/mcp", server_label="flowscan")],
)
chat.append(user("Which builder earned the most revenue over the last 7 days?"))
print(chat.sample().content)
```

The same works through the OpenAI-compatible Responses API (`base_url="https://api.x.ai/v1"`, `tools=[{"type": "mcp", "server_url": ..., "server_label": "flowscan"}]`, optional `allowed_tools`). Docs: <https://docs.x.ai/developers/tools/remote-mcp>.

**Frameworks.** With a local stdio server and Grok as the model, use any MCP-capable framework with an xAI model: the Vercel AI SDK with `@ai-sdk/xai` ([examples/vercel-ai.ts](../examples/vercel-ai.ts); the provider also has `xai.tools.mcpServer()` for remote servers), LangChain with an `xai:` model, the OpenAI Agents SDK with xAI's OpenAI-compatible endpoint, or Hermes Agent with its xAI provider.

## Nous Research Hermes

**Hermes Agent** is an MCP client. Config: `mcp_servers` in `~/.hermes/config.yaml`.

```yaml
mcp_servers:
  flowscan:
    command: "npx"
    args: ["-y", "github:joshavenue/flowscan_mcp"]
    # env:
    #   FLOWSCAN_HYPERLIQUID_DIRECT: "1"

# Over HTTP instead:
#  flowscan:
#    url: "http://127.0.0.1:8787/mcp"
```

- Tools are registered as `mcp_<server>_<tool>`, so `mcp_flowscan_flowscan_revenue_summary`.
- When the server supports them, Hermes adds utility tools `mcp_flowscan_list_prompts` / `mcp_flowscan_get_prompt` and `mcp_flowscan_list_resources` / `mcp_flowscan_read_resource`, so the model can fetch `flowscan_guide` itself. Turn them off per server with `tools: {prompts: false, resources: false}`; filter tools with `tools: {include: [...], exclude: [...]}` (globs allowed).
- Only explicitly configured `env` values (plus a safe baseline) reach stdio servers.
- `/reload-mcp` reloads servers mid-session.
- Guidance: Hermes loads one project context file, first match of `.hermes.md` / `HERMES.md`, `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`.
- Hermes Agent runs on many providers (Nous Portal, OpenRouter, OpenAI, Anthropic, xAI, local OpenAI-compatible servers via `provider: custom` and `base_url`).

Docs: <https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp>, <https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files>, <https://hermes-agent.nousresearch.com/docs/integrations/providers>.

**Hermes 4 models** (outside Hermes Agent) have no MCP client of their own. Use them as the model in an MCP-capable framework through an OpenAI-compatible endpoint (Nous Portal, or your own vLLM / SGLang / llama.cpp server); see [Any OpenAI-compatible model](#any-openai-compatible-model).

## Agent frameworks

### LangChain and LangGraph

LangChain now ships MCP support as `langchain.mcp` (`pip install "langchain[mcp]"`, version 1.4.0 or newer, beta). It replaces `langchain-mcp-adapters`, whose README points to the new package. Full example: [examples/langchain-mcp.py](../examples/langchain-mcp.py).

```python
from langchain.agents import create_agent
from langchain.mcp import MCPAdapter

config = {"mcpServers": {"flowscan": {"command": "npx", "args": ["-y", "github:joshavenue/flowscan_mcp"]}}}
# HTTP: {"mcpServers": {"flowscan": {"url": "http://127.0.0.1:8787/mcp"}}}

async with MCPAdapter(config) as adapter:
    tools = await adapter.list_tools()
    agent = create_agent("openai:<model>", tools)
```

Prompts and resources are not wrapped by `langchain.mcp` yet; the migration guide says to use the FastMCP client directly. `await adapter.client.get_prompt("flowscan_guide")` returns the guide (tested with langchain 1.4.3). With one server the tools keep their names; with several servers in one config they are prefixed `{server}_{tool}`.

The older package still works: `from langchain_mcp_adapters.client import MultiServerMCPClient`, `MultiServerMCPClient({"flowscan": {"command": "npx", "args": [...], "transport": "stdio"}})`, `await client.get_tools()` (`"transport": "http"` with `"url"` for HTTP). Version 0.3.1 fails to import with mcp 2.x; pin `"mcp<2"` alongside it.

JavaScript (`@langchain/mcp-adapters`):

```ts
import { MCPAdapter } from "@langchain/mcp-adapters";
import { createAgent } from "langchain";

const adapter = new MCPAdapter({
  servers: { flowscan: { command: "npx", args: ["-y", "github:joshavenue/flowscan_mcp"] } },
  // HTTP: servers: { flowscan: { url: "http://127.0.0.1:8787/mcp" } }
});
try {
  const tools = await adapter.listTools();
  const agent = createAgent({ model: "<provider:model>", tools });
  // ... agent.invoke({ messages: [...] })
} finally {
  await adapter.close();
}
```

Docs: <https://docs.langchain.com/oss/python/langchain/mcp>, <https://docs.langchain.com/oss/python/migrate/langchain-mcp-adapters>, <https://docs.langchain.com/oss/javascript/langchain/mcp>.

### Vercel AI SDK

`createMCPClient` is in `@ai-sdk/mcp` (it was `experimental_createMCPClient` in `ai` in earlier versions). Full example with Grok: [examples/vercel-ai.ts](../examples/vercel-ai.ts).

```ts
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport as StdioClientTransport } from "@ai-sdk/mcp/mcp-stdio";

const mcpClient = await createMCPClient({
  transport: new StdioClientTransport({ command: "npx", args: ["-y", "github:joshavenue/flowscan_mcp"] }),
  // HTTP: transport: { type: "http", url: "http://127.0.0.1:8787/mcp" }
});
const tools = await mcpClient.tools();
// generateText({ model, tools, stopWhen: isStepCount(8), ... }), then await mcpClient.close()
```

Resources: `listResources()`, `readResource({ uri: "flowscan://guide" })`. Prompts: `experimental_listPrompts()`, `experimental_getPrompt()`. Multi-step tool use is `stopWhen: isStepCount(n)` in the current docs (older releases: `stepCountIs`, `maxSteps`). Docs: <https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools>, <https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling>.

### Pydantic AI

```python
from fastmcp.client.transports import StdioTransport
from pydantic_ai import Agent
from pydantic_ai.mcp import MCPToolset

flowscan = MCPToolset(StdioTransport(command="npx", args=["-y", "github:joshavenue/flowscan_mcp"]))
# HTTP: MCPToolset("http://127.0.0.1:8787/mcp")
agent = Agent("openai:<model>", toolsets=[flowscan])
```

Install `pydantic-ai-slim[mcp]`. Resources: `list_resources()`, `read_resource(uri)`. Docs: <https://pydantic.dev/docs/ai/mcp/client/> (formerly ai.pydantic.dev).

### CrewAI

```python
from crewai import Agent
from crewai.mcp import MCPServerStdio, MCPServerHTTP

analyst = Agent(
    role="Hyperliquid analyst",
    goal="Answer with Flowscan data only",
    backstory="...",
    mcps=[MCPServerStdio(command="npx", args=["-y", "github:joshavenue/flowscan_mcp"])],
    # mcps=[MCPServerHTTP(url="http://127.0.0.1:8787/mcp")],
)
```

CrewAI adapts MCP tools only (no prompts or resources); put the guidance in the agent's backstory or task. `MCPServerAdapter` from `crewai_tools` is the lower-level alternative. Docs: <https://docs.crewai.com/en/mcp/overview>.

### smolagents

```python
from mcp import StdioServerParameters
from smolagents import CodeAgent, MCPClient

params = StdioServerParameters(command="npx", args=["-y", "github:joshavenue/flowscan_mcp"])
# HTTP: params = {"url": "http://127.0.0.1:8787/mcp", "transport": "streamable-http"}
with MCPClient(params) as tools:
    agent = CodeAgent(tools=tools, model=model)
    agent.run("Which HIP-4 market has the most volume?")
```

Docs: <https://huggingface.co/docs/smolagents/tutorials/tools>.

### Any OpenAI-compatible model

Models without an MCP client of their own (Hermes 4, models served by vLLM, SGLang, llama.cpp or LM Studio, and others behind an OpenAI-compatible API) can use the server through a framework that is an MCP client. The OpenAI Agents SDK is one option:

```python
from agents import Agent, AsyncOpenAI, OpenAIChatCompletionsModel, Runner, set_tracing_disabled
from agents.mcp import MCPServerStdio

set_tracing_disabled(disabled=True)
model = OpenAIChatCompletionsModel(
    model="<model name>",
    openai_client=AsyncOpenAI(base_url="<provider base URL>/v1", api_key="<key>"),
)
async with MCPServerStdio(
    name="flowscan",
    params={"command": "npx", "args": ["-y", "github:joshavenue/flowscan_mcp"]},
    client_session_timeout_seconds=60,
) as server:
    agent = Agent(name="Flowscan analyst", instructions="...", model=model, mcp_servers=[server])
    print((await Runner.run(agent, "Top builders this week?")).final_output)
```

The model must support tool calling through the Chat Completions API. LangChain, Pydantic AI, the Vercel AI SDK (`@ai-sdk/openai-compatible`) and Hermes Agent (`provider: custom`) work the same way. Docs: <https://openai.github.io/openai-agents-python/models/>.

## What could not be verified

These points are stated with less certainty above, or left out:

- Claude Desktop: whether its local (non-connector) MCP setup exposes prompts and resources was not checked for this page.
- Codex: prompt support is absent from the docs and from the MCP client source; resource support comes from the source (`list_mcp_resources`, `read_mcp_resource`), not the docs.
- ChatGPT developer mode: OpenAI's two pages name the menu path differently over time; the steps above follow developers.openai.com as of 2026-10-02. Whether ChatGPT uses MCP prompts or resources is not documented.
- Cursor: the 40-tool cap comes from Cursor forum threads (2025); the current docs state no number.
- Devin Desktop (Windsurf): the config path for the new Devin Local agent is not documented on the desktop MCP page; the path given is for the Cascade agent. The legacy `~/.codeium/windsurf/mcp_config.json` path is from older Windsurf releases and is not on the current page.
- Roo Code: the rules file location was not checked.
- Grok Build: whether it reads `AGENTS.md`, and whether it, grok.com or the xAI API use MCP prompts or resources, is not documented.
- Zed: behaviour with a remote server that offers no OAuth was not tested.
- Nous Portal's base URL is not given on a Nous-owned page that was checked, so none is printed here; use the one from your Nous Portal account.

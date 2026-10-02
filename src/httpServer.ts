/**
 * Streamable HTTP transport (MCP 2025-03-26+), plus the legacy HTTP+SSE transport.
 *
 *   POST/GET/DELETE /mcp   Streamable HTTP (what ChatGPT connectors, the OpenAI
 *                          Responses API, Codex, Cursor, VS Code, Gemini CLI, ... use)
 *   GET /sse + POST /messages   legacy HTTP+SSE (2024-11-05) for older clients
 *   GET /healthz           {ok, mode, tools, ...}
 *
 * Default is STATELESS: every POST gets a fresh McpServer + transport and no
 * Mcp-Session-Id is issued. That is what hosted clients expect, scales behind a
 * load balancer, and works with the SDK's own StreamableHTTPClientTransport
 * (its optional GET stream gets 405, which the spec allows). The tools never
 * send server-initiated messages, so nothing is lost. `--stateful` keeps
 * in-memory sessions (Mcp-Session-Id, GET stream, DELETE) for clients that want them.
 *
 * Security: no authentication. Binds 127.0.0.1 by default and then only accepts
 * Host headers naming localhost (DNS-rebinding protection, as the SDK's
 * hostHeaderValidation middleware does). Browser Origins are refused unless
 * listed in FLOWSCAN_MCP_CORS (or local when bound locally).
 */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { registeredToolNames } from "./register.js";
import { hyperliquidDirectEnabled } from "./upstream.js";

export type HttpOptions = {
  port: number;
  host: string;
  /** Keep in-memory sessions (Mcp-Session-Id). Default false (stateless). */
  stateful?: boolean;
  /** Allowed browser origins for CORS ("*" = any). Default none. */
  corsOrigins?: string[];
  /** Extra Host header names to accept (e.g. a reverse proxy's public name). */
  allowedHosts?: string[];
  /** Idle session lifetime in stateful mode. */
  sessionTtlMs?: number;
  log?: (line: string) => void;
};

export type RunningHttpServer = { url: string; port: number; close: () => Promise<void> };

export const MCP_PATH = "/mcp";
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 1000;

export function isLoopback(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.toLowerCase()) || /^127\./.test(host);
}

/** Hostname part of a Host header ("localhost:8787" -> "localhost", "[::1]:8787" -> "[::1]"). */
function hostName(header: string | undefined): string {
  if (!header) return "";
  const h = header.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; message: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return { ok: false, status: 413, message: `Request body over ${MAX_BODY_BYTES} bytes` };
    chunks.push(chunk as Buffer);
  }
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, message: "Parse error: body is not valid JSON" };
  }
}

export async function startHttpServer(opts: HttpOptions): Promise<RunningHttpServer> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const local = isLoopback(opts.host);
  const allowedHosts = local ? [...LOOPBACK_HOSTS, ...(opts.allowedHosts ?? [])] : opts.allowedHosts?.length ? opts.allowedHosts : null;
  const allowedHostSet = allowedHosts ? new Set(allowedHosts.map((h) => h.toLowerCase())) : null;
  const cors = new Set(opts.corsOrigins ?? []);
  const ttl = opts.sessionTtlMs ?? 30 * 60_000;
  const toolCount = registeredToolNames(createServer()).length;
  const mode = hyperliquidDirectEnabled() ? "hyperliquid-direct" : "strict";

  type Session = { transport: StreamableHTTPServerTransport | SSEServerTransport; server: McpServer; lastSeen: number };
  const sessions = new Map<string, Session>();

  const closeSession = (id: string): void => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void s.transport.close().catch(() => {});
    void s.server.close().catch(() => {});
  };

  const originAllowed = (origin: string): boolean => {
    if (cors.has("*") || cors.has(origin)) return true;
    if (!local) return false;
    try {
      return LOOPBACK_HOSTS.includes(new URL(origin).hostname.toLowerCase()) || new URL(origin).hostname === "::1";
    } catch {
      return false;
    }
  };

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

    if (!opts.stateful) {
      if (method !== "POST") {
        jsonRpcError(res, 405, -32000, "Method not allowed: this server is stateless (POST only; no session stream).", { Allow: "POST, OPTIONS" });
        return;
      }
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return jsonRpcError(res, parsed.status, parsed.status === 413 ? -32000 : -32700, parsed.message);
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed.body);
      return;
    }

    // Stateful sessions.
    if (sessionId) {
      const s = sessions.get(sessionId);
      if (!s || !(s.transport instanceof StreamableHTTPServerTransport)) return jsonRpcError(res, 404, -32001, "Session not found");
      s.lastSeen = Date.now();
      let body: unknown;
      if (method === "POST") {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) return jsonRpcError(res, parsed.status, parsed.status === 413 ? -32000 : -32700, parsed.message);
        body = parsed.body;
      }
      await s.transport.handleRequest(req, res, body);
      return;
    }
    if (method !== "POST") return jsonRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header required");
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return jsonRpcError(res, parsed.status, parsed.status === 413 ? -32000 : -32700, parsed.message);
    const isInit = Array.isArray(parsed.body) ? parsed.body.some((m) => isInitializeRequest(m)) : isInitializeRequest(parsed.body);
    if (!isInit) return jsonRpcError(res, 400, -32000, "Bad Request: no valid session ID; send initialize first");
    if (sessions.size >= MAX_SESSIONS) return jsonRpcError(res, 503, -32000, "Too many sessions");
    const server = createServer();
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, lastSeen: Date.now() });
      },
      onsessionclosed: (id) => closeSession(id),
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed.body);
  }

  async function handleLegacySse(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === "/sse" && req.method === "GET") {
      if (sessions.size >= MAX_SESSIONS) return jsonRpcError(res, 503, -32000, "Too many sessions");
      const transport = new SSEServerTransport("/messages", res);
      const server = createServer();
      sessions.set(transport.sessionId, { transport, server, lastSeen: Date.now() });
      res.on("close", () => closeSession(transport.sessionId));
      await server.connect(transport);
      return;
    }
    if (url.pathname === "/messages" && req.method === "POST") {
      const s = sessions.get(url.searchParams.get("sessionId") ?? "");
      if (!s || !(s.transport instanceof SSEServerTransport)) return jsonRpcError(res, 404, -32001, "Session not found");
      s.lastSeen = Date.now();
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return jsonRpcError(res, parsed.status, -32700, parsed.message);
      await s.transport.handlePostMessage(req, res, parsed.body);
      return;
    }
    jsonRpcError(res, 405, -32000, "Method not allowed", { Allow: url.pathname === "/sse" ? "GET" : "POST" });
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (allowedHostSet && !allowedHostSet.has(hostName(req.headers.host))) {
        return jsonRpcError(res, 403, -32000, `Forbidden: Host '${hostName(req.headers.host)}' not allowed (set FLOWSCAN_MCP_ALLOWED_HOSTS)`);
      }
      const origin = req.headers.origin;
      if (origin) {
        if (!originAllowed(origin)) return jsonRpcError(res, 403, -32000, `Forbidden: Origin '${origin}' not allowed (set FLOWSCAN_MCP_CORS)`);
        res.setHeader("Access-Control-Allow-Origin", cors.has("*") ? "*" : origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
          "Access-Control-Max-Age": "86400",
        });
        return void res.end();
      }
      if (url.pathname === "/healthz" || url.pathname === "/") {
        if (req.method !== "GET" && req.method !== "HEAD") return jsonRpcError(res, 405, -32000, "Method not allowed", { Allow: "GET" });
        return sendJson(res, 200, { ok: true, name: SERVER_NAME, version: SERVER_VERSION, mode, tools: toolCount, transport: "streamable-http", endpoint: MCP_PATH, stateful: Boolean(opts.stateful), legacySse: "/sse" });
      }
      if (url.pathname === MCP_PATH) return await handleMcp(req, res);
      if (url.pathname === "/sse" || url.pathname === "/messages") return await handleLegacySse(req, res, url);
      jsonRpcError(res, 404, -32000, `Not found. MCP endpoint: ${MCP_PATH}`);
    } catch (err) {
      log(`flowscan-mcp http error: ${(err as Error).stack ?? err}`);
      jsonRpcError(res, 500, -32603, "Internal server error");
    }
  });

  const sweep = setInterval(() => {
    const cutoff = Date.now() - ttl;
    for (const [id, s] of sessions) if (s.lastSeen < cutoff && s.transport instanceof StreamableHTTPServerTransport) closeSession(id);
  }, 60_000);
  sweep.unref();

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, () => resolve());
  });
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  const shownHost = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  const url = `http://${shownHost}:${port}${MCP_PATH}`;

  return {
    url,
    port,
    close: async () => {
      clearInterval(sweep);
      for (const id of [...sessions.keys()]) closeSession(id);
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
    },
  };
}

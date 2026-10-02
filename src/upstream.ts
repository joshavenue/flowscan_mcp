/**
 * Opt-in "Hyperliquid-direct" transport (FLOWSCAN_HYPERLIQUID_DIRECT=1).
 *
 * Some Flowscan panels are not served by flowscan.xyz routes: the Flowscan web
 * page fetches them in the browser directly from Hyperliquid hosts (block and tx
 * details, the live block/tx feed, prices, candles, the address page's portfolio
 * chart, EVM balance and Unit bridge operations, ...). In this mode the server
 * makes the same requests to the same hosts, and nothing more.
 *
 * Hard rules enforced here (and unit-tested):
 *   - off by default: with the switch unset every call is refused before any I/O;
 *   - when on, only these hosts, over https:// or wss://, on the default port:
 *       api.hyperliquid.xyz, rpc.hyperliquid.xyz, api-ui.hyperliquid.xyz, api.hyperunit.xyz
 *   - mainnet only (these are the mainnet hosts Flowscan uses);
 *   - concurrency 2, short caches, 4xx (including 429) never retried.
 *
 * www.flowscan.xyz traffic stays in src/client.ts, which is unchanged by this mode.
 */
import { cachedRun, fetchOnce, Semaphore, TtlCache, withRetries } from "./http.js";

export const DIRECT_ENV = "FLOWSCAN_HYPERLIQUID_DIRECT";
export const DIRECT_MODE = "hyperliquid-direct" as const;

/** True when FLOWSCAN_HYPERLIQUID_DIRECT is "1" or "true" (case-insensitive). Read at call time. */
export function hyperliquidDirectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true)$/i.test((env[DIRECT_ENV] ?? "").trim());
}

/** Exactly the hosts the Flowscan web page contacts from the browser. */
export const UPSTREAM_HOSTS = ["api.hyperliquid.xyz", "rpc.hyperliquid.xyz", "api-ui.hyperliquid.xyz", "api.hyperunit.xyz"] as const;

/** The concrete endpoints, as found in Flowscan's JS bundles. */
export const ENDPOINTS = {
  info: "https://api.hyperliquid.xyz/info",
  uiInfo: "https://api-ui.hyperliquid.xyz/info",
  explorer: "https://rpc.hyperliquid.xyz/explorer",
  evm: "https://rpc.hyperliquid.xyz/evm",
  explorerWs: "wss://rpc.hyperliquid.xyz/ws",
  infoWs: "wss://api.hyperliquid.xyz/ws",
  unitOperations: (address: string) => `https://api.hyperunit.xyz/operations/${encodeURIComponent(address)}`,
} as const;

const USER_AGENT = `flowscan-mcp/${process.env.npm_package_version ?? "0.1.0"} (+https://github.com/joshavenue/flowscan_mcp)`;
const TIMEOUT_MS = Number(process.env.FLOWSCAN_TIMEOUT_MS ?? 30_000);
const MAX_CONCURRENCY = 2;
const MAX_RETRIES = 2;
/** Default TTL for upstream responses without a more specific one. */
export const TTL = { prices: 5_000, metas: 60_000, short: 10_000, explorer: 30_000, none: 0 } as const;

export class UpstreamError extends Error {
  /** Host-level provenance for error results. */
  public readonly source: string;
  constructor(
    message: string,
    public readonly status: number | null,
    /** The upstream URL (and for POSTs the request type), e.g. "https://api.hyperliquid.xyz/info {type:l2Book}". */
    public readonly route: string,
    public readonly body?: unknown,
    public readonly retryable: boolean = false,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "UpstreamError";
    let host = "?";
    try {
      host = new URL(route.split(" ")[0]).host;
    } catch {
      /* keep ? */
    }
    this.source = host;
  }
}

/**
 * Validate an upstream URL against the mode switch and the host allowlist.
 * Throws before any I/O when the mode is off or the host/scheme/port is not allowed.
 */
export function assertUpstreamAllowed(url: string, protocols: readonly string[] = ["https:"]): URL {
  if (!hyperliquidDirectEnabled()) {
    throw new UpstreamError(`Hyperliquid-direct mode is off: refusing to contact ${safeHost(url)}. Set ${DIRECT_ENV}=1 to enable it.`, null, url);
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UpstreamError(`Refusing malformed upstream URL: ${url}`, null, url);
  }
  if (!protocols.includes(u.protocol)) throw new UpstreamError(`Refusing ${u.protocol}// URL (allowed: ${protocols.join(", ")}): ${url}`, null, url);
  if (!(UPSTREAM_HOSTS as readonly string[]).includes(u.hostname) || u.port !== "" || u.username || u.password) {
    throw new UpstreamError(`Refusing to contact ${u.host}: allowed upstream hosts are ${UPSTREAM_HOSTS.join(", ")}`, null, url);
  }
  return u;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const cache = new TtlCache();
const semaphore = new Semaphore(MAX_CONCURRENCY);

function describe(url: string, body?: Record<string, unknown>): string {
  if (!body) return url;
  if (typeof body.type === "string") return `${url} {type:${body.type}}`;
  if (typeof body.method === "string") return `${url} {method:${body.method}}`;
  return url;
}

function retryAfterSeconds(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const n = Number.parseInt(h, 10);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, Math.round((t - Date.now()) / 1000)) : null;
}

async function doFetch(url: string, init: RequestInit, label: string): Promise<unknown> {
  const host = safeHost(url);
  const reqInit: RequestInit = { ...init, headers: { accept: "application/json", "user-agent": USER_AGENT, ...(init.headers ?? {}) } };
  return withRetries<unknown>(
    MAX_RETRIES,
    () =>
      fetchOnce<unknown>(
        url,
        reqInit,
        TIMEOUT_MS,
        (res, _text, body) => {
          if (res.ok) return { ok: true, value: body };
          if (res.status === 429) {
            const ra = retryAfterSeconds(res);
            const wait = ra ?? 60;
            return {
              ok: false,
              error: new UpstreamError(
                `Rate limited by ${host} (HTTP 429). Hyperliquid limits requests per IP by weight; this request was not retried.`,
                429,
                label,
                body,
                false,
                `Wait about ${wait}s before retrying, and prefer fewer/narrower calls (smaller bars, one coin at a time).`,
              ),
            };
          }
          // 5xx are retried; every other 4xx is surfaced immediately (retrying cannot help).
          const retryable = res.status >= 500;
          const upstreamMsg = typeof body === "string" ? body.slice(0, 200) : body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error).slice(0, 200) : "";
          return { ok: false, error: new UpstreamError(`${host} returned HTTP ${res.status}${upstreamMsg ? `: ${upstreamMsg}` : ""}`, res.status, label, body, retryable) };
        },
        (aborted, err) => new UpstreamError(aborted ? `${host} request timed out after ${TIMEOUT_MS}ms` : `Network error reaching ${host}: ${err.message}`, null, label, undefined, true),
      ),
    () => new UpstreamError(`${host} request failed`, null, label),
  );
}

/**
 * POST a JSON body to an allowed upstream URL. `check` runs inside the cached
 * promise, so an error payload delivered with HTTP 200 (the explorer and EVM RPC
 * do this) is thrown and never cached.
 */
export function upstreamPost<T = unknown>(url: string, body: Record<string, unknown>, opts: { ttlMs?: number; check?: (v: unknown) => T } = {}): Promise<T> {
  try {
    assertUpstreamAllowed(url);
  } catch (e) {
    return Promise.reject(e);
  }
  const payload = JSON.stringify(body);
  const label = describe(url, body);
  const ttl = opts.ttlMs ?? TTL.short;
  return cachedRun(cache, semaphore, `POST ${url} ${payload}`, ttl, async () => {
    const v = await doFetch(url, { method: "POST", body: payload, headers: { "content-type": "application/json" } }, label);
    return opts.check ? opts.check(v) : (v as T);
  });
}

/** GET an allowed upstream URL. */
export function upstreamGet<T = unknown>(url: string, opts: { ttlMs?: number; headers?: Record<string, string>; check?: (v: unknown) => T } = {}): Promise<T> {
  try {
    assertUpstreamAllowed(url);
  } catch (e) {
    return Promise.reject(e);
  }
  const ttl = opts.ttlMs ?? TTL.short;
  return cachedRun(cache, semaphore, `GET ${url}`, ttl, async () => {
    const v = await doFetch(url, { method: "GET", headers: opts.headers ?? {} }, url);
    return opts.check ? opts.check(v) : (v as T);
  });
}

export function clearUpstreamCache(): void {
  cache.clear();
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

const wsSemaphore = new Semaphore(MAX_CONCURRENCY);
const WS_CONNECT_TIMEOUT_MS = 10_000;

export interface WsCollectResult {
  messages: number;
  /** ms from start until the socket opened (null if it never did). */
  openMs: number | null;
  /** Why collection ended. */
  ended: "duration" | "done" | "closed";
}

/**
 * Open a WebSocket to an allowed wss:// host, send `subscribe` for each
 * subscription (exactly the frames the Flowscan page sends), feed every parsed
 * message to `onMessage`, and close after `durationMs` or as soon as onMessage
 * returns true. Hard cap: durationMs + connect timeout. The socket is always closed.
 */
export async function wsCollect(opts: { url: string; subscriptions: Array<Record<string, unknown>>; durationMs: number; onMessage: (msg: unknown) => boolean | void }): Promise<WsCollectResult> {
  assertUpstreamAllowed(opts.url, ["wss:"]);
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (typeof WS !== "function") throw new UpstreamError("This tool needs a global WebSocket (Node.js 22 or newer).", null, opts.url);
  const release = await wsSemaphore.acquire();
  const t0 = Date.now();
  let ws: WebSocket | undefined;
  try {
    return await new Promise<WsCollectResult>((resolve, reject) => {
      let messages = 0;
      let openMs: number | null = null;
      let settled = false;
      let durationTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (err: Error | null, ended: WsCollectResult["ended"] = "duration") => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        if (durationTimer) clearTimeout(durationTimer);
        if (err) reject(err);
        else resolve({ messages, openMs, ended });
      };
      const connectTimer = setTimeout(() => finish(new UpstreamError(`WebSocket to ${safeHost(opts.url)} did not open within ${WS_CONNECT_TIMEOUT_MS}ms`, null, opts.url, undefined, true)), WS_CONNECT_TIMEOUT_MS);
      try {
        ws = new WS(opts.url);
      } catch (e) {
        finish(new UpstreamError(`Could not open WebSocket to ${safeHost(opts.url)}: ${(e as Error).message}`, null, opts.url, undefined, true));
        return;
      }
      ws.onopen = () => {
        openMs = Date.now() - t0;
        clearTimeout(connectTimer);
        for (const s of opts.subscriptions) ws!.send(JSON.stringify({ method: "subscribe", subscription: s }));
        durationTimer = setTimeout(() => finish(null, "duration"), opts.durationMs);
      };
      ws.onmessage = (ev: MessageEvent) => {
        messages++;
        let msg: unknown;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        try {
          if (opts.onMessage(msg) === true) finish(null, "done");
        } catch (e) {
          finish(e as Error);
        }
      };
      ws.onerror = () => {
        if (openMs === null) finish(new UpstreamError(`WebSocket error connecting to ${safeHost(opts.url)}`, null, opts.url, undefined, true));
      };
      ws.onclose = () => finish(openMs === null ? new UpstreamError(`WebSocket to ${safeHost(opts.url)} closed before opening`, null, opts.url, undefined, true) : null, "closed");
    });
  } finally {
    try {
      if (ws) {
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      }
    } catch {
      /* already closed */
    }
    release();
  }
}

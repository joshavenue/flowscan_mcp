/**
 * HTTP client for www.flowscan.xyz.
 *
 * Hard rule: this is the ONLY place in the server that performs network I/O,
 * and it only ever talks to the Flowscan host. No Hyperliquid, Hydromancer or
 * other upstream endpoints are contacted directly; everything goes through the
 * routes that Flowscan's own frontend uses.
 */

export const FLOWSCAN_BASE_URL = (process.env.FLOWSCAN_BASE_URL ?? "https://www.flowscan.xyz").replace(/\/+$/, "");
export const NETWORK = "mainnet" as const; // flowscan.xyz only serves Hyperliquid mainnet

const USER_AGENT = `flowscan-mcp/${process.env.npm_package_version ?? "0.1.0"} (+https://github.com/joshavenue/flowscan_mcp)`;
const TIMEOUT_MS = Number(process.env.FLOWSCAN_TIMEOUT_MS ?? 45_000);
const MAX_CONCURRENCY = Number(process.env.FLOWSCAN_MAX_CONCURRENCY ?? 4);
const CACHE_TTL_MS = Number(process.env.FLOWSCAN_CACHE_TTL_MS ?? 20_000);
const MAX_RETRIES = 2;

export class FlowscanError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly route: string,
    public readonly body?: unknown,
    /** True for 429/5xx, timeouts and network failures; false for other 4xx (retrying cannot help). */
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "FlowscanError";
  }
}

type Json = unknown;

interface CacheEntry {
  expires: number;
  value: Promise<Json>;
}

const cache = new Map<string, CacheEntry>();

// Small semaphore so an agent firing many tools at once does not hammer the site.
let active = 0;
const waiters: Array<() => void> = [];
async function acquire(): Promise<() => void> {
  if (active < MAX_CONCURRENCY) {
    active++;
    return release;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
  return release;
}
function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function doFetch(route: string, init: RequestInit): Promise<Json> {
  const url = `${FLOWSCAN_BASE_URL}${route}`;
  let lastErr: FlowscanError | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": USER_AGENT,
          ...(init.headers ?? {}),
        },
      });
      text = await res.text();
    } catch (err) {
      const aborted = (err as { name?: string })?.name === "AbortError";
      lastErr = new FlowscanError(
        aborted ? `Flowscan request timed out after ${TIMEOUT_MS}ms (${route})` : `Network error reaching Flowscan (${route}): ${(err as Error).message}`,
        null,
        route,
        undefined,
        true,
      );
      continue;
    } finally {
      clearTimeout(timer);
    }

    let body: Json = text;
    try {
      body = text.length ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body, keep as text */
    }
    if (res.ok) return body;

    // Hydromancer-backed routes answer malformed queries (e.g. an unknown dex) with a
    // deterministic 500 "...Check your request body"; retrying cannot help.
    const deterministic = typeof text === "string" && /check your request body/i.test(text);
    const retryable = (res.status === 429 || res.status >= 500) && !deterministic;
    const msg =
      (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : null) ?? `Flowscan returned HTTP ${res.status} for ${route}`;
    lastErr = new FlowscanError(msg, res.status, route, body, retryable);
    // Non-retryable client errors (400/404/...) are surfaced immediately.
    if (!retryable) throw lastErr;
  }
  throw lastErr ?? new FlowscanError(`Flowscan request failed (${route})`, null, route);
}

async function request(route: string, init: RequestInit, cacheKey: string | null, ttlMs = CACHE_TTL_MS): Promise<Json> {
  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.value;
  }
  const run = (async () => {
    const done = await acquire();
    try {
      return await doFetch(route, init);
    } finally {
      done();
    }
  })();
  if (cacheKey) {
    cache.set(cacheKey, { expires: Date.now() + ttlMs, value: run });
    run.catch(() => cache.delete(cacheKey));
    if (cache.size > 500) {
      const now = Date.now();
      for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
    }
  }
  return run;
}

export type QueryValue = string | number | boolean | undefined | null;

export function buildQuery(params: Record<string, QueryValue>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** GET a Flowscan JSON route, e.g. get("/api/stablecoin/current"). */
export function get(route: string, params: Record<string, QueryValue> = {}, opts: { ttlMs?: number } = {}): Promise<Json> {
  const full = `${route}${buildQuery(params)}`;
  return request(full, { method: "GET" }, `GET ${full}`, opts.ttlMs);
}

/** Multi-megabyte, slowly-changing payloads (HIP-3 snapshot, builder intelligence) get a longer cache. */
export const LONG_TTL_MS = Number(process.env.FLOWSCAN_LONG_CACHE_TTL_MS ?? 5 * 60_000);

/** POST a JSON body to a Flowscan route, e.g. post("/api/gossip/info", {type:"hypercoreFeeSummary"}). */
export function post(route: string, body: Record<string, unknown>): Promise<Json> {
  const payload = JSON.stringify(body);
  return request(route, { method: "POST", body: payload, headers: { "content-type": "application/json" } }, `POST ${route} ${payload}`);
}

export function clearCache(): void {
  cache.clear();
}

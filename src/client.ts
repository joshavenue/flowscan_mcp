/**
 * HTTP client for www.flowscan.xyz.
 *
 * Hard rule: this module only ever talks to https://www.flowscan.xyz (every URL
 * is checked by flowscanUrl() before the request). By default it is the only
 * network module in the server. The opt-in Hyperliquid-direct mode
 * (FLOWSCAN_HYPERLIQUID_DIRECT=1) adds a SEPARATE module, src/upstream.ts, with
 * its own allowlist; nothing in this file changes in that mode.
 */

import { cachedRun, fetchOnce, Semaphore, TtlCache, withRetries } from "./http.js";

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

/** The only host this module ever contacts. */
export const FLOWSCAN_HOST = "www.flowscan.xyz";

const cache = new TtlCache();
// Small semaphore so an agent firing many tools at once does not hammer the site.
const semaphore = new Semaphore(MAX_CONCURRENCY);

/** Build the absolute URL for a route and refuse anything that is not https://www.flowscan.xyz. */
export function flowscanUrl(route: string): string {
  const url = `${FLOWSCAN_BASE_URL}${route}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FlowscanError(`Refusing malformed Flowscan URL (${route})`, null, route);
  }
  if (parsed.protocol !== "https:" || parsed.host !== FLOWSCAN_HOST || parsed.username || parsed.password) {
    throw new FlowscanError(`Refusing to contact ${parsed.protocol}//${parsed.host}: this client only talks to https://${FLOWSCAN_HOST}`, null, route);
  }
  return url;
}

async function doFetch(route: string, init: RequestInit): Promise<Json> {
  const url = flowscanUrl(route);
  const reqInit: RequestInit = {
    ...init,
    headers: {
      accept: "application/json",
      "user-agent": USER_AGENT,
      ...(init.headers ?? {}),
    },
  };
  return withRetries<Json>(
    MAX_RETRIES,
    () =>
      fetchOnce<Json>(
        url,
        reqInit,
        TIMEOUT_MS,
        (res, text, body) => {
          if (res.ok) return { ok: true, value: body };
          // Hydromancer-backed routes answer malformed queries (e.g. an unknown dex) with a
          // deterministic 500 "...Check your request body"; retrying cannot help.
          const deterministic = typeof text === "string" && /check your request body/i.test(text);
          const retryable = (res.status === 429 || res.status >= 500) && !deterministic;
          const msg =
            (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
              ? (body as { error: string }).error
              : null) ?? `Flowscan returned HTTP ${res.status} for ${route}`;
          // Non-retryable client errors (400/404/...) are surfaced immediately.
          return { ok: false, error: new FlowscanError(msg, res.status, route, body, retryable) };
        },
        (aborted, err) =>
          new FlowscanError(
            aborted ? `Flowscan request timed out after ${TIMEOUT_MS}ms (${route})` : `Network error reaching Flowscan (${route}): ${err.message}`,
            null,
            route,
            undefined,
            true,
          ),
      ),
    () => new FlowscanError(`Flowscan request failed (${route})`, null, route),
  );
}

function request(route: string, init: RequestInit, cacheKey: string | null, ttlMs = CACHE_TTL_MS): Promise<Json> {
  return cachedRun(cache, semaphore, cacheKey, ttlMs, () => doFetch(route, init));
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

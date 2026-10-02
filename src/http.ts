/**
 * Transport primitives shared by the two network modules:
 *   - src/client.ts   (www.flowscan.xyz only; always on)
 *   - src/upstream.ts (Hyperliquid hosts the Flowscan page calls from the browser; opt-in)
 *
 * Each module creates its own Semaphore and TtlCache instances (different limits)
 * but uses the same retry loop. Nothing here performs I/O on its own: the caller
 * passes the URL it has already validated.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Counting semaphore: at most `max` holders at once, FIFO wake-up. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(public readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    };
  }

  get inUse(): number {
    return this.active;
  }
}

/** Promise cache with per-entry TTL; rejected promises are evicted so errors are never cached. */
export class TtlCache {
  private readonly map = new Map<string, { expires: number; value: Promise<unknown> }>();
  constructor(private readonly maxEntries = 500) {}

  get(key: string): Promise<unknown> | undefined {
    const hit = this.map.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    return undefined;
  }

  set(key: string, value: Promise<unknown>, ttlMs: number): void {
    this.map.set(key, { expires: Date.now() + ttlMs, value });
    value.catch(() => {
      if (this.map.get(key)?.value === value) this.map.delete(key);
    });
    if (this.map.size > this.maxEntries) {
      const now = Date.now();
      for (const [k, v] of this.map) if (v.expires <= now) this.map.delete(k);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

/** Run `fn` under the semaphore, memoised in `cache` for `ttlMs` when a key is given. */
export function cachedRun<T>(cache: TtlCache, sem: Semaphore, key: string | null, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  if (key && ttlMs > 0) {
    const hit = cache.get(key);
    if (hit) return hit as Promise<T>;
  }
  const run = (async () => {
    const done = await sem.acquire();
    try {
      return await fn();
    } finally {
      done();
    }
  })();
  if (key && ttlMs > 0) cache.set(key, run, ttlMs);
  return run;
}

export type AttemptOutcome<T> = { ok: true; value: T } | { ok: false; error: Error & { retryable?: boolean } };

/**
 * One fetch with a timeout, then hand the response to `classify`. Network errors
 * and timeouts become `onNetworkError(...)` (always retryable).
 */
export async function fetchOnce<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  classify: (res: Response, text: string, body: unknown) => AttemptOutcome<T>,
  onNetworkError: (aborted: boolean, err: Error) => Error & { retryable?: boolean },
): Promise<AttemptOutcome<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
    text = await res.text();
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    return { ok: false, error: onNetworkError(aborted, err as Error) };
  } finally {
    clearTimeout(timer);
  }
  let body: unknown = text;
  try {
    body = text.length ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body, keep as text */
  }
  return classify(res, text, body);
}

/**
 * Retry loop shared by both clients: attempts = 1 + maxRetries, exponential
 * backoff (400ms, 800ms, ...), and only errors flagged `retryable` are retried.
 */
export async function withRetries<T>(maxRetries: number, attempt: () => Promise<AttemptOutcome<T>>, fallback: () => Error): Promise<T> {
  let lastErr: Error | undefined;
  for (let i = 0; i <= maxRetries; i++) {
    if (i > 0) await sleep(400 * 2 ** (i - 1));
    const out = await attempt();
    if (out.ok) return out.value;
    lastErr = out.error;
    if (!out.error.retryable) throw out.error;
  }
  throw lastErr ?? fallback();
}

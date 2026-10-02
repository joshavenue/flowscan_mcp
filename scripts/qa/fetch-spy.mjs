// Preloaded into the server process (NODE_OPTIONS=--import) by the QA harness and the smoke test.
// Wraps globalThis.fetch and globalThis.WebSocket to log every outbound request host to stderr,
// so the harness can verify which hosts are contacted (only www.flowscan.xyz in strict mode;
// plus the four allowlisted Hyperliquid/Unit hosts in hyperliquid-direct mode) and that the
// concurrency limits are respected. `inflight`/`max` are counted per group: "flowscan"
// (www.flowscan.xyz, FLOWSCAN_MAX_CONCURRENCY) and "upstream" (every other host, limit 2).
const orig = globalThis.fetch;
const inFlight = { flowscan: 0, upstream: 0 };
const maxInFlight = { flowscan: 0, upstream: 0 };
const groupOf = (host) => (host === "www.flowscan.xyz" ? "flowscan" : "upstream");
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
};

globalThis.fetch = async function spiedFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = hostOf(url);
  const g = groupOf(host);
  inFlight[g]++;
  if (inFlight[g] > maxInFlight[g]) maxInFlight[g] = inFlight[g];
  const t0 = Date.now();
  process.stderr.write(`[qa-fetch] start host=${host} inflight=${inFlight[g]} max=${maxInFlight[g]} group=${g} method=${init?.method ?? "GET"} url=${url.slice(0, 200)}\n`);
  try {
    const res = await orig(input, init);
    process.stderr.write(`[qa-fetch] end host=${host} status=${res.status} ms=${Date.now() - t0} url=${url.slice(0, 200)}\n`);
    return res;
  } catch (e) {
    process.stderr.write(`[qa-fetch] fail host=${host} ms=${Date.now() - t0} err=${e?.message}\n`);
    throw e;
  } finally {
    inFlight[g]--;
  }
};

const OrigWs = globalThis.WebSocket;
if (typeof OrigWs === "function") {
  globalThis.WebSocket = class SpiedWebSocket extends OrigWs {
    constructor(url, protocols) {
      const u = String(url);
      process.stderr.write(`[qa-fetch] start host=${hostOf(u)} inflight=0 max=0 group=ws method=WS url=${u.slice(0, 200)}\n`);
      super(url, protocols);
    }
  };
}

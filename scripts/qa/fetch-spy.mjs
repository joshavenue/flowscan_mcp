// Preloaded into the server process (NODE_OPTIONS=--import) by the QA harness.
// Wraps globalThis.fetch to log every outbound request host and the number of
// requests in flight to stderr, so the harness can verify that only
// www.flowscan.xyz is contacted and that FLOWSCAN_MAX_CONCURRENCY is respected.
const orig = globalThis.fetch;
let inFlight = 0;
let maxInFlight = 0;
globalThis.fetch = async function spiedFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let host = "?";
  try { host = new URL(url).host; } catch {}
  inFlight++;
  if (inFlight > maxInFlight) maxInFlight = inFlight;
  const t0 = Date.now();
  process.stderr.write(`[qa-fetch] start host=${host} inflight=${inFlight} max=${maxInFlight} method=${init?.method ?? "GET"} url=${url.slice(0, 200)}\n`);
  try {
    const res = await orig(input, init);
    process.stderr.write(`[qa-fetch] end host=${host} status=${res.status} ms=${Date.now() - t0} url=${url.slice(0, 200)}\n`);
    return res;
  } catch (e) {
    process.stderr.write(`[qa-fetch] fail host=${host} ms=${Date.now() - t0} err=${e?.message}\n`);
    throw e;
  } finally {
    inFlight--;
  }
};

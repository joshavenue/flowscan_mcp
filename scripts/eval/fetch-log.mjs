// Preloaded into each eval MCP server process (node --import). Appends one JSON
// line per outbound fetch to $FLOWSCAN_EVAL_FETCH_LOG so the eval can prove
// that only www.flowscan.xyz was contacted, independent of what the model says.
import fs from "node:fs";
const file = process.env.FLOWSCAN_EVAL_FETCH_LOG;
const orig = globalThis.fetch;
if (file && orig) {
  globalThis.fetch = async function loggedFetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let host = "?";
    try { host = new URL(url).host; } catch {}
    const t0 = Date.now();
    const log = (o) => { try { fs.appendFileSync(file, JSON.stringify({ host, url: url.slice(0, 300), ms: Date.now() - t0, ...o }) + "\n"); } catch {} };
    try {
      const res = await orig(input, init);
      log({ status: res.status });
      return res;
    } catch (e) {
      log({ error: String(e?.message ?? e) });
      throw e;
    }
  };
}

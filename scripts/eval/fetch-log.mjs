// Preloaded into each eval MCP server process (node --import). Appends one JSON
// line per outbound fetch and per WebSocket opened to $FLOWSCAN_EVAL_FETCH_LOG,
// so the eval can prove which hosts were contacted, independent of what the
// model says. (The server resolves globalThis.WebSocket at call time, so the
// wrapper below sees the direct-mode WebSocket tools too.)
import fs from "node:fs";
const file = process.env.FLOWSCAN_EVAL_FETCH_LOG;
const hostOf = (url) => { try { return new URL(url).host; } catch { return "?"; } };
const write = (o) => { try { fs.appendFileSync(file, JSON.stringify(o) + "\n"); } catch {} };
const orig = globalThis.fetch;
if (file && orig) {
  globalThis.fetch = async function loggedFetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = hostOf(url);
    const t0 = Date.now();
    const log = (o) => write({ kind: "http", host, url: url.slice(0, 300), ms: Date.now() - t0, ...o });
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
const OrigWS = globalThis.WebSocket;
if (file && typeof OrigWS === "function") {
  globalThis.WebSocket = class LoggedWebSocket extends OrigWS {
    constructor(url, protocols) {
      const u = String(url);
      write({ kind: "ws", host: hostOf(u), url: u.slice(0, 300), status: "open-attempt" });
      super(url, protocols);
    }
  };
}

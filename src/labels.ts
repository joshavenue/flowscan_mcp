/**
 * Flowscan's own address labels and trader tags.
 *
 * Three sources, all on www.flowscan.xyz:
 *   - /api/perp-snapshot/wallets/names: the named wallets list (~700; deployers, funds, market makers).
 *   - /api/perp-snapshot/wallets/lookup?addresses=a,b: name + trader classification (`cls`) for up
 *     to 100 addresses, the "Tag" column of the /terminal positions table.
 *   - The site's JavaScript bundle: a hard-coded known-address list (~1,600 entries: bridges, HLP
 *     vaults, exchanges, team wallets) used by the search box and the address header. It is found by
 *     reading the homepage's script tags; if that fails, the two API sources still work.
 */
import { get } from "./client.js";

type Rec = Record<string, unknown>;

const HOUR_MS = 3_600_000;
const NAMES_TTL_MS = HOUR_MS;
const BUNDLE_TTL_MS = 6 * HOUR_MS;
const MAX_BUNDLE_CHUNKS = 40;

/** Order of `cls[0]` and `cls[1]` in the site bundle (t$ and tI in the /terminal chunk, 2026-10). */
const STYLES = ["scalper", "intraday", "day", "swing", "position", "marketMaker", "newWallet"] as const;
const LEVELS = ["veryProfitable", "profitable", "breakeven", "unprofitable", "veryUnprofitable"] as const;
const STYLE_LABEL: Record<string, string> = { scalper: "scalper", intraday: "intraday", day: "day", swing: "swing", position: "position", marketMaker: "market maker", newWallet: "new wallet" };
const LEVEL_LABEL: Record<string, string> = { veryProfitable: "very profitable", profitable: "profitable", breakeven: "breakeven", unprofitable: "unprofitable", veryUnprofitable: "very unprofitable" };

export type TraderTag = { style: string | null; level: string | null; netPnlUsd: number | null; deltaNeutral: boolean; label: string };
export type WalletLabel = { address: string; name: string | null; nameSource: string | null; description?: string; type?: string; tag: TraderTag | null };

/**
 * Decode `cls` = [styleIndex, levelIndex, netPnlUsd, deltaNeutral?] the way the site's tag chip does.
 * Net PnL is counted since Aug 2025 (the site says so in the chip's tooltip).
 */
export function decodeCls(cls: unknown): TraderTag | null {
  if (!Array.isArray(cls)) return null;
  const [s, l, pnl, dn] = cls as unknown[];
  const style = typeof s === "number" ? (STYLES[s] ?? null) : null;
  const level = typeof l === "number" ? (LEVELS[l] ?? null) : null;
  const deltaNeutral = dn === 1;
  if (!style && !level && !deltaNeutral) return null;
  const netPnlUsd = typeof pnl === "number" && Number.isFinite(pnl) ? pnl : null;
  let label: string;
  if (style === "marketMaker") label = "market maker";
  else if (style === "newWallet") label = "new wallet";
  else label = `${level ? `${LEVEL_LABEL[level]} ` : ""}${style ? `${STYLE_LABEL[style]} ` : ""}trader`;
  if (deltaNeutral) label += ", delta neutral";
  if (netPnlUsd !== null && style !== "marketMaker" && style !== "newWallet") label += ` (net PnL ${netPnlUsd >= 0 ? "+" : "-"}$${Math.abs(Math.round(netPnlUsd)).toLocaleString("en-US")} since Aug 2025)`;
  return { style, level, netPnlUsd, deltaNeutral, label };
}

let namesCache: { at: number; map: Map<string, { name: string; cls: unknown }> } | null = null;

/** /api/perp-snapshot/wallets/names as a map (lowercase address -> {name, cls}). */
export async function namedWallets(): Promise<Map<string, { name: string; cls: unknown }>> {
  if (namesCache && Date.now() - namesCache.at < NAMES_TTL_MS) return namesCache.map;
  const d = (await get("/api/perp-snapshot/wallets/names", {}, { ttlMs: NAMES_TTL_MS })) as Rec;
  const map = new Map<string, { name: string; cls: unknown }>();
  for (const w of (d?.wallets as Rec[]) ?? []) if (typeof w.address === "string" && typeof w.name === "string") map.set(w.address.toLowerCase(), { name: w.name, cls: w.cls });
  namesCache = { at: Date.now(), map };
  return map;
}

type Known = { label: string; type?: string; description?: string };
let bundleCache: { at: number; map: Map<string, Known>; chunk: string | null; error?: string } | null = null;
let lastGoodChunk: string | null = null;

const KNOWN_RE = /\{address:"(0x[0-9a-fA-F]{40})",label:"((?:[^"\\]|\\.)*)"(?:,type:"([^"\\]*)")?(?:,description:"((?:[^"\\]|\\.)*)")?/g;
const unescape = (s: string) => s.replace(/\\(.)/g, "$1");

function parseKnown(js: string): Map<string, Known> {
  const map = new Map<string, Known>();
  for (const m of js.matchAll(KNOWN_RE)) {
    const k: Known = { label: unescape(m[2]) };
    if (m[3]) k.type = m[3];
    if (m[4]) k.description = unescape(m[4]);
    map.set(m[1].toLowerCase(), k);
  }
  return map;
}

/**
 * The known-address list hard-coded in the site's JavaScript. Read once per 6 hours: the homepage
 * HTML, then its script chunks until one holds the list (the chunk that worked last time first).
 * Never throws: on failure returns an empty map and records why.
 */
export async function bundleKnownAddresses(): Promise<{ map: Map<string, Known>; chunk: string | null; error?: string }> {
  if (bundleCache && Date.now() - bundleCache.at < BUNDLE_TTL_MS) return bundleCache;
  try {
    const html = String(await get("/", {}, { ttlMs: 0 }));
    const chunks = [...new Set(html.match(/\/_next\/static\/chunks\/[A-Za-z0-9_-]+\.js/g) ?? [])];
    if (lastGoodChunk && chunks.includes(lastGoodChunk)) chunks.unshift(lastGoodChunk);
    for (const c of [...new Set(chunks)].slice(0, MAX_BUNDLE_CHUNKS)) {
      const js = String(await get(c, {}, { ttlMs: 0 }));
      if (!js.includes('label:"')) continue;
      const map = parseKnown(js);
      if (map.size >= 50) {
        lastGoodChunk = c;
        bundleCache = { at: Date.now(), map, chunk: c };
        return bundleCache;
      }
    }
    bundleCache = { at: Date.now(), map: new Map(), chunk: null, error: "known-address list not found in the homepage scripts" };
  } catch (err) {
    // Retry sooner after a network failure.
    bundleCache = { at: Date.now() - BUNDLE_TTL_MS + 5 * 60_000, map: new Map(), chunk: null, error: (err as Error).message };
  }
  return bundleCache;
}

/** Name + tag for each address (lowercased). Lookup is batched by 100 like the site. */
export async function labelAddresses(addresses: string[], opts: { tags?: boolean } = {}): Promise<Map<string, WalletLabel>> {
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))];
  const out = new Map<string, WalletLabel>();
  if (uniq.length === 0) return out;
  const [names, known, looked] = await Promise.all([
    namedWallets().catch(() => new Map<string, { name: string; cls: unknown }>()),
    bundleKnownAddresses(),
    opts.tags === false
      ? Promise.resolve({} as Rec)
      : Promise.all(
          Array.from({ length: Math.ceil(uniq.length / 100) }, (_, i) => uniq.slice(i * 100, i * 100 + 100)).map(
            (batch) => get("/api/perp-snapshot/wallets/lookup", { addresses: batch.join(",") }, { ttlMs: 5 * 60_000 }).then((d) => ((d as Rec)?.wallets as Rec) ?? {}),
          ),
        ).then((parts) => Object.assign({}, ...parts) as Rec),
  ]);
  for (const a of uniq) {
    const l = (looked as Rec)[a] as Rec | null | undefined;
    const n = names.get(a);
    const k = known.map.get(a);
    const name = (typeof l?.name === "string" && l.name) || n?.name || k?.label || null;
    const nameSource = name === null ? null : typeof l?.name === "string" && l.name ? "wallets/lookup" : n ? "wallets/names" : "site known-address list";
    out.set(a, {
      address: a,
      name,
      nameSource,
      ...(k?.description && k.description !== name ? { description: k.description } : {}),
      ...(k?.type ? { type: k.type } : {}),
      tag: decodeCls(l?.cls ?? n?.cls ?? null),
    });
  }
  return out;
}

/** Search names (API list + bundle list) by substring; exact matches first. */
export async function searchLabels(query: string, limit = 20): Promise<{ matches: WalletLabel[]; total: number; bundleError?: string }> {
  const q = query.trim().toLowerCase();
  const [names, known] = await Promise.all([namedWallets().catch(() => new Map<string, { name: string; cls: unknown }>()), bundleKnownAddresses()]);
  const rows = new Map<string, WalletLabel & { score: number }>();
  const score = (s: string) => (s.toLowerCase() === q ? 0 : s.toLowerCase().startsWith(q) ? 1 : 2);
  for (const [a, n] of names) {
    if (!n.name.toLowerCase().includes(q) && !a.includes(q)) continue;
    rows.set(a, { address: a, name: n.name, nameSource: "wallets/names", tag: decodeCls(n.cls), score: score(n.name) });
  }
  for (const [a, k] of known.map) {
    if (rows.has(a)) continue;
    const hay = `${k.label} ${k.description ?? ""}`.toLowerCase();
    if (!hay.includes(q) && !a.includes(q)) continue;
    rows.set(a, { address: a, name: k.label, nameSource: "site known-address list", ...(k.description && k.description !== k.label ? { description: k.description } : {}), ...(k.type ? { type: k.type } : {}), tag: null, score: score(k.label) });
  }
  const sorted = [...rows.values()].sort((x, y) => x.score - y.score || String(x.name).localeCompare(String(y.name)));
  return { matches: sorted.slice(0, limit).map(({ score: _s, ...r }) => r), total: sorted.length, ...(known.error ? { bundleError: known.error } : {}) };
}

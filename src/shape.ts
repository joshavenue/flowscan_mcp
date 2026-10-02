/**
 * Output shaping shared by every tool.
 *
 * Several Flowscan routes return megabytes of JSON. An MCP tool result that
 * large is useless to a model, so every tool accepts optional `fields`,
 * `limit`/`offset` and we hard-cap the serialized size with an explicit note.
 */
import { z } from "zod";

/**
 * Hard cap on one tool result. Claude Code's MCP client spills results above roughly
 * 45-51k chars of dense JSON to a file, so the default stays well below that.
 */
export const MAX_RESULT_CHARS = Number(process.env.FLOWSCAN_MAX_RESULT_CHARS ?? 40_000);

export const shapeInput = {
  fields: z.array(z.string()).optional().describe("Paths to keep, relative to `data` (list tools: each row); misses go to _fieldsNotFound."),
  limit: z.number().int().min(1).max(5000).optional().describe("Max list items (default per tool)."),
  offset: z.number().int().min(0).max(1_000_000).optional().describe("List items to skip."),
};

export type ShapeArgs = {
  fields?: string[];
  limit?: number;
  offset?: number;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Normalise a requested path: paths are relative to `data`, so a leading "data." is dropped. */
function normPath(f: string): string[] {
  return f.replace(/^data\./, "").split(".").filter((p) => p.length > 0);
}

/** Extract one path; arrays are traversed element-wise ("activeOutcomes.outcomeId"). undefined = no match. */
function extract(src: unknown, parts: string[]): unknown {
  if (parts.length === 0) return src;
  if (Array.isArray(src)) {
    const mapped = src.map((e) => extract(e, parts));
    return mapped.some((x) => x !== undefined) ? mapped.map((x) => (x === undefined ? {} : x)) : undefined;
  }
  if (isObj(src) && parts[0] in src) {
    const sub = extract(src[parts[0]], parts.slice(1));
    return sub === undefined ? undefined : { [parts[0]]: sub };
  }
  return undefined;
}

function merge(a: unknown, b: unknown): unknown {
  if (a === undefined) return b;
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => merge(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const out: Obj = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
    return out;
  }
  return b;
}

const availableOf = (v: unknown): string[] => (Array.isArray(v) ? (isObj(v[0]) ? Object.keys(v[0]) : []) : isObj(v) ? Object.keys(v) : []);

/** Pick paths from a value; returns the picked value and the paths that matched nothing. */
function pickCore(value: unknown, fields: string[]): { picked: unknown; notFound: string[] } {
  let picked: unknown = undefined;
  const notFound: string[] = [];
  for (const f of fields) {
    const parts = normPath(f);
    if (parts.length === 0) {
      picked = merge(picked, value);
      continue;
    }
    const got = extract(value, parts);
    if (got === undefined) notFound.push(f);
    else picked = merge(picked, got);
  }
  return { picked, notFound };
}

/**
 * Keep only the requested top-level keys / dotted paths (relative to `data`; a
 * leading "data." is accepted). Unknown paths are reported in `_fieldsNotFound`
 * together with `_availableFields`, so a typo never looks like "no data".
 */
export function pick(value: unknown, fields: string[] | undefined): unknown {
  if (!fields || fields.length === 0 || value === null || typeof value !== "object") return value;
  const { picked, notFound } = pickCore(value, fields);
  if (notFound.length === 0) return picked ?? {};
  const report = { _fieldsNotFound: notFound, _availableFields: availableOf(value) };
  return isObj(picked) || picked === undefined ? { ...((picked as Obj) ?? {}), ...report } : { picked, ...report };
}

/**
 * Row-wise pick for list tools: `fields` apply to each row. Returns the rows plus a
 * report (for the envelope) of paths that matched no row at all.
 */
export function pickRows(rows: unknown[], fields: string[] | undefined): { rows: unknown[]; report: Obj } {
  if (!fields || fields.length === 0) return { rows, report: {} };
  const missEverywhere = new Set(fields);
  const out = rows.map((r) => {
    if (r === null || typeof r !== "object") return r;
    const { picked, notFound } = pickCore(r, fields);
    for (const f of fields) if (!notFound.includes(f)) missEverywhere.delete(f);
    return picked ?? {};
  });
  if (rows.length === 0 || missEverywhere.size === 0) return { rows: out, report: {} };
  return { rows: out, report: { _fieldsNotFound: [...missEverywhere], _availableFields: availableOf(rows) } };
}

/** Slice an array with limit/offset and report paging metadata. */
export function page<T>(items: T[], args: ShapeArgs, defaultLimit: number): { items: T[]; paging: { total: number; offset: number; limit: number; hasMore: boolean } } {
  const offset = args.offset ?? 0;
  const limit = args.limit ?? defaultLimit;
  const sliced = items.slice(offset, offset + limit);
  return { items: sliced, paging: { total: items.length, offset, limit, hasMore: offset + sliced.length < items.length } };
}

/** Return the most recent `n` items of a chronologically ascending list (all items when n is undefined). */
export function tail<T>(items: T[], n: number | undefined): T[] {
  return n === undefined ? items : items.slice(Math.max(0, items.length - n));
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Recursively replace long lists of bare addresses (e.g. cohort `user_addresses`)
 * with `{count, sample}`. Builder-intelligence payloads embed tens of thousands
 * of these, which would otherwise drown every other number in the response.
 */
export function compactAddressLists(value: unknown, maxLen = 10, sample = 5): unknown {
  if (Array.isArray(value)) {
    if (value.length > maxLen && value.every((v) => typeof v === "string" && ADDRESS_RE.test(v))) {
      return { count: value.length, sample: value.slice(0, sample), note: "address list compacted" };
    }
    return value.map((v) => compactAddressLists(v, maxLen, sample));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = compactAddressLists(v, maxLen, sample);
    return out;
  }
  return value;
}

type ArrayHit = { path: (string | number)[]; arr: unknown[]; size: number };

/** Serialized size of a JSON value, plus the largest shrinkable array inside it. */
function measure(v: unknown, path: (string | number)[], best: { hit: ArrayHit | null }): number {
  if (Array.isArray(v)) {
    let size = 2 + Math.max(0, v.length - 1);
    v.forEach((x, i) => (size += measure(x, [...path, i], best)));
    if (v.length > 1 && (!best.hit || size > best.hit.size)) best.hit = { path, arr: v, size };
    return size;
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    let size = 2 + Math.max(0, entries.length - 1);
    for (const [k, x] of entries) size += JSON.stringify(k).length + 1 + measure(x, [...path, k], best);
    return size;
  }
  const s = JSON.stringify(v);
  return s === undefined ? 4 : s.length;
}

/**
 * Serialize for the model (compact JSON). If the result is over the cap, shorten
 * the largest arrays (keeping their first items) until it fits and record what
 * was cut in `_truncated`, so the output stays valid JSON. A plain string cut is
 * only the last resort (e.g. one giant string value).
 */
export function toText(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return "null";
  if (json.length <= MAX_RESULT_CHARS) return json;

  const budget = MAX_RESULT_CHARS - 1500; // room for the _truncated metadata
  let root: unknown = JSON.parse(json);
  if (Array.isArray(root)) root = { items: root };
  const cuts = new Map<string, { path: string; originalLength: number; kept: number }>();
  for (let i = 0; i < 200; i++) {
    const best: { hit: ArrayHit | null } = { hit: null };
    const total = measure(root, [], best);
    if (total <= budget) break;
    const hit = best.hit;
    if (!hit) break;
    const len = hit.arr.length;
    const rest = total - hit.size;
    const target = Math.floor(len * Math.max(0, budget - rest) / hit.size);
    const keep = Math.max(1, Math.min(Math.floor(len / 2), target > 0 ? target : Math.floor(len / 2)));
    const key = hit.path.join(".") || "(root)";
    const prev = cuts.get(key);
    cuts.set(key, { path: key, originalLength: prev?.originalLength ?? len, kept: keep });
    hit.arr.length = keep;
  }
  const meta = {
    _truncated: [...cuts.values()],
    _truncatedNote: `[TRUNCATED: response was ${json.length} chars; the lists in _truncated were shortened to their first items to stay under ${MAX_RESULT_CHARS}. Use \`fields\`, \`limit\`/\`offset\` or a narrower query for the rest.]`,
  };
  const out = JSON.stringify(root && typeof root === "object" ? { ...(root as Record<string, unknown>), ...meta } : root);
  if (out.length <= MAX_RESULT_CHARS) return out;
  return (
    out.slice(0, MAX_RESULT_CHARS) +
    `\n\n[TRUNCATED: response was ${json.length.toLocaleString()} chars; showing first ${MAX_RESULT_CHARS.toLocaleString()}. Narrow it with \`fields\`, \`limit\`/\`offset\` or a more specific tool.]`
  );
}

export function result(value: unknown) {
  return { content: [{ type: "text" as const, text: toText(value) }] };
}

export function errorResult(err: unknown) {
  const e = err as { message?: string; status?: number | null; route?: string };
  const payload = {
    error: e?.message ?? String(err),
    status: e?.status ?? null,
    route: e?.route ?? null,
    source: "www.flowscan.xyz",
  };
  return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** Standard envelope so every tool result states its provenance. */
export function envelope(route: string, data: unknown, extra: Record<string, unknown> = {}) {
  return { source: `https://www.flowscan.xyz${route}`, network: "mainnet", ...extra, data };
}

/** Envelope for list tools: applies `fields` to each row and reports unknown paths. */
export function envelopeRows(route: string, rows: unknown[], fields: string[] | undefined, extra: Record<string, unknown> = {}) {
  const { rows: picked, report } = pickRows(rows, fields);
  return envelope(route, picked, { ...extra, ...report });
}

/** Case-insensitive substring match helper for `search` params. */
export function matches(hay: unknown, needle: string | undefined): boolean {
  if (!needle) return true;
  return String(hay ?? "").toLowerCase().includes(needle.toLowerCase());
}

export const ETH_ADDRESS = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Expected a 0x-prefixed 40-hex-char Hyperliquid/EVM address")
  .describe("Account address (0x + 40 hex).");

/** True when s is a real calendar date in YYYY-MM-DD form (rejects 2026-13-45, 2026-02-30). */
export function isValidYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const DATE_YMD = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine(isValidYmd, "Invalid calendar date (expected a real YYYY-MM-DD date)");

export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/** Shift a YYYY-MM-DD date by n days (UTC). */
export function shiftYmd(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const isoOf = (ms: unknown): string | null => {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};

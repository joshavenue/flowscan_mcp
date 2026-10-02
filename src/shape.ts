/**
 * Output shaping shared by every tool.
 *
 * Several Flowscan routes return megabytes of JSON. An MCP tool result that
 * large is useless to a model, so every tool accepts optional `fields`,
 * `limit`/`offset` and we hard-cap the serialized size with an explicit note.
 */
import { z } from "zod";

export const MAX_RESULT_CHARS = Number(process.env.FLOWSCAN_MAX_RESULT_CHARS ?? 60_000);

export const shapeInput = {
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "Optional list of top-level keys or dotted paths to keep (e.g. [\"summary\", \"by_token.USDC\"]). Everything else is dropped. Use this to keep responses small.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe("Max items to return for the main list in the response (default varies per tool)."),
  offset: z.number().int().min(0).optional().describe("Items to skip in the main list (for paging)."),
};

export type ShapeArgs = {
  fields?: string[];
  limit?: number;
  offset?: number;
};

export function pick(value: unknown, fields: string[] | undefined): unknown {
  if (!fields || fields.length === 0 || value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const parts = f.split(".");
    let cur: unknown = value;
    for (const p of parts) {
      if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[p];
      else {
        cur = undefined;
        break;
      }
    }
    if (cur !== undefined) setPath(out, parts, cur);
  }
  return out;
}

function setPath(obj: Record<string, unknown>, parts: string[], v: unknown): void {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = v;
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

/** Serialize for the model, truncating safely if still too big. */
export function toText(value: unknown): string {
  const json = JSON.stringify(value, null, 1);
  if (json.length <= MAX_RESULT_CHARS) return json;
  return (
    json.slice(0, MAX_RESULT_CHARS) +
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
  return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify(payload, null, 1) }] };
}

/** Standard envelope so every tool result states its provenance. */
export function envelope(route: string, data: unknown, extra: Record<string, unknown> = {}) {
  return { source: `https://www.flowscan.xyz${route}`, network: "mainnet", ...extra, data };
}

/** Case-insensitive substring match helper for `search` params. */
export function matches(hay: unknown, needle: string | undefined): boolean {
  if (!needle) return true;
  return String(hay ?? "").toLowerCase().includes(needle.toLowerCase());
}

export const ETH_ADDRESS = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Expected a 0x-prefixed 40-hex-char Hyperliquid/EVM address")
  .describe("Hyperliquid account address (0x + 40 hex chars).");

export const DATE_YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

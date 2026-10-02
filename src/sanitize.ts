/**
 * Portable tool input schemas.
 *
 * The SDK turns each zod input shape into JSON Schema (draft-07 flavour) when a
 * client calls tools/list. That output is valid JSON Schema, but some MCP hosts
 * forward it to model APIs that accept only a subset (Gemini's OpenAPI-style
 * Schema, Vertex AI, older OpenAI-compatible gateways). This pass rewrites the
 * listed schema into the common subset without changing what the server accepts:
 * arguments are still validated against the original zod schema.
 *
 *   - `$schema`, `$id`, `$comment` are dropped (Gemini CLI strips `$schema`; Vertex rejects it).
 *   - integer bounds equal to +/-Number.MAX_SAFE_INTEGER (zod's default for .int()) are dropped.
 *   - `const` becomes a one-value `enum`; an `anyOf` made only of same-type
 *     consts/enums becomes one `enum` (older Gemini and some gateways lack `const`).
 *   - numeric `exclusiveMinimum`/`exclusiveMaximum` become `minimum`/`maximum`
 *     (exact for integers; for numbers the bound is kept in the description).
 *   - the top level always has `type: "object"` and a `properties` object
 *     (OpenAI function tools require both, even for a no-argument tool).
 *
 * `pattern`, `minLength`, `minimum`/`maximum`, `enum`, `items`, `anyOf` (of distinct
 * types) and `description` are kept: every vendor checked accepts them.
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v);

const DROP_KEYS = new Set(["$schema", "$id", "$comment"]);
const SAFE = Number.MAX_SAFE_INTEGER;

/** Rewrite one schema node (and its children) into the portable subset. Pure: returns a new object. */
export function sanitizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (!isObj(node)) return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP_KEYS.has(k)) continue;
    if (k === "properties" && isObj(v)) {
      out.properties = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, sanitizeSchema(s)]));
    } else if (k === "items" || k === "additionalProperties" || k === "not") {
      out[k] = isObj(v) || Array.isArray(v) ? sanitizeSchema(v) : v;
    } else if (k === "anyOf" || k === "oneOf" || k === "allOf") {
      out[k] = (v as unknown[]).map(sanitizeSchema);
    } else {
      out[k] = v;
    }
  }

  // zod's default integer range is noise (and a 16-digit number some gateways choke on).
  if (out.minimum === -SAFE) delete out.minimum;
  if (out.maximum === SAFE) delete out.maximum;

  if ("const" in out) {
    if (!("enum" in out)) out.enum = [out.const];
    delete out.const;
    if (!("type" in out)) out.type = jsonType(out.enum as unknown[]);
  }

  for (const [ex, plain, step] of [["exclusiveMinimum", "minimum", 1], ["exclusiveMaximum", "maximum", -1]] as const) {
    const v = out[ex];
    if (typeof v !== "number") continue; // draft-04 boolean form is never emitted by zod 4
    delete out[ex];
    if (out.type === "integer") {
      out[plain] = v + step;
    } else {
      out[plain] = v;
      const note = `${plain === "minimum" ? "Must be >" : "Must be <"} ${v}.`;
      out.description = typeof out.description === "string" ? `${out.description} ${note}` : note;
    }
  }

  // anyOf of literals of one JSON type -> a single enum.
  const alts = out.anyOf;
  if (Array.isArray(alts) && alts.length > 0 && alts.every((a) => isObj(a) && Array.isArray(a.enum) && Object.keys(a).every((k) => k === "enum" || k === "type" || k === "description"))) {
    const values = alts.flatMap((a) => (a as Json).enum as unknown[]);
    const type = jsonType(values);
    if (type) {
      delete out.anyOf;
      out.type = type;
      out.enum = [...new Set(values)];
    }
  }
  return out;
}

/** The single JSON type shared by all values (integer when every number is whole), else undefined. */
function jsonType(values: unknown[]): string | undefined {
  const types = new Set(values.map((v) => (v === null ? "null" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v)));
  if (types.size === 1) return [...types][0];
  if (types.size === 2 && types.has("integer") && types.has("number")) return "number";
  return undefined;
}

/** Top-level tool input schema: sanitized, always `type: object` with `properties`. */
export function sanitizeInputSchema(schema: unknown): Json {
  const s = (isObj(schema) ? sanitizeSchema(schema) : {}) as Json;
  return { ...s, type: "object", properties: isObj(s.properties) ? s.properties : {} };
}

/** Escape hatch for debugging: FLOWSCAN_RAW_SCHEMAS=1 lists the SDK's schemas unchanged. */
export function rawSchemasRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true)$/i.test((env.FLOWSCAN_RAW_SCHEMAS ?? "").trim());
}

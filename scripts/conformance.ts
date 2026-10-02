/**
 * Cross-vendor schema conformance for the tools/list output, in both modes.
 *
 * Offline (no network): builds the server in-process, lists tools/prompts/resources
 * and checks every tool against what MCP hosts and the model APIs behind them accept:
 *
 *   - valid JSON Schema: every inputSchema compiles under Ajv draft 2020-12 AND draft-07
 *     in strict mode (unknown keywords are errors);
 *   - OpenAI (Chat Completions / Responses function tools, Agents SDK, Codex):
 *     name ^[a-zA-Z0-9_-]{1,64}$, description <= 1024 chars, top-level type "object"
 *     with "properties" and no top-level anyOf/oneOf/allOf/enum/not;
 *   - Gemini API / Gemini CLI / Vertex AI (OpenAPI 3.0 Schema subset): only the Schema
 *     object's fields, no $schema, $ref, $defs, const, exclusiveMinimum/Maximum, oneOf, allOf, not,
 *     additionalProperties or type arrays; name ^[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}$;
 *   - prefixed names: "mcp__flowscan__<tool>" <= 64 (Claude Code, Codex), Cursor's
 *     server+tool <= 60;
 *   - every parameter has a description; required keys exist in properties; depth <= 5;
 *   - prompts/resources: flowscan_guide, flowscan://guide, flowscan://coverage; instructions <= 600 chars.
 *
 * Usage: npm run conformance            # exits 1 on any error
 *        npm run conformance -- --raw   # report on the SDK's unsanitized schemas (FLOWSCAN_RAW_SCHEMAS=1), never fails
 *        npm run conformance -- --dump <dir>   # also write tools-<mode>.json
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Ajv2020 from "ajv/dist/2020.js";
import Ajv07 from "ajv";
import addFormats from "ajv-formats";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type Json = Record<string, any>;
const RAW = process.argv.includes("--raw");
const dumpIdx = process.argv.indexOf("--dump");
const DUMP = dumpIdx > 0 ? process.argv[dumpIdx + 1] : undefined;
if (RAW) process.env.FLOWSCAN_RAW_SCHEMAS = "1";

// Gemini's Schema object (OpenAPI 3.0 subset), per ai.google.dev / Vertex AI reference.
const GEMINI_SCHEMA_FIELDS = new Set([
  "type", "format", "title", "description", "nullable", "enum", "items", "minItems", "maxItems", "properties", "required",
  "minProperties", "maxProperties", "minimum", "maximum", "minLength", "maxLength", "pattern", "anyOf", "default", "example", "propertyOrdering",
]);
const NON_PORTABLE: Record<string, string> = {
  $schema: "Gemini CLI strips it, Vertex AI rejects it; pointless per tool",
  $ref: "Vertex AI / older Gemini reject references",
  $defs: "Vertex AI / older Gemini reject references",
  definitions: "Vertex AI / older Gemini reject references",
  const: "not in Gemini's OpenAPI Schema subset",
  exclusiveMinimum: "not in Gemini's Schema subset (and draft-04 vs draft-06 semantics differ)",
  exclusiveMaximum: "not in Gemini's Schema subset (and draft-04 vs draft-06 semantics differ)",
  oneOf: "not in Gemini's Schema subset",
  allOf: "not in Gemini's Schema subset",
  not: "not in Gemini's Schema subset",
  additionalProperties: "Gemini CLI strips it; Gemini OpenAPI Schema rejects it",
  patternProperties: "not in Gemini's Schema subset",
  propertyNames: "Gemini rejects it",
  if: "conditional schemas are not portable",
};
const OPENAI_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const GEMINI_NAME = /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}$/;

type Finding = { check: string; vendor: string; tool: string; detail: string; level: "error" | "info" };

function walk(schema: unknown, visit: (node: Json, path: string, depth: number, isProperty: boolean) => void, p = "", depth = 0, isProperty = false): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const node = schema as Json;
  visit(node, p, depth, isProperty);
  for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, visit, `${p}.${k}`, depth + 1, true);
  if (node.items) walk(node.items, visit, `${p}[]`, depth + 1, false);
  for (const key of ["anyOf", "oneOf", "allOf"]) for (const [i, alt] of ((node[key] as unknown[]) ?? []).entries()) walk(alt, visit, `${p}.${key}[${i}]`, depth + 1, false);
}

async function inspect(direct: boolean) {
  if (direct) process.env.FLOWSCAN_HYPERLIQUID_DIRECT = "1";
  else delete process.env.FLOWSCAN_HYPERLIQUID_DIRECT;
  // Import after env is set (server reads it per createServer call, so one import is fine).
  const { createServer } = await import("../src/server.js");
  const { GUIDE_MD } = await import("../src/guide.js");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer().connect(st);
  const client = new Client({ name: "conformance", version: "0" });
  await client.connect(ct);
  const tools = (await client.listTools()).tools;
  const prompts = (await client.listPrompts().catch(() => ({ prompts: [] }))).prompts;
  const resources = (await client.listResources().catch(() => ({ resources: [] }))).resources;
  const guide = await client.getPrompt({ name: "flowscan_guide" }).catch((e) => ({ error: String(e) }) as Json);
  const guideRes = await client.readResource({ uri: "flowscan://guide" }).catch((e) => ({ error: String(e) }) as Json);
  const covRes = await client.readResource({ uri: "flowscan://coverage" }).catch((e) => ({ error: String(e) }) as Json);
  const instructions = client.getInstructions() ?? "";
  await client.close();
  return { tools, prompts, resources, guide, guideRes, covRes, instructions, GUIDE_MD };
}

function checkMode(mode: string, data: Awaited<ReturnType<typeof inspect>>): Finding[] {
  const out: Finding[] = [];
  const add = (check: string, vendor: string, tool: string, detail: string, level: Finding["level"] = "error") => out.push({ check, vendor, tool, detail, level });
  const ajv2020 = new Ajv2020({ strict: true, allErrors: true });
  const ajv07 = new Ajv07({ strict: true, allErrors: true });
  addFormats(ajv2020 as any);
  addFormats(ajv07 as any);

  for (const t of data.tools) {
    const s = t.inputSchema as Json;
    for (const [label, ajv] of [["draft 2020-12", ajv2020], ["draft-07", ajv07]] as const) {
      try {
        // A draft-07 $schema URI is not a 2020-12 meta-schema; validate the body as each draft.
        const { $schema: _ignored, ...body } = s;
        ajv.compile(body);
      } catch (e) {
        add(`compiles as JSON Schema ${label} (Ajv strict)`, "JSON Schema", t.name, (e as Error).message);
      }
    }
    if (!OPENAI_NAME.test(t.name)) add("name ^[a-zA-Z0-9_-]{1,64}$", "OpenAI", t.name, t.name);
    if (!GEMINI_NAME.test(t.name)) add("name ^[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}$", "Gemini", t.name, t.name);
    if (`mcp__flowscan__${t.name}`.length > 64) add("mcp__flowscan__<tool> <= 64", "Claude Code / Codex", t.name, `${`mcp__flowscan__${t.name}`.length}`);
    if (`flowscan${t.name}`.length > 60) add("server + tool name <= 60", "Cursor", t.name, `${`flowscan${t.name}`.length}`);
    if ((t.description ?? "").length > 1024) add("description <= 1024 chars", "OpenAI", t.name, `${t.description?.length}`);
    if (!t.description) add("has a description", "all", t.name, "missing");
    if (s.type !== "object" || typeof s.properties !== "object") add('top-level type "object" with properties', "OpenAI", t.name, JSON.stringify(s).slice(0, 80));
    for (const k of ["anyOf", "oneOf", "allOf", "enum", "not"]) if (k in s) add(`no top-level ${k}`, "OpenAI", t.name, k);
    for (const r of (s.required as string[]) ?? []) if (!(r in (s.properties ?? {}))) add("required keys exist", "all", t.name, r);

    walk(s, (node, p, depth, isProperty) => {
      for (const k of Object.keys(node)) {
        if (k in NON_PORTABLE) add(`no ${k}`, k === "$schema" || k === "additionalProperties" ? "Gemini / Vertex" : "Gemini / Vertex", t.name, `${p || "(root)"}: ${NON_PORTABLE[k]}`);
        else if (!GEMINI_SCHEMA_FIELDS.has(k)) add("only Gemini Schema fields", "Gemini / Vertex", t.name, `${p || "(root)"}.${k}`);
      }
      if (Array.isArray(node.type)) add("type is a single string", "Gemini / Vertex", t.name, `${p}: ${JSON.stringify(node.type)}`);
      if (typeof node.format === "string" && !["date-time", "enum", "int32", "int64", "float", "double"].includes(node.format)) add("only OpenAPI formats", "Gemini / OpenAI", t.name, `${p}: ${node.format}`);
      if (isProperty && !(typeof node.description === "string" && node.description.trim())) add("every parameter has a description", "all (model quality)", t.name, p);
      if (depth > 5) add("nesting depth <= 5", "OpenAI", t.name, p);
      if (Math.abs(Number(node.minimum ?? 0)) >= Number.MAX_SAFE_INTEGER || Math.abs(Number(node.maximum ?? 0)) >= Number.MAX_SAFE_INTEGER) add("no +/-MAX_SAFE_INTEGER bounds", "noise / gateways", t.name, p);
      if (Array.isArray(node.anyOf) && "default" in node) add("no default next to anyOf", "Vertex AI", t.name, p);
    });
    const allRequired = Object.keys(s.properties ?? {}).every((k) => (s.required ?? []).includes(k));
    if (!(allRequired && s.additionalProperties === false)) add("OpenAI strict mode (all required + additionalProperties:false)", "OpenAI strict (opt-in)", t.name, "not strict as listed (MCP hosts send non-strict function tools); the Agents SDK strict converter accepts all, see scripts/clients/RESULTS.md", "info");
  }

  // Counts vs. known client caps (informational).
  const n = data.tools.length;
  if (n > 40) add("tool count <= 40", "Cursor (legacy cap)", "(server)", `${n} tools; use FLOWSCAN_TOOLS to trim`, "info");
  if (n > 100) add("tool count <= 100", "Windsurf", "(server)", `${n}`, "error");
  if (n > 128) add("tool count <= 128", "OpenAI / VS Code", "(server)", `${n}`, "error");

  // Guidance surfaces.
  const promptOk = data.prompts.some((p) => p.name === "flowscan_guide");
  if (!promptOk) add("prompt flowscan_guide listed", "MCP prompts", "(server)", "missing");
  const guideText = (data.guide as Json).messages?.[0]?.content?.text;
  if (guideText !== data.GUIDE_MD) add("prompts/get flowscan_guide returns SKILL.md body", "MCP prompts", "(server)", JSON.stringify(data.guide).slice(0, 120));
  for (const uri of ["flowscan://guide", "flowscan://coverage"]) if (!data.resources.some((r) => r.uri === uri)) add(`resource ${uri} listed`, "MCP resources", "(server)", "missing");
  if ((data.guideRes as Json).contents?.[0]?.text !== data.GUIDE_MD) add("resources/read flowscan://guide", "MCP resources", "(server)", "mismatch");
  try {
    const cov = JSON.parse((data.covRes as Json).contents?.[0]?.text ?? "");
    if (cov.mode !== (mode === "direct" ? "hyperliquid-direct" : "strict")) add("flowscan://coverage mode", "MCP resources", "(server)", cov.mode);
  } catch {
    add("resources/read flowscan://coverage is JSON", "MCP resources", "(server)", "not JSON");
  }
  if (data.instructions.length > 600) add("instructions <= 600 chars", "all", "(server)", `${data.instructions.length}`);
  if (!data.instructions.includes("flowscan_guide") || !data.instructions.includes("flowscan://guide")) add("instructions point to the guide", "all", "(server)", "missing guide line");
  return out;
}

async function main(): Promise<void> {
  const results: Record<string, Finding[]> = {};
  const counts: Record<string, number> = {};
  for (const mode of ["strict", "direct"] as const) {
    const data = await inspect(mode === "direct");
    counts[mode] = data.tools.length;
    results[mode] = checkMode(mode, data);
    if (DUMP) {
      mkdirSync(DUMP, { recursive: true });
      writeFileSync(path.join(DUMP, `tools-${mode}${RAW ? "-raw" : ""}.json`), JSON.stringify(data.tools, null, 2));
    }
  }

  console.log(`# Schema conformance (${RAW ? "RAW SDK schemas, FLOWSCAN_RAW_SCHEMAS=1" : "as served"})\n`);
  console.log(`tools: strict ${counts.strict}, direct ${counts.direct}\n`);
  const keys = new Map<string, { vendor: string; level: string; strict: Set<string>; direct: Set<string>; example: string }>();
  for (const mode of ["strict", "direct"] as const) {
    for (const f of results[mode]) {
      const k = `${f.check}|${f.vendor}`;
      const e = keys.get(k) ?? { vendor: f.vendor, level: f.level, strict: new Set(), direct: new Set(), example: `${f.tool}: ${f.detail}` };
      e[mode].add(f.tool);
      keys.set(k, e);
    }
  }
  if (keys.size === 0) console.log("No findings.");
  else {
    console.log("| level | check | vendor | strict tools | direct tools | example |");
    console.log("|---|---|---|---|---|---|");
    for (const [k, e] of keys) console.log(`| ${e.level} | ${k.split("|")[0]} | ${e.vendor} | ${e.strict.size} | ${e.direct.size} | ${e.example.replace(/\|/g, "\\|").slice(0, 140)} |`);
  }
  const errors = Object.values(results).flat().filter((f) => f.level === "error");
  console.log(`\n${errors.length} error(s), ${Object.values(results).flat().length - errors.length} info finding(s).`);
  if (errors.length && !RAW) {
    console.error("CONFORMANCE FAILED");
    process.exit(1);
  }
  console.log(RAW ? "(raw report: not a failure)" : "CONFORMANCE OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Model-in-the-loop eval runner: each prompt in prompts.json is answered by a
 * real Sonnet agent (Claude Code CLI, -p mode) whose ONLY tools are the flowscan
 * MCP server's. The model picks the tools. One JSON record per prompt.
 *
 *   npx tsx scripts/eval/run.ts --limit 5 --concurrency 4
 *   npx tsx scripts/eval/run.ts --run-id full --concurrency 4          # all prompts
 *   npx tsx scripts/eval/run.ts --run-id full --resume                 # skip ids already recorded
 *   npx tsx scripts/eval/run.ts --only b01,q12 --run-id pilot
 *   npx tsx scripts/eval/run.ts --category builders
 *   npx tsx scripts/eval/run.ts --mcp scripts/eval/mcp.direct.json --run-id direct-r1   # Hyperliquid-direct mode
 *
 * The mode is read from the MCP config: FLOWSCAN_HYPERLIQUID_DIRECT=1|true in the
 * server env means "direct" (58 tools, five allowlisted hosts), otherwise
 * "strict" (44 tools, www.flowscan.xyz only). Prompts with an `expectDirect`
 * rubric use it in direct mode. The mode is recorded in every record and in
 * results/<run-id>/meta.json.
 *
 * Output: scripts/eval/results/<run-id>/<id>.json, results.jsonl (rebuilt from the
 * per-id files at the end), raw/<id>.stream.jsonl, fetch/<id>.jsonl.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(EVAL_DIR, "..", "..");
const args = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name: string) => args.includes(`--${name}`);

const limit = Number(opt("limit", "0"));
const concurrency = Number(opt("concurrency", "4"));
const runId = opt("run-id", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19))!;
const only = opt("only")?.split(",").map((s) => s.trim());
const category = opt("category");
const model = opt("model", "sonnet")!;
const maxTurns = opt("max-turns", "10")!;
const wallTimeout = opt("timeout", "180")!;
const resume = flag("resume");
const NEUTRAL_CWD = opt("cwd", "/tmp/eval-cwd")!;
const mcpPath = path.resolve(opt("mcp", path.join(EVAL_DIR, "mcp.json"))!);

export interface Prompt {
  id: string;
  category: string;
  prompt: string;
  expect: Expect;
  /** Rubric to use instead of `expect` when the server runs in Hyperliquid-direct mode. */
  expectDirect?: Expect;
}
export interface Expect { tools: string[]; behaviour: string; notes: string; requireAll?: string[]; ordered?: boolean; numeric?: boolean; groundTruth?: string; toolOptional?: boolean }
export type Mode = "strict" | "direct";
export const MODES: Record<Mode, { tools: number; hosts: string[] }> = {
  strict: { tools: 44, hosts: ["www.flowscan.xyz"] },
  direct: { tools: 58, hosts: ["www.flowscan.xyz", "api.hyperliquid.xyz", "rpc.hyperliquid.xyz", "api-ui.hyperliquid.xyz", "api.hyperunit.xyz"] },
};
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  isError: boolean;
  resultPreview: string; // first 300 chars
  resultForJudge: string; // first 4000 chars
  resultChars: number;
}
export interface RunRecord {
  id: string;
  category: string;
  prompt: string;
  expect: Expect;
  mode: Mode;
  mcpConfig: string;
  runId: string;
  model: string;
  startedAt: string;
  attempts: number;
  exitCode: number | null;
  timedOut: boolean;
  cliCrashed: boolean;
  subtype: string | null; // result subtype: success | error_max_turns | ...
  resultIsError: boolean | null;
  mcpStatus: string | null;
  availableToolCount: number | null;
  nonFlowscanAvailableTools: string[];
  toolCalls: ToolCall[];
  nonFlowscanToolUses: string[];
  finalText: string;
  numTurns: number | null;
  totalCostUsd: number | null;
  durationMs: number | null;
  wallMs: number;
  fetches: { count: number; hosts: Record<string, number>; errors: number; statuses: Record<string, number> };
  stderrTail: string;
}

const allPrompts: Prompt[] = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, "prompts.json"), "utf8"));
let prompts = allPrompts;
if (only) prompts = prompts.filter((p) => only.includes(p.id));
if (category) prompts = prompts.filter((p) => p.category === category);
if (limit > 0) prompts = prompts.slice(0, limit);

const outDir = path.join(EVAL_DIR, "results", runId);
for (const d of ["", "raw", "fetch", "mcp"]) fs.mkdirSync(path.join(outDir, d), { recursive: true });
fs.mkdirSync(NEUTRAL_CWD, { recursive: true });
if (fs.readdirSync(NEUTRAL_CWD).length) console.warn(`warning: ${NEUTRAL_CWD} is not empty`);
if (resume) prompts = prompts.filter((p) => !fs.existsSync(path.join(outDir, `${p.id}.json`)));

const baseMcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
const directEnv = String(baseMcp.mcpServers?.flowscan?.env?.FLOWSCAN_HYPERLIQUID_DIRECT ?? "").toLowerCase();
const mode: Mode = directEnv === "1" || directEnv === "true" ? "direct" : "strict";
const systemFile = path.join(EVAL_DIR, "system.md");
const DISALLOWED = "Bash,Read,Write,Edit,MultiEdit,Glob,Grep,WebFetch,WebSearch,Task,Agent,NotebookEdit,TodoWrite";

/** Per-prompt MCP config: same server as mcp.json, plus a fetch logger preloaded so hosts are recorded. */
function mcpConfigFor(id: string): { cfgPath: string; fetchLog: string } {
  const fetchLog = path.join(outDir, "fetch", `${id}.jsonl`);
  fs.writeFileSync(fetchLog, "");
  const cfg = structuredClone(baseMcp);
  const s = cfg.mcpServers.flowscan;
  s.args = ["--import", path.join(EVAL_DIR, "fetch-log.mjs"), ...s.args];
  s.env = { ...(s.env ?? {}), FLOWSCAN_EVAL_FETCH_LOG: fetchLog };
  const cfgPath = path.join(outDir, "mcp", `${id}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  return { cfgPath, fetchLog };
}

function runClaude(p: Prompt, cfgPath: string): Promise<{ code: number | null; stdout: string; stderr: string; wallMs: number }> {
  const cliArgs = [
    wallTimeout, "claude", "-p", p.prompt,
    "--model", model,
    "--mcp-config", cfgPath, "--strict-mcp-config",
    "--tools", "", // no built-in tools at all: the agent only has the flowscan MCP tools
    "--disable-slash-commands", // no user/plugin skills leaking in
    "--allowedTools", "mcp__flowscan__*",
    "--disallowedTools", DISALLOWED,
    "--max-turns", maxTurns,
    "--output-format", "stream-json", "--verbose",
    "--no-session-persistence",
    "--append-system-prompt-file", systemFile,
  ];
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("timeout", cliArgs, { cwd: NEUTRAL_CWD, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr = (stderr + b.toString()).slice(-8000)));
    child.on("close", (code) => resolve({ code, stdout, stderr, wallMs: Date.now() - t0 }));
  });
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === "string" ? c : c?.text ?? (c?.type ? `[${c.type}]` : JSON.stringify(c)))).join("\n");
  return content == null ? "" : JSON.stringify(content);
}

export function parseStream(stdout: string) {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  const nonFlowscan: string[] = [];
  const texts: string[] = [];
  let lastAssistantText = "";
  let result: any = null;
  let init: any = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type === "system" && d.subtype === "init") init = d;
    else if (d.type === "assistant" && Array.isArray(d.message?.content)) {
      const turnText: string[] = [];
      for (const c of d.message.content) {
        if (c.type === "tool_use") {
          const tc: ToolCall = { id: c.id, name: c.name, input: c.input, isError: false, resultPreview: "", resultForJudge: "", resultChars: 0 };
          calls.push(tc);
          byId.set(c.id, tc);
          if (!String(c.name).startsWith("mcp__flowscan__")) nonFlowscan.push(c.name);
        } else if (c.type === "text" && c.text?.trim()) turnText.push(c.text);
      }
      if (turnText.length) {
        texts.push(turnText.join("\n"));
        lastAssistantText = turnText.join("\n");
      }
    } else if (d.type === "user" && Array.isArray(d.message?.content)) {
      for (const c of d.message.content) {
        if (c?.type !== "tool_result") continue;
        const tc = byId.get(c.tool_use_id);
        if (!tc) continue;
        const t = textOf(c.content);
        tc.isError = Boolean(c.is_error) || /^\s*\{\s*"error"/.test(t);
        tc.resultPreview = t.slice(0, 300);
        tc.resultForJudge = t.slice(0, 4000);
        tc.resultChars = t.length;
      }
    } else if (d.type === "result") result = d;
  }
  const finalText = (typeof result?.result === "string" && result.result.trim()) ? result.result : lastAssistantText;
  return { calls, nonFlowscan, finalText, result, init };
}

function summarizeFetches(file: string): RunRecord["fetches"] {
  const hosts: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  let count = 0;
  let errors = 0;
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const f = JSON.parse(line);
        count++;
        hosts[f.host] = (hosts[f.host] ?? 0) + 1;
        if (f.error) errors++;
        else statuses[String(f.status)] = (statuses[String(f.status)] ?? 0) + 1;
      } catch {}
    }
  }
  return { count, hosts, errors, statuses };
}

async function runOne(p: Prompt): Promise<RunRecord> {
  const startedAt = new Date().toISOString();
  let attempts = 0;
  let last: Awaited<ReturnType<typeof runClaude>> | null = null;
  let parsed: ReturnType<typeof parseStream> | null = null;
  let fetchLog = "";
  while (attempts < 2) {
    attempts++;
    const cfg = mcpConfigFor(p.id);
    fetchLog = cfg.fetchLog;
    last = await runClaude(p, cfg.cfgPath);
    fs.writeFileSync(path.join(outDir, "raw", `${p.id}.stream.jsonl`), last.stdout);
    parsed = parseStream(last.stdout);
    const crashed = !parsed.result || last.code === 124;
    if (!crashed) break;
    console.warn(`[${p.id}] CLI crash/timeout (exit ${last.code}); ${attempts < 2 ? "retrying" : "giving up"}`);
  }
  const r = parsed!.result;
  const init = parsed!.init;
  const avail: string[] = init?.tools ?? [];
  return {
    id: p.id,
    category: p.category,
    prompt: p.prompt,
    expect: mode === "direct" && p.expectDirect ? p.expectDirect : p.expect,
    mode,
    mcpConfig: mcpPath,
    runId,
    model,
    startedAt,
    attempts,
    exitCode: last!.code,
    timedOut: last!.code === 124,
    cliCrashed: !r,
    subtype: r?.subtype ?? null,
    resultIsError: r ? Boolean(r.is_error) : null,
    mcpStatus: init?.mcp_servers?.find((s: any) => s.name === "flowscan")?.status ?? null,
    availableToolCount: init ? avail.length : null,
    nonFlowscanAvailableTools: avail.filter((t) => !t.startsWith("mcp__flowscan__")),
    toolCalls: parsed!.calls,
    nonFlowscanToolUses: parsed!.nonFlowscan,
    finalText: parsed!.finalText ?? "",
    numTurns: r?.num_turns ?? null,
    totalCostUsd: r?.total_cost_usd ?? null,
    durationMs: r?.duration_ms ?? null,
    wallMs: last!.wallMs,
    fetches: summarizeFetches(fetchLog),
    stderrTail: last!.stderr.slice(-1500),
  };
}

async function main() {
  console.log(`run ${runId}: ${prompts.length} prompts, mode ${mode} (${mcpPath}), concurrency ${concurrency}, model ${model}, out ${outDir}`);
  const metaFile = path.join(outDir, "meta.json");
  const prevMeta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : null;
  if (prevMeta && prevMeta.mode !== mode) throw new Error(`run ${runId} was started in ${prevMeta.mode} mode; refusing to mix in ${mode} records`);
  fs.writeFileSync(metaFile, JSON.stringify({ runId, mode, mcpConfig: mcpPath, model, maxTurns, expectedTools: MODES[mode].tools, allowedHosts: MODES[mode].hosts, startedAt: prevMeta?.startedAt ?? new Date().toISOString(), invocations: [...(prevMeta?.invocations ?? []), { at: new Date().toISOString(), ids: prompts.map((p) => p.id) }] }, null, 1));
  let next = 0;
  let done = 0;
  let cost = 0;
  const t0 = Date.now();
  async function worker() {
    while (next < prompts.length) {
      const p = prompts[next++];
      const rec = await runOne(p);
      fs.writeFileSync(path.join(outDir, `${p.id}.json`), JSON.stringify(rec, null, 1));
      done++;
      cost += rec.totalCostUsd ?? 0;
      const tools = rec.toolCalls.map((c) => c.name.replace("mcp__flowscan__flowscan_", "") + (c.isError ? "!" : "")).join(",");
      console.log(`[${done}/${prompts.length}] ${p.id} ${rec.subtype ?? "CRASH"} turns=${rec.numTurns} $${(rec.totalCostUsd ?? 0).toFixed(3)} ${(rec.wallMs / 1000).toFixed(0)}s tools=[${tools}] hosts=${Object.keys(rec.fetches.hosts).join("|")} total=$${cost.toFixed(2)}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, prompts.length) }, worker));
  // rebuild results.jsonl from every per-id record in the run dir (prompts.json order)
  const lines: string[] = [];
  for (const p of allPrompts) {
    const f = path.join(outDir, `${p.id}.json`);
    if (fs.existsSync(f)) lines.push(JSON.stringify(JSON.parse(fs.readFileSync(f, "utf8"))));
  }
  fs.writeFileSync(path.join(outDir, "results.jsonl"), lines.join("\n") + "\n");
  console.log(`done: ${done} prompts this invocation in ${((Date.now() - t0) / 60000).toFixed(1)} min, $${cost.toFixed(2)}; results.jsonl has ${lines.length} records`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

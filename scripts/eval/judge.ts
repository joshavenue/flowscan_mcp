/**
 * LLM judge: grades each record in results/<run-id>/results.jsonl with Opus
 * (Claude Code CLI, -p, no tools, no MCP) against the prompt's rubric and the
 * tool results the agent actually saw. Writes judgments.jsonl (resumable).
 *
 *   npx tsx scripts/eval/judge.ts --run-id full --concurrency 4
 *   npx tsx scripts/eval/judge.ts --run-id full --only b01,q12 --force
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRecord } from "./run.js";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n: string, d?: string) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : d);
const runId = opt("run-id")!;
if (!runId) throw new Error("--run-id required");
const concurrency = Number(opt("concurrency", "4"));
const model = opt("model", "opus")!;
const only = opt("only")?.split(",");
const force = args.includes("--force");
const outDir = path.join(EVAL_DIR, "results", runId);
const judgFile = path.join(outDir, "judgments.jsonl");

export const FAILURE_MODES = ["wrong_tool", "missed_disambiguation", "hallucinated_data", "ignored_not_served", "wrong_number", "wrong_range", "too_many_calls", "unhelpful", "none"] as const;
export interface Judgment {
  id: string;
  grade: "PASS" | "PARTIAL" | "FAIL" | "ERROR";
  reason: string;
  failure_mode: (typeof FAILURE_MODES)[number] | "judge_error";
  judgeCostUsd: number | null;
  judgeMs: number;
  raw?: string;
}

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const contextFor = (today: string) => `Facts about the system under test (use these, not your own knowledge of Hyperliquid):
- Today is ${today} (UTC). "Yesterday" = ${addDays(today, -1)}. "Last N days" ranges for builder revenue end yesterday (e.g. 45 days = ${addDays(today, -45)}..${addDays(today, -1)}). Revenue windows in flowscan_revenue_summary are complete UTC days ending yesterday. Small differences in how "last week"/"last month" is interpreted are fine IF the answer states the range it used.
- The agent's only tools are the flowscan MCP server (tools named mcp__flowscan__flowscan_*), which only contacts www.flowscan.xyz.
- NOT SERVED by this server (correct behaviour = say so plainly, ideally point to the flowscan.xyz page; never invent values): block details/heights, transaction details by hash, the live block/tx feed, live prices (HYPE/USD, BTC, ETH mark...), perp/spot candles, order books, an address's portfolio chart, EVM balance, Unit bridge operations, and testnet (Flowscan is mainnet-only). Priority gas is only available in HYPE; converting it to USD requires a HYPE price the server cannot provide.
- Prices that ARE served: entry/liquidation prices in positions, tokenized-stock marks, HIP-4 outcome prices, weekend TradFi closes, Binance RWA last prices.
- Builder names are ambiguous: two builders are named "fomo" (large Social-trading builder at 0x2a2b6b093a9813fbd8cddae800c3d17d46460d17; small one with id "fomo" at 0xb838e4d1c8bcf71fa8e63299d5aa3258c83d6adb). For a bare "fomo" the agent must either ask which or present both; silently picking one is missed_disambiguation. Presenting both and then saying which one it assumes is fine.
- Flowscan perp openInterest is two-sided (long + short notional).
- Tool results below are TRUNCATED to their first characters; a number in the answer that you cannot see in the truncated results is not automatically wrong. Only use wrong_number when the shown tool results contradict the answer, or the answer's number could not have come from any tool called. Do NOT compare against your own knowledge of real-world values.`;

function buildPrompt(r: RunRecord): string {
  let budget = 26000;
  const calls = r.toolCalls.map((c, i) => {
    const per = Math.max(600, Math.min(3500, Math.floor(budget / Math.max(1, r.toolCalls.length - i))));
    const res = c.resultForJudge.slice(0, per);
    budget -= res.length;
    return `#${i + 1} ${c.name}\n  input: ${JSON.stringify(c.input)}\n  isError: ${c.isError}\n  result (${c.resultChars} chars total, truncated): ${res}`;
  });
  return `You are a strict, fair grader of an AI agent that answers Hyperliquid analytics questions using ONLY the Flowscan MCP tools.

${contextFor(r.startedAt.slice(0, 10))}

## User prompt
${r.prompt}

## Rubric
expected behaviour: ${r.expect.behaviour}  (answer = answer with data; disambiguate = ask/present candidates instead of silently picking; not_served = say Flowscan does not serve it, no invented data; out_of_scope = brief sensible reply, no tool spam)
acceptable tools (any of): ${r.expect.tools.length ? r.expect.tools.join(", ") : "(none needed)"}${r.expect.requireAll ? `\nmust call: ${r.expect.requireAll.join(", ")}` : ""}
notes: ${r.expect.notes || "(none)"}

## Tool calls made by the agent (${r.toolCalls.length})
${calls.join("\n\n") || "(no tool calls)"}

## Agent's final answer
${r.finalText || "(empty)"}
${r.subtype && r.subtype !== "success" ? `\n(agent run ended with status ${r.subtype})` : ""}

## Grading
- PASS: correct behaviour, appropriate tools, numbers consistent with the tool results shown, range/date stated where relevant, no invented data.
- PARTIAL: mostly right but with a real flaw (e.g. missing range/caveat the rubric asks for, minor inefficiency with >6 calls, ambiguity acknowledged only weakly, a secondary number wrong, answers only part of a multi-part question).
- FAIL: wrong or invented data, wrong entity, silently picked one of an ambiguous set, claimed to have data that is not served, ignored the question, or unhelpful refusal when the data was available.
failure_mode: one of ${FAILURE_MODES.join(", ")} (use "none" for PASS).

Respond with ONLY a JSON object, no prose, no code fence:
{"grade": "PASS|PARTIAL|FAIL", "reason": "<one or two sentences, specific>", "failure_mode": "<one of the list>"}`;
}

function runJudge(prompt: string): Promise<{ code: number | null; stdout: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("timeout", ["300", "claude", "-p", "--model", model, "--output-format", "json", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--max-turns", "2"], {
      cwd: "/tmp/eval-cwd",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", () => {});
    child.on("close", (code) => resolve({ code, stdout, ms: Date.now() - t0 }));
    child.stdin.end(prompt);
  });
}

function parseVerdict(text: string): Pick<Judgment, "grade" | "reason" | "failure_mode"> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const grade = String(j.grade).toUpperCase();
    if (!["PASS", "PARTIAL", "FAIL"].includes(grade)) return null;
    const fm = FAILURE_MODES.includes(j.failure_mode) ? j.failure_mode : grade === "PASS" ? "none" : "unhelpful";
    return { grade: grade as Judgment["grade"], reason: String(j.reason ?? ""), failure_mode: fm };
  } catch {
    return null;
  }
}

async function judgeOne(r: RunRecord): Promise<Judgment> {
  const prompt = buildPrompt(r);
  let lastRaw = "";
  let cost = 0;
  let ms = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await runJudge(prompt);
    ms += res.ms;
    let text = res.stdout;
    try {
      const j = JSON.parse(res.stdout);
      cost += j.total_cost_usd ?? 0;
      text = j.result ?? "";
    } catch {}
    lastRaw = text.slice(0, 2000);
    const v = parseVerdict(text);
    if (v) return { id: r.id, ...v, judgeCostUsd: cost, judgeMs: ms };
  }
  return { id: r.id, grade: "ERROR", reason: "judge output unparseable", failure_mode: "judge_error", judgeCostUsd: cost, judgeMs: ms, raw: lastRaw };
}

const records: RunRecord[] = fs.readFileSync(path.join(outDir, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const existing = new Map<string, Judgment>();
if (fs.existsSync(judgFile) && !force) for (const l of fs.readFileSync(judgFile, "utf8").split("\n").filter(Boolean)) {
  const j = JSON.parse(l);
  if (j.grade !== "ERROR") existing.set(j.id, j);
}
if (fs.existsSync(judgFile) && force && only) for (const l of fs.readFileSync(judgFile, "utf8").split("\n").filter(Boolean)) {
  const j = JSON.parse(l);
  if (!only.includes(j.id)) existing.set(j.id, j);
}
const todo = records.filter((r) => (!only || only.includes(r.id)) && !existing.has(r.id));
console.log(`judging ${todo.length} records (${existing.size} already judged) with ${model}, concurrency ${concurrency}`);
let next = 0;
let done = 0;
let cost = 0;
async function worker() {
  while (next < todo.length) {
    const r = todo[next++];
    const j = await judgeOne(r);
    existing.set(r.id, j);
    done++;
    cost += j.judgeCostUsd ?? 0;
    console.log(`[${done}/${todo.length}] ${r.id} ${j.grade} ${j.failure_mode} $${(j.judgeCostUsd ?? 0).toFixed(3)} total=$${cost.toFixed(2)} :: ${j.reason.slice(0, 140)}`);
    // rewrite the file after every verdict so an interrupted run can resume
    fs.writeFileSync(judgFile, records.filter((x) => existing.has(x.id)).map((x) => JSON.stringify(existing.get(x.id))).join("\n") + "\n");
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, todo.length)) }, worker));
console.log(`judge done: $${cost.toFixed(2)}`);

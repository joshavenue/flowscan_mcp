/**
 * Builds results/<run-id>/REPORT.md from results.jsonl, judgments.jsonl,
 * groundtruth-*.json and (optionally) a hand-written analysis.md in the same
 * directory (prioritized fixes etc.), plus checks.json with every
 * deterministic check per record.
 *
 *   npx tsx scripts/eval/report.ts --run-id full
 *   npx tsx scripts/eval/report.ts --run-id direct-r1 --mode direct   # mode is normally read from meta.json / the records
 *
 * The mode sets the allowed hosts and the expected tool count (strict: www.flowscan.xyz, 44;
 * direct: www.flowscan.xyz + api/rpc/api-ui.hyperliquid.xyz + api.hyperunit.xyz, 58).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODES, type Mode, type RunRecord } from "./run.js";
import type { Judgment } from "./judge.js";
import type { GT } from "./groundtruth.js";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const runId = args[args.indexOf("--run-id") + 1];
if (!runId || args.indexOf("--run-id") < 0) throw new Error("--run-id required");
const outDir = path.join(EVAL_DIR, "results", runId);
const readJsonl = <T,>(f: string): T[] => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const records = readJsonl<RunRecord>(path.join(outDir, "results.jsonl"));
const judgments = new Map(readJsonl<Judgment>(path.join(outDir, "judgments.jsonl")).map((j) => [j.id, j]));
const modeArg = args.indexOf("--mode") >= 0 ? args[args.indexOf("--mode") + 1] : undefined;
const metaFile = path.join(outDir, "meta.json");
const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : null;
const recordModes = [...new Set(records.map((r) => r.mode ?? "strict"))];
if (recordModes.length > 1) throw new Error(`records in ${runId} mix modes: ${recordModes.join(", ")}`);
const mode: Mode = (modeArg ?? meta?.mode ?? recordModes[0] ?? "strict") as Mode;
if (!MODES[mode]) throw new Error(`unknown --mode ${mode}`);
if (recordModes[0] && recordModes[0] !== mode) throw new Error(`--mode ${mode} but the records were run in ${recordModes[0]} mode`);
const ALLOWED_HOSTS = new Set(MODES[mode].hosts);
const EXPECTED_TOOLS = MODES[mode].tools;
const gtFiles = ["before", "after"].map((l) => path.join(outDir, `groundtruth-${l}.json`)).filter((f) => fs.existsSync(f));
const gts: Record<string, GT>[] = gtFiles.map((f) => JSON.parse(fs.readFileSync(f, "utf8")).gt);

const short = (n: string) => n.replace(/^mcp__flowscan__flowscan_/, "").replace(/^mcp__flowscan__/, "");
const full = (n: string) => (n.startsWith("mcp__flowscan__") ? n.replace("mcp__flowscan__", "") : n);
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
/** Claude Code replaces an MCP result above its output-token limit with this notice and saves the body to a file the agent cannot read without file tools. */
const SPILL = /^Error: result \([\d,]+ characters.*exceeds maximum allowed tokens/;
const DATA_TOOL = (n: string) => n.startsWith("mcp__flowscan__") && full(n) !== "flowscan_coverage";

/* ---------- number extraction (handles 1,234.5 / 1.65M / 437.47 million / German 437,47 Mio / CJK 万 亿) ---------- */
const SUFFIX: Record<string, number> = { k: 1e3, thousand: 1e3, tsd: 1e3, m: 1e6, mm: 1e6, mn: 1e6, mio: 1e6, million: 1e6, millions: 1e6, millionen: 1e6, b: 1e9, bn: 1e9, billion: 1e9, billions: 1e9, mrd: 1e9, milliarden: 1e9, "万": 1e4, "亿": 1e8 };
export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  const re = /(\d[\d,. ' ]*\d|\d)\s*(k|thousand|tsd\.?|mm|mn|mio\.?|millionen|millions?|m|bn|billions?|b|mrd\.?|milliarden|万|亿)?(?![a-z])/gi;
  for (const m of text.matchAll(re)) {
    const rawNum = m[1].replace(/[ ' ]/g, "");
    const suf = (m[2] ?? "").toLowerCase().replace(/\.$/, "");
    const mult = SUFFIX[suf] ?? 1;
    const cands = new Set<number>();
    // English: commas thousands, dot decimal
    const en = Number(rawNum.replace(/,/g, ""));
    if (Number.isFinite(en)) cands.add(en);
    // German/European: dots thousands, comma decimal
    if (/,\d{1,2}$/.test(rawNum) || /\.\d{3}(\.|,|$)/.test(rawNum)) {
      const de = Number(rawNum.replace(/\./g, "").replace(",", "."));
      if (Number.isFinite(de)) cands.add(de);
    }
    for (const c of cands) out.push(c * mult);
  }
  return out;
}
function gtMatch(text: string, key: string): { ok: boolean | null; detail: string } {
  const defs = gts.map((g) => g[key]).filter(Boolean);
  if (!defs.length) return { ok: null, detail: "no ground truth computed" };
  if (defs[0].kind === "name") {
    const names = defs.flatMap((d) => [d.value, ...(d.alt ?? [])].map(String));
    const ok = names.some((n) => text.toLowerCase().includes(n.toLowerCase()));
    return { ok, detail: `expected name ${[...new Set(names)].join("/")}` };
  }
  const targets = defs.flatMap((d) => [Number(d.value), ...(d.alt ?? []).map(Number)].map((v) => ({ v, tol: Math.max(d.tol ?? 0.01, 0) })));
  const nums = extractNumbers(text);
  let best = Infinity;
  let bestN: number | null = null;
  for (const n of nums) for (const t of targets) {
    const rel = Math.abs(n - t.v) / Math.max(Math.abs(t.v), 1e-9);
    if (rel < best) { best = rel; bestN = n; }
    if (rel <= Math.max(t.tol, t.tol === 0 ? 0 : 0.01)) return { ok: true, detail: `stated ${n.toLocaleString("en-US")} vs truth ${t.v.toLocaleString("en-US")} (${(rel * 100).toFixed(2)}%)` };
  }
  return { ok: false, detail: `truth ${[...new Set(targets.map((t) => Math.round(t.v * 100) / 100))].join(" / ")}; closest stated ${bestN ?? "none"} (${Number.isFinite(best) ? (best * 100).toFixed(1) + "%" : "-"})` };
}

/* ---------- deterministic checks ---------- */
interface Checks {
  id: string;
  flags: string[];
  dataToolCalls: number;
  toolErrors: number;
  gt?: { key: string; ok: boolean | null; detail: string };
}
function check(r: RunRecord): Checks {
  const flags: string[] = [];
  const e = r.expect;
  const called = r.toolCalls.map((c) => full(c.name));
  const dataCalls = r.toolCalls.filter((c) => DATA_TOOL(c.name)).length;
  const toolErrors = r.toolCalls.filter((c) => c.isError && c.name.startsWith("mcp__flowscan__")).length;
  if (r.cliCrashed) flags.push("cli_crash");
  if (r.timedOut) flags.push("timeout");
  if (r.subtype && r.subtype !== "success") flags.push(`result_${r.subtype}`);
  if (r.mcpStatus !== "connected") flags.push(`mcp_${r.mcpStatus}`);
  if ((e.behaviour === "answer" || e.behaviour === "disambiguate") && !e.toolOptional && r.toolCalls.length === 0) flags.push("no_tool_called");
  if ((e.behaviour === "not_served" || e.behaviour === "out_of_scope") && dataCalls > 0) flags.push(`data_tools_on_${e.behaviour}(${dataCalls})`);
  if (e.tools.length && (e.behaviour === "answer" || e.behaviour === "disambiguate") && called.length && !called.some((t) => e.tools.includes(t))) flags.push("no_expected_tool");
  if (e.requireAll) {
    const missing = e.requireAll.filter((t) => !called.includes(t));
    if (missing.length) flags.push(`missing_required(${missing.map(short).join(",")})`);
    else if (e.ordered) {
      const idx = e.requireAll.map((t) => called.indexOf(t));
      if (idx.some((v, i) => i > 0 && v < idx[i - 1])) flags.push("required_out_of_order");
    }
  }
  if (toolErrors) flags.push(`tool_errors(${toolErrors})`);
  const spilled = r.toolCalls.filter((c) => SPILL.test(c.resultPreview));
  if (spilled.length) flags.push(`result_too_large_for_client(${spilled.map((c) => short(c.name)).join(",")})`);
  if (r.toolCalls.length > 6) flags.push(`inefficient(${r.toolCalls.length}_calls)`);
  if (e.numeric && !/\d/.test(r.finalText)) flags.push("no_number_in_answer");
  if (e.behaviour === "not_served") {
    // strip things echoed from the prompt / harmless: urls, hex, years, dates
    const stripped = r.finalText.replace(/https?:\/\/\S+/g, "").replace(/0x[0-9a-fA-F]+/g, "").replace(/\b20\d\d-\d\d-\d\d\b/g, "").replace(/\b(19|20)\d\d\b/g, "");
    const promptNums = new Set((r.prompt.match(/\d+/g) ?? []).map(String));
    const nums = (stripped.match(/\$\s?\d[\d,.]*|\d[\d,.]{2,}/g) ?? []).filter((n) => !promptNums.has(n.replace(/[$,\s]/g, "")));
    if (nums.length) flags.push(`REVIEW_digits_in_not_served(${nums.slice(0, 4).join(" ")})`);
  }
  if (r.nonFlowscanToolUses.length) flags.push(`non_flowscan_tool_use(${r.nonFlowscanToolUses.join(",")})`);
  const badHosts = Object.keys(r.fetches.hosts).filter((h) => !ALLOWED_HOSTS.has(h));
  if (r.availableToolCount !== null && r.availableToolCount !== EXPECTED_TOOLS) flags.push(`tool_count_${r.availableToolCount}_expected_${EXPECTED_TOOLS}`);
  if (badHosts.length) flags.push(`non_flowscan_host(${badHosts.join(",")})`);
  const c: Checks = { id: r.id, flags, dataToolCalls: dataCalls, toolErrors };
  if (e.groundTruth) c.gt = { key: e.groundTruth, ...gtMatch(r.finalText, e.groundTruth) };
  return c;
}

const checks = new Map(records.map((r) => [r.id, check(r)]));
fs.writeFileSync(path.join(outDir, "checks.json"), JSON.stringify([...checks.values()], null, 1));

/* ---------- aggregate ---------- */
const grades = ["PASS", "PARTIAL", "FAIL", "ERROR"] as const;
const cats = [...new Set(records.map((r) => r.category))];
const count = (rs: RunRecord[], g: string) => rs.filter((r) => (judgments.get(r.id)?.grade ?? "ERROR") === g).length;
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
const sumN = (xs: (number | null | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
const agentCost = sumN(records.map((r) => r.totalCostUsd));
const judgeCost = sumN([...judgments.values()].map((j) => j.judgeCostUsd));
const agentMs = sumN(records.map((r) => r.wallMs));
const judgeMs = sumN([...judgments.values()].map((j) => j.judgeMs));
const toolCallsTotal = sumN(records.map((r) => r.toolCalls.length));
const L: string[] = [];
const P = (s = "") => L.push(s);

P(`# Flowscan MCP model-in-the-loop eval: run \`${runId}\``);
P();
P(`Mode: **${mode}** (${EXPECTED_TOOLS} tools; allowed hosts: ${[...ALLOWED_HOSTS].join(", ")}). Agent: Claude Code CLI \`-p\` with \`--model ${records[0]?.model ?? "sonnet"}\`, only the ${EXPECTED_TOOLS} \`mcp__flowscan__*\` tools (built-in tools disabled with \`--tools ""\`, skills disabled), system prompt = shipped SKILL.md body + one instruction line. Judge: Opus via \`claude -p --model opus\`, no tools. Generated ${new Date().toISOString()}.`);
P();
P(`## Totals`);
P();
const n = records.length;
P(`| prompts completed | PASS | PARTIAL | FAIL | judge error | agent cost | judge cost | total cost | agent wall time (sum) | judge time (sum) | tool calls |`);
P(`|---|---|---|---|---|---|---|---|---|---|---|`);
P(`| ${n} | ${count(records, "PASS")} (${pct(count(records, "PASS"), n)}) | ${count(records, "PARTIAL")} (${pct(count(records, "PARTIAL"), n)}) | ${count(records, "FAIL")} (${pct(count(records, "FAIL"), n)}) | ${count(records, "ERROR")} | $${agentCost.toFixed(2)} | $${judgeCost.toFixed(2)} | $${(agentCost + judgeCost).toFixed(2)} | ${(agentMs / 60000).toFixed(1)} min | ${(judgeMs / 60000).toFixed(1)} min | ${toolCallsTotal} |`);
P();
P(`Mean agent cost per prompt: $${(agentCost / Math.max(1, n)).toFixed(3)}; mean tool calls per prompt: ${(toolCallsTotal / Math.max(1, n)).toFixed(2)}; CLI crashes: ${records.filter((r) => r.cliCrashed).length}; retries used: ${records.filter((r) => r.attempts > 1).length}; runs not ending in \`success\`: ${records.filter((r) => r.subtype !== "success").length}.`);
P();
P(`## By category`);
P();
P(`| category | n | PASS | PARTIAL | FAIL | pass rate | mean calls | cost |`);
P(`|---|---|---|---|---|---|---|---|`);
for (const c of cats) {
  const rs = records.filter((r) => r.category === c);
  P(`| ${c} | ${rs.length} | ${count(rs, "PASS")} | ${count(rs, "PARTIAL")} | ${count(rs, "FAIL")} | ${pct(count(rs, "PASS"), rs.length)} | ${(sumN(rs.map((r) => r.toolCalls.length)) / rs.length).toFixed(1)} | $${sumN(rs.map((r) => r.totalCostUsd)).toFixed(2)} |`);
}
P();
P(`## By expected behaviour`);
P();
P(`| behaviour | n | PASS | PARTIAL | FAIL |`);
P(`|---|---|---|---|---|`);
for (const b of ["answer", "disambiguate", "not_served", "out_of_scope"]) {
  const rs = records.filter((r) => r.expect.behaviour === b);
  if (rs.length) P(`| ${b} | ${rs.length} | ${count(rs, "PASS")} | ${count(rs, "PARTIAL")} | ${count(rs, "FAIL")} |`);
}
P();
P(`## Failure modes (judge, FAIL + PARTIAL)`);
P();
const fm = new Map<string, { fail: number; partial: number }>();
for (const r of records) {
  const j = judgments.get(r.id);
  if (!j || j.grade === "PASS") continue;
  const e = fm.get(j.failure_mode) ?? { fail: 0, partial: 0 };
  if (j.grade === "FAIL") e.fail++;
  else if (j.grade === "PARTIAL") e.partial++;
  fm.set(j.failure_mode, e);
}
P(`| failure_mode | FAIL | PARTIAL |`);
P(`|---|---|---|`);
for (const [k, v] of [...fm.entries()].sort((a, b) => b[1].fail + b[1].partial - (a[1].fail + a[1].partial))) P(`| ${k} | ${v.fail} | ${v.partial} |`);
P();
P(`## Every FAIL and PARTIAL`);
P();
P(`| id | grade | prompt | tools called (! = error result) | failure_mode | reason | deterministic flags |`);
P(`|---|---|---|---|---|---|---|`);
const order = { FAIL: 0, ERROR: 1, PARTIAL: 2, PASS: 3 } as Record<string, number>;
for (const r of [...records].sort((a, b) => order[judgments.get(a.id)?.grade ?? "ERROR"] - order[judgments.get(b.id)?.grade ?? "ERROR"] || a.id.localeCompare(b.id))) {
  const j = judgments.get(r.id);
  if (j?.grade === "PASS") continue;
  const tools = r.toolCalls.map((c) => short(c.name) + (c.isError ? "!" : "")).join(", ") || "(none)";
  P(`| ${r.id} | ${j?.grade ?? "ERROR"} | ${esc(r.prompt.slice(0, 110))} | ${esc(tools)} | ${j?.failure_mode ?? "-"} | ${esc(j?.reason ?? "not judged")} | ${esc(checks.get(r.id)!.flags.join("; "))} |`);
}
P();
P(`## Deterministic checks`);
P();
const flagCounts = new Map<string, string[]>();
for (const c of checks.values()) for (const f of c.flags) {
  const k = f.replace(/\(.*$/, "");
  flagCounts.set(k, [...(flagCounts.get(k) ?? []), c.id]);
}
P(`| flag | count | ids |`);
P(`|---|---|---|`);
for (const [k, ids] of [...flagCounts.entries()].sort((a, b) => b[1].length - a[1].length)) P(`| ${k} | ${ids.length} | ${ids.join(", ")} |`);
P();
P(`Flag meanings: no_tool_called = answer expected but no tool used; data_tools_on_* = data tools (anything except flowscan_coverage) called for a not-served/out-of-scope prompt; no_expected_tool = none of the rubric's acceptable tools was used; missing_required = a rubric-mandated tool was not called; tool_errors = tool results with isError or an {error} body; inefficient = more than 6 tool calls; REVIEW_digits_in_not_served = figures in a not-served answer (manually reviewed below); disagreements between these flags and the judge are expected (the rubric's tool lists are deliberately narrow).`);
P();
P(`## Ground truth spot checks (agent's stated figure vs tools called directly, before and after the run)`);
P();
P(`| id | key | match | detail |`);
P(`|---|---|---|---|`);
let gtOk = 0;
let gtN = 0;
for (const r of records) {
  const c = checks.get(r.id)!;
  if (!c.gt) continue;
  gtN++;
  if (c.gt.ok) gtOk++;
  P(`| ${r.id} | ${c.gt.key} | ${c.gt.ok === null ? "n/a" : c.gt.ok ? "yes" : "NO"} | ${esc(c.gt.detail)} |`);
}
P();
P(`${gtOk}/${gtN} ground-truth prompts state a figure within tolerance (1% for live data; exact for counts) of a directly computed value. A NO for a disambiguation prompt can be correct behaviour (the agent asked instead of answering); see the judge's verdict.`);
P();
if (gts.length) {
  P(`Ground-truth values (${gtFiles.map((f) => path.basename(f)).join(", ")}):`);
  P();
  P(`| key | before | after | how |`);
  P(`|---|---|---|---|`);
  for (const k of Object.keys(gts[0])) P(`| ${k} | ${gts[0][k]?.value} | ${gts[1]?.[k]?.value ?? "-"} | ${esc(gts[0][k].how)} |`);
  P();
}
P(`## Server-side errors`);
P();
const errRows = records.flatMap((r) => r.toolCalls.filter((c) => c.isError && c.name.startsWith("mcp__flowscan__")).map((c) => ({ r, c })));
if (!errRows.length) P(`No tool call returned an error.`);
else {
  P(`${errRows.length} tool results were errors (isError, or a JSON body starting with "error"). Errors where status/route are null are input validation by the server itself (expected for bad input); others are upstream Flowscan failures.`);
  P();
  P(`| id | tool | input | error (first 200 chars) |`);
  P(`|---|---|---|---|`);
  for (const { r, c } of errRows) P(`| ${r.id} | ${short(c.name)} | ${esc(JSON.stringify(c.input).slice(0, 120))} | ${esc(c.resultPreview.slice(0, 200))} |`);
}
P();
const upstream = records.flatMap((r) => Object.entries(r.fetches.statuses).filter(([s]) => Number(s) >= 400).map(([s, k]) => `${r.id}: HTTP ${s} x${k}`));
const fetchErrs = records.filter((r) => r.fetches.errors).map((r) => `${r.id}: ${r.fetches.errors} network errors`);
const spills = records.flatMap((r) => r.toolCalls.filter((c) => SPILL.test(c.resultPreview)).map((c) => ({ r, c })));
P(`### Results too large for the client`);
P();
if (!spills.length) P(`None.`);
else {
  P(`${spills.length} flowscan results were not shown to the agent: Claude Code replaced them with "result (N characters) exceeds maximum allowed tokens. Output has been saved to <file>". The server itself succeeded (its own cap is ~60,000 chars), but the agent cannot read the file without file tools.`);
  P();
  P(`| id | tool | input | notice |`);
  P(`|---|---|---|---|`);
  for (const { r, c } of spills) P(`| ${r.id} | ${short(c.name)} | ${esc(JSON.stringify(c.input).slice(0, 140))} | ${esc(c.resultPreview.slice(0, 60))} |`);
}
P();
P(`Upstream HTTP status >= 400 seen by the fetch logger: ${upstream.length ? upstream.join("; ") : "none"}. Network-level fetch failures: ${fetchErrs.length ? fetchErrs.join("; ") : "none"}.`);
P();
P(`## Host and tool-surface confirmation`);
P();
const allHosts: Record<string, number> = {};
for (const r of records) for (const [h, k] of Object.entries(r.fetches.hosts)) allHosts[h] = (allHosts[h] ?? 0) + k;
const nonFs = records.filter((r) => r.nonFlowscanToolUses.length);
const extraAvail = [...new Set(records.flatMap((r) => r.nonFlowscanAvailableTools))];
const toolCountSet = [...new Set(records.map((r) => r.availableToolCount))];
const spillIds = new Set(records.filter((r) => r.toolCalls.some((c) => SPILL.test(c.resultPreview))).map((r) => r.id));
const nonFsSpill = nonFs.filter((r) => spillIds.has(r.id));
const nonFsOther = nonFs.filter((r) => !spillIds.has(r.id));
const fmtNonFs = (rs: RunRecord[]) => rs.map((r) => `${r.id} (${r.nonFlowscanToolUses.join(",")}: ${esc(JSON.stringify(r.toolCalls.find((c) => !c.name.startsWith("mcp__flowscan__"))?.input ?? {}).slice(0, 90))})`).join("; ");
P(`- tool_use blocks not named \`mcp__flowscan__*\`: ${nonFs.length ? `**${nonFs.length} records attempted a non-flowscan tool.** All were refused by the CLI ("No such tool available") because no built-in tools were enabled, so none executed and none contacted any host. After a result was saved to a file (see "Results too large for the client"): ${fmtNonFs(nonFsSpill) || "none"}. Other attempts: ${fmtNonFs(nonFsOther) || "none"}.` : "**none** across all records"}`);
P(`- Tools available to the agent per the init message: ${toolCountSet.join("/")} tools (expected ${EXPECTED_TOOLS} for ${mode} mode); non-flowscan tools available: ${extraAvail.length ? extraAvail.join(", ") : "none"}. MCP status: ${[...new Set(records.map((r) => r.mcpStatus))].join("/")}.`);
P(`- Outbound requests (HTTP and WebSocket) recorded by the logger preloaded into every MCP server process: ${Object.entries(allHosts).map(([h, k]) => `${h} x${k}`).join(", ") || "none"}. ${Object.keys(allHosts).every((h) => ALLOWED_HOSTS.has(h)) ? `**Only allowed hosts for ${mode} mode were contacted** (${[...ALLOWED_HOSTS].join(", ")}).` : `**HOSTS OUTSIDE THE ${mode.toUpperCase()} ALLOWLIST CONTACTED: ${Object.keys(allHosts).filter((h) => !ALLOWED_HOSTS.has(h)).join(", ")}**`}`);
const sizes = records.flatMap((r) => r.toolCalls.filter((c) => c.name.startsWith("mcp__flowscan__") && !SPILL.test(c.resultPreview)).map((c) => ({ id: r.id, tool: short(c.name), chars: c.resultChars })));
const biggest = sizes.sort((a, b) => b.chars - a.chars)[0];
P(`- Largest flowscan result the client received: ${biggest ? `${biggest.chars.toLocaleString("en-US")} chars (${biggest.id}, ${biggest.tool})` : "n/a"}; results the client saved to a file instead: ${records.reduce((a, r) => a + r.toolCalls.filter((c) => SPILL.test(c.resultPreview)).length, 0)}.`);
if (mode === "strict") {
  const ns = records.filter((r) => r.expect.behaviour === "not_served");
  const mentions = ns.filter((r) => /FLOWSCAN_HYPERLIQUID_DIRECT|direct mode|hyperliquid-direct/i.test(r.finalText));
  if (ns.length) P(`- Not-served answers that mention the operator can enable direct mode (FLOWSCAN_HYPERLIQUID_DIRECT): ${mentions.length}/${ns.length}${ns.length - mentions.length ? ` (missing: ${ns.filter((r) => !mentions.includes(r)).map((r) => r.id).join(", ")})` : ""}.`);
}
P();
P(`## Tool usage`);
P();
const usage = new Map<string, number>();
for (const r of records) for (const c of r.toolCalls) usage.set(short(c.name), (usage.get(short(c.name)) ?? 0) + 1);
P(`| tool | calls |`);
P(`|---|---|`);
for (const [t, k] of [...usage.entries()].sort((a, b) => b[1] - a[1])) P(`| ${t} | ${k} |`);
const unused = ["coverage", "stablecoin_margin", "peers", "staking_overview", "validator_stakers", "staking_events", "revenue_hypercore_fees", "revenue_deployer_fees", "revenue_priority_gas", "revenue_summary", "perp_markets", "perp_positions", "address_perp_positions", "address_summary", "address_orders", "address_fills", "address_ledger", "address_staking", "address_vaults_subaccounts", "address_extras", "spot_stocks", "weekend_weeks", "weekend_prices", "weekend_positions", "weekend_coin_changes", "hip4_markets", "hip4_outcome", "hip4_labels", "hip3_overview", "hip3_daily", "hip3_markets", "hip3_dex", "hip3_builders", "hip3_binance_comparison", "builders_leaderboard", "builders_summary", "builders_daily_revenue", "builder_lookup", "builder_revenue", "builders_user_series", "builder_dashboard", "builder_intelligence_list", "builder_intelligence_detail", "builder_intelligence_summary", ...(mode === "direct" ? ["block", "transaction", "live_feed", "prices", "candles", "order_book", "recent_trades", "spot_tokens", "perp_dexs", "validator_summaries", "borrow_lend_reserves", "address_portfolio", "address_evm_balance", "address_unit_operations"] : [])].filter((t) => !usage.has(t));
P();
P(`Tools never called: ${unused.length ? unused.join(", ") : "none"}.`);
P();
const analysis = path.join(outDir, "analysis.md");
if (fs.existsSync(analysis)) {
  P(fs.readFileSync(analysis, "utf8").trim());
  P();
}
fs.writeFileSync(path.join(outDir, "REPORT.md"), L.join("\n"));
console.log(`wrote ${path.join(outDir, "REPORT.md")} (${records.length} records, ${judgments.size} judgments)`);

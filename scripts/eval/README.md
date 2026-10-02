# Model-in-the-loop eval

`scripts/smoke.ts` and `scripts/qa/scenarios.ts` call the tools from a script. This eval is different: a real Sonnet agent gets a natural-language question and **only this MCP server's tools**, picks the tools itself, and answers. An Opus judge then grades each answer against a rubric and against the tool results the agent actually saw.

## Files

| file | purpose |
| --- | --- |
| `prompts.json` | 220 prompts `{id, category, prompt, expect}`. `expect = {tools (acceptable, any-of), behaviour: answer \| disambiguate \| not_served \| out_of_scope, notes, requireAll?, ordered?, numeric?, groundTruth?, toolOptional?}` |
| `mcp.json` | the MCP config the agent uses (`node dist/index.js`, `FLOWSCAN_MAX_CONCURRENCY=2`) |
| `system.md` | appended system prompt: the body of `skills/flowscan/SKILL.md` (no frontmatter) plus one instruction line. It is a copy, so regenerate it after editing the skill (see below) |
| `run.ts` | runs the agent per prompt and records tool calls, results, final answer, cost, turns, hosts |
| `fetch-log.mjs` | preloaded into each MCP server process (`node --import`); logs every outbound request host so the run proves only www.flowscan.xyz was contacted |
| `judge.ts` | Opus judge, one verdict `{grade: PASS\|PARTIAL\|FAIL, reason, failure_mode}` per record |
| `groundtruth.ts` | computes ~20 reference figures by calling the tools directly (via `scripts/qa/lib.ts`) |
| `report.ts` | deterministic checks + judge + ground truth -> `REPORT.md` and `checks.json` (appends `analysis.md` from the run dir if present) |

## Running

`system.md` is a static copy of the skill body. After changing `skills/flowscan/SKILL.md`, regenerate it so the eval tests the skill you ship:

```sh
{ awk 'f>=2{print} /^---$/{f++}' skills/flowscan/SKILL.md; echo; \
  echo "Answer the user's question using the flowscan tools. If the data is not available from Flowscan, say so plainly. Be concise and state the source and date range."; } > scripts/eval/system.md
```


```sh
npm run build                                      # the agent runs dist/index.js
mkdir -p /tmp/eval-cwd                             # empty, neutral cwd: no CLAUDE.md leaks in

npx tsx scripts/eval/run.ts --limit 5 --run-id pilot             # pilot
npx tsx scripts/eval/groundtruth.ts --run-id full --label before
npx tsx scripts/eval/run.ts --run-id full --concurrency 4         # all prompts (~15 min, ~$7)
npx tsx scripts/eval/groundtruth.ts --run-id full --label after
npx tsx scripts/eval/judge.ts --run-id full --concurrency 4       # ~$10
npx tsx scripts/eval/report.ts --run-id full                      # -> results/full/REPORT.md
```

Useful flags. `run.ts`: `--only b01,q12`, `--category builders`, `--resume` (skip ids already recorded in the run dir), `--model`, `--max-turns` (default 10), `--timeout` (seconds, default 180), `--cwd`. `judge.ts`: `--only ids --force` to re-judge, `--model` (default opus). Both are resumable.

### Re-running a subset after a fix

Re-run the prompts that failed plus a seeded regression sample of ones that passed, under a new run id, then compare `judgments.jsonl` across the two run dirs. For example, round 3 (`results/after-r3/selection.json` records the ids and seed):

```sh
npx tsx scripts/eval/run.ts --run-id after-r3 --only a06,k07,...,x03 --concurrency 4
npx tsx scripts/eval/judge.ts --run-id after-r3 && npx tsx scripts/eval/report.ts --run-id after-r3
```

## How the agent is run

Per prompt, `run.ts` spawns:

```sh
timeout 180 claude -p "<prompt>" --model sonnet \
  --mcp-config results/<run>/mcp/<id>.json --strict-mcp-config \
  --tools "" --disable-slash-commands \
  --allowedTools "mcp__flowscan__*" \
  --disallowedTools "Bash,Read,Write,Edit,MultiEdit,Glob,Grep,WebFetch,WebSearch,Task,Agent,NotebookEdit,TodoWrite" \
  --max-turns 10 --output-format stream-json --verbose --no-session-persistence \
  --append-system-prompt-file scripts/eval/system.md
```

from `/tmp/eval-cwd`. The per-prompt MCP config is `mcp.json` plus the fetch logger. Two flags go beyond the original plan:

- `--tools ""`: without it Claude Code still exposes ~30 non-coding built-ins (Artifact, Workflow, SendMessage, ToolSearch, ...), and the flowscan tools are deferred behind ToolSearch. With it, the init message lists exactly the 44 flowscan tools, loaded eagerly.
- `--disable-slash-commands`: stops user/plugin skills from appearing in the agent's context.

A prompt is retried once if the CLI crashes or times out (no `result` event, or exit 124), never because of a bad answer.

## Output (`results/<run-id>/`)

- `<id>.json` and `results.jsonl`: one record per prompt: tool calls in order (name, input, isError, first 300 chars of the result, first 4000 chars for the judge), final text, num_turns, total_cost_usd, duration, the hosts contacted, MCP status and the available tool list.
- `raw/<id>.stream.jsonl`: the raw stream-json. `fetch/<id>.jsonl`: every outbound request.
- `judgments.jsonl`, `groundtruth-before.json`, `groundtruth-after.json`, `checks.json`, `REPORT.md`.

## Grading

1. Deterministic (`report.ts`): a tool was called when an answer was expected; no data tools (only `flowscan_coverage` allowed) for not-served or out-of-scope prompts; at least one acceptable tool and every `requireAll` tool was used; tool error results; more than 6 calls; the answer contains a number when one is expected; figures in not-served answers are flagged for manual review; no non-flowscan `tool_use`; only www.flowscan.xyz contacted.
2. LLM judge (`judge.ts`): Opus sees the prompt, rubric, tool calls with truncated results, and the answer. It is told to compare numbers against the tool results, not its own knowledge.
3. Ground truth (`groundtruth.ts`): for prompts with `expect.groundTruth`, the figure stated in the answer must be within 1% of the value computed directly before or after the run (exact for counts; names must appear).

The data is live, so the absolute numbers in `prompts.json` notes (e.g. FOMO 45d = 1,649,115.56 USD) are only correct for 2026-10-02; date-relative prompts ("yesterday", "last 45 days") will resolve to other dates later. The judge's context block (`judge.ts`, `contextFor`) takes today's date from each record's `startedAt`.

## Results

- `results/full/REPORT.md`: the first full run (2026-10-02, 220 prompts): 197 PASS (89.5%), 20 PARTIAL, 3 FAIL, with a hand-written analysis of every non-PASS record (`results/full/analysis.md`). Every one of the 362 outbound requests went to www.flowscan.xyz.
- `../../docs/eval-2026-10-02.md`: a copy of that report, including the failure analysis and the prioritized fixes. The fixes that followed were the lower result cap, server-side totals, `_fieldsNotFound` reporting, ISO timestamps, dated HIP-3 rows, spot-stock tickers in the tool description, and skill rules on arithmetic and adversarial requests.

To compare a later run with this baseline, use a new `--run-id` and keep `results/full/` unchanged.

/** Ad-hoc: npx tsx scripts/qa/explore.ts '<json array of [tool,args]>' [maxChars] */
import { Harness } from "./lib.js";
const calls: [string, Record<string, unknown>][] = JSON.parse(process.argv[2]);
const max = Number(process.argv[3] ?? 3000);
const h = new Harness();
await h.start();
for (const [tool, args] of calls) {
  const r = await h.call(tool, args);
  const hosts = [...new Set(r.fetches.map((f) => f.host))];
  console.log(`\n=== ${tool} ${JSON.stringify(args)} -> isError=${r.isError} chars=${r.chars} ms=${r.ms} truncated=${r.truncated} fetches=${r.fetches.filter((f) => f.kind === "start").length} hosts=${hosts.join(",")}`);
  console.log(r.text.slice(0, max));
}
await h.stop();

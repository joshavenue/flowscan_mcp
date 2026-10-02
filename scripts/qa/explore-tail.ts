/** Ad-hoc: show head and tail of each result. npx tsx scripts/qa/explore-tail.ts '<json [[tool,args]]>' [headChars] [tailChars] */
import { Harness } from "./lib.js";
const calls: [string, Record<string, unknown>][] = JSON.parse(process.argv[2]);
const head = Number(process.argv[3] ?? 800);
const tailN = Number(process.argv[4] ?? 600);
const h = new Harness();
await h.start();
for (const [tool, args] of calls) {
  const r = await h.call(tool, args);
  console.log(`\n=== ${tool} ${JSON.stringify(args)} -> isError=${r.isError} chars=${r.chars} ms=${r.ms} truncated=${r.truncated} jsonParses=${r.json !== null}`);
  console.log(r.text.slice(0, head));
  console.log("   ...   ");
  console.log(r.text.slice(-tailN));
}
await h.stop();

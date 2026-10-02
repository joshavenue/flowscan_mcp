/** Print every tool with its required params and description length. npx tsx scripts/qa/list-tools.ts [--full] */
import { Harness } from "./lib.js";
const h = new Harness();
await h.start();
const tools = await h.listTools();
let total = 0;
for (const t of tools) {
  const s: any = t.inputSchema;
  const req = s.required ?? [];
  const props = Object.keys(s.properties ?? {});
  total += JSON.stringify(t).length;
  console.log(`${t.name} | req=[${req.join(",")}] | params=${props.length} | desc=${t.description?.length}`);
  if (process.argv.includes("--full")) console.log(`   ${t.description}\n`);
}
console.log(`tools=${tools.length} totalSchemaChars=${total}`);
await h.stop();

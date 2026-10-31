// Applies candidate fixes to the frozen actor copy under ~/ar-vendors, never to the shared checkout.
// Usage, from the frozen actor folder: bun run <path>/patch-actor.ts tick-in-memory
import { readFileSync, writeFileSync } from "node:fs";

type Edit = { find: string; replace: string };

const PATCHES: Record<string, Edit[]> = {
  // The tick counter stops being a durable write every second.
  "tick-in-memory": [{ find: "    @Persisted @Emittable tickCount = 0\n", replace: "    tickCount = 0\n" }],
};

const file = "src/actor.ts";
let text = readFileSync(file, "utf8");
for (const name of process.argv.slice(2)) {
  const edits = PATCHES[name];
  if (!edits) throw new Error(`unknown patch ${name}`);
  for (const { find, replace } of edits) {
    if (!text.includes(find)) throw new Error(`${name}: ${file} no longer contains the expected line`);
    text = text.replace(find, replace);
  }
  console.log(`patched ${name}`);
}
writeFileSync(file, text);

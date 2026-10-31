// Why votes failed and why counters did not happen: bun run evals/counter/tally.ts <tag>
import { readFileSync } from "node:fs";
import { join } from "node:path";

const tag = process.argv[2]!;
const recs = readFileSync(join(import.meta.dir, "out", `${tag}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const count = (into: Record<string, number>, key: string) => (into[key] = (into[key] ?? 0) + 1);
const rejections: Record<string, number> = {};
for (const r of recs) for (const line of r.rejections) count(rejections, line.replace(/^plant-[ab]\/\S+ /, "").replace(/attempt \d /, "").slice(0, 70));
console.log("vote rejections:", JSON.stringify(rejections, null, 0));

const parentNoReasons: Record<string, number> = {};
const emptyPredictions: Record<string, number> = {};
for (const r of recs) {
  for (const v of r.parentVotes ?? []) {
    if (v.vote !== "no") continue;
    const reason = String(v.reason).replace(/\d+(\.\d+)?/g, "#").slice(0, 60);
    count(parentNoReasons, `${v.id.split("/").slice(-2).join("/")}: ${reason}`);
    if (!Object.keys(v.predicted).length) count(emptyPredictions, v.id.split("/").slice(-2).join("/"));
  }
}
console.log("parent no reasons:", JSON.stringify(Object.fromEntries(Object.entries(parentNoReasons).sort((a, b) => b[1] - a[1]).slice(0, 20)), null, 0));
console.log("parent no votes with empty predicted:", JSON.stringify(emptyPredictions));

const noCounter = recs.filter((r) => r.rounds[0]?.refused);
for (const r of noCounter.slice(0, 40)) {
  const nos = (r.parentVotes ?? []).filter((v: any) => v.vote === "no").map((v: any) => `${v.id.split("/").pop()} ${JSON.stringify(v.predicted)}`);
  console.log(`${r.id} ${r.scenario.from}->${r.scenario.to} ${String(r.rounds[0].refused).slice(-40)} :: ${nos.join(" | ")}`);
}

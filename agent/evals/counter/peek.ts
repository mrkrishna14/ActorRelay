// Prints the scenarios that did not pass: bun run evals/counter/peek.ts <tag> [group,group]
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [tag, groups] = process.argv.slice(2);
const wanted = groups ? new Set(groups.split(",")) : null;
const recs = readFileSync(join(import.meta.dir, "out", `${tag}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));

for (const r of recs) {
  if (wanted && !wanted.has(r.group)) continue;
  if (r.rounds.some((f: any) => f.unanimous)) continue;
  const s = r.scenario;
  console.log(`\n${r.id} ${s.from}->${s.to} margins=${JSON.stringify(s.margins)} ceiling=${r.ceiling} parent blockers=${r.parentBlockers.map((b: string) => b.split("/").slice(-2).join("/"))}`);
  for (const p of r.parentVotes ?? []) if (p.vote === "no") console.log(`  parent NO ${p.id} ${JSON.stringify(p.predicted)} :: ${p.reason.slice(0, 220)}`);
  for (const f of r.rounds) {
    console.log(`  r${f.n} to=${f.to} refused=${f.refused ?? ""} rationale="${(f.rationale ?? "").slice(0, 160)}"`);
    for (const b of f.blockers) console.log(`     NO ${b.id} spurious=${b.spurious} ${JSON.stringify(b.predicted)} :: ${b.reason.slice(0, 240)}`);
  }
  if (r.rejections.length) console.log(`  rejections: ${r.rejections.slice(0, 4).join(" | ").slice(0, 400)}`);
}

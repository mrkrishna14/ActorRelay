// Turns measured result JSON into Markdown tables for REPORT.md, so the report cannot drift from the data.
//   bun run summarize.ts <runId> [<runId> ...]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioResult } from "./lib/scenario";

const runs = process.argv.slice(2);
const latest = new Map<string, ScenarioResult & { runId: string }>();
for (const runId of runs) {
  const dir = join(import.meta.dir, "results", runId);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const result = JSON.parse(readFileSync(join(dir, file), "utf8"));
    latest.set(result.id, { ...result, runId }); // Later run ids win, so a re-run replaces its earlier result.
  }
}

const results = [...latest.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
console.log("| Scenario | Result | Checks | Run | What failed |");
console.log("|---|---|---|---|---|");
for (const result of results) {
  const passed = result.checks.filter((check) => check.pass).length;
  const failed = result.checks.filter((check) => !check.pass).map((check) => check.name);
  const reason = result.error ? `harness error: ${result.error.split("\n")[0].slice(0, 120)}` : failed.join("; ");
  console.log(`| ${result.id} | ${result.status.toUpperCase()} | ${passed}/${result.checks.length} | ${result.runId} | ${reason} |`);
}

const pick = (result: ScenarioResult, suffix: string) => Object.entries(result.metrics).filter(([name]) => name.endsWith(suffix)).map(([, value]) => value);
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? `n=${sorted.length} min ${sorted[0]} median ${sorted[Math.floor(sorted.length / 2)]} max ${sorted.at(-1)}` : "not measured";
};
const across = (suffix: string) => results.flatMap((result) => pick(result, suffix));

console.log("\n| Recovery measurement (ms) | Values |");
console.log("|---|---|");
console.log(`| First server start | ${stats(across("firstStartMs"))} |`);
console.log(`| Kill to /healthz ok | ${stats(across("healthyAfterKillMs"))} |`);
console.log(`| Kill to first Plant read | ${stats(across("firstPlantReadAfterKillMs"))} |`);
console.log(`| Kill to first /tick at glue | ${stats(across("firstTickAfterKillMs"))} |`);
console.log(`| Kill of Plant host only, to first read | ${stats(across("hostkill.firstReadAfterKillMs"))} |`);

const notes = results.flatMap((result) => result.notes.map((note) => `- ${result.id}: ${note}`));
if (notes.length) console.log(`\nObserved notes:\n${notes.join("\n")}`);

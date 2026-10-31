#!/usr/bin/env node
// Offline only: reads a finished run's timing files and shows when Plant calls stalled and what else was slow then.
// Usage: node stalls.mjs real-ram
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const label = process.argv[2] ?? "real-ram";
const results = join(dirname(fileURLToPath(import.meta.url)), "..", "results");
const read = (name) =>
  readFileSync(join(results, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
const glue = read(`timing-glue-${label}.jsonl`);
const agents = read(`timing-agents-${label}.jsonl`);
const report = JSON.parse(readFileSync(join(results, `rt-${label}.json`), "utf8"));
const actor = glue.filter((t) => t.kind === "actor");
const start = Math.min(...report.proposals.map((p) => p.t0));
const rel = (at) => ((at - start) / 1000).toFixed(1);

const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] : null;
};
const stats = (values) => ({ n: values.length, p50: pct(values, 50), p95: pct(values, 95), max: values.length ? Math.max(...values) : null });

console.log("proposal starts (seconds into run):");
console.log(report.proposals.map((p) => `${p.label}@${rel(p.t0)}`).join(" "));

const slowPlant = actor.filter((t) => t.actor === "Plant" && t.ms >= 2000 && t.method !== "loadSeed").sort((a, b) => a.at - b.at);
console.log(`\nPlant calls of 2s or more: ${slowPlant.length}`);
for (const t of slowPlant) console.log(`  ${rel(t.at)}s ${t.id}.${t.method} ${t.componentId ?? ""} ${t.ms}ms ${t.error ? "ERROR " + t.error.slice(0, 50) : `status ${t.status}`}`);

// Merge overlapping slow calls per plant into stall windows.
const windows = [];
for (const t of slowPlant) {
  const last = windows.at(-1);
  if (last && t.at <= last.end) {
    last.end = Math.max(last.end, t.at + t.ms);
    last.plants.add(t.id);
    last.calls += 1;
  } else windows.push({ start: t.at, end: t.at + t.ms, plants: new Set([t.id]), calls: 1 });
}
console.log(`\nstall windows: ${windows.length}`);
for (const w of windows) {
  const inside = (t) => t.at >= w.start && t.at + t.ms <= w.end + 500;
  const company = actor.filter((t) => t.actor === "Company" && inside(t)).map((t) => t.ms);
  const mirror = actor.filter((t) => t.method === "mirror" && inside(t)).map((t) => t.ms);
  const openai = agents.filter((t) => t.kind === "openai" && inside(t)).map((t) => t.ms);
  const relay = agents.filter((t) => t.kind === "relay" && inside(t)).map((t) => t.ms);
  console.log(`  ${rel(w.start)}-${rel(w.end)}s (${((w.end - w.start) / 1000).toFixed(1)}s) plants=${[...w.plants].join(",")} calls=${w.calls}`);
  console.log(`    Company ${JSON.stringify(stats(company))} mirror ${JSON.stringify(stats(mirror))} openai ${JSON.stringify(stats(openai))} relay ${JSON.stringify(stats(relay))}`);
}

const voteCalls = actor.filter((t) => t.method === "vote");
console.log(`\nPlant.vote: ${JSON.stringify(stats(voteCalls.map((t) => t.ms)))} failed ${voteCalls.filter((t) => t.error || t.status !== 200).length}`);
for (const t of voteCalls.filter((t) => t.error || t.status !== 200)) console.log(`  ${rel(t.at)}s ${t.componentId} ${t.ms}ms ${String(t.error ?? t.status).slice(0, 70)}`);
const proposeCalls = actor.filter((t) => t.method === "propose");
console.log(`Plant.propose: ${JSON.stringify(stats(proposeCalls.map((t) => t.ms)))} failed ${proposeCalls.filter((t) => t.error || t.status !== 200).length}`);

const tenPairs = report.proposals.filter((p) => p.label.startsWith("ten-"));
console.log(`\nten at once, seen by dashboard: ${tenPairs.map((p) => `${p.label} ${p.seenAt - p.t0}ms ${p.status}`).join("; ")}`);
const models = agents.filter((t) => t.kind === "openai");
const repeats = report.proposals.filter((p) => p.label.startsWith("repeat"));
const during = repeats.map((p) => models.filter((t) => t.at >= p.t0 && t.at < p.t0 + 12000).length);
console.log(`model calls per repeat proposal: ${during.join(",")}`);
console.log(`reads per repeat proposal at Plant: ${repeats.map((p) => actor.filter((t) => t.actor === "Plant" && t.at >= p.t0 && t.at < p.t0 + 5000).length).join(",")}`);
const windowMs = (Math.max(...actor.map((t) => t.at)) - Math.min(...actor.map((t) => t.at))) / 1000;
const count = (m) => actor.filter((t) => t.method === m).length;
console.log(`rates per second over ${windowMs.toFixed(0)}s: mirror ${(count("mirror") / windowMs).toFixed(1)}, Plant.getState ${(actor.filter((t) => t.actor === "Plant" && t.method === "getState").length / windowMs).toFixed(2)}, Company.getState ${(actor.filter((t) => t.actor === "Company").length / windowMs).toFixed(2)}`);

// Rebuilds the per-proposal timeline for a finished run from the timing files, and shows what the slow ones waited on.
// Usage, in WSL from the frozen agent folder: RT_LABEL=real-ram bun run roundtrip/analyze.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LABEL = process.env.RT_LABEL ?? "real";
const VOTER = process.env.RT_VOTER ?? "plant-a/LV-101";
const runDir = join(import.meta.dir, "..", "..");
const resultDir = process.env.RT_RESULTS ?? join(runDir, "results");
const report = JSON.parse(readFileSync(join(resultDir, `rt-${LABEL}.json`), "utf8"));
const read = (file: string) =>
  readFileSync(join(runDir, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
const agents = read(`timing-agents-${LABEL}.jsonl`);
const glue = read(`timing-glue-${LABEL}.jsonl`);
const encoded = encodeURIComponent(VOTER);

const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] : null;
};
const line = (name: string, values: number[]) => ({ name, n: values.length, p50: pct(values, 50), p95: pct(values, 95), max: values.length ? Math.max(...values) : null });

const rows: any[] = [];
for (const r of report.proposals) {
  if (!r.t0 || r.label === "counter") continue;
  const propose = glue.find((t) => t.kind === "actor" && t.method === "propose" && t.result === r.id);
  const publish = glue.filter((t) => t.kind === "relay" && t.type === "proposal" && t.ref === r.id);
  const post = agents.find((t) => t.kind === "relay" && t.type === "vote" && t.proposalId === r.id && t.componentId === VOTER);
  const votes = glue.filter((t) => t.kind === "actor" && t.method === "vote" && t.proposalId === r.id && t.componentId === VOTER);
  const plantVote = votes[0];
  if (!propose || !post || !plantVote) {
    rows.push({ label: r.label, id: r.id, missing: { propose: !propose, post: !post, plantVote: !plantVote } });
    continue;
  }
  const reads = agents.filter((t) => t.kind === "glue" && t.at >= propose.at && t.at < post.at);
  const own = reads.filter((t) => t.path.includes(encoded) || t.query?.includes(`componentId=${encoded}`));
  const ownRules = own.find((t) => t.path === "/rules");
  const proposerRules = reads
    .filter((t) => t.path === "/rules" && t.query?.includes(encodeURIComponent(`${r.plantId}/P-100`)))
    .sort((a, b) => Math.abs(a.at - (ownRules?.at ?? 0)) - Math.abs(b.at - (ownRules?.at ?? 0)))[0];
  const shared = ["/state", "/similar"].flatMap((path) => reads.filter((t) => t.path === path).slice(0, 1));
  const context = [...own, ...(proposerRules ? [proposerRules] : []), ...shared];
  const firstRead = Math.min(...context.map((t) => t.at));
  const contextDone = Math.max(...context.map((t) => t.at + t.ms));
  const voteDone = plantVote.at + plantVote.ms;
  rows.push({
    label: r.label,
    id: r.id,
    load: r.load,
    total: voteDone - r.t0,
    propose: propose.ms,
    publish: Math.max(...publish.map((t) => t.at + t.ms)) - (propose.at + propose.ms),
    deliver: firstRead - (propose.at + propose.ms),
    context: contextDone - firstRead,
    decide: post.at - contextDone,
    post: post.ms,
    fanOut: plantVote.at - (post.at + post.ms),
    plantVote: plantVote.ms,
    voteOk: plantVote.status === 200 && !plantVote.error,
    voteTries: votes.length,
    seen: r.seenAt ? r.seenAt - r.t0 : null,
    prefix: r.votes?.find((v: any) => v.componentId === VOTER)?.prefix?.slice(0, 40) ?? "",
  });
}

const complete = rows.filter((row) => row.total !== undefined);
const stages = ["total", "propose", "publish", "deliver", "context", "decide", "post", "fanOut", "plantVote", "seen"].map((k) => line(k, complete.map((row) => row[k]).filter((n) => typeof n === "number")));
const groups = { repeat: complete.filter((row) => row.label.startsWith("repeat")), tenA: complete.filter((row) => row.label.startsWith("ten-a")) };
const summary = Object.fromEntries(
  Object.entries(groups).map(([name, group]) => [name, { n: group.length, under5s: group.filter((row) => row.total < 5000).length, total: line("total", group.map((row) => row.total)) }]),
);

// What the Plant was doing while the slow votes waited.
const plantCalls = glue.filter((t) => t.kind === "actor" && t.actor === "Plant");
const slow = complete.filter((row) => row.total > 5000).map((row) => {
  const r = report.proposals.find((p: any) => p.id === row.id);
  const end = r.t0 + row.total;
  const during = plantCalls.filter((t) => t.at < end && t.at + t.ms > r.t0);
  const byMethod: Record<string, { n: number; maxMs: number }> = {};
  for (const call of during) {
    const entry = (byMethod[`${call.id}.${call.method}`] ??= { n: 0, maxMs: 0 });
    entry.n += 1;
    entry.maxMs = Math.max(entry.maxMs, call.ms);
  }
  return { label: row.label, total: row.total, propose: row.propose, plantVote: row.plantVote, load: row.load, byMethod };
});

const result = { label: LABEL, voter: VOTER, summary, stages, rows, slow };
writeFileSync(join(resultDir, `rt-${LABEL}-analysis.json`), JSON.stringify(result, null, 1));
console.log(JSON.stringify({ summary, stages }));
for (const row of rows) console.log(JSON.stringify(row));
for (const row of slow) console.log(`SLOW ${JSON.stringify(row)}`);

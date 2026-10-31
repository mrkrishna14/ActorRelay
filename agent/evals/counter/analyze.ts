// Aggregates a run's JSONL: bun run evals/counter/analyze.ts <tag> [tag...]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const outDir = join(import.meta.dir, "out");

const pct = (n: number, d: number) => (d === 0 ? "-" : `${((100 * n) / d).toFixed(0)}%`);
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
const median = (xs: number[]) => quantile(xs, 0.5);
const secs = (ms: number) => (Number.isNaN(ms) ? "-" : (ms / 1000).toFixed(1));

function row(group: string, recs: any[]): string {
  const n = recs.length;
  const blocked = recs.filter((r) => r.parentBlocked);
  const errors = recs.filter((r) => r.error).length;
  const firsts = blocked.map((r) => r.rounds[0]).filter(Boolean);
  const made = firsts.filter((f) => f.to !== null);
  const rounds = blocked.flatMap((r) => r.rounds).filter((f: any) => f.to !== null);
  const pass1 = blocked.filter((r) => r.rounds[0]?.unanimous).length;
  const pass2 = blocked.filter((r) => r.rounds.some((f: any) => f.unanimous)).length;
  const values = made.map((f) => f.to as number);
  const inRange = rounds.filter((f: any) => f.inRange).length;
  const clears = rounds.filter((f: any) => f.clearsTruth).length;
  const backToBlocked = rounds.filter((f: any) => f.equalsBlocked).length;
  const noOp = rounds.filter((f: any) => f.equalsFrom).length;
  const headroom = made.map((f) => f.headroomUsed).filter((h) => h !== null) as number[];
  const refused = blocked.flatMap((r) => r.rounds).filter((f: any) => f.refused).length;
  const counterMs = rounds.map((f: any) => f.counterMs);
  const e2e = blocked.filter((r) => r.rounds.some((f: any) => f.unanimous)).map((r) => r.rounds.reduce((sum: number, f: any) => sum + f.counterMs + f.voteMs, 0));
  return [
    group, n, errors || "", pct(blocked.length, n), made.length,
    pct(inRange, rounds.length), pct(clears, rounds.length), pct(pass1, blocked.length), pct(pass2, blocked.length),
    values.length ? `${quantile(values, 0.1)}/${median(values)}/${quantile(values, 0.9)}` : "-",
    headroom.length ? median(headroom).toFixed(2) : "-",
    backToBlocked || "", noOp || "", refused || "",
    `${secs(median(counterMs))}/${secs(quantile(counterMs, 0.95))}`, `${secs(median(e2e))}/${secs(quantile(e2e, 0.95))}`,
  ].join(" | ");
}

const HEAD = "group | n | err | blocked | counters | inRange | clearsTruth | pass r1 | pass r1-2 | p10/p50/p90 | headroom | =blocked | =from | refused | counter s p50/p95 | block->pass s p50/p95";

for (const tag of process.argv.slice(2)) {
  const path = join(outDir, `${tag}.jsonl`);
  const recs = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const metaPath = join(outDir, `${tag}.meta.json`);
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
  console.log(`\n## ${tag}: ${meta.implName ?? "?"} ${meta.model ?? ""}/${meta.effort ?? ""} ${recs.length} scenarios, code ${JSON.stringify(meta.code ?? {})}, ${JSON.stringify(meta.stats ?? {})}, wall ${Math.round(meta.wallSeconds ?? 0)}s\n`);
  console.log(HEAD);
  console.log(HEAD.split(" | ").map(() => "---").join(" | "));
  const groups = [...new Set(recs.map((r) => r.group))];
  for (const group of groups) console.log(row(group, recs.filter((r) => r.group === group)));
  console.log(row("ALL", recs));

  const demo = recs.filter((r) => r.group === "demo" && r.parentBlocked && r.rounds[0]?.to !== null);
  if (demo.length) {
    const near = demo.filter((r) => r.rounds[0].to >= 60 && r.rounds[0].to <= 70).length;
    const hist: Record<string, number> = {};
    demo.forEach((r) => (hist[r.rounds[0].to] = (hist[r.rounds[0].to] ?? 0) + 1));
    console.log(`\ndemo first counter values: ${JSON.stringify(hist)}; in 60-70: ${pct(near, demo.length)}`);
  }

  const failures: Record<string, number> = {};
  for (const r of recs) {
    for (const f of r.rounds) for (const b of f.blockers) failures[`${r.group}: ${b.id.split("/").slice(-2).join("/")} r${f.n}`] = (failures[`${r.group}: ${b.id.split("/").slice(-2).join("/")} r${f.n}`] ?? 0) + 1;
  }
  console.log(`\nblockers on counters: ${JSON.stringify(Object.fromEntries(Object.entries(failures).sort((a, b) => b[1] - a[1]).slice(0, 25)))}`);
  const notBlocked = recs.filter((r) => !r.parentBlocked && !r.error).map((r) => r.group);
  console.log(`parent not blocked: ${JSON.stringify(notBlocked.reduce((acc: any, g) => ((acc[g] = (acc[g] ?? 0) + 1), acc), {}))}`);
  const voted = recs.flatMap((r) => r.rounds).filter((f: any) => f.to !== null);
  const safe = voted.filter((f: any) => f.clearsTruth);
  const unsafe = voted.filter((f: any) => !f.clearsTruth);
  const noes = voted.flatMap((f: any) => f.blockers);
  console.log(`
of counters that clear physics, voted through: ${pct(safe.filter((f: any) => f.unanimous).length, safe.length)} (n=${safe.length})`);
  console.log(`of counters that fail physics, voted through (false pass): ${pct(unsafe.filter((f: any) => f.unanimous).length, unsafe.length)} (n=${unsafe.length})`);
  console.log(`no votes on counters with every prediction under threshold: ${pct(noes.filter((b: any) => b.spurious).length, noes.length)} (n=${noes.length})`);
  const passedNoOp = recs.filter((r) => r.rounds.some((f: any) => f.unanimous && f.equalsFrom)).length;
  const passedRepeat = recs.filter((r) => r.rounds.some((f: any) => f.unanimous && f.equalsBlocked)).length;
  console.log(`passed as a no-op (value = from): ${passedNoOp}; passed by re-proposing a blocked value: ${passedRepeat}`);
  const rationales = voted.map((f: any) => f.rationale);
  console.log(`rationales distinct: ${new Set(rationales).size}/${rationales.length}, citing a blocker tag: ${pct(voted.filter((f: any) => f.citesBlocker).length, voted.length)}`);
  const partial = recs.filter((r) => r.visibleVotes);
  if (partial.length) {
    const missing = partial.filter((r) => r.visibleVotes.length < 5);
    const noLv = partial.filter((r) => r.parentBlockers.some((b: string) => b.endsWith("LV-101")) && !r.visibleVotes.includes("LV-101:no"));
    console.log(`partial votes at block: counter saw fewer than all voters in ${pct(missing.length, partial.length)}; LV-101's no not yet in: ${pct(noLv.length, partial.length)}`);
  }
  const byCode = voted.filter((f: any) => f.decidedBy === "code").length;
  console.log(`counters chosen by code fallback (model gave no valid reply): ${byCode}/${voted.length}`);
  const refusals: Record<string, number> = {};
  for (const r of recs) for (const f of r.rounds) if (f.refused) refusals[`${r.group} r${f.n}: ${String(f.refused).replace(/^[^:]*: /, "").replace(/\d+/g, "#").slice(0, 60)}`] = (refusals[`${r.group} r${f.n}: ${String(f.refused).replace(/^[^:]*: /, "").replace(/\d+/g, "#").slice(0, 60)}`] ?? 0) + 1;
  console.log(`no counter produced: ${JSON.stringify(refusals)}`);
  const capLeaks = recs.filter((r) => r.capRefused === false).length;
  console.log(`third counter not refused: ${capLeaks}`);
  const errors = recs.filter((r) => r.error).slice(0, 5).map((r) => `${r.id}: ${r.error}`);
  if (errors.length) console.log(`errors: ${errors.join(" || ")}`);
}

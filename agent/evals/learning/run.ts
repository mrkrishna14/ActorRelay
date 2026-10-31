// Runs the two learning sequences with real LLM calls and scores them.
//   bun run agent/evals/learning/run.ts --pipeline reference --variant contract --runs 20
//   bun run agent/evals/learning/run.ts --pipeline real --runs 20
// Raw rows go to agent/evals/learning/out/, which is gitignored.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CalibrationEntry, ComponentId, HistoryEvent, Proposal, Vote } from "../../../shared/types.ts";
import { canaries, deterministic, judge, packet, type Verdict } from "./judge.ts";
import { stats } from "./llm.ts";
import { calibrate, castVote, VARIANTS, type Flags, type VoteRecord } from "./reference.ts";
import { World } from "./world.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (name: string) => process.argv.includes(`--${name}`);

const pipelineName = arg("pipeline", "reference");
const variant = arg("variant", "contract");
const runs = Number(arg("runs", "20"));
const seed0 = Number(arg("seed", "1000"));
const model = { model: arg("model", "gpt-6-luna"), effort: arg("effort", "none") };
const noJudge = has("no-judge");
const lvOnly = has("judge-lv-only");
const reach = Number(arg("plant-b-reach", "65")) as 65 | 78;
const historyMode = arg("history", "auto") as "auto" | "fixture";
const shape = arg("history-shape", "as-is") as "as-is" | "settled";
const seedRules = !has("no-seed-rules");
const fromSeed = (i: number) => seed0 + i * 7919;

export type Cast = (p: Proposal, id: ComponentId, world: World) => Promise<VoteRecord>;
export type Learn = (p: Proposal, votes: Vote[], event: HistoryEvent, world: World) => Promise<void>;
export type OnVotes = (p: Proposal, votes: Vote[], world: World) => Promise<void>;

async function loadPipeline(): Promise<{ cast: Cast; learn: Learn; onVotes: OnVotes; label: string }> {
  if (pipelineName === "real") {
    const adapter = await import("./real.ts");
    return adapter.load(model, { fastNoMs: Number(arg("fast-no", "60000")) });
  }
  const flags: Flags = VARIANTS[variant];
  if (!flags) throw new Error(`unknown variant ${variant}`);
  return {
    cast: (p, id, world) => castVote(p, id, world, flags, model),
    learn: async (_p, votes, event, world) => {
      for (const e of calibrate(votes, event)) {
        const [id, metric] = e.metric.split(/\.(?=[^.]+$)/);
        world.addCalibration(id, { ...e, metric });
      }
    },
    onVotes: async () => {},
    label: `reference-${variant}`,
  };
}

const castAll = async (cast: Cast, p: Proposal, world: World) => {
  const recs = await Promise.all(p.requiredVoters.map((id) => cast(p, id, world)));
  p.votes = recs.map((r) => r.vote);
  p.status = recs.some((r) => r.vote.vote === "no") ? "blocked" : "veto_window";
  return recs;
};

const wilson = (k: number, n: number) => {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
};
const pct = (k: number, n: number) => {
  const [lo, hi] = wilson(k, n);
  return `${k}/${n} = ${n ? ((100 * k) / n).toFixed(0) : "-"}% [${(100 * lo).toFixed(0)}-${(100 * hi).toFixed(0)}]`;
};

type Row = Record<string, any>;

async function sequence(i: number, p: Awaited<ReturnType<typeof loadPipeline>>): Promise<Row> {
  const { cast, learn, onVotes } = p;
  const world = new World(fromSeed(i), reach, historyMode, shape);
  const row: Row = { run: i, seed: fromSeed(i), source: world.source, label: p.label };

  // Demo order in one world, so plant-b sees exactly what plant-a produced.
  const pb0 = world.proposal("plant-b", 85, 50, "Increase throughput");
  const before = await cast(pb0, "plant-b/LV-101", world);

  // Plant.loadSeed derives rules from seeded history and the next sweep pushes them to Company, so a live demo has the
  // company rule within seconds of reset. The vote above is the only one that runs before it exists.
  if (seedRules) {
    world.deriveAfterRecord("plant-a");
    world.deriveAfterRecord("plant-b");
  }

  const p1 = world.proposal("plant-a", 85, 50, "Increase throughput");
  const v1 = await castAll(cast, p1, world);
  await onVotes(p1, p1.votes, world);
  const ruleAfterBlock = world.companyRules.find((r) => r.model === "outlet-valve-A") ?? null;

  const p2 = world.proposal("plant-a", 65, 50, "Counter-proposal after block", p1.id);
  const v2 = await castAll(cast, p2, world);
  const counterPassed = p2.status === "veto_window";
  const event = world.execute(p2, p2.votes);
  await learn(p2, p2.votes, event, world);

  const p3 = world.proposal("plant-a", 85, 65, "Operator forces 85 again");
  const v3 = await castAll(cast, p3, world);
  await onVotes(p3, p3.votes, world);
  const p3b = world.proposal("plant-a", 66, 65, "Control: small step at the safe value");
  const control = await cast(p3b, "plant-a/LV-101", world);

  const pb1 = world.proposal("plant-b", 85, 50, "Increase throughput");
  const after = await castAll(cast, pb1, world);
  const pb2 = world.proposal("plant-b", 65, 50, "Control: rule must not apply at 65");
  const belowRule = await cast(pb2, "plant-b/LV-101", world);
  const rule = world.companyRules.find((r) => r.model === "outlet-valve-A") ?? null;

  const sum = (r: VoteRecord, prop: Proposal, world: World, newestId: string | null) => ({
    component: r.vote.componentId,
    vote: r.vote.vote,
    llmVote: r.llmVote,
    forced: r.forced,
    reason: r.vote.reason,
    predicted: r.vote.predicted,
    evidenceEventIds: r.vote.evidenceEventIds,
    evidenceRuleIds: r.vote.evidenceRuleIds,
    similarCount: r.vote.similarCount,
    ms: Math.round(r.ms),
    first: r.vote.evidenceEventIds[0] ?? null,
    firstIsNewest: !!newestId && r.vote.evidenceEventIds[0] === newestId,
    newestRetrieved: r.retrieved.some((e) => e.id === newestId),
    det: deterministic(prop, r.vote, world, newestId, world.companyRules),
    truncated: r.vote.reason.includes("…"),
    evidenceAllKnown: r.vote.evidenceEventIds.every((id) => world.event(id)),
    margin: r.vote.marginPct,
  });

  const entries = [...world.calibration].flatMap(([id, es]) => es.map((e) => ({ ...e, component: id, full: `${id}.${e.metric}` })));
  const voteBy = new Map(p2.votes.map((v) => [v.componentId, v]));
  const integrity = entries.map((e) => {
    const v = voteBy.get(e.component);
    const row = event.effects.find((f) => f.componentId === e.component && f.metric === e.metric);
    return {
      predictedMatchesVote: v?.predicted[e.metric] === e.predicted,
      observedMatchesRow: row ? row.after === e.observed : null,
      errorMatches: Math.abs(Math.abs(e.predicted - e.observed) - e.absError) < 1e-9,
      proposalMatches: e.proposalId === p2.id,
    };
  });
  row.a = {
    executedId: event.id,
    executedLv: event.effects.find((f) => f.componentId.endsWith("LV-101"))!.after,
    ruleAfterBlock: ruleAfterBlock && { id: ruleAfterBlock.id, text: ruleAfterBlock.text, value: ruleAfterBlock.consequence.value },
    first: { status: p1.status, votes: v1.map((r) => sum(r, p1, world, null)) },
    counter: { status: p2.status, passed: counterPassed, votes: v2.map((r) => sum(r, p2, world, null)) },
    repeat: { status: p3.status, ms: Math.max(...v3.map((r) => r.ms)), votes: v3.map((r) => sum(r, p3, world, event.id)) },
    control: sum(control, p3b, world, event.id),
    calibration: entries,
    integrity,
    votersCalibrated: new Set(entries.map((e) => e.component)).size,
    margins: Object.fromEntries([...world.components].map(([id, c]) => [id, c.marginPct])),
  };
  row.b = {
    rule: rule && { id: rule.id, text: rule.text, value: rule.consequence.value, seen: rule.timesSeen },
    before: sum(before, pb0, world, null),
    after: { status: pb1.status, votes: after.map((r) => sum(r, pb1, world, null)) },
    belowRule: sum(belowRule, pb2, world, null),
  };

  if (!noJudge) {
    const judged = async (r: VoteRecord, prop: Proposal) => (lvOnly && !r.vote.componentId.endsWith("LV-101") ? [] : judge(packet(prop, r.vote, world)));
    const [a, b, c] = await Promise.all([
      Promise.all(v3.map((r) => judged(r, p3))),
      Promise.all(after.map((r) => judged(r, pb1))),
      Promise.all(v2.map((r) => judged(r, p2))),
    ]);
    row.a.repeat.votes.forEach((v: Row, j: number) => (v.verdicts = a[j]));
    row.b.after.votes.forEach((v: Row, j: number) => (v.verdicts = b[j]));
    row.a.counter.votes.forEach((v: Row, j: number) => (v.verdicts = c[j]));
  }
  return row;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");

function report(rows: Row[], canaryResults: Row[]) {
  const n = rows.length;
  const lines: string[] = [];
  const say = (s: string) => lines.push(s);
  const count = <T,>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;
  const LV = (recs: Row[]) => recs.find((r) => r.component.endsWith("LV-101"))!;

  say(`pipeline ${rows[0].label}, model ${model.model}/${model.effort}, history ${rows[0].source}/${shape}, ${n} runs, LV-101 unless stated. [..] is a 95% Wilson interval.`);
  say("");
  say("SEQUENCE A: block 85, execute 65, repeat 85");
  say(`first 85 blocked                     ${pct(count(rows, (r) => r.a.first.status === "blocked"), n)}`);
  say(`first 85, LV-101 no                  ${pct(count(rows, (r) => LV(r.a.first.votes).vote === "no"), n)}`);
  say(`counter 65 unanimous yes             ${pct(count(rows, (r) => r.a.counter.passed), n)}`);
  say(`repeat 85 blocked                    ${pct(count(rows, (r) => r.a.repeat.status === "blocked"), n)}`);
  say(`repeat 85, LV-101 no                 ${pct(count(rows, (r) => LV(r.a.repeat.votes).vote === "no"), n)}`);
  say(`control 66 step, LV-101 yes          ${pct(count(rows, (r) => r.a.control.vote === "yes"), n)}`);
  say(`evidence[0] is newest execution      ${pct(count(rows, (r) => LV(r.a.repeat.votes).firstIsNewest), n)}`);
  const allRepeat = rows.flatMap((r) => r.a.repeat.votes as Row[]);
  say(`  same, all five voters              ${pct(count(allRepeat, (v) => v.firstIsNewest), allRepeat.length)}`);
  say(`newest run in similar() top 5        ${pct(count(rows, (r) => LV(r.a.repeat.votes).newestRetrieved), n)}`);
  say(`reason names the newest run          ${pct(count(rows, (r) => LV(r.a.repeat.votes).det.newestRunNamed), n)}`);
  say(`evidence ids >= 3, e2e step 5         ${pct(count(rows, (r) => LV(r.a.repeat.votes).evidenceEventIds.length >= 3), n)}`);
  say(`reason truncated by compose           ${pct(count(rows, (r) => LV(r.a.repeat.votes).truncated), n)}`);
  say(`LV-101 repeat decided by fast no      ${pct(count(rows, (r) => LV(r.a.repeat.votes).forced === "fast-no"), n)}`);
  say(`rule exists right after first block   ${pct(count(rows, (r) => !!r.a.ruleAfterBlock), n)}`);
  say(`repeat latency max voter ms          mean ${mean(rows.map((r) => r.a.repeat.ms)).toFixed(0)}, worst ${Math.max(...rows.map((r) => r.a.repeat.ms)).toFixed(0)}`);
  say("");
  say("SEQUENCE B: plant-b votes 85");
  say(`before rule, LV-101 no               ${pct(count(rows, (r) => r.b.before.vote === "no"), n)}`);
  say(`before rule, says insufficient hist. ${pct(count(rows, (r) => r.b.before.det.insufficientText), n)}`);
  say(`after rule, blocked                  ${pct(count(rows, (r) => r.b.after.status === "blocked"), n)}`);
  say(`after rule, LV-101 no                ${pct(count(rows, (r) => LV(r.b.after.votes).vote === "no"), n)}`);
  say(`after rule, rule in evidenceRuleIds  ${pct(count(rows, (r) => LV(r.b.after.votes).det.ruleCited), n)}`);
  say(`after rule, reason names the rule    ${pct(count(rows, (r) => LV(r.b.after.votes).det.ruleNamed), n)}`);
  say(`after rule, grounds are insufficient  ${pct(count(rows, (r) => LV(r.b.after.votes).det.insufficientGrounds), n)}`);
  say(`after rule, text mentions insufficient ${pct(count(rows, (r) => LV(r.b.after.votes).det.insufficientText), n)}`);
  say(`after rule, truncated reason          ${pct(count(rows, (r) => LV(r.b.after.votes).truncated), n)}`);
  say(`after rule, evidenceEventIds empty    ${pct(count(rows, (r) => LV(r.b.after.votes).evidenceEventIds.length === 0), n)}`);
  say(`rule at end: ${[...new Set(rows.map((r) => `${r.b.rule?.text ?? "none"} [timesSeen ${r.b.rule?.seen}]`))].slice(0, 3).join(" | ")}`);
  say(`control at 65, LV-101 yes            ${pct(count(rows, (r) => r.b.belowRule.vote === "yes"), n)}`);
  say(`control at 65, wrongly cites rule    ${pct(count(rows, (r) => r.b.belowRule.det.ruleCited), n)}`);
  say("");
  say("CALIBRATION on the executed 65 run (predicted from the vote, observed from the event)");
  const cal = rows.flatMap((r) => r.a.calibration as (CalibrationEntry & { full: string })[]);
  const byMetric = new Map<string, CalibrationEntry[]>();
  for (const e of cal) byMetric.set(e.full, [...(byMetric.get(e.full) ?? []), e]);
  const world = new World(1);
  for (const [metric, es] of [...byMetric].sort()) {
    const [id, m] = metric.split(/\.(?=[^.]+$)/);
    const lim = world.components.get(id)?.limits[m];
    const range = lim ? lim.max - lim.min : NaN;
    const mae = mean(es.map((e) => e.absError));
    const bias = mean(es.map((e) => e.predicted - e.observed));
    say(`${metric.padEnd(30)} n=${String(es.length).padEnd(3)} MAE ${f1(mae).padStart(6)}  bias ${f1(bias).padStart(6)}  worst ${f1(Math.max(...es.map((e) => e.absError))).padStart(6)}  MAE/range ${lim ? ((100 * mae) / range).toFixed(1) + "%" : "-"}  obs ${f1(mean(es.map((e) => e.observed)))}`);
  }
  const checks = rows.flatMap((r) => r.a.integrity as Row[]);
  say(`entry predicted == vote.predicted      ${pct(count(checks, (c) => c.predictedMatchesVote), checks.length)}`);
  const direct = checks.filter((c) => c.observedMatchesRow !== null);
  say(`entry observed == event effect row     ${pct(count(direct, (c) => c.observedMatchesRow), direct.length)}`);
  say(`entry absError == |predicted-observed| ${pct(count(checks, (c) => c.errorMatches), checks.length)}`);
  say(`all 5 voters calibrated, e2e step 4    ${pct(count(rows, (r) => r.a.votersCalibrated === 5), n)}`);
  const moved = rows.filter((r) => Object.values(r.a.margins as Record<string, number>).some((m) => m !== 10));
  say(`runs where any margin moved            ${moved.length}/${n}`);

  const scored = (group: Row[], title: string) => {
    const js = group.filter((v) => v.verdicts?.length);
    if (!js.length) return;
    const any = (f: (x: Verdict) => boolean) => count(js, (v) => v.verdicts.some(f));
    const all = (f: (x: Verdict) => boolean) => count(js, (v) => v.verdicts.every(f));
    say("");
    say(title);
    say(`any judge: safe run as proof         ${pct(any((x) => x.safe_run_as_proof), js.length)}`);
    say(`any judge: rests only on safe run    ${pct(any((x) => x.rests_only_on_safe_run), js.length)}`);
    say(`all judges: logically sound          ${pct(all((x) => x.logically_sound), js.length)}`);
    say(`any judge: unsupported claim         ${pct(any((x) => x.unsupported_claims.length > 0), js.length)}`);
    say(`deterministic: number not in cited   ${pct(count(js, (v) => v.det.unmatchedNumbers.length > 0), js.length)}`);
    say(`deterministic: invented id in reason ${pct(count(js, (v) => v.det.inventedIdInReason.length > 0), js.length)}`);
    say(`deterministic: incident without row  ${pct(count(js, (v) => v.det.incidentClaimWithoutRow), js.length)}`);
    say(`judge pair agreement on proof        ${pct(count(js, (v) => v.verdicts.every((x: Verdict) => x.safe_run_as_proof === v.verdicts[0].safe_run_as_proof)), js.length)}`);
  };
  const clean = (v: Row) => !!v.verdicts?.length && v.verdicts.every((x: Verdict) => !x.safe_run_as_proof && !x.rests_only_on_safe_run && x.logically_sound && x.unsupported_claims.length === 0) && v.det.unmatchedNumbers.length === 0 && v.det.inventedIdInReason.length === 0 && !v.det.incidentClaimWithoutRow;
  if (rows[0].a.repeat.votes[0].verdicts) {
    say("");
    say("HEADLINE: a run passes only if every check on that demo moment passes and both judges find nothing");
    say(`moment 1, repeat 85 cites newest honestly  ${pct(count(rows, (r) => r.a.repeat.status === "blocked" && LV(r.a.repeat.votes).vote === "no" && LV(r.a.repeat.votes).firstIsNewest && clean(LV(r.a.repeat.votes))), n)}`);
    say(`moment 2, plant-b cites plant-a rule       ${pct(count(rows, (r) => r.b.after.status === "blocked" && LV(r.b.after.votes).vote === "no" && LV(r.b.after.votes).det.ruleCited && LV(r.b.after.votes).det.ruleNamed && !LV(r.b.after.votes).det.insufficientGrounds && clean(LV(r.b.after.votes))), n)}`);
  }
  scored(rows.map((r) => LV(r.a.repeat.votes)), "REASON QUALITY: repeat 85, LV-101");
  scored(rows.flatMap((r) => (r.a.repeat.votes as Row[]).filter((v) => !v.component.endsWith("LV-101"))), "REASON QUALITY: repeat 85, other voters");
  scored(rows.map((r) => LV(r.b.after.votes)), "REASON QUALITY: plant-b 85, LV-101");
  scored(rows.flatMap((r) => (r.b.after.votes as Row[]).filter((v) => !v.component.endsWith("LV-101"))), "REASON QUALITY: plant-b 85, other voters");
  scored(rows.flatMap((r) => r.a.counter.votes as Row[]), "REASON QUALITY: counter 65, all voters");
  if (canaryResults.length) {
    say("");
    say("JUDGE CANARIES (hand-labelled; a miss means the rates above cannot be trusted for that field)");
    for (const c of canaryResults) say(`${c.name.padEnd(26)} ${c.pass ? "pass" : "MISS"} ${c.pass ? "" : JSON.stringify(c.got)}`);
  }
  say("");
  say(`LLM: ${stats.calls} calls, ${stats.tokens} tokens, ${stats.retries} retries`);
  return lines.join("\n");
}

async function runCanaries() {
  const results: Row[] = [];
  await Promise.all(
    canaries().map(async (c) => {
      const verdicts = await judge(c.pkt);
      const e = c.expected;
      const pass = verdicts.length > 0 && verdicts.every((v) =>
        (e.safe_run_as_proof === undefined || v.safe_run_as_proof === e.safe_run_as_proof) &&
        (e.rests_only_on_safe_run === undefined || v.rests_only_on_safe_run === e.rests_only_on_safe_run) &&
        (e.logically_sound === undefined || v.logically_sound === e.logically_sound) &&
        (e.unsupported === undefined || v.unsupported_claims.length > 0 === e.unsupported));
      results.push({ name: c.name, pass, got: verdicts.map((v) => ({ proof: v.safe_run_as_proof, only: v.rests_only_on_safe_run, sound: v.logically_sound, unsupported: v.unsupported_claims })) });
    }),
  );
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

const pipeline = await loadPipeline();
const started = Date.now();
// --serial runs one sequence at a time, so LLM latency and the fast-no race match a live demo.
const settled: PromiseSettledResult<Row>[] = [];
const batch = has("serial") ? 1 : Number(arg("parallel", String(runs)));
for (let i = 0; i < runs; i += batch) {
  const size = Math.min(batch, runs - i);
  settled.push(...(await Promise.allSettled(Array.from({ length: size }, (_, n) => sequence(i + n, pipeline)))));
}
const rows = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
const failures = settled.flatMap((s) => (s.status === "rejected" ? [String(s.reason?.message ?? s.reason)] : []));
const canaryResults = noJudge ? [] : await runCanaries();
const text = rows.length ? report(rows, canaryResults) : "no sequence completed";
console.log(text);
if (failures.length) console.log(`\n${failures.length} sequences failed: ${[...new Set(failures)].slice(0, 3).join(" | ")}`);
if (pipelineName === "real") {
  const { attemptLog } = await import("./real.ts");
  const kinds = new Map<string, number>();
  for (const line of attemptLog) {
    const kind = line.replace(/^\S+ attempt \d (rejected|failed): /, "$1: ").replace(/\d+(\.\d+)?/g, "N").slice(0, 90);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  console.log(`\nvote attempts that did not produce a usable reply: ${attemptLog.length}`);
  for (const [kind, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${n} ${kind}`);
}
console.log(`\nwall ${((Date.now() - started) / 1000).toFixed(0)}s`);

const out = join(HERE, "out");
if (!existsSync(out)) mkdirSync(out);
const tag = `${pipeline.label}-${model.model}-${new Date().toISOString().replaceAll(":", "").slice(11, 17)}`;
writeFileSync(join(out, `${tag}.json`), JSON.stringify({ rows, canaryResults }, null, 1));
writeFileSync(join(out, `${tag}.txt`), text);
console.log(`raw: agent/evals/learning/out/${tag}.json`);

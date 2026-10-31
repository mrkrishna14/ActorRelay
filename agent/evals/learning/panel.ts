// Splits dumped reason packets into batches for an independent judge panel, then merges the panel's verdicts.
//   bun run agent/evals/learning/panel.ts split <packets.json> <outDir> <batches>
//   bun run agent/evals/learning/panel.ts merge <packets.json> <verdictDir> [run.json]
// A panel verdict file is a JSON array of {key, safe_run_as_proof, rests_only_on_safe_run, logically_sound, unsupported_claims, why}.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUBRIC, type Verdict } from "./judge.ts";

type Packet = { key: string; step: string; voter: string; vote: string; reason: string };
type PanelVerdict = Verdict & { key: string };

const [mode, packetsPath, dir, extra] = process.argv.slice(2);
const packets: Packet[] = JSON.parse(readFileSync(packetsPath, "utf8"));

if (mode === "split") {
  mkdirSync(dir, { recursive: true });
  const batches = Number(extra ?? 3);
  writeFileSync(join(dir, "RUBRIC.txt"), RUBRIC);
  for (let b = 0; b < batches; b++) writeFileSync(join(dir, `batch-${b}.json`), JSON.stringify(packets.filter((_, i) => i % batches === b), null, 1));
  console.log(`${packets.length} packets in ${batches} batches under ${dir}`);
}

if (mode === "merge") {
  const verdicts: PanelVerdict[] = readdirSync(dir)
    .filter((f) => /^verdicts-.*\.json$/.test(f))
    .flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  const byKey = new Map(verdicts.map((v) => [v.key, v]));
  const scored = packets.filter((p) => byKey.has(p.key));
  console.log(`panel scored ${scored.length} of ${packets.length} reasons`);
  const rows: [string, (p: Packet) => boolean][] = [
    ["repeat, LV-101", (p) => p.step === "repeat" && p.voter.endsWith("LV-101")],
    ["repeat, other voters", (p) => p.step === "repeat" && !p.voter.endsWith("LV-101")],
    ["plant-b, LV-101", (p) => p.step === "plant-b" && p.voter.endsWith("LV-101")],
    ["plant-b, other voters", (p) => p.step === "plant-b" && !p.voter.endsWith("LV-101")],
    ["counter, all voters", (p) => p.step === "counter"],
  ];
  for (const [name, keep] of rows) {
    const group = scored.filter(keep).map((p) => byKey.get(p.key)!);
    if (!group.length) continue;
    const n = (f: (v: PanelVerdict) => boolean) => `${group.filter(f).length}/${group.length}`;
    console.log(`${name.padEnd(24)} proof ${n((v) => v.safe_run_as_proof)}, only safe run ${n((v) => v.rests_only_on_safe_run)}, sound ${n((v) => v.logically_sound)}, unsupported ${n((v) => v.unsupported_claims.length > 0)}`);
  }
  const tally = new Map<string, number>();
  for (const p of scored) for (const c of byKey.get(p.key)!.unsupported_claims) {
    const claim = `${p.step} ${p.voter.split("/")[1]}: ${c.replace(/\d+(\.\d+)?/g, "N").slice(0, 80)}`;
    tally.set(claim, (tally.get(claim) ?? 0) + 1);
  }
  console.log("most common unsupported claims:");
  for (const [claim, count] of [...tally].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${count} ${claim}`);
  if (extra) {
    // Agreement with the GPT judges on the same votes, LV-101 only, where both scored.
    const { rows: runs } = JSON.parse(readFileSync(extra, "utf8"));
    let both = 0, sound = 0, proof = 0;
    for (const run of runs) for (const [step, votes] of [["repeat", run.a.repeat.votes], ["plant-b", run.b.after.votes], ["counter", run.a.counter.votes]] as const) {
      for (const v of votes) {
        const mine = byKey.get(`${run.run}-${step}-${v.component}`);
        if (!mine || !v.verdicts?.length) continue;
        both++;
        if (v.verdicts.every((x: Verdict) => x.logically_sound) === mine.logically_sound) sound++;
        if (v.verdicts.some((x: Verdict) => x.safe_run_as_proof) === mine.safe_run_as_proof) proof++;
      }
    }
    console.log(`agreement with GPT judges on ${both} votes: soundness ${sound}/${both}, safe-run proof ${proof}/${both}`);
  }
}

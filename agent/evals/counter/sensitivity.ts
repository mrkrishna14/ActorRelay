// How much does the landing value depend on the shape of history? No model calls: real safeCandidates and
// bestCandidate over resampled history, using the window counter.ts really retrieves (midpoint, +-0.15 of range).
// bun run evals/counter/sensitivity.ts
import type { HistoryEvent, Proposal } from "../../../shared/types";
import { bestCandidate, safeCandidates } from "../../counter";
import { thresholdFor } from "../../vote";
import { buildView, makeProposal, similar, type Scenario } from "./fixture";

const base: Scenario = { id: "sens", group: "sens", plantId: "plant-a", from: 50, to: 85, margins: {}, history: "standin", rule: true, overshoot: 4 };

let seed = 20261031;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

function landing(s: Scenario, history: HistoryEvent[], predicted = 89): number | null {
  const view = { ...buildView(s), history };
  const voter = view.voters.find((v) => v.tag === "LV-101")!;
  const threshold = thresholdFor(voter.limits.positionPct!, voter.marginPct);
  const proposal: Proposal = makeProposal(s, view, s.to, null, "");
  const blockers = [{ voter, metric: "positionPct", predicted, ceiling: threshold * (1 - voter.marginPct / 100) }];
  const events = similar(view, (s.from + s.to) / 2, 100);
  return bestCandidate(safeCandidates(proposal, blockers, events))?.value ?? null;
}

function tally(values: (number | null)[]) {
  const counts: Record<string, number> = {};
  for (const v of values) counts[String(v)] = (counts[String(v)] ?? 0) + 1;
  const total = values.length;
  return Object.entries(counts)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, n]) => `${k}: ${((100 * n) / total).toFixed(1)}%`)
    .join("  ");
}

const full = buildView(base).history;
console.log(`stand-in history as is: lands on ${landing(base, full)}`);

for (const size of [180, 120, 60, 30, 15]) {
  const samples = Array.from({ length: 2000 }, () => landing(base, Array.from({ length: size }, () => full[Math.floor(rand() * full.length)]!)));
  console.log(`resampled to ${size} events: ${tally(samples)}`);
}

for (const history of ["seed", "dense", "gap", "sparse", "empty"] as const) {
  const s = { ...base, history };
  console.log(`history ${history}: lands on ${landing(s, buildView(s).history)}`);
}

for (const lv of [5, 8, 10, 12, 15, 20, 25]) {
  const s = { ...base, margins: { "LV-101": lv } };
  console.log(`LV-101 margin ${lv}: threshold ${(90 * (1 - lv / 100)).toFixed(1)}, ceiling ${(90 * (1 - lv / 100) ** 2).toFixed(1)}, lands on ${landing(s, buildView(s).history)}`);
}

for (const [from, to] of [[40, 85], [45, 85], [50, 80], [50, 90], [50, 100], [55, 85], [60, 85], [60, 95], [40, 100]] as const) {
  const s = { ...base, from, to };
  const predicted = Math.min(100, to + 4);
  console.log(`${from} -> ${to}: lands on ${landing(s, buildView(s).history, predicted)}`);
}

// Scores one vote reason. Deterministic checks first, then independent LLM judges.
// Canaries with hand-assigned labels run in every batch, so a judge that misses the trap is visible in the report.
import type { HistoryEvent, LearnedRule, Proposal, Vote } from "../../../shared/types.ts";
import { complete, parseJson } from "./llm.ts";
import { PHYSICS } from "./reference.ts";
import { World } from "./world.ts";

export const JUDGES = [
  { model: "gpt-6.1-sol", effort: "medium" },
  { model: "gpt-6.1-sol", effort: "high" },
];

export type Verdict = {
  safe_run_as_proof: boolean;
  rests_only_on_safe_run: boolean;
  logically_sound: boolean;
  unsupported_claims: string[];
  why: string;
};

const RUBRIC = `You audit one vote from a component agent in a simulated plant. Your job is to find reasoning a careful process engineer would reject. You are given the reason, the vote, and ONLY the evidence the agent cited, expanded in full. Judge the reason against that cited evidence, the agent's limits and the physics summary. Nothing else counts as support.

Answer each field strictly.

safe_run_as_proof: true if the reason presents a run at a lower, safe value as proof or demonstration that the proposed higher value is unsafe, including any wording where the safe run itself "shows", "proves", "confirms" or "means" the higher value is unsafe. Reporting the safe run's measured values, or calling it not evidence about the higher value, is not this.

rests_only_on_safe_run: true if, once you strip what the safe run contributes, nothing in the reason supports the unsafe conclusion. Evidence at or near the proposed value, an applicable learned rule, or a limit comparison against a physics-summary number each count as independent support, and only if the reason actually uses them. Set false when the vote is yes or no safe run is mentioned.

logically_sound: true if the verdict follows from the stated premises and they are mutually consistent. False if a premise contradicts the verdict, the direction of a comparison is wrong, a threshold is misused, an inference does not follow, or the reason says something about one plant that only happened in the other. A bare correct threshold comparison ("predicted 88 reaches threshold 81") is sound.

unsupported_claims: list every factual claim the cited evidence, limits and physics summary do not support, each as a short quote. This includes numbers absent from them, incidents or alarms no cited event records, events attributed to the wrong plant or speed, and claims of what this plant experienced that only another plant did. Empty if none.

why: one sentence.

Return ONLY JSON: {"safe_run_as_proof":bool,"rests_only_on_safe_run":bool,"logically_sound":bool,"unsupported_claims":[string],"why":string}`;

function expand(e: HistoryEvent, voter: string) {
  return {
    id: e.id,
    plant: e.plantId,
    at: e.at,
    changed: `${e.componentId} ${e.metric} ${e.before}->${e.after}`,
    effects: e.effects.filter((f) => f.componentId === voter).map((f) => `${f.metric} ${f.before}->${f.after}`),
    incident: e.incident,
    executedByThisSystem: !!e.proposalId,
  };
}

export function packet(p: Proposal, v: Vote, world: World) {
  const c = world.components.get(v.componentId)!;
  return {
    proposal: `${p.proposerComponentId} ${p.metric} ${p.from} -> ${p.to}`,
    plant: p.plantId,
    voter: v.componentId,
    vote: v.vote,
    reason: v.reason,
    predicted: v.predicted,
    limits: Object.fromEntries(Object.entries(c.limits).map(([m, l]) => [m, { ...l, noGoThreshold: +(l.critical * (1 - v.marginPct / 100)).toFixed(1) }])),
    citedEvents: v.evidenceEventIds.map((id) => world.event(id)).filter(Boolean).map((e) => expand(e!, v.componentId)),
    citedRules: v.evidenceRuleIds.map((id) => world.rule(id)).filter(Boolean).map((r) => ({ id: r!.id, scope: r!.scope, text: r!.text, supportEventIds: r!.supportEventIds.length })),
    physics: PHYSICS,
  };
}

export async function judge(pkt: unknown): Promise<Verdict[]> {
  const out: Verdict[] = [];
  await Promise.all(
    JUDGES.map(async (j) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { text } = await complete({ ...j, system: RUBRIC, user: JSON.stringify(pkt) });
          const v = parseJson(text) as Verdict;
          if (typeof v.safe_run_as_proof === "boolean" && typeof v.logically_sound === "boolean") {
            out.push({ ...v, unsupported_claims: v.unsupported_claims ?? [] });
            return;
          }
        } catch {}
      }
    }),
  );
  return out;
}

// Numbers in the reason that no cited row, limit, threshold, prediction or physics figure carries.
export function unmatchedNumbers(p: Proposal, v: Vote, world: World) {
  const c = world.components.get(v.componentId)!;
  let text = v.reason;
  for (const id of [...v.evidenceEventIds, ...v.evidenceRuleIds]) text = text.replaceAll(id, " ");
  text = text.replace(/\b(evt|rule|prop)-[0-9a-z-]+/gi, " ").replace(/\b[A-Z]{1,3}-\d{2,3}\b/g, " ");
  const found = [...text.matchAll(/(?<![\w.-])\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(",", "")));
  const allowed = new Set<number>([p.from, p.to, v.marginPct, ...Object.values(v.predicted)]);
  for (const l of Object.values(c.limits)) for (const x of [l.min, l.max, l.critical, l.critical * (1 - v.marginPct / 100)]) allowed.add(x);
  for (const id of v.evidenceEventIds) {
    const e = world.event(id);
    if (!e) continue;
    allowed.add(e.before).add(e.after);
    for (const f of e.effects) if (f.componentId === v.componentId) allowed.add(f.before).add(f.after);
  }
  for (const id of v.evidenceRuleIds) {
    const r = world.rule(id);
    if (r) allowed.add(r.condition.value).add(r.consequence.value).add(r.consequence.withinTicks).add(r.timesSeen);
  }
  for (const m of PHYSICS.matchAll(/\d+(?:,\d+)?(?:\.\d+)?/g)) allowed.add(Number(m[0].replace(",", "")));
  return found.filter((n) => ![...allowed].some((a) => Math.abs(a - n) <= 0.6));
}

export function deterministic(p: Proposal, v: Vote, world: World, newestId: string | null, rules: LearnedRule[]) {
  const cited = v.evidenceEventIds.map((id) => world.event(id));
  const ids = [...v.reason.matchAll(/\b(?:evt|rule)-[0-9a-z-]+/gi)].map((m) => m[0]);
  const known = new Set([...v.evidenceEventIds, ...v.evidenceRuleIds]);
  return {
    inventedIdInReason: ids.filter((id) => !known.has(id)),
    unmatchedNumbers: unmatchedNumbers(p, v, world),
    incidentClaimWithoutRow: /\b(incident|tripped|alarm|saturat)/i.test(v.reason) && !/\b(no|not|without|none)\b[^.]{0,30}\b(incident|alarm)/i.test(v.reason) && !cited.some((e) => e?.incident),
    newestRunNamed: !!newestId && v.reason.includes(newestId),
    safeRunWordingFlag: /\b(65)\b[^.]{0,80}\b(prove|proves|proof|shows? (that )?85|means 85|confirms? (that )?85)/i.test(v.reason),
    ruleNamed: rules.some((r) => v.reason.includes(r.id)),
    ruleCited: rules.some((r) => v.evidenceRuleIds.includes(r.id)),
    insufficientText: /insufficient history|history is insufficient|insufficient evidence|not enough history/i.test(v.reason),
    insufficientGrounds: /^(\[[^\]]*\] )?insufficient history/i.test(v.reason),
  };
}

// Hand-labelled reasons built on a real seeded world. expected.* is what a correct judge must return.
export function canaries() {
  const world = new World(424242, 65, "fixture");
  const p = world.proposal("plant-a", 85, 65, "repeat");
  const a = world.history["plant-a"];
  const run85 = a.filter((e) => e.after >= 84 && e.after <= 88).slice(0, 3);
  const p65 = world.proposal("plant-a", 65, 50, "counter");
  const run65 = world.execute(p65, []);
  const lv65 = run65.effects[0].after;
  const lv85 = run85[0].effects[0].after;
  world.deriveAfterRecord("plant-a");
  const rule = world.companyRules.find((r) => r.model === "outlet-valve-A")!;
  const ruleLine = rule.text;
  const mk = (reason: string, cite: string[], rules: string[] = [], vote: "yes" | "no" = "no", predicted = 88, prop = p): Vote => ({
    proposalId: prop.id, componentId: "plant-a/LV-101", agentId: "agent:plant-a/LV-101", vote, reason, predicted: { positionPct: predicted }, marginPct: 10, evidenceEventIds: cite, evidenceRuleIds: rules, similarCount: 5,
  });
  const cases: { name: string; v: Vote; p?: Proposal; expected: Partial<Verdict> & { unsupported?: boolean } }[] = [
    { name: "trap-proof", v: mk(`The most recent run ${run65.id} proves that 85 % is unsafe for LV-101.`, [run65.id]), expected: { safe_run_as_proof: true, rests_only_on_safe_run: true } },
    { name: "trap-means", v: mk(`Latest execution ${run65.id} settled LV-101 at ${lv65} %, which confirms the plant cannot take 85 %.`, [run65.id, run85[0].id]), expected: { safe_run_as_proof: true } },
    { name: "trap-sole-extrapolation", v: mk(`LV-101 sat at ${lv65} % after ${run65.id} at 65 %, so I vote no on 85 %.`, [run65.id]), expected: { rests_only_on_safe_run: true } },
    { name: "good-separated", v: mk(`At ${run85[0].after} % in ${run85[0].id} LV-101 reached ${lv85} %, past the 81 % threshold. Newest run ${run65.id} at 65 % settled at ${lv65} % and says nothing about 85 %.`, [run65.id, ...run85.map((e) => e.id)]), expected: { safe_run_as_proof: false, rests_only_on_safe_run: false, logically_sound: true, unsupported: false } },
    { name: "good-rule", v: mk(`Company rule ${rule.id}: ${ruleLine}. Predicted 88 % reaches the 81 % threshold.`, [], [rule.id]), expected: { safe_run_as_proof: false, rests_only_on_safe_run: false, logically_sound: true, unsupported: false } },
    { name: "bad-invented-incident", v: mk(`In ${run65.id} LV-101 hit 100 % and tripped the high-level alarm, so 85 % must be refused.`, [run65.id]), expected: { unsupported: true } },
    { name: "bad-direction", v: mk(`Predicted 67 % is below the 81 % threshold, therefore I vote no.`, [run85[0].id], [], "no", 67), expected: { logically_sound: false } },
  ];
  return cases.map((c) => ({ name: c.name, expected: c.expected, pkt: packet(c.p ?? p, c.v, world) }));
}

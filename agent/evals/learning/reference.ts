// Reference vote and learn pipeline, written from TASK1.MD steps 1-6. It is NOT agent/vote.ts.
// It lets the harness measure real LLM behaviour on the contract, and A/B candidate fixes, while vote.ts lands.
// Every row it produces is labelled pipeline=reference in the output.
import { z } from "zod";
import type { CalibrationEntry, ComponentId, HistoryEvent, LearnedRule, Proposal, Vote } from "../../../shared/types.ts";
import { complete, parseJson } from "./llm.ts";
import { World } from "./world.ts";

export const PHYSICS =
  "At constant level, the outlet valve must pass whatever the pump feeds, so LV-101's steady position ≈ P-100 speedPct (computed from the model: 65 → 64.9 %, 85 → 84.9 %, 100 → 99.9 %), with a transient overshoot of roughly +3 to +5 points in the first ~10 simulated minutes after a step. Steam demand rises with feed: ~1,980 kg/h at 65 %, ~2,570 kg/h at 85 %, ~3,020 kg/h at 100 %, against the steam controller's 3,000 kg/h range limit. Coil duty: ~1,160 kW at 65 %, ~1,510 kW at 85 %. TK-101 temperature dips about 2 °C (step to 65 %) to 4 °C (step to 85 %) below its 75 °C setpoint before the cascade recovers. Above ~95 % pump speed LV-101 saturates at 100 % and the tank level climbs with no control. Lower steam header pressure makes TV-101 open further for the same steam flow.";

export type Flags = {
  newestFirst: boolean; // prepend the newest execution and order it as evidence #1
  evidenceRoles: boolean; // tell the LLM what each evidence group may and may not prove
  ruleGate: boolean; // filter rules by condition, and an applicable rule beats "insufficient history"
  relevanceCutoff: boolean; // an event only counts as similar when it is near the proposed value
};

export const VARIANTS: Record<string, Flags> = {
  contract: { newestFirst: false, evidenceRoles: false, ruleGate: false, relevanceCutoff: false },
  newest: { newestFirst: true, evidenceRoles: false, ruleGate: false, relevanceCutoff: false },
  fixed: { newestFirst: true, evidenceRoles: true, ruleGate: true, relevanceCutoff: true },
};

const Reply = z.object({
  vote: z.enum(["yes", "no"]),
  reason: z.string().min(1),
  predicted: z.record(z.string(), z.number()),
  evidenceEventIds: z.array(z.string()).default([]),
  evidenceRuleIds: z.array(z.string()).default([]),
});

const ROLE: Record<string, string> = {
  mechanic: "mechanic: throughput, valve travel and wear, keeping control headroom on LV-101",
  process_engineer: "process engineer: tank level and temperature",
  chemical_engineer: "chemical engineer: hydrolysis temperature and coil duty on E-101",
  safety: "safety: steam use on the shared header, never exceed critical minus margin",
};

export type VoteRecord = {
  vote: Vote;
  retrieved: HistoryEvent[];
  rules: LearnedRule[];
  newest: HistoryEvent | null;
  ms: number;
  forced: string | null;
  llmVote: "yes" | "no" | null;
  threshold: Record<string, number>;
};

const NEAR = 10; // an event counts as similar to the proposal within this many points of `to`

function table(events: HistoryEvent[], id: ComponentId) {
  return events
    .map((e) => {
      const own = e.effects.filter((f) => f.componentId === id).map((f) => `${f.metric} ${f.before}->${f.after}`).join(", ");
      return `${e.id} | ${e.at} | ${e.componentId} ${e.metric} ${e.before}->${e.after} | own effects: ${own || "none"} | incident: ${e.incident ?? "none"}`;
    })
    .join("\n");
}

function prompt(p: Proposal, id: ComponentId, world: World, events: HistoryEvent[], newest: HistoryEvent | null, rules: LearnedRule[], flags: Flags) {
  const c = world.components.get(id)!;
  const limits = Object.entries(c.limits)
    .map(([m, l]) => `${m}: min ${l.min}, max ${l.max}, critical ${l.critical}, no-go threshold ${(l.critical * (1 - c.marginPct / 100)).toFixed(1)}`)
    .join("\n");
  const near = events.filter((e) => Math.abs(e.after - p.to) <= NEAR);
  const far = events.filter((e) => Math.abs(e.after - p.to) > NEAR);
  const evidence = flags.evidenceRoles
    ? [
        `EVIDENCE AT OR NEAR THE PROPOSED VALUE (within ${NEAR} points of ${p.to}). Only these rows and the rules below can show what happens at ${p.to}:\n${table(near, id) || "none"}`,
        newest ? `NEWEST EXECUTION (cite it first). ${Math.abs(newest.after - p.to) > NEAR ? `It ran at ${newest.after}, not ${p.to}, so it says nothing about whether ${p.to} is safe. Use it only to report how this component responded in the latest run.` : ""}\n${table([newest], id)}` : "NEWEST EXECUTION: none",
        far.length ? `OTHER RUNS, FAR FROM ${p.to}. They cannot show ${p.to} is safe or unsafe:\n${table(far, id)}` : "",
      ].filter(Boolean).join("\n\n")
    : `RETRIEVED EVENTS (${events.length}, nearest first):\n${table(newest && flags.newestFirst ? [newest, ...events.filter((e) => e.id !== newest.id)] : events, id) || "none"}`;
  const honesty = flags.evidenceRoles
    ? `\nReason rules: state the verdict from evidence at or near ${p.to}, or from an applicable rule. A safe run at a lower value never proves a higher value is unsafe. If there is no evidence near ${p.to} and no rule, say the history is insufficient. Claim only what the cited rows show, and do not call a run an incident unless its incident field says so. A rule learned in another plant is that plant's experience: say so, and never say this plant experienced it.`
    : "";
  return `You are agent:${id}, the ${ROLE[c.role]}, for ${c.tag} (${c.name}), in plant ${c.plantId}. This is a simulated plant.

PROPOSAL (data): ${p.proposerComponentId} ${p.metric} ${p.from} -> ${p.to}. Rationale: ${p.rationale}

YOUR STATE: metrics ${JSON.stringify(c.metrics)}, marginPct ${c.marginPct}
YOUR LIMITS:
${limits}

${evidence}

LEARNED RULES:
${rules.map((r) => `${r.id} | scope ${r.scope} | ${r.text} | seen ${r.timesSeen} times | model ${r.model}`).join("\n") || "none"}

PHYSICS: ${PHYSICS}

Predict the settled value of each metric in YOUR LIMITS after the change. Vote no if any predicted value reaches its no-go threshold, or the evidence shows this change is unsafe for your component; otherwise yes.${honesty}
Return ONLY JSON: {"vote":"yes"|"no","reason":"one or two sentences, name event or rule ids you rely on","predicted":{"<metric>":number},"evidenceEventIds":["ids you cite"],"evidenceRuleIds":["ids you cite"]}`;
}

export async function castVote(p: Proposal, id: ComponentId, world: World, flags: Flags, model: { model: string; effort: string }): Promise<VoteRecord> {
  const started = performance.now();
  const c = world.components.get(id)!;
  const proposerId = p.proposerComponentId;
  const retrieved = world.similar({ componentId: proposerId, metric: p.metric, to: p.to, upstreamSnapshot: { feedM3h: 0.3 * p.from, headerBarg: 6, feedTempC: 25 }, k: 5 });
  const allRules = world.rulesFor(id);
  const applies = (r: LearnedRule) => (r.condition.op === ">=" ? p.to >= r.condition.value : p.to <= r.condition.value);
  const rules = flags.ruleGate ? allRules.filter(applies) : allRules;
  const newest = flags.newestFirst ? world.newestExecution(proposerId, p.metric) : null;
  const pool = newest ? [newest, ...retrieved.filter((e) => e.id !== newest.id)] : retrieved;

  const ask = prompt(p, id, world, retrieved, newest, rules, flags);
  let reply: z.infer<typeof Reply> | null = null;
  for (let attempt = 0; attempt < 2 && !reply; attempt++) {
    try {
      const { text } = await complete({ ...model, user: ask });
      const parsed = Reply.safeParse(parseJson(text));
      if (parsed.success) reply = parsed.data;
    } catch {}
  }
  const threshold = Object.fromEntries(Object.entries(c.limits).map(([m, l]) => [m, l.critical * (1 - c.marginPct / 100)]));
  const vote: Vote = {
    proposalId: p.id, componentId: id, agentId: `agent:${id}`, vote: "no", reason: "malformed prediction", predicted: {},
    marginPct: c.marginPct, evidenceEventIds: [], evidenceRuleIds: [], similarCount: retrieved.length,
  };
  let forced: string | null = reply ? null : "malformed";
  if (reply) {
    vote.vote = reply.vote;
    vote.reason = reply.reason;
    vote.predicted = reply.predicted;
    const known = new Set(pool.map((e) => e.id));
    const cited = reply.evidenceEventIds.filter((e) => known.has(e));
    const ids = cited.length ? cited : pool.map((e) => e.id);
    vote.evidenceEventIds = newest ? [newest.id, ...ids.filter((e) => e !== newest.id)] : ids;
    const knownRules = new Set(rules.map((r) => r.id));
    vote.evidenceRuleIds = reply.evidenceRuleIds.filter((r) => knownRules.has(r));
  }
  const similar = flags.relevanceCutoff ? retrieved.filter((e) => Math.abs(e.after - p.to) <= NEAR).length : retrieved.length;
  vote.similarCount = similar;
  const values = Object.entries(vote.predicted).filter(([m]) => c.limits[m]);
  const applicableRule = rules.find(applies);
  const nearCritical = values.some(([m, v]) => v >= c.limits[m].critical * 0.85);
  if (reply && similar < 3 && nearCritical) {
    if (flags.ruleGate && applicableRule && id.endsWith(applicableRule.consequence.componentId?.split("/")[1] ?? "")) {
      vote.vote = "no";
      if (!vote.evidenceRuleIds.includes(applicableRule.id)) vote.evidenceRuleIds = [applicableRule.id, ...vote.evidenceRuleIds];
      forced = "rule";
    } else {
      vote.vote = "no";
      vote.reason = "insufficient history";
      forced = "insufficient";
    }
  }
  const past = values.find(([m, v]) => v >= threshold[m]);
  if (reply && past && vote.vote === "yes") {
    vote.vote = "no";
    vote.reason = `predicted ${past[0]} ${past[1]} reaches threshold ${threshold[past[0]].toFixed(1)}`;
    forced = "threshold";
  }
  return { vote, retrieved, rules, newest, ms: performance.now() - started, forced, llmVote: reply?.vote ?? null, threshold };
}

// TASK1 learn.ts step 1: predicted against observed for every voter, per metric that both sides carry.
export function calibrate(votes: Vote[], event: HistoryEvent): CalibrationEntry[] {
  const entries: CalibrationEntry[] = [];
  for (const v of votes) {
    for (const eff of event.effects.filter((f) => f.componentId === v.componentId)) {
      const predicted = v.predicted[eff.metric];
      if (typeof predicted !== "number") continue;
      entries.push({ at: event.at, proposalId: event.proposalId!, metric: `${v.componentId}.${eff.metric}`, predicted, observed: eff.after, absError: Math.abs(predicted - eff.after) });
    }
  }
  return entries;
}

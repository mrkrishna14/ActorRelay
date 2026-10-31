// Learning after execution: calibration, the retrieval cache, and evidence-backed rule proposals.
import type { CalibrationEntry, ComponentId, HistoryEvent, LearnedRule, Proposal, Vote } from "../shared/types";
import type { ComponentView, Glue } from "./glue";
import { MIN_SIMILAR, RetrievalCache, satisfies, tagOf } from "./retrieval";

const RULE_K = 20;
const CONDITION_STEP = 5;
/** Runs this far above the crossing's own speed still count as the same pattern. */
const SUPPORT_BELOW = 5;

export type LearnDeps = { glue: Glue; cache: RetrievalCache; now?: () => string; log?: (line: string) => void };

const timestamp = (deps: LearnDeps) => deps.now?.() ?? new Date().toISOString();

/** Observed value for one predicted metric: the effect row, else the shared-header twin's row, else the live reading. */
function observedValue(event: HistoryEvent, own: ComponentView, metric: string): number | undefined {
  const direct = event.effects.find((e) => e.componentId === own.id && e.metric === metric);
  if (direct) return direct.after;
  if (metric === "headerBarg" && own.sharedResources.length) {
    const twin = event.effects.find((e) => tagOf(e.componentId) === own.tag && e.metric === metric);
    if (twin) return twin.after;
  }
  return own.metrics[metric];
}

/** One CalibrationEntry per predicted metric, skipping what this component already recorded for the proposal. */
export function calibrationEntries(vote: Vote, event: HistoryEvent, own: ComponentView, at: string): CalibrationEntry[] {
  const done = new Set((own.calibration ?? []).filter((c) => c.proposalId === vote.proposalId).map((c) => c.metric));
  const entries: CalibrationEntry[] = [];
  for (const [metric, predicted] of Object.entries(vote.predicted)) {
    if (done.has(metric)) continue;
    const observed = observedValue(event, own, metric);
    if (observed === undefined) continue;
    entries.push({ at, proposalId: vote.proposalId, metric, predicted, observed, absError: Math.abs(predicted - observed) });
  }
  return entries;
}

export async function calibrate(deps: LearnDeps, vote: Vote, event: HistoryEvent): Promise<CalibrationEntry[]> {
  const own = await deps.glue.component(vote.componentId);
  const entries = calibrationEntries(vote, event, own, timestamp(deps));
  for (const entry of entries) await deps.glue.calibration(vote.componentId, entry);
  return entries;
}

type Crossing = { componentId: ComponentId; metric: string };

/** A rule is deterministic in its content, so a repeat from any path dedupes on id. */
function ruleFrom(deps: LearnDeps, crossing: Crossing, changed: { componentId: ComponentId; metric: string }, model: string, support: HistoryEvent[]): LearnedRule {
  const rows = support.flatMap((e) => e.effects.filter((r) => r.componentId === crossing.componentId && r.metric === crossing.metric));
  const conditionValue = Math.floor(Math.min(...support.map((e) => e.after)) / CONDITION_STEP) * CONDITION_STEP;
  const consequenceValue = Math.floor(Math.min(...rows.map((r) => r.after)));
  const withinTicks = Math.max(...rows.map((r) => r.ticksToSettle));
  const changedTag = tagOf(changed.componentId);
  const tag = tagOf(crossing.componentId);
  const at = timestamp(deps);
  return {
    id: `rule-${support[0].plantId}-${changedTag}-${changed.metric}-ge-${conditionValue}-${tag}-${crossing.metric}-ge-${consequenceValue}`,
    scope: "plant",
    model,
    text: `${changedTag} ${changed.metric} >= ${conditionValue} -> ${tag} ${crossing.metric} >= ${consequenceValue} within ${withinTicks} ticks, seen ${support.length} times`,
    condition: { componentId: changed.componentId, metric: changed.metric, op: ">=", value: conditionValue },
    consequence: { componentId: crossing.componentId, metric: crossing.metric, op: ">=", value: consequenceValue, withinTicks },
    supportEventIds: support.map((e) => e.id),
    timesSeen: support.length,
    createdAt: at,
    lastSeenAt: at,
  };
}

function crosses(event: HistoryEvent, crossing: Crossing, limitMax: number): boolean {
  return event.effects.some((r) => r.componentId === crossing.componentId && r.metric === crossing.metric && r.after >= limitMax);
}

function covered(rules: LearnedRule[], changedMetric: string, value: number, crossing: Crossing): boolean {
  return rules.some(
    (r) =>
      r.condition.metric === changedMetric &&
      satisfies(value, r.condition.op, r.condition.value) &&
      r.consequence.metric === crossing.metric &&
      (r.consequence.componentId === null || tagOf(r.consequence.componentId) === tagOf(crossing.componentId)),
  );
}

/**
 * Looks for a limit crossing that at least MIN_SIMILAR past runs share on the same component and that no known rule
 * covers yet, and returns the rule to propose. Plant and Company dedupe on the way in.
 */
export async function findRule(deps: LearnDeps, changed: { componentId: ComponentId; metric: string }, target: number, own: ComponentView, knownRules: LearnedRule[]): Promise<LearnedRule | null> {
  for (const [metric, limit] of Object.entries(own.limits)) {
    const crossing = { componentId: own.id, metric };
    if (covered(knownRules, changed.metric, target, crossing)) continue;
    const near = await deps.glue.similar({ ...changed, to: target, k: RULE_K });
    const inRange = near.filter((e) => e.after >= target - SUPPORT_BELOW);
    const support = inRange.filter((e) => crosses(e, crossing, limit.max));
    // A rule states what always happens, so one safe run in the same range rules it out.
    if (support.length >= MIN_SIMILAR && support.length === inRange.length) return ruleFrom(deps, crossing, changed, own.model, support);
  }
  return null;
}

/** After a voter blocks a change on repeated evidence, the pattern becomes a rule the other plant can cite. */
export async function learnFromBlock(deps: LearnDeps, proposal: Proposal, vote: Vote): Promise<LearnedRule | null> {
  if (vote.vote !== "no" || vote.evidenceEventIds.length < MIN_SIMILAR) return null;
  const own = await deps.glue.component(vote.componentId);
  if (own.plantId !== proposal.plantId) return null;
  const known = await deps.glue.rules(own.id, own.model).catch(() => null);
  if (!known) return null;
  const rule = await findRule(deps, { componentId: proposal.proposerComponentId, metric: proposal.metric }, proposal.to, own, known);
  if (rule) await postRule(deps, rule);
  return rule;
}

async function postRule(deps: LearnDeps, rule: LearnedRule) {
  deps.cache.addRule(rule);
  await deps.glue.rule(rule);
}

/**
 * Handles `executed` once per proposal. Calibrates every voter this process owns, caches the event, and proposes a
 * rule for any of the owned components the event pushed over a limit.
 */
export async function learnFromExecution(deps: LearnDeps, event: HistoryEvent, owned: Set<ComponentId>): Promise<CalibrationEntry[]> {
  const plant = await deps.glue.plant(event.plantId);
  const proposal = plant.proposals.find((p) => p.id === event.proposalId);
  if (proposal?.status !== "executed") return [];
  deps.cache.addEvent(event);
  deps.cache.addEvents(plant.history);
  const votes = proposal.votes.filter((v) => owned.has(v.componentId));
  const results = await Promise.allSettled(votes.map((vote) => calibrate(deps, vote, event)));

  const changed = { componentId: event.componentId, metric: event.metric };
  if (owned.has(event.componentId)) {
    for (const effect of event.effects) {
      if (!owned.has(effect.componentId)) continue;
      const own = await deps.glue.component(effect.componentId);
      const limit = own.limits[effect.metric];
      if (!limit || effect.after < limit.max) continue;
      const known = await deps.glue.rules(own.id, own.model).catch(() => null);
      if (!known) continue;
      const rule = await findRule(deps, changed, event.after, own, known);
      if (rule) await postRule(deps, rule);
    }
  }
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

// What counts as "similar", and the local cache of executions and rules that keeps prompts fast.
import type { ComponentId, ComponentState, HistoryEvent, LearnedRule, Limit, Proposal } from "../shared/types";

/** Below this many similar events a component cannot claim history. */
export const MIN_SIMILAR = 3;

/** For a change near critical, a run only speaks for the target if it got within this fraction of the range of it. */
export const CLOSE_RUN_FRACTION = 0.05;

/** similar() is k-nearest with no cutoff, so an event only counts within this fraction of the metric's operating range. */
export const RELEVANCE_BAND_FRACTION = 0.15;

export type OwnRow = { metric: string; before: number; after: number; ticksToSettle: number; counterpart: boolean };

export function relevanceBand(to: number, limit: Limit | undefined): number {
  const range = limit ? limit.max - limit.min : Math.abs(to);
  return Math.max(RELEVANCE_BAND_FRACTION * range, 1);
}

export function relevantEvents(events: HistoryEvent[], to: number, limit: Limit | undefined): HistoryEvent[] {
  const band = relevanceBand(to, limit);
  return events.filter((e) => Math.abs(e.after - to) <= band);
}

/**
 * The rows of an event that describe `own`. Events are keyed to the plant that changed, so a cross-plant voter has no
 * rows of its own. Its twin on the shared resource sees the same header, so only that metric carries across.
 */
export function ownRows(event: HistoryEvent, own: ComponentState): OwnRow[] {
  const direct = event.effects.filter((e) => e.componentId === own.id);
  if (direct.length) return direct.map((e) => ({ ...e, counterpart: false }));
  if (event.plantId === own.plantId || own.sharedResources.length === 0) return [];
  const twin = `${event.plantId}/${own.tag}`;
  return event.effects
    .filter((e) => e.componentId === twin && e.metric === "headerBarg")
    .map((e) => ({ ...e, counterpart: true }));
}

/** Runs that moved the way the proposal does. A step down heats the tank and a step up cools it, so peaks do not carry across. */
export function sameDirection(events: HistoryEvent[], proposal: Pick<Proposal, "from" | "to">): HistoryEvent[] {
  return events.filter((e) => Math.sign(e.after - e.before) === Math.sign(proposal.to - proposal.from));
}

/** Closeness-weighted mean of what past events did to each metric, so the nearest runs dominate. */
export function evidenceEstimates(events: HistoryEvent[], own: ComponentState, to: number): Record<string, number> {
  const totals: Record<string, { sum: number; weight: number }> = {};
  for (const event of events) {
    const weight = 1 / (1 + Math.abs(event.after - to));
    for (const row of ownRows(event, own)) {
      const t = (totals[row.metric] ??= { sum: 0, weight: 0 });
      t.sum += row.after * weight;
      t.weight += weight;
    }
  }
  return Object.fromEntries(Object.entries(totals).map(([metric, t]) => [metric, Math.round((t.sum / t.weight) * 100) / 100]));
}

/** The simulator's header equation: pressure falls this much for each extra kg/h on the header. */
const HEADER_BARG_PER_KGH = 0.0005;
const HEADER_RANGE = { min: 4.5, max: 6.5 };

/**
 * Header pressure after a change, from the steam it adds. History holds the header fixed within a run, so its rows
 * cannot show a drop. `steam` is the changed plant's steam valve, and `events` are the runs that moved the same way.
 */
export function expectedHeader(events: HistoryEvent[], steam: ComponentState, to: number): number | undefined {
  const header = steam.metrics.headerBarg;
  const flow = steam.metrics.steamKgH;
  const target = evidenceEstimates(events, steam, to).steamKgH;
  if (header === undefined || flow === undefined || target === undefined) return undefined;
  const after = header - HEADER_BARG_PER_KGH * (target - flow);
  return Math.round(Math.min(HEADER_RANGE.max, Math.max(HEADER_RANGE.min, after)) * 100) / 100;
}

/** Highest value each metric reached in runs that went no further than the target. A smaller change already got there. */
export function evidencePeaks(events: HistoryEvent[], own: ComponentState, to: number): Record<string, number> {
  const peaks: Record<string, number> = {};
  for (const event of events) {
    if (event.after > to) continue;
    for (const row of ownRows(event, own)) peaks[row.metric] = Math.max(peaks[row.metric] ?? -Infinity, row.after);
  }
  return peaks;
}

export const newestFirst = (a: HistoryEvent, b: HistoryEvent) => Date.parse(b.at) - Date.parse(a.at);

/** Newest run of this change path that went through the proposal flow. Seeded history has proposalId null. */
export function newestExecution(events: HistoryEvent[], proposal: Pick<Proposal, "proposerComponentId" | "metric">) {
  const runs = events.filter(
    (e) => e.componentId === proposal.proposerComponentId && e.metric === proposal.metric && e.proposalId !== null,
  );
  return runs.sort(newestFirst)[0] ?? null;
}

const plantOf = (id: ComponentId) => id.split("/")[0];
export const tagOf = (id: ComponentId) => id.split("/").pop() ?? id;

export const satisfies = (value: number, op: ">=" | "<=", bound: number) => (op === ">=" ? value >= bound : value <= bound);

/** A rule applies when its condition matches this change and its consequence lands on this voter's equipment. */
export function ruleApplies(rule: LearnedRule, proposal: Proposal, own: ComponentState): boolean {
  const { condition, consequence } = rule;
  if (condition.metric !== proposal.metric || !satisfies(proposal.to, condition.op, condition.value)) return false;
  if (condition.componentId && tagOf(condition.componentId) !== tagOf(proposal.proposerComponentId)) return false;
  if (consequence.componentId && tagOf(consequence.componentId) !== own.tag) return false;
  if (!consequence.componentId && rule.model !== own.model) return false;
  if (!(consequence.metric in own.limits)) return false;
  if (rule.scope === "company") return true;
  const home = consequence.componentId ?? condition.componentId;
  return home !== null && plantOf(home) === own.plantId;
}

export class RetrievalCache {
  private readonly events = new Map<string, HistoryEvent>();
  private readonly rules = new Map<string, LearnedRule>();

  addEvent(event: HistoryEvent) {
    this.events.set(event.id, event);
  }
  addEvents(events: HistoryEvent[]) {
    for (const event of events) if (event.proposalId !== null) this.addEvent(event);
  }
  addRule(rule: LearnedRule) {
    this.rules.set(rule.id, rule);
  }
  allEvents() {
    return [...this.events.values()];
  }
  allRules() {
    return [...this.rules.values()];
  }
  clear() {
    this.events.clear();
    this.rules.clear();
  }
}

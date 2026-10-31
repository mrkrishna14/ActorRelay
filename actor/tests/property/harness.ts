import fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ComponentState,
  HistoryEvent,
  LearnedRule,
  Limit,
  Proposal,
  Vote,
} from "../../../shared/types";

// PROP_RUNS scales every suite. PROP_SEED replays a failure printed by fast-check.
export const RUNS = Number(process.env.PROP_RUNS ?? 5000);
const SEED = process.env.PROP_SEED ? Number(process.env.PROP_SEED) : undefined;

export function check(property: fc.IRawProperty<any, any>, numRuns = RUNS) {
  return fc.assert(property, { numRuns, ...(SEED === undefined ? {} : { seed: SEED }) });
}

export const plantsJson = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../shared/plants.json"), "utf8"),
);
export const seedComponents: ComponentState[] = plantsJson.plants.flatMap(
  (p: { components: ComponentState[] }) => p.components,
);
export const plantComponents = (plantId: string): ComponentState[] =>
  seedComponents.filter((c) => c.plantId === plantId);

export const clone = <T>(x: T): T => structuredClone(x);

export function deepFreeze<T>(x: T): T {
  if (x && typeof x === "object" && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

// Next representable doubles, so boundary cases sit one ulp either side of a limit.
const f64 = new Float64Array(1);
const u64 = new BigInt64Array(f64.buffer);
export function nextUp(x: number): number {
  if (x === 0) return Number.MIN_VALUE;
  f64[0] = x;
  u64[0] += x > 0 ? 1n : -1n;
  return f64[0];
}
export function nextDown(x: number): number {
  if (x === 0) return -Number.MIN_VALUE;
  f64[0] = x;
  u64[0] += x > 0 ? -1n : 1n;
  return f64[0];
}

export const iso = (ms: number) => new Date(ms).toISOString();
export const T0 = Date.parse("2026-10-31T12:00:00.000Z");

export const finite = (min = -1e4, max = 1e4) =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

// A valid yes must predict every limited metric. These sit low in range: the seed's normal tempC
// of 75 is already within 15% of critical, which with no similar history turns a yes into a no.
function safePredictions(componentId: string): Record<string, number> {
  const limits = seedComponents.find((c) => c.id === componentId)?.limits ?? {};
  return Object.fromEntries(
    Object.entries(limits).map(([metric, l]) => [metric, l.min + (l.max - l.min) / 10]),
  );
}

export function makeVote(
  proposalId: string,
  componentId: string,
  vote: "yes" | "no" = "yes",
): Vote {
  return {
    proposalId,
    componentId,
    agentId: `agent:${componentId}`,
    vote,
    reason: "generated",
    predicted: safePredictions(componentId),
    marginPct: 10,
    evidenceEventIds: [],
    evidenceRuleIds: [],
    similarCount: 3,
  };
}

export function makeProposal(
  id: string,
  atMs: number,
  proposer: string,
  requiredVoters: string[],
  overrides: Partial<Proposal> = {},
): Proposal {
  return {
    id,
    at: iso(atMs),
    plantId: proposer.split("/")[0] as Proposal["plantId"],
    proposerComponentId: proposer,
    proposerAgentId: `agent:${proposer}`,
    metric: "speedPct",
    from: 50,
    to: 65,
    rationale: "generated",
    requiredVoters,
    votes: [],
    status: "voting",
    vetoDeadline: null,
    parentProposalId: null,
    crossPlant: requiredVoters.some(
      (v) => v.split("/")[0] !== proposer.split("/")[0],
    ),
    ...overrides,
  };
}

export function makeEvent(
  id: string,
  componentId: string,
  metric: string,
  after: number,
  effects: HistoryEvent["effects"] = [],
  overrides: Partial<HistoryEvent> = {},
): HistoryEvent {
  return {
    id,
    at: iso(T0),
    plantId: componentId.split("/")[0] as HistoryEvent["plantId"],
    componentId,
    metric,
    before: 50,
    after,
    upstreamSnapshot: {},
    effects,
    incident: null,
    approvedBy: [],
    operator: null,
    proposalId: null,
    ...overrides,
  };
}

// The seam every suite goes through, so the same properties run against the real
// logic, the spec reference, and each deliberately broken reference mutant.
export type StatusValue = ComponentState["status"];
export type SimilarQuery = {
  history: HistoryEvent[];
  componentId: string;
  metric: string;
  to: number;
  upstreamSnapshot: Record<string, number>;
  k?: number;
  limit?: Limit;
};
export type CalibrationState = {
  calibration: import("../../../shared/types").CalibrationEntry[];
  marginPct: number;
};
export type LifecycleState = {
  proposals: Proposal[];
  setpoints?: Record<string, Record<string, number>>;
  executions?: Record<string, { state: string }>;
};
export type Outcome<S> = { accepted: true; state: S } | { accepted: false; reason: string };
type Awaitable<T> = T | Promise<T>;
export type RuleContext = {
  components: ComponentState[];
  otherPlantComponents: ComponentState[];
};
export type RuleResult = {
  planted: LearnedRule[];
  company: LearnedRule[];
  history: HistoryEvent[];
};

// Documented departures from the plain TASK1 reading. Each stays stricter than, or adds
// to, the spec; the suites check the stated behaviour exactly rather than skipping it.
export type Traits = {
  // similar(): newest live event first whatever its distance; seed events past this
  // normalised gap are dropped.
  similarLive: { dropBeyond: number } | null;
  // Calibration needs five fresh entries after a margin change before it can move again.
  calibrationFreshWindow: boolean;
  // A deadline missed by more than this reopens a full window instead of executing.
  vetoLapseMs: number | null;
  // A unanimous proposal still waiting for a window after this long expires.
  waitingTimeoutMs: number | null;
  // A veto after the deadline still lands if the sweep has not executed yet.
  lateVetoWins: boolean;
  // A blocked proposal keeps recording slower voters; its status never moves.
  blockedRecordsLateVotes: boolean;
  // A proposal whose `from` no longer matches the setpoint expires, even with every vote in.
  staleExpires: boolean;
  // An accepted proposal whose dispatch failed moves from executed to expired.
  failedDispatchExpires: boolean;
  // A rule needs a threshold where every run at or past it crossed, so a safe run above
  // all unsafe runs suppresses the rule rather than being outvoted.
  ruleThresholdScan: boolean;
};

export interface Engine {
  name: string;
  traits: Traits;
  // Decides the range similar() normalises by; the suite computes the oracle with it.
  similarRanges(query: SimilarQuery): {
    metricRange: number;
    keyRange(key: string): number;
  };
  similar(query: SimilarQuery): HistoryEvent[];
  computeStatus(
    metrics: Record<string, number>,
    limits: Record<string, Limit>,
  ): StatusValue;
  addCalibration(
    state: CalibrationState,
    entry: CalibrationState["calibration"][number],
    limits: Record<string, Limit>,
  ): CalibrationState;
  setMargin(current: number, pct: number): number;
  requiredVoters(
    proposerId: string,
    components: ComponentState[],
  ): { requiredVoters: string[]; crossPlant: boolean };
  vote(state: LifecycleState, vote: Vote, nowMs: number): Awaitable<Outcome<LifecycleState>>;
  veto(state: LifecycleState, id: string, by: string, nowMs: number): Awaitable<Outcome<LifecycleState>>;
  sweep(state: LifecycleState, nowMs: number): Awaitable<LifecycleState>;
  execute(state: LifecycleState, id: string, nowMs: number): Awaitable<Outcome<LifecycleState>>;
  promoteAfterEvent(
    history: HistoryEvent[],
    rules: LearnedRule[],
    company: LearnedRule[],
    event: HistoryEvent,
    ctx: RuleContext,
    nowMs: number,
  ): Awaitable<RuleResult>;
  // The id a generated event ends up with once it is on the record.
  eventId(id: string): string;
  submitRule(rule: LearnedRule, history: HistoryEvent[], ctx: RuleContext): Awaitable<boolean>;
  submitCompanyRule(rule: LearnedRule, ctx: RuleContext): Awaitable<boolean>;
}

export type { ComponentState, HistoryEvent, LearnedRule, Limit, Proposal, Vote };

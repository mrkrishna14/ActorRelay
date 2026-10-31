// Fixtures for the adversarial suite. Components come from shared/plants.json; events are hand-built to the
// physics summary so that every test knows exactly what the evidence says.
import plants from "../../../shared/plants.json";
import type { ComponentState, HistoryEvent, LearnedRule, Proposal, Vote } from "../../../shared/types";

const ALL = plants.plants.flatMap((p) => p.components) as unknown as ComponentState[];

export function component(id: string, patch: Partial<ComponentState> = {}): ComponentState {
  const found = ALL.find((c) => c.id === id);
  if (!found) throw new Error(`no fixture component ${id}`);
  return { ...structuredClone(found), ...patch };
}

export function event(id: string, after: number, lv101After: number, patch: Partial<HistoryEvent> = {}): HistoryEvent {
  const plantId = (patch.plantId ?? "plant-a") as HistoryEvent["plantId"];
  return {
    id,
    at: "2026-10-31T10:00:00.000Z",
    plantId,
    componentId: `${plantId}/P-100`,
    metric: "speedPct",
    before: 50,
    after,
    upstreamSnapshot: {},
    effects: [
      { componentId: `${plantId}/LV-101`, metric: "positionPct", before: 50, after: lv101After, ticksToSettle: 3 },
      { componentId: `${plantId}/TK-101`, metric: "levelPct", before: 50, after: after >= 80 ? 74 : 52, ticksToSettle: 5 },
      { componentId: `${plantId}/TK-101`, metric: "tempC", before: 75, after: after >= 80 ? 71 : 73, ticksToSettle: 5 },
      { componentId: `${plantId}/E-101`, metric: "dutyKw", before: 898, after: after >= 80 ? 1510 : 1160, ticksToSettle: 5 },
      { componentId: `${plantId}/TV-101`, metric: "positionPct", before: 50, after: after >= 80 ? 78 : 62, ticksToSettle: 5 },
      { componentId: `${plantId}/TV-101`, metric: "steamKgH", before: 1533, after: after >= 80 ? 2570 : 1980, ticksToSettle: 5 },
    ],
    incident: after >= 80 ? "LV-101 saturated; TK-101 high level alarm" : null,
    approvedBy: [],
    operator: null,
    proposalId: null,
    ...patch,
  };
}

// Retrieved for P-100 -> 85: three incidents where LV-101 ended past the threshold of 81.
export const UNSAFE_EVENTS = (): HistoryEvent[] => [
  event("evt-85-a", 85, 92),
  event("evt-85-b", 85, 96),
  event("evt-85-c", 84, 90),
  event("evt-80-d", 80, 86),
  event("evt-65-e", 65, 67),
];

// Retrieved for P-100 -> 65: safe runs, plus two unsafe runs at 85 that are not proof about 65.
export const SAFE_EVENTS = (): HistoryEvent[] => [
  event("evt-65-a", 65, 66),
  event("evt-65-b", 66, 67),
  event("evt-64-c", 64, 66),
  event("evt-85-d", 85, 92),
  event("evt-85-e", 85, 96),
];

export const SEED_HISTORY = (): HistoryEvent[] => [...SAFE_EVENTS(), ...UNSAFE_EVENTS()];

export function proposal(to: number, patch: Partial<Proposal> = {}): Proposal {
  return {
    id: "prop-1",
    at: "2026-10-31T12:00:00.000Z",
    plantId: "plant-a",
    proposerComponentId: "plant-a/P-100",
    proposerAgentId: "agent:plant-a/P-100",
    metric: "speedPct",
    from: 50,
    to,
    rationale: "Increase throughput",
    requiredVoters: ["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101", "plant-b/TV-101"],
    votes: [],
    status: "voting",
    vetoDeadline: null,
    parentProposalId: null,
    crossPlant: true,
    ...patch,
  };
}

export const RULE_85: LearnedRule = {
  id: "rule-lv-sat",
  scope: "company",
  model: "outlet-valve-A",
  text: "P-100 speedPct >= 80 -> LV-101 positionPct >= 85 within 3 ticks, seen 4 times",
  condition: { componentId: "plant-a/P-100", metric: "speedPct", op: ">=", value: 80 },
  consequence: { componentId: "plant-a/LV-101", metric: "positionPct", op: ">=", value: 85, withinTicks: 3 },
  supportEventIds: ["evt-85-a", "evt-85-b", "evt-85-c"],
  timesSeen: 4,
  createdAt: "2026-10-31T11:00:00.000Z",
  lastSeenAt: "2026-10-31T11:30:00.000Z",
};

// What a well-behaved model returns. Only the LLM-authored fields; tests add spoofed fields on top.
export function reply(vote: "yes" | "no", predicted: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    proposalId: "prop-1",
    componentId: "plant-a/LV-101",
    agentId: "agent:plant-a/LV-101",
    vote,
    reason: "based on retrieved events",
    predicted,
    marginPct: 10,
    evidenceEventIds: [],
    evidenceRuleIds: [],
    similarCount: 5,
    ...extra,
  });
}

export const isSafeOutcome = (v: Vote | null | undefined) => v == null || v.vote === "no";

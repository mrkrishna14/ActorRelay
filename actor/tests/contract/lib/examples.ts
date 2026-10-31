// One canonical, fully typed example of every contract object. If shared/types.ts changes, these stop compiling.
import type {
  AuditEntry,
  CalibrationEntry,
  CompanyState,
  HistoryEvent,
  LearnedRule,
  PlantState,
  Proposal,
  Vote,
} from "../../../../shared/types";
import plantsFile from "../../../../shared/plants.json";
import { PlantsFileS, type EmittedComponent } from "./schemas";

export const seed = PlantsFileS.parse(plantsFile);
export const ALL_COMPONENT_IDS = seed.plants.flatMap((p) => p.components.map((c) => c.id));
export const T0 = "2026-10-31T19:00:00.000Z";

export const vote: Vote = {
  proposalId: "plant-a-prop-1",
  componentId: "plant-a/LV-101",
  agentId: "agent:plant-a/LV-101",
  vote: "no",
  reason: "Predicted 89 % is past 81 % (critical 90 less margin 10 %).",
  predicted: { positionPct: 89 },
  marginPct: 10,
  evidenceEventIds: ["evt-1", "evt-2", "evt-3"],
  evidenceRuleIds: ["rule-1"],
  similarCount: 5,
};

export const crossPlantVote: Vote = {
  ...vote,
  componentId: "plant-b/TV-101",
  agentId: "agent:plant-b/TV-101",
  vote: "yes",
  reason: "Header drop stays in range.",
  predicted: { positionPct: 54, steamKgH: 1533, headerBarg: 5.6 },
  evidenceRuleIds: [],
};

export const proposal: Proposal = {
  id: "plant-a-prop-1",
  at: T0,
  plantId: "plant-a",
  proposerComponentId: "plant-a/P-100",
  proposerAgentId: "agent:plant-a/P-100",
  metric: "speedPct",
  from: 50,
  to: 85,
  rationale: "Raise throughput.",
  requiredVoters: ["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101", "plant-b/TV-101"],
  votes: [vote],
  status: "voting",
  vetoDeadline: null,
  parentProposalId: null,
  crossPlant: true,
};

export const event: HistoryEvent = {
  id: "evt-1",
  at: T0,
  plantId: "plant-a",
  componentId: "plant-a/P-100",
  metric: "speedPct",
  before: 50,
  after: 65,
  upstreamSnapshot: { feedM3h: 15, headerBarg: 6, feedTempC: 25 },
  effects: [{ componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: 66, ticksToSettle: 3 }],
  incident: null,
  approvedBy: ["plant-a/TK-101", "plant-a/LV-101"],
  operator: null,
  proposalId: "plant-a-prop-2",
};

export const calibration: CalibrationEntry = {
  at: T0,
  proposalId: "plant-a-prop-2",
  metric: "positionPct",
  predicted: 66,
  observed: 67,
  absError: 1,
};

export const rule: LearnedRule = {
  id: "rule-1",
  scope: "company",
  model: "outlet-valve-A",
  text: "P-100 speedPct >= 80 -> LV-101 positionPct >= 85 within 3 ticks, seen 4 times",
  condition: { componentId: "plant-a/P-100", metric: "speedPct", op: ">=", value: 80 },
  consequence: { componentId: "plant-a/LV-101", metric: "positionPct", op: ">=", value: 85, withinTicks: 3 },
  supportEventIds: ["evt-1", "evt-2", "evt-3"],
  timesSeen: 3,
  createdAt: T0,
  lastSeenAt: T0,
};

export const audit: AuditEntry = { at: T0, plantId: "plant-a", kind: "proposal", refId: "plant-a-prop-1", summary: "Pump 50 -> 85", by: "operator" };

export const emittedComponent: EmittedComponent = { ...seed.plants[0]!.components[2]!, calibration: [calibration] };

export const plantState: PlantState = {
  id: "plant-a",
  name: "Plant A",
  components: seed.plants[0]!.components.map((c) => c.id),
  proposals: [proposal],
  history: [event],
  rules: [rule],
  audit: [audit],
  tick: 7,
  connected: true,
};

export const companyState: CompanyState = {
  plants: ["plant-a", "plant-b"],
  sharedResources: seed.company.sharedResources,
  rules: [rule],
  crossPlantProposals: ["plant-a-prop-1"],
  audit: [audit],
};

// The exact body each glue route takes, built from the objects above.
export const routeBodies = {
  "/propose": { plantId: "plant-a", proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 85, rationale: "Raise throughput." },
  "/mirror": { componentId: "plant-a/LV-101", metrics: { positionPct: 50 } },
  "/vote": { vote },
  "/counter": {
    parentProposalId: "plant-a-prop-1",
    proposal: { plantId: "plant-a", proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 65, rationale: "Safer step." },
  },
  "/veto": { proposalId: "plant-a-prop-1", by: "operator" },
  "/execute-callback": { proposalId: "plant-a-prop-1" },
  "/observed": { proposalId: "plant-a-prop-2", effects: event.effects },
  "/calibration": { componentId: "plant-a/LV-101", entry: calibration },
  "/rule": { rule },
  "/reset": {},
  "/tick": {},
} as const;

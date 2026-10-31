export type PlantId = "plant-a" | "plant-b";
export type ComponentId = string;                       // e.g. "plant-a/LV-101"
export type Role = "mechanic" | "process_engineer" | "chemical_engineer" | "safety";
export type Vendor = "claude" | "codex" | "gemini";

export type Limit = { min: number; max: number; critical: number };

export type ComponentState = {
  id: ComponentId; plantId: PlantId; tag: string; name: string; model: string;   // model e.g. "outlet-valve-A"
  role: Role; vendor: Vendor;
  metrics: Record<string, number>;
  limits: Record<string, Limit>;
  upstream: ComponentId[]; downstream: ComponentId[]; sharedResources: string[];
  status: "ok" | "warning" | "critical" | "offline";
  marginPct: number;                                     // safety margin, starts 10, 5..25
  lastTick: string;
};

export type HistoryEvent = {
  id: string; at: string; plantId: PlantId; componentId: ComponentId; metric: string;
  before: number; after: number;
  upstreamSnapshot: Record<string, number>;
  effects: { componentId: ComponentId; metric: string; before: number; after: number; ticksToSettle: number }[];
  incident: string | null; approvedBy: string[]; operator: string | null; proposalId: string | null;
};

export type CalibrationEntry = { at: string; proposalId: string; metric: string; predicted: number; observed: number; absError: number };

export type LearnedRule = {
  id: string; scope: "component" | "plant" | "company"; model: string | null;
  text: string; condition: { componentId: ComponentId | null; metric: string; op: ">=" | "<="; value: number };
  consequence: { componentId: ComponentId | null; metric: string; op: ">=" | "<="; value: number; withinTicks: number };
  supportEventIds: string[]; timesSeen: number; createdAt: string; lastSeenAt: string;
};

export type Vote = {
  proposalId: string; componentId: ComponentId; agentId: string; vote: "yes" | "no";
  reason: string; predicted: Record<string, number>; marginPct: number;
  evidenceEventIds: string[]; evidenceRuleIds: string[]; similarCount: number;
};

export type Proposal = {
  id: string; at: string; plantId: PlantId; proposerComponentId: ComponentId; proposerAgentId: string;
  metric: string; from: number; to: number; rationale: string;
  requiredVoters: ComponentId[]; votes: Vote[];
  status: "voting" | "blocked" | "veto_window" | "vetoed" | "executed" | "expired";
  vetoDeadline: string | null; parentProposalId: string | null; crossPlant: boolean;
};

export type AuditEntry = { at: string; plantId: PlantId | "company"; kind: "proposal" | "vote" | "veto" | "execute" | "block" | "incident" | "rule_learned" | "calibration"; refId: string; summary: string; by: string };

export type PlantState = {
  id: PlantId; name: string; components: ComponentId[]; proposals: Proposal[];
  history: HistoryEvent[]; rules: LearnedRule[]; audit: AuditEntry[]; tick: number; connected: boolean;
};

export type CompanyState = {
  plants: PlantId[]; sharedResources: { id: string; name: string; components: ComponentId[] }[];
  rules: LearnedRule[]; crossPlantProposals: string[]; audit: AuditEntry[];
};

export type DashboardState = { plant: PlantState; components: (ComponentState & {calibration?: CalibrationEntry[]})[]; company: CompanyState; mode: "mock" | "live"; integrations?: Record<string, unknown> };

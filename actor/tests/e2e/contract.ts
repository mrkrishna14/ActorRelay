// Strict zod mirror of shared/types.ts, used by the fake glue and by the contract-drift checks.
// `.strict()` is deliberate: a field outside types.ts is contract drift and must fail loudly.
import { z } from "zod";

const num = z.number().refine(Number.isFinite, "must be finite");
export const PlantIdZ = z.enum(["plant-a", "plant-b"]);
export const ComponentIdZ = z.string().regex(/^plant-[ab]\/[A-Z]+-\d+$/);
const metricsZ = z.record(z.string(), num);
const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be a date");

export const LimitZ = z.object({ min: num, max: num, critical: num }).strict();

export const ComponentStateZ = z.object({
  id: ComponentIdZ, plantId: PlantIdZ, tag: z.string(), name: z.string(), model: z.string(),
  role: z.enum(["mechanic", "process_engineer", "chemical_engineer", "safety"]),
  vendor: z.enum(["claude", "codex", "gemini"]),
  metrics: metricsZ,
  limits: z.record(z.string(), LimitZ),
  upstream: z.array(ComponentIdZ), downstream: z.array(ComponentIdZ), sharedResources: z.array(z.string()),
  status: z.enum(["ok", "warning", "critical", "offline"]),
  marginPct: num.min(5).max(25),
  lastTick: iso,
});

export const EffectZ = z.object({ componentId: ComponentIdZ, metric: z.string(), before: num, after: num, ticksToSettle: num }).strict();

export const HistoryEventZ = z.object({
  id: z.string().min(1), at: iso, plantId: PlantIdZ, componentId: ComponentIdZ, metric: z.string(),
  before: num, after: num,
  upstreamSnapshot: metricsZ,
  effects: z.array(EffectZ),
  incident: z.string().nullable(), approvedBy: z.array(z.string()), operator: z.string().nullable(), proposalId: z.string().nullable(),
}).strict();

export const CalibrationEntryZ = z.object({
  at: iso, proposalId: z.string().min(1), metric: z.string(), predicted: num, observed: num, absError: num,
}).strict();

const ruleSideZ = z.object({
  componentId: ComponentIdZ.nullable(), metric: z.string(), op: z.enum([">=", "<="]), value: num,
});

export const LearnedRuleZ = z.object({
  id: z.string().min(1), scope: z.enum(["component", "plant", "company"]), model: z.string().nullable(),
  text: z.string(),
  condition: ruleSideZ.strict(),
  consequence: ruleSideZ.extend({ withinTicks: num }).strict(),
  supportEventIds: z.array(z.string()), timesSeen: num, createdAt: iso, lastSeenAt: iso,
}).strict();

export const VoteZ = z.object({
  proposalId: z.string().min(1), componentId: ComponentIdZ, agentId: z.string().min(1), vote: z.enum(["yes", "no"]),
  reason: z.string(), predicted: metricsZ, marginPct: num,
  evidenceEventIds: z.array(z.string()), evidenceRuleIds: z.array(z.string()), similarCount: num.int().min(0),
}).strict();

export const ProposalZ = z.object({
  id: z.string().min(1), at: iso, plantId: PlantIdZ, proposerComponentId: ComponentIdZ, proposerAgentId: z.string(),
  metric: z.string(), from: num, to: num, rationale: z.string(),
  requiredVoters: z.array(ComponentIdZ), votes: z.array(VoteZ),
  status: z.enum(["voting", "blocked", "veto_window", "vetoed", "executed", "expired"]),
  vetoDeadline: iso.nullable(), parentProposalId: z.string().nullable(), crossPlant: z.boolean(),
}).strict();

export const AuditEntryZ = z.object({
  at: iso, plantId: z.union([PlantIdZ, z.literal("company")]),
  kind: z.enum(["proposal", "vote", "veto", "execute", "block", "incident", "rule_learned", "calibration"]),
  refId: z.string(), summary: z.string(), by: z.string(),
}).strict();

export const PlantStateZ = z.object({
  id: PlantIdZ, name: z.string(), components: z.array(ComponentIdZ), proposals: z.array(ProposalZ),
  history: z.array(HistoryEventZ), rules: z.array(LearnedRuleZ), audit: z.array(AuditEntryZ), tick: num, connected: z.boolean(),
}).strict();

export const CompanyStateZ = z.object({
  plants: z.array(PlantIdZ),
  sharedResources: z.array(z.object({ id: z.string(), name: z.string(), components: z.array(ComponentIdZ) }).strict()),
  rules: z.array(LearnedRuleZ), crossPlantProposals: z.array(z.string()), audit: z.array(AuditEntryZ),
}).strict();

// Route payloads, exactly as written in TASK2.MD and TASK3.MD.
export const MirrorBodyZ = z.object({ componentId: ComponentIdZ, metrics: metricsZ }).strict();
export const ProposeBodyZ = z.object({
  plantId: PlantIdZ, proposerComponentId: ComponentIdZ, metric: z.string(), to: num, rationale: z.string(),
}).strict();
export const VoteBodyZ = z.object({ vote: VoteZ }).strict();
export const CounterBodyZ = z.object({ parentProposalId: z.string().min(1), proposal: ProposeBodyZ }).strict();
export const VetoBodyZ = z.object({ proposalId: z.string().min(1), by: z.string().min(1) }).strict();
export const ExecuteCallbackBodyZ = z.object({ proposalId: z.string().min(1) }).strict();
export const TickBodyZ = z.object({}).strict();
export const ResetBodyZ = z.object({}).strict();
export const ObservedBodyZ = z.object({ proposalId: z.string().min(1), effects: z.array(EffectZ) }).strict();
export const CalibrationBodyZ = z.object({ componentId: ComponentIdZ, entry: CalibrationEntryZ }).strict();
export const RuleBodyZ = z.object({ rule: LearnedRuleZ }).strict();
export const SimilarQueryZ = z.object({
  componentId: ComponentIdZ, metric: z.string(), to: num, upstreamSnapshot: metricsZ.default({}), k: num.int().min(1).default(5),
});

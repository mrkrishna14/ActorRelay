// Zod schemas for the frozen contract in shared/types.ts. `satisfies` keeps them in step with it at compile time.
import { z } from "zod";
import type {
  AuditEntry,
  CalibrationEntry,
  ComponentState,
  CompanyState,
  HistoryEvent,
  LearnedRule,
  Limit,
  PlantState,
  Proposal,
  Vote,
} from "../shared/types";

const finite = z.number().finite();
const id = z.string().min(1);

export const plantIdSchema = z.enum(["plant-a", "plant-b"]);
export const roleSchema = z.enum(["mechanic", "process_engineer", "chemical_engineer", "safety"]);
export const vendorSchema = z.enum(["claude", "codex", "gemini"]);

export const limitSchema = z.object({ min: finite, max: finite, critical: finite }) satisfies z.ZodType<Limit>;

export const calibrationEntrySchema = z.object({
  at: id,
  proposalId: id,
  metric: id,
  predicted: finite,
  observed: finite,
  absError: z.number().nonnegative(),
}) satisfies z.ZodType<CalibrationEntry>;

export const componentStateSchema = z.object({
  id,
  plantId: plantIdSchema,
  tag: id,
  name: z.string(),
  model: id,
  role: roleSchema,
  vendor: vendorSchema,
  metrics: z.record(z.string(), finite),
  limits: z.record(z.string(), limitSchema),
  upstream: z.array(id),
  downstream: z.array(id),
  sharedResources: z.array(z.string()),
  status: z.enum(["ok", "warning", "critical", "offline"]),
  marginPct: finite,
  lastTick: z.string(),
  calibration: z.array(calibrationEntrySchema).optional(),
}) satisfies z.ZodType<ComponentState & { calibration?: CalibrationEntry[] }>;

export const effectSchema = z.object({
  componentId: id,
  metric: id,
  before: finite,
  after: finite,
  ticksToSettle: z.number().nonnegative(),
});

export const historyEventSchema = z.object({
  id,
  at: id,
  plantId: plantIdSchema,
  componentId: id,
  metric: id,
  before: finite,
  after: finite,
  upstreamSnapshot: z.record(z.string(), finite),
  effects: z.array(effectSchema),
  incident: z.string().nullable(),
  approvedBy: z.array(z.string()),
  operator: z.string().nullable(),
  proposalId: z.string().nullable(),
}) satisfies z.ZodType<HistoryEvent>;

const ruleClause = z.object({ componentId: z.string().nullable(), metric: id, op: z.enum([">=", "<="]), value: finite });

export const learnedRuleSchema = z.object({
  id,
  scope: z.enum(["component", "plant", "company"]),
  model: z.string().nullable(),
  text: z.string().min(1),
  condition: ruleClause,
  consequence: ruleClause.extend({ withinTicks: z.number().nonnegative() }),
  supportEventIds: z.array(id),
  timesSeen: z.number().int().nonnegative(),
  createdAt: id,
  lastSeenAt: id,
}) satisfies z.ZodType<LearnedRule>;

export const voteSchema = z
  .object({
    proposalId: id,
    componentId: id,
    agentId: id,
    vote: z.enum(["yes", "no"]),
    reason: z.string().min(1),
    predicted: z.record(z.string(), finite),
    marginPct: finite,
    evidenceEventIds: z.array(id),
    evidenceRuleIds: z.array(id),
    similarCount: z.number().int().nonnegative(),
  })
  .strict() satisfies z.ZodType<Vote>;

export const proposalSchema = z.object({
  id,
  at: id,
  plantId: plantIdSchema,
  proposerComponentId: id,
  proposerAgentId: z.string(),
  metric: id,
  from: finite,
  to: finite,
  rationale: z.string(),
  requiredVoters: z.array(id),
  votes: z.array(voteSchema.loose()),
  status: z.enum(["voting", "blocked", "veto_window", "vetoed", "executed", "expired"]),
  vetoDeadline: z.string().nullable(),
  parentProposalId: z.string().nullable(),
  crossPlant: z.boolean(),
}) satisfies z.ZodType<Proposal>;

/** Body of POST /counter's `proposal`. The glue route is strict, so this must stay exactly these five fields. */
export const proposalInputSchema = z
  .object({
    plantId: plantIdSchema,
    proposerComponentId: id,
    metric: id,
    to: finite,
    rationale: z.string().min(1).max(4000),
  })
  .strict();
export type ProposalInput = z.infer<typeof proposalInputSchema>;

export const auditEntrySchema = z.object({
  at: z.string(),
  plantId: z.enum(["plant-a", "plant-b", "company"]),
  kind: z.enum(["proposal", "vote", "veto", "execute", "block", "incident", "rule_learned", "calibration"]),
  refId: z.string(),
  summary: z.string(),
  by: z.string(),
}) satisfies z.ZodType<AuditEntry>;

export const plantStateSchema = z.object({
  id: plantIdSchema,
  name: z.string(),
  components: z.array(id),
  proposals: z.array(proposalSchema),
  history: z.array(historyEventSchema),
  rules: z.array(learnedRuleSchema),
  audit: z.array(auditEntrySchema),
  tick: finite,
  connected: z.boolean(),
}) satisfies z.ZodType<PlantState>;

export const companyStateSchema = z.object({
  plants: z.array(plantIdSchema),
  sharedResources: z.array(z.object({ id, name: z.string(), components: z.array(id) })),
  rules: z.array(learnedRuleSchema),
  crossPlantProposals: z.array(z.string()),
  audit: z.array(auditEntrySchema),
}) satisfies z.ZodType<CompanyState>;

/** What the model is asked for. Identity, margin and counts are filled in by code, so only judgement fields are read. */
export const llmVoteSchema = z.object({
  vote: z.enum(["yes", "no"]),
  reason: z.string().trim().min(1).max(2000),
  predicted: z.record(z.string(), finite),
  evidenceEventIds: z.array(z.string()).default([]),
  evidenceRuleIds: z.array(z.string()).default([]),
});
export type LlmVote = z.infer<typeof llmVoteSchema>;

export const llmCounterSchema = z.object({ value: finite, rationale: z.string().trim().min(1).max(2000) });
export type LlmCounter = z.infer<typeof llmCounterSchema>;

/** Relay message bodies. The text of every Relay message on the plant and company channels is one of these as JSON. */
export const wireMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("proposal"), proposal: proposalSchema }),
  z.object({ type: z.literal("vote"), vote: voteSchema }),
  z.object({ type: z.literal("counter"), parentProposalId: id, proposal: proposalInputSchema }),
  z.object({ type: z.literal("executed"), proposalId: id, event: historyEventSchema }),
  z.object({ type: z.literal("rule"), rule: learnedRuleSchema }),
]);
export type WireMessage = z.infer<typeof wireMessageSchema>;

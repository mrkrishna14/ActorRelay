// Strict runtime mirrors of shared/types.ts. Every object is strict, so an extra field is a failure:
// nothing the dashboard could come to depend on can leave an actor unnoticed. The Expect block at the
// bottom ties each schema to the frozen type at compile time, so drift in either direction fails tsc.
import { z } from "zod";
import type {
  AuditEntry,
  CalibrationEntry,
  CompanyState,
  ComponentState,
  HistoryEvent,
  LearnedRule,
  Limit,
  PlantId,
  PlantState,
  Proposal,
  Role,
  Vendor,
  Vote,
} from "../../../../shared/types";
import type { Equal, Expect } from "./typeassert";

const num = z.number().finite();
export const isoInstant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not a parseable timestamp");

export const PlantIdS = z.enum(["plant-a", "plant-b"]);
export const ComponentIdS = z.string().regex(/^plant-[ab]\/[A-Z]+-\d+$/, "ComponentId must be <plantId>/<tag>");
export const RoleS = z.enum(["mechanic", "process_engineer", "chemical_engineer", "safety"]);
export const VendorS = z.enum(["claude", "codex", "gemini"]);
export const LimitS = z.strictObject({ min: num, max: num, critical: num });
export const MetricsS = z.record(z.string(), num);

export const ComponentStateS = z.strictObject({
  id: ComponentIdS,
  plantId: PlantIdS,
  tag: z.string(),
  name: z.string(),
  model: z.string(),
  role: RoleS,
  vendor: VendorS,
  metrics: MetricsS,
  limits: z.record(z.string(), LimitS),
  upstream: z.array(ComponentIdS),
  downstream: z.array(ComponentIdS),
  sharedResources: z.array(z.string()),
  status: z.enum(["ok", "warning", "critical", "offline"]),
  marginPct: num,
  lastTick: z.string(),
});

export const EffectS = z.strictObject({
  componentId: ComponentIdS,
  metric: z.string(),
  before: num,
  after: num,
  ticksToSettle: num,
});

export const HistoryEventS = z.strictObject({
  id: z.string(),
  at: z.string(),
  plantId: PlantIdS,
  componentId: ComponentIdS,
  metric: z.string(),
  before: num,
  after: num,
  upstreamSnapshot: MetricsS,
  effects: z.array(EffectS),
  incident: z.string().nullable(),
  approvedBy: z.array(z.string()),
  operator: z.string().nullable(),
  proposalId: z.string().nullable(),
});

export const CalibrationEntryS = z.strictObject({
  at: z.string(),
  proposalId: z.string(),
  metric: z.string(),
  predicted: num,
  observed: num,
  absError: num,
});

const OpS = z.enum([">=", "<="]);
export const LearnedRuleS = z.strictObject({
  id: z.string(),
  scope: z.enum(["component", "plant", "company"]),
  model: z.string().nullable(),
  text: z.string(),
  condition: z.strictObject({ componentId: ComponentIdS.nullable(), metric: z.string(), op: OpS, value: num }),
  consequence: z.strictObject({
    componentId: ComponentIdS.nullable(),
    metric: z.string(),
    op: OpS,
    value: num,
    withinTicks: num,
  }),
  supportEventIds: z.array(z.string()),
  timesSeen: num,
  createdAt: z.string(),
  lastSeenAt: z.string(),
});

export const VoteS = z.strictObject({
  proposalId: z.string(),
  componentId: ComponentIdS,
  agentId: z.string(),
  vote: z.enum(["yes", "no"]),
  reason: z.string(),
  predicted: MetricsS,
  marginPct: num,
  evidenceEventIds: z.array(z.string()),
  evidenceRuleIds: z.array(z.string()),
  similarCount: num,
});

export const ProposalS = z.strictObject({
  id: z.string(),
  at: z.string(),
  plantId: PlantIdS,
  proposerComponentId: ComponentIdS,
  proposerAgentId: z.string(),
  metric: z.string(),
  from: num,
  to: num,
  rationale: z.string(),
  requiredVoters: z.array(ComponentIdS),
  votes: z.array(VoteS),
  status: z.enum(["voting", "blocked", "veto_window", "vetoed", "executed", "expired"]),
  vetoDeadline: z.string().nullable(),
  parentProposalId: z.string().nullable(),
  crossPlant: z.boolean(),
});

export const AuditEntryS = z.strictObject({
  at: z.string(),
  plantId: z.union([PlantIdS, z.literal("company")]),
  kind: z.enum(["proposal", "vote", "veto", "execute", "block", "incident", "rule_learned", "calibration"]),
  refId: z.string(),
  summary: z.string(),
  by: z.string(),
});

export const PlantStateS = z.strictObject({
  id: PlantIdS,
  name: z.string(),
  components: z.array(ComponentIdS),
  proposals: z.array(ProposalS),
  history: z.array(HistoryEventS),
  rules: z.array(LearnedRuleS),
  audit: z.array(AuditEntryS),
  tick: num,
  connected: z.boolean(),
});

export const SharedResourceS = z.strictObject({ id: z.string(), name: z.string(), components: z.array(ComponentIdS) });

export const CompanyStateS = z.strictObject({
  plants: z.array(PlantIdS),
  sharedResources: z.array(SharedResourceS),
  rules: z.array(LearnedRuleS),
  crossPlantProposals: z.array(z.string()),
  audit: z.array(AuditEntryS),
});

// CLAUDE.MD: Component emits ComponentState plus its calibration. Nothing else.
export const EmittedComponentS = ComponentStateS.extend({ calibration: z.array(CalibrationEntryS) }).strict();
export type EmittedComponent = ComponentState & { calibration: CalibrationEntry[] };

// shared/plants.json is a seed, not an emitted state: PlantSeed.components carries full ComponentState objects
// and CompanySeed omits the runtime lists. The loadSeed methods own the conversion.
export const PlantSeedS = z.strictObject({ id: PlantIdS, name: z.string(), components: z.array(ComponentStateS) });
export const CompanySeedS = z.strictObject({ plants: z.array(PlantIdS), sharedResources: z.array(SharedResourceS) });
export const PlantsFileS = z.strictObject({ company: CompanySeedS, plants: z.array(PlantSeedS) });
export type PlantSeed = z.infer<typeof PlantSeedS>;
export type CompanySeed = z.infer<typeof CompanySeedS>;

export type SchemaTypeChecks = [
  Expect<Equal<z.infer<typeof PlantIdS>, PlantId>>,
  Expect<Equal<z.infer<typeof RoleS>, Role>>,
  Expect<Equal<z.infer<typeof VendorS>, Vendor>>,
  Expect<Equal<z.infer<typeof LimitS>, Limit>>,
  Expect<Equal<z.infer<typeof ComponentStateS>, ComponentState>>,
  Expect<Equal<z.infer<typeof HistoryEventS>, HistoryEvent>>,
  Expect<Equal<z.infer<typeof CalibrationEntryS>, CalibrationEntry>>,
  Expect<Equal<z.infer<typeof LearnedRuleS>, LearnedRule>>,
  Expect<Equal<z.infer<typeof VoteS>, Vote>>,
  Expect<Equal<z.infer<typeof ProposalS>, Proposal>>,
  Expect<Equal<z.infer<typeof AuditEntryS>, AuditEntry>>,
  Expect<Equal<z.infer<typeof PlantStateS>, PlantState>>,
  Expect<Equal<z.infer<typeof CompanyStateS>, CompanyState>>,
];

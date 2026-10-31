// agent/schemas.ts against shared/types.ts in both directions. `satisfies z.ZodType<T>` there only proves the schema
// output is assignable to T, so a field removed from types.ts would still compile. Equal fails the build either way.
import type { z } from "zod";
import type {
  auditEntrySchema,
  calibrationEntrySchema,
  companyStateSchema,
  componentStateSchema,
  effectSchema,
  historyEventSchema,
  learnedRuleSchema,
  limitSchema,
  plantIdSchema,
  plantStateSchema,
  proposalInputSchema,
  proposalSchema,
  roleSchema,
  vendorSchema,
  voteSchema,
  wireMessageSchema,
} from "../../../../agent/schemas";
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
import type { ProposalInput } from "../lib/glue-spec";
import type { Equal, Expect, Same } from "../lib/typeassert";

type Effect = HistoryEvent["effects"][number];
type ComponentView = ComponentState & { calibration?: CalibrationEntry[] };

export type AgentSchemaChecks = [
  Expect<Equal<z.infer<typeof plantIdSchema>, PlantId>>,
  Expect<Equal<z.infer<typeof roleSchema>, Role>>,
  Expect<Equal<z.infer<typeof vendorSchema>, Vendor>>,
  Expect<Equal<z.infer<typeof limitSchema>, Limit>>,
  Expect<Equal<z.infer<typeof calibrationEntrySchema>, CalibrationEntry>>,
  Expect<Equal<z.infer<typeof effectSchema>, Effect>>,
  Expect<Equal<z.infer<typeof historyEventSchema>, HistoryEvent>>,
  Expect<Equal<z.infer<typeof learnedRuleSchema>, LearnedRule>>,
  Expect<Equal<z.infer<typeof voteSchema>, Vote>>,
  // proposalSchema reads votes with .loose(), tolerating extras on a read. Same still fails on a missing or changed field.
  Expect<Same<z.infer<typeof proposalSchema>, Proposal>>,
  Expect<Equal<z.infer<typeof auditEntrySchema>, AuditEntry>>,
  Expect<Same<z.infer<typeof plantStateSchema>, PlantState>>,
  Expect<Equal<z.infer<typeof companyStateSchema>, CompanyState>>,
  Expect<Equal<Omit<z.infer<typeof componentStateSchema>, "calibration">, ComponentState>>,
  Expect<Equal<Pick<z.infer<typeof componentStateSchema>, "calibration">, Pick<ComponentView, "calibration">>>,
  // The counter body must be exactly the five fields TASK3 gives POST /propose.
  Expect<Equal<z.infer<typeof proposalInputSchema>, ProposalInput>>,
];

// The five Relay messages, spelled the way CLAUDE.MD spells them.
type Wire = z.infer<typeof wireMessageSchema>;
export type WireChecks = [
  Expect<Same<Extract<Wire, { type: "proposal" }>, { type: "proposal"; proposal: Proposal }>>,
  Expect<Equal<Extract<Wire, { type: "vote" }>, { type: "vote"; vote: Vote }>>,
  Expect<Equal<Extract<Wire, { type: "counter" }>, { type: "counter"; parentProposalId: string; proposal: ProposalInput }>>,
  Expect<Equal<Extract<Wire, { type: "executed" }>, { type: "executed"; proposalId: string; event: HistoryEvent }>>,
  Expect<Equal<Extract<Wire, { type: "rule" }>, { type: "rule"; rule: LearnedRule }>>,
];

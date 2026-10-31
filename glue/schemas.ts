// Zod schemas for every glue route, written against shared/types.ts. agent/tests/live-relay-proof.ts copies this file
// out of glue/, so it imports nothing but zod.
import { z } from "zod";

const finite = z.number().finite();
const metricRecord = z.record(z.string(), finite);
const text = z.string().min(1);

export const plantIdSchema = z.enum(["plant-a", "plant-b"]);
export const componentIdSchema = z.string().regex(/^plant-[a-z0-9]+\/[A-Za-z0-9._-]+$/, "componentId must be <plantId>/<tag>");
export const proposalIdSchema = z.string().regex(/^plant-[a-z0-9]+-p\d+-/, "not a proposal id");

const plantOf = (componentId: string) => componentId.split("/")[0];

export const voteSchema = z.object({
  proposalId: proposalIdSchema,
  componentId: componentIdSchema,
  agentId: text,
  vote: z.enum(["yes", "no"]),
  reason: z.string(),
  predicted: metricRecord,
  marginPct: finite,
  evidenceEventIds: z.array(z.string()),
  evidenceRuleIds: z.array(z.string()),
  similarCount: z.number().int().min(0),
});

export const calibrationEntrySchema = z.object({
  at: text,
  proposalId: text,
  metric: text,
  predicted: finite,
  observed: finite,
  absError: finite,
});

const ruleSide = z.object({
  componentId: componentIdSchema.nullable(),
  metric: text,
  op: z.enum([">=", "<="]),
  value: finite,
});

export const learnedRuleSchema = z.object({
  id: text,
  scope: z.enum(["component", "plant", "company"]),
  model: z.string().nullable(),
  text: text,
  condition: ruleSide,
  consequence: ruleSide.extend({ withinTicks: finite }),
  supportEventIds: z.array(z.string()),
  timesSeen: z.number().int().min(0),
  createdAt: text,
  lastSeenAt: text,
});

export const effectSchema = z.object({
  componentId: componentIdSchema,
  metric: text,
  before: finite,
  after: finite,
  ticksToSettle: finite,
});

/** The five fields a person or agent may set. `from`, the id and the voters are the Plant's to decide. */
export const proposalInputSchema = z
  .object({
    plantId: plantIdSchema,
    proposerComponentId: componentIdSchema,
    metric: text,
    to: finite,
    rationale: text,
  })
  .strict()
  .refine(p => plantOf(p.proposerComponentId) === p.plantId, {
    message: "proposerComponentId belongs to another plant",
    path: ["proposerComponentId"],
  });

export const proposeBodySchema = proposalInputSchema;

export const counterBodySchema = z
  .object({ parentProposalId: proposalIdSchema, proposal: proposalInputSchema })
  .strict()
  .refine(body => body.parentProposalId.startsWith(`${body.proposal.plantId}-p`), {
    message: "a counter stays in the plant of its parent",
    path: ["proposal", "plantId"],
  });

export const voteBodySchema = z.object({ vote: voteSchema }).strict();
export const vetoBodySchema = z.object({ proposalId: proposalIdSchema, by: text }).strict();
export const calibrationBodySchema = z.object({ componentId: componentIdSchema, entry: calibrationEntrySchema }).strict();
export const ruleBodySchema = z
  .object({ rule: learnedRuleSchema })
  .strict()
  .refine(({ rule }) => (rule.condition.componentId ?? rule.consequence.componentId) !== null, {
    message: "a rule needs a componentId in its condition or consequence, or glue cannot tell which plant owns it",
    path: ["rule", "condition", "componentId"],
  });

export const tickBodySchema = z.object({}).strict();
export const resetBodySchema = z.object({}).strict();
export const executeCallbackBodySchema = z.object({ proposalId: proposalIdSchema }).strict();

/** The bridge owns these two payloads and may add keys, so extras are dropped rather than refused. */
export const mirrorBodySchema = z.object({ componentId: componentIdSchema, metrics: metricRecord });
export const observedBodySchema = z.object({
  proposalId: proposalIdSchema,
  effects: z.array(effectSchema),
  upstreamSnapshot: metricRecord.optional(),
  incident: z.string().nullable().optional(),
  operator: z.string().nullable().optional(),
});

/** Query strings arrive as text, so numbers and the JSON snapshot are parsed here. */
const numberFromQuery = z
  .string()
  .min(1)
  .transform(Number)
  .pipe(z.number().finite());

const jsonRecordFromQuery = z.string().transform((value, ctx) => {
  try {
    return metricRecord.parse(JSON.parse(value));
  } catch {
    ctx.addIssue({ code: "custom", message: "upstreamSnapshot must be a JSON object of finite numbers" });
    return z.NEVER;
  }
});

export const similarQuerySchema = z.object({
  componentId: componentIdSchema,
  metric: text,
  to: numberFromQuery,
  k: numberFromQuery.pipe(z.number().int().min(1).max(100)).default(5),
  upstreamSnapshot: jsonRecordFromQuery.optional(),
});

export const rulesQuerySchema = z.object({
  componentId: componentIdSchema,
  model: text,
});

export const stateQuerySchema = z.object({
  plantId: plantIdSchema,
  full: z.string().optional(),
});

/** One message from Relay: JSON text {type, payload}. Whatever the type, the payload is checked by its route's schema. */
export const relayEnvelopeSchema = z.object({ type: z.string().min(1), payload: z.unknown() });

export type VoteBody = z.infer<typeof voteBodySchema>;
export type CounterBody = z.infer<typeof counterBodySchema>;
export type ProposeBody = z.infer<typeof proposeBodySchema>;
export type ObservedBody = z.infer<typeof observedBodySchema>;
export type MirrorBody = z.infer<typeof mirrorBodySchema>;

// Zod schemas for every route body and every reply glue acts on. `satisfies` ties them to the frozen shared/types.ts,
// so a change there fails to compile here. Strict: a body with an unknown key is refused, not trimmed.
import { z } from "zod";
import type { CalibrationEntry, ComponentState, HistoryEvent, LearnedRule, Limit, Vote } from "../shared/types";

const finite = z.number().finite();
const id = z.string().min(1);

export const plantIdSchema = z.enum(["plant-a", "plant-b"]);
export const componentIdSchema = z.string().regex(/^plant-[ab]\/[A-Z]+-\d+$/, "ComponentId must be <plantId>/<tag>");
export const metricsSchema = z.record(z.string(), finite);

export const effectSchema = z.strictObject({
  componentId: componentIdSchema,
  metric: id,
  before: finite,
  after: finite,
  ticksToSettle: finite.nonnegative(),
});

export const calibrationEntrySchema = z.strictObject({
  at: id,
  proposalId: id,
  metric: id,
  predicted: finite,
  observed: finite,
  absError: finite.nonnegative(),
}) satisfies z.ZodType<CalibrationEntry>;

const ruleOp = z.enum([">=", "<="]);
const ruleClause = z.strictObject({ componentId: componentIdSchema.nullable(), metric: id, op: ruleOp, value: finite });

export const learnedRuleSchema = z.strictObject({
  id,
  scope: z.enum(["component", "plant", "company"]),
  model: z.string().nullable(),
  text: id,
  condition: ruleClause,
  consequence: ruleClause.extend({ withinTicks: finite.nonnegative() }),
  supportEventIds: z.array(id),
  timesSeen: finite,
  createdAt: id,
  lastSeenAt: id,
}) satisfies z.ZodType<LearnedRule>;

export const voteSchema = z.strictObject({
  proposalId: id,
  componentId: componentIdSchema,
  agentId: id,
  vote: z.enum(["yes", "no"]),
  reason: id,
  predicted: metricsSchema,
  marginPct: finite,
  evidenceEventIds: z.array(id),
  evidenceRuleIds: z.array(id),
  similarCount: z.number().int().nonnegative(),
}) satisfies z.ZodType<Vote>;

export const proposalInputSchema = z
  .strictObject({ plantId: plantIdSchema, proposerComponentId: componentIdSchema, metric: id, to: finite, rationale: id })
  .refine((p) => p.proposerComponentId.startsWith(`${p.plantId}/`), "proposer must belong to the plant");
export type ProposalInput = z.infer<typeof proposalInputSchema>;

const limitSchema = z.strictObject({ min: finite, max: finite, critical: finite }) satisfies z.ZodType<Limit>;

export const componentStateSchema = z.strictObject({
  id: componentIdSchema,
  plantId: plantIdSchema,
  tag: id,
  name: id,
  model: id,
  role: z.enum(["mechanic", "process_engineer", "chemical_engineer", "safety"]),
  vendor: z.enum(["claude", "codex", "gemini"]),
  metrics: metricsSchema,
  limits: z.record(z.string(), limitSchema),
  upstream: z.array(componentIdSchema),
  downstream: z.array(componentIdSchema),
  sharedResources: z.array(z.string()),
  status: z.enum(["ok", "warning", "critical", "offline"]),
  marginPct: finite,
  lastTick: z.string(),
}) satisfies z.ZodType<ComponentState>;

export const historyEventSchema = z.strictObject({
  id,
  at: id,
  plantId: plantIdSchema,
  componentId: componentIdSchema,
  metric: id,
  before: finite,
  after: finite,
  upstreamSnapshot: metricsSchema,
  effects: z.array(effectSchema),
  incident: z.string().nullable(),
  approvedBy: z.array(z.string()),
  operator: z.string().nullable(),
  proposalId: z.string().nullable(),
}) satisfies z.ZodType<HistoryEvent>;

export const plantsFileSchema = z.strictObject({
  company: z.strictObject({
    plants: z.array(plantIdSchema),
    sharedResources: z.array(z.strictObject({ id, name: id, components: z.array(componentIdSchema) })),
  }),
  plants: z.array(z.strictObject({ id: plantIdSchema, name: id, components: z.array(componentStateSchema) })),
});
export type PlantsFile = z.infer<typeof plantsFileSchema>;

/** POST bodies, one per route. Telemetry from the simulator may carry extra keys; only these two are forwarded. */
export const routeSchemas = {
  "/mirror": z.object({ componentId: componentIdSchema, metrics: metricsSchema }),
  "/tick": z.strictObject({}),
  "/propose": proposalInputSchema,
  "/vote": z.strictObject({ vote: voteSchema }),
  "/counter": z.strictObject({ parentProposalId: id, proposal: proposalInputSchema }),
  "/veto": z.strictObject({ proposalId: id, by: id }),
  "/execute-callback": z.strictObject({ proposalId: id }),
  "/observed": z.strictObject({ proposalId: id, effects: z.array(effectSchema) }),
  "/calibration": z.strictObject({ componentId: componentIdSchema, entry: calibrationEntrySchema }),
  "/rule": z.strictObject({ rule: learnedRuleSchema }),
  "/reset": z.strictObject({}),
} as const;
export type Route = keyof typeof routeSchemas;
export type RouteBody<R extends Route> = z.infer<(typeof routeSchemas)[R]>;

const jsonRecord = z.string().transform((text, ctx) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    ctx.addIssue({ code: "custom", message: "upstreamSnapshot must be JSON" });
    return z.NEVER;
  }
});

/** agent/glue.ts sends numbers as text and upstreamSnapshot as a JSON string; Plant.similar rejects anything but real values. */
export const similarQuerySchema = z.object({
  componentId: componentIdSchema,
  metric: id,
  to: z.coerce.number().finite(),
  k: z.coerce.number().int().min(1).max(100).default(5),
  upstreamSnapshot: jsonRecord.pipe(metricsSchema).optional(),
});

export const rulesQuerySchema = z.object({ componentId: componentIdSchema, model: id.optional() });

/** Plant.claimDispatch. Parsing it is what makes a missing token a refusal rather than a write. */
export const dispatchClaimSchema = z.discriminatedUnion("dispatch", [
  z.object({ dispatch: z.literal(true), proposalId: id, componentId: componentIdSchema, metric: id, value: finite, token: id }),
  z.object({ dispatch: z.literal(false), proposalId: id, state: z.string() }),
]);
export type DispatchClaim = z.infer<typeof dispatchClaimSchema>;

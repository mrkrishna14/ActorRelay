// Runtime validation of every external input. The actor runtime does not check argument shapes,
// so each public method parses its arguments here first. Mirrors src/types.ts (= shared/types.ts).
import { z } from "zod"

const num = z.number().refine(Number.isFinite, "must be a finite number")
const id = z.string().min(1).max(256)
const componentId = z.string().regex(/^plant-[ab]\/[A-Z0-9-]+$/, "must look like plant-a/LV-101")
const plantId = z.enum(["plant-a", "plant-b"])
const metrics = z.record(z.string(), num)
const limit = z.object({ min: num, max: num, critical: num })

export const VoteSchema = z.object({
    proposalId: id, componentId, agentId: id, vote: z.enum(["yes", "no"]),
    reason: z.string().max(4000), predicted: metrics, marginPct: num,
    evidenceEventIds: z.array(id).max(50), evidenceRuleIds: z.array(id).max(50),
    similarCount: z.number().int().min(0),
})

export const ProposalInputSchema = z.object({
    id: id.optional(), proposerComponentId: componentId, proposerAgentId: id.optional(),
    metric: id, from: num.optional(), to: num, rationale: z.string().max(4000),
    parentProposalId: id.nullable().optional(),
})

const effect = z.object({ componentId, metric: id, before: num, after: num, ticksToSettle: z.number().int().min(0) })
export const HistoryEventSchema = z.object({
    id, at: z.string(), plantId, componentId, metric: id, before: num, after: num,
    upstreamSnapshot: metrics, effects: z.array(effect), incident: z.string().nullable(),
    approvedBy: z.array(z.string()), operator: z.string().nullable(), proposalId: z.string().nullable(),
})

export const CalibrationEntrySchema = z.object({
    at: z.string(), proposalId: id, metric: id, predicted: num, observed: num, absError: num,
})

const clause = z.object({ componentId: componentId.nullable(), metric: id, op: z.enum([">=", "<="]), value: num })
export const LearnedRuleSchema = z.object({
    id, scope: z.enum(["component", "plant", "company"]), model: z.string().nullable(), text: z.string().max(1000),
    condition: clause, consequence: clause.extend({ withinTicks: z.number().int().min(0) }),
    supportEventIds: z.array(id), timesSeen: z.number().int().min(0), createdAt: z.string(), lastSeenAt: z.string(),
})

export const ComponentStateSchema = z.object({
    id: componentId, plantId, tag: id, name: z.string(), model: id,
    role: z.enum(["mechanic", "process_engineer", "chemical_engineer", "safety"]),
    vendor: z.enum(["claude", "codex", "gemini"]),
    metrics, limits: z.record(z.string(), limit),
    upstream: z.array(componentId), downstream: z.array(componentId), sharedResources: z.array(id),
    status: z.enum(["ok", "warning", "critical", "offline"]), marginPct: num, lastTick: z.string(),
})

export const MetricsSchema = metrics
export const DispatchResultSchema = z.object({ ok: z.boolean(), applied: num.optional(), error: z.string().max(1000).optional() })

/** Parses or throws one readable error naming the bad fields. */
export function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const result = schema.safeParse(value)
    if (result.success) return result.data
    const issues = result.error.issues.slice(0, 5).map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
    throw new Error(`invalid ${what}: ${issues}`)
}

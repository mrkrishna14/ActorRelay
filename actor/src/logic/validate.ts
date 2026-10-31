import type { AuditEntry, CalibrationEntry, ComponentState, HistoryEvent, LearnedRule, Vote } from "../../../shared/types.js"

// Thrown errors start with a stable code; glue/actors.ts maps it to an HTTP status.
export function fail(code: string, detail: string): never {
    throw new Error(`${code}: ${detail}`)
}

export function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value)
}

export function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isFiniteRecord(value: unknown): value is Record<string, number> {
    return isRecord(value) && Object.values(value).every(isFiniteNumber)
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === "string")
}

const ROLES = new Set(["mechanic", "process_engineer", "chemical_engineer", "safety"])
const VENDORS = new Set(["claude", "codex", "gemini"])
const STATUSES = new Set(["ok", "warning", "critical", "offline"])
const OPS = new Set([">=", "<="])
const AUDIT_KINDS = new Set(["proposal", "vote", "veto", "execute", "block", "incident", "rule_learned", "calibration"])

export function assertComponentState(state: unknown): asserts state is ComponentState {
    if (!isRecord(state)) fail("invalid_seed", "component state must be an object")
    for (const key of ["id", "plantId", "tag", "name", "model"]) {
        if (!isNonEmptyString(state[key])) fail("invalid_seed", `component ${key} is required`)
    }
    if (!ROLES.has(state.role as string)) fail("invalid_seed", `unknown role ${String(state.role)}`)
    if (!VENDORS.has(state.vendor as string)) fail("invalid_seed", `unknown vendor ${String(state.vendor)}`)
    if (!STATUSES.has(state.status as string)) fail("invalid_seed", `unknown status ${String(state.status)}`)
    if (!isFiniteRecord(state.metrics)) fail("invalid_seed", "metrics must be finite numbers")
    if (!isRecord(state.limits)) fail("invalid_seed", "limits must be an object")
    for (const [metric, limit] of Object.entries(state.limits)) {
        if (!isRecord(limit) || ![limit.min, limit.max, limit.critical].every(isFiniteNumber)) {
            fail("invalid_seed", `limit ${metric} must have finite min, max and critical`)
        }
    }
    for (const key of ["upstream", "downstream", "sharedResources"]) {
        if (!isStringArray(state[key])) fail("invalid_seed", `${key} must be a string array`)
    }
    if (!isFiniteNumber(state.marginPct)) fail("invalid_seed", "marginPct must be finite")
}

export function assertHistoryEvent(event: unknown): asserts event is HistoryEvent {
    if (!isRecord(event)) fail("invalid_event", "event must be an object")
    for (const key of ["id", "at", "plantId", "componentId", "metric"]) {
        if (!isNonEmptyString(event[key])) fail("invalid_event", `${key} is required`)
    }
    if (!isFiniteNumber(event.before) || !isFiniteNumber(event.after)) fail("invalid_event", "before and after must be finite")
    if (!isFiniteRecord(event.upstreamSnapshot)) fail("invalid_event", "upstreamSnapshot must be finite numbers")
    assertEffects(event.effects)
    if (event.incident !== null && typeof event.incident !== "string") fail("invalid_event", "incident must be a string or null")
    if (!isStringArray(event.approvedBy)) fail("invalid_event", "approvedBy must be a string array")
    if (event.operator !== null && typeof event.operator !== "string") fail("invalid_event", "operator must be a string or null")
    if (event.proposalId !== null && typeof event.proposalId !== "string") fail("invalid_event", "proposalId must be a string or null")
}

export function assertEffects(effects: unknown): asserts effects is HistoryEvent["effects"] {
    if (!Array.isArray(effects)) fail("invalid_event", "effects must be an array")
    for (const effect of effects) {
        if (
            !isRecord(effect) ||
            !isNonEmptyString(effect.componentId) ||
            !isNonEmptyString(effect.metric) ||
            !isFiniteNumber(effect.before) ||
            !isFiniteNumber(effect.after) ||
            !isFiniteNumber(effect.ticksToSettle) ||
            effect.ticksToSettle < 0
        ) {
            fail("invalid_event", "every effect needs componentId, metric, and finite before, after, ticksToSettle")
        }
    }
}

// Rebuilds the vote from known fields, so extra keys in agent output never reach state.
export function normalizeVote(input: unknown): Vote {
    if (!isRecord(input)) fail("invalid_vote", "vote must be an object")
    const { proposalId, componentId, agentId, vote, reason, predicted, marginPct, evidenceEventIds, evidenceRuleIds, similarCount } = input
    if (!isNonEmptyString(proposalId)) fail("invalid_vote", "proposalId is required")
    if (!isNonEmptyString(componentId)) fail("invalid_vote", "componentId is required")
    if (!isNonEmptyString(agentId)) fail("invalid_vote", "agentId is required")
    if (vote !== "yes" && vote !== "no") fail("invalid_vote", "vote must be exactly yes or no")
    if (!isNonEmptyString(reason)) fail("invalid_vote", "reason is required")
    if (!isFiniteRecord(predicted)) fail("invalid_vote", "predicted values must be finite numbers")
    if (!isFiniteNumber(marginPct) || marginPct < 5 || marginPct > 25) fail("invalid_vote", "marginPct must be within 5..25")
    if (!isStringArray(evidenceEventIds)) fail("invalid_vote", "evidenceEventIds must be a string array")
    if (!isStringArray(evidenceRuleIds)) fail("invalid_vote", "evidenceRuleIds must be a string array")
    if (!isFiniteNumber(similarCount) || !Number.isInteger(similarCount) || similarCount < 0) {
        fail("invalid_vote", "similarCount must be a non-negative integer")
    }
    return {
        proposalId,
        componentId,
        agentId,
        vote,
        reason,
        predicted: { ...predicted },
        marginPct,
        evidenceEventIds: [...evidenceEventIds],
        evidenceRuleIds: [...evidenceRuleIds],
        similarCount
    }
}

export function normalizeCalibration(input: unknown): CalibrationEntry {
    if (!isRecord(input)) fail("invalid_calibration", "entry must be an object")
    const { at, proposalId, metric, predicted, observed } = input
    if (!isNonEmptyString(proposalId)) fail("invalid_calibration", "proposalId is required")
    if (!isNonEmptyString(metric)) fail("invalid_calibration", "metric is required")
    if (!isFiniteNumber(predicted) || !isFiniteNumber(observed)) fail("invalid_calibration", "predicted and observed must be finite")
    // absError is recomputed so a forged value cannot walk the margin down.
    return {
        at: isNonEmptyString(at) ? at : new Date().toISOString(),
        proposalId,
        metric,
        predicted,
        observed,
        absError: Math.abs(predicted - observed)
    }
}

export function assertRuleShape(rule: unknown): asserts rule is LearnedRule {
    if (!isRecord(rule)) fail("invalid_rule", "rule must be an object")
    if (!isNonEmptyString(rule.id)) fail("invalid_rule", "id is required")
    if (rule.scope !== "component" && rule.scope !== "plant" && rule.scope !== "company") fail("invalid_rule", "unknown scope")
    if (rule.model !== null && typeof rule.model !== "string") fail("invalid_rule", "model must be a string or null")
    if (!isNonEmptyString(rule.text)) fail("invalid_rule", "text is required")
    const { condition, consequence } = rule
    if (!isRecord(condition) || !isNonEmptyString(condition.metric) || !OPS.has(condition.op as string) || !isFiniteNumber(condition.value)) {
        fail("invalid_rule", "condition needs metric, op and a finite value")
    }
    if (condition.componentId !== null && typeof condition.componentId !== "string") fail("invalid_rule", "condition.componentId must be a string or null")
    if (!isRecord(consequence) || !isNonEmptyString(consequence.metric) || !OPS.has(consequence.op as string) || !isFiniteNumber(consequence.value)) {
        fail("invalid_rule", "consequence needs metric, op and a finite value")
    }
    if (consequence.componentId !== null && typeof consequence.componentId !== "string") fail("invalid_rule", "consequence.componentId must be a string or null")
    if (!isFiniteNumber(consequence.withinTicks) || consequence.withinTicks < 0) fail("invalid_rule", "consequence.withinTicks must be finite")
    if (!isStringArray(rule.supportEventIds) || rule.supportEventIds.length < 3) fail("invalid_rule", "a rule needs at least 3 supporting events")
    if (new Set(rule.supportEventIds).size !== rule.supportEventIds.length) fail("invalid_rule", "supporting events must be distinct")
    if (!isFiniteNumber(rule.timesSeen) || rule.timesSeen < 3) fail("invalid_rule", "timesSeen must be at least 3")
    if (!isNonEmptyString(rule.createdAt) || !isNonEmptyString(rule.lastSeenAt)) fail("invalid_rule", "createdAt and lastSeenAt are required")
}

export function assertAuditEntry(entry: unknown): asserts entry is AuditEntry {
    if (!isRecord(entry)) fail("invalid_audit", "entry must be an object")
    if (!AUDIT_KINDS.has(entry.kind as string)) fail("invalid_audit", `unknown kind ${String(entry.kind)}`)
    for (const key of ["at", "plantId", "refId", "summary", "by"]) {
        if (!isNonEmptyString(entry[key])) fail("invalid_audit", `${key} is required`)
    }
}

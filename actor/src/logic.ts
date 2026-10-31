// Pure decision logic shared by the actors. No I/O, no clock reads unless a time is passed in.
import { createHmac, timingSafeEqual } from "node:crypto"
import type {
    CalibrationEntry,
    ComponentId,
    ComponentState,
    HistoryEvent,
    LearnedRule,
    Limit,
    PlantId,
    Proposal,
} from "./types.js"

/** Static facts about a component that the Plant needs for routing and rules. */
export type ComponentInfo = Pick<
    ComponentState,
    "id" | "plantId" | "tag" | "model" | "limits" | "upstream" | "downstream" | "sharedResources"
>

// ---------------------------------------------------------------- ids

/** Actor ids allow only letters, digits, ".", "_" and "-": "plant-a/LV-101" -> "plant-a.LV-101". */
export function actorIdFor(componentId: ComponentId): string {
    return componentId.replace("/", ".")
}

/** "plant-a.LV-101" -> "plant-a/LV-101". */
export function componentIdFor(actorId: string): ComponentId {
    const dot = actorId.indexOf(".")
    return dot < 0 ? actorId : `${actorId.slice(0, dot)}/${actorId.slice(dot + 1)}`
}

export function plantOf(componentId: ComponentId): PlantId {
    return componentId.split("/")[0] as PlantId
}

export function tagOf(componentId: ComponentId | null): string {
    return componentId ? (componentId.split("/")[1] ?? componentId) : "*"
}

// ---------------------------------------------------------------- status and limits

/** warning at limit.max, critical at limit.critical (high side, per CLAUDE.MD). */
export function statusFor(metrics: Record<string, number>, limits: Record<string, Limit>): ComponentState["status"] {
    let status: ComponentState["status"] = "ok"
    for (const [metric, limit] of Object.entries(limits)) {
        const value = metrics[metric]
        if (typeof value !== "number" || !Number.isFinite(value)) continue
        if (value >= limit.critical) return "critical"
        if (value >= limit.max) status = "warning"
    }
    return status
}

/** critical − marginPct%: the value a prediction must stay below for a "yes". */
export function safeThreshold(limit: Limit, marginPct: number): number {
    return limit.critical * (1 - marginPct / 100)
}

export function rangeOf(limit: Limit | undefined): number {
    if (!limit) return 100
    const span = limit.max - limit.min
    return span > 0 ? span : Math.max(Math.abs(limit.critical), 1)
}

// ---------------------------------------------------------------- voters

/** Every other component reachable from `start` through upstream/downstream links, in BFS order. */
export function reachableVoters(info: Record<ComponentId, ComponentInfo>, start: ComponentId): ComponentId[] {
    const seen = new Set<ComponentId>([start])
    const order: ComponentId[] = []
    const queue: ComponentId[] = [start]
    while (queue.length > 0) {
        const current = info[queue.shift()!]
        if (!current) continue
        for (const next of [...current.downstream, ...current.upstream]) {
            if (seen.has(next) || !info[next]) continue
            seen.add(next)
            order.push(next)
            queue.push(next)
        }
    }
    return order
}

/** Components in other plants that share a resource with the proposer or any local voter. */
export function crossPlantVoters(
    sharedResources: { id: string; components: ComponentId[] }[],
    proposal: Pick<Proposal, "plantId" | "proposerComponentId" | "requiredVoters">,
): ComponentId[] {
    const local = new Set([proposal.proposerComponentId, ...proposal.requiredVoters])
    const out: ComponentId[] = []
    for (const resource of sharedResources) {
        if (!resource.components.some(id => local.has(id))) continue
        for (const id of resource.components) {
            if (plantOf(id) !== proposal.plantId && !out.includes(id)) out.push(id)
        }
    }
    return out
}

// ---------------------------------------------------------------- retrieval

/**
 * Nearest past changes of (componentId, metric): |after − to| / range
 * + 0.5 × mean normalized distance over upstreamSnapshot keys present in both.
 * Ties go to the most recent event.
 */
export function similarEvents(
    history: HistoryEvent[],
    componentId: ComponentId,
    metric: string,
    to: number,
    upstreamSnapshot: Record<string, number>,
    k: number,
    range: number,
): HistoryEvent[] {
    const scored = history
        .filter(e => e.componentId === componentId && e.metric === metric)
        .map(e => {
            const keys = Object.keys(upstreamSnapshot).filter(key => typeof e.upstreamSnapshot?.[key] === "number")
            const upstream =
                keys.length === 0
                    ? 0
                    : keys.reduce((sum, key) => {
                          const a = upstreamSnapshot[key]!
                          const b = e.upstreamSnapshot[key]!
                          return sum + Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1)
                      }, 0) / keys.length
            return { e, score: Math.abs(e.after - to) / range + 0.5 * upstream }
        })
    scored.sort((x, y) => x.score - y.score || y.e.at.localeCompare(x.e.at))
    return scored.slice(0, Math.max(0, Math.floor(k))).map(s => s.e)
}

// ---------------------------------------------------------------- calibration

/**
 * Margin after appending calibration entries. Evaluated once 5 entries exist:
 * mean normalized |error| of the last 5 > 10 % of range → +5 (max 25); < 3 % → −2 (min 5).
 */
export function nextMargin(entries: CalibrationEntry[], limits: Record<string, Limit>, marginPct: number): number {
    if (entries.length < 5) return marginPct
    const last = entries.slice(-5)
    const mean = last.reduce((sum, e) => sum + Math.abs(e.predicted - e.observed) / rangeOf(limits[e.metric]), 0) / last.length
    if (mean > 0.1) return Math.min(25, marginPct + 5)
    if (mean < 0.03) return Math.max(5, marginPct - 2)
    return marginPct
}

// ---------------------------------------------------------------- rules

export function ruleKey(r: Pick<LearnedRule, "condition" | "consequence">, withPlant = true): string {
    const id = (c: ComponentId | null) => (withPlant ? (c ?? "*") : tagOf(c))
    return `${id(r.condition.componentId)}:${r.condition.metric}${r.condition.op}${r.condition.value}->${id(r.consequence.componentId)}:${r.consequence.metric}${r.consequence.op}`
}

/**
 * Rules supported by `event` once it is in `history`: events of the same (componentId, metric) with
 * `after` ≥ the event's 10-point bucket, whose effect on one downstream component crosses that
 * component's `limit.max`. Three or more such events make a plant-scope rule.
 */
export function rulesFromEvent(
    history: HistoryEvent[],
    event: HistoryEvent,
    info: Record<ComponentId, ComponentInfo>,
    now: string,
    existing: LearnedRule[],
): LearnedRule[] {
    const threshold = Math.floor(event.after / 10) * 10
    const candidates = history.filter(h => h.componentId === event.componentId && h.metric === event.metric && h.after >= threshold)
    const out: LearnedRule[] = []
    for (const effect of event.effects ?? []) {
        const target = info[effect.componentId]
        const limit = target?.limits[effect.metric]
        if (!target || !limit || effect.after < limit.max) continue
        const supports = candidates
            .map(h => ({ h, f: h.effects.find(f => f.componentId === effect.componentId && f.metric === effect.metric && f.after >= limit.max) }))
            .filter((s): s is { h: HistoryEvent; f: HistoryEvent["effects"][number] } => s.f !== undefined)
        if (supports.length < 3) continue
        const value = Math.floor(Math.min(...supports.map(s => s.f.after)))
        const withinTicks = Math.max(1, ...supports.map(s => s.f.ticksToSettle))
        const draft = {
            condition: { componentId: event.componentId, metric: event.metric, op: ">=" as const, value: threshold },
            consequence: { componentId: effect.componentId, metric: effect.metric, op: ">=" as const, value, withinTicks },
        }
        const key = ruleKey(draft)
        const prior = existing.find(r => ruleKey(r) === key)
        out.push({
            id: prior?.id ?? `rule:${key}`,
            scope: "plant",
            model: target.model,
            text: `${tagOf(event.componentId)} ${event.metric} ≥ ${threshold} → ${tagOf(effect.componentId)} ${effect.metric} ≥ ${value} within ${withinTicks} ticks, seen ${supports.length} times`,
            ...draft,
            supportEventIds: supports.map(s => s.h.id),
            timesSeen: supports.length,
            createdAt: prior?.createdAt ?? now,
            lastSeenAt: now,
        })
    }
    return out
}

// ---------------------------------------------------------------- one-time execute token

export const env = (name: string): string | undefined => (typeof process !== "undefined" ? process.env?.[name] : undefined) || undefined
const secret = () => env("ACTORRELAY_EXECUTE_SECRET") ?? "actorrelay-demo-execute-secret"

/** Minted only by Plant.confirmDispatch after the veto window passed; verified by Component.setMetric. */
export function executeToken(proposalId: string, componentId: ComponentId, metric: string, value: number): string {
    return createHmac("sha256", secret()).update(`${proposalId}|${componentId}|${metric}|${value}`).digest("hex")
}

export function verifyExecuteToken(token: string, proposalId: string, componentId: ComponentId, metric: string, value: number): boolean {
    const expected = Buffer.from(executeToken(proposalId, componentId, metric, value), "hex")
    const given = Buffer.from(token, "hex")
    return given.length === expected.length && timingSafeEqual(given, expected)
}

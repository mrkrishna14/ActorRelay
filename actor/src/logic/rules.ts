import type { ComponentId, ComponentState, HistoryEvent, LearnedRule } from "../../../shared/types"

export type ComponentDef = Pick<ComponentState, "id" | "tag" | "model" | "limits" | "upstream" | "downstream" | "sharedResources">
export type Topology = Record<ComponentId, ComponentDef>

export const MIN_SIGHTINGS = 3
const CONDITION_STEP = 5
const CONSEQUENCE_STEP = 5

type Op = ">=" | "<="

function floorTo(value: number, step: number): number {
    return Math.floor(value / step) * step
}

function ceilTo(value: number, step: number): number {
    return Math.ceil(value / step) * step
}

function ruleKey(rule: Pick<LearnedRule, "condition" | "consequence">): string {
    const { condition: a, consequence: b } = rule
    return [a.componentId, a.metric, a.op, b.componentId, b.metric, b.op].join("|")
}

function companyRuleKey(rule: LearnedRule): string {
    const { condition: a, consequence: b } = rule
    return [rule.model, a.metric, a.op, b.metric, b.op].join("|")
}

function ruleId(condition: LearnedRule["condition"], consequence: LearnedRule["consequence"]): string {
    return `rule:${condition.componentId}:${condition.metric}:${consequence.componentId}:${consequence.metric}:${consequence.op === ">=" ? "high" : "low"}`
}

function tagOf(componentId: ComponentId | null): string {
    return componentId === null ? "any" : (componentId.split("/")[1] ?? componentId)
}

function describe(rule: Pick<LearnedRule, "condition" | "consequence" | "timesSeen">): string {
    const { condition: a, consequence: b } = rule
    const symbol = (op: Op) => (op === ">=" ? "≥" : "≤")
    return `${tagOf(a.componentId)} ${a.metric} ${symbol(a.op)} ${a.value} → ${tagOf(b.componentId)} ${b.metric} ${symbol(b.op)} ${b.value} within ${b.withinTicks} ticks, seen ${rule.timesSeen} times`
}

type Sighting = { event: HistoryEvent; after: number; ticks: number; crossed: boolean }

// The threshold is the lowest step at which every recorded run at or past it crossed the limit,
// so a safe run above the threshold moves the threshold up instead of leaving a false rule.
function supportFor(sightings: Sighting[]): { threshold: number; support: Sighting[] } | null {
    const crossed = sightings.filter(sighting => sighting.crossed)
    if (crossed.length < MIN_SIGHTINGS) return null
    const start = floorTo(Math.min(...crossed.map(sighting => sighting.event.after)), CONDITION_STEP)
    const stop = Math.max(...crossed.map(sighting => sighting.event.after))
    for (let threshold = start; threshold <= stop; threshold += CONDITION_STEP) {
        const atOrPast = sightings.filter(sighting => sighting.event.after >= threshold)
        if (atOrPast.length >= MIN_SIGHTINGS && atOrPast.every(sighting => sighting.crossed)) return { threshold, support: atOrPast }
    }
    return null
}

function buildRule(input: {
    componentId: ComponentId
    metric: string
    effectComponentId: ComponentId
    effectMetric: string
    op: Op
    threshold: number
    support: Sighting[]
    model: string | null
    now: string
}): LearnedRule {
    const { support, op } = input
    const afters = support.map(sighting => sighting.after)
    const value = op === ">=" ? floorTo(Math.min(...afters), CONSEQUENCE_STEP) : ceilTo(Math.max(...afters), CONSEQUENCE_STEP)
    const condition = { componentId: input.componentId, metric: input.metric, op: ">=" as const, value: input.threshold }
    const consequence = { componentId: input.effectComponentId, metric: input.effectMetric, op, value, withinTicks: Math.max(...support.map(sighting => sighting.ticks)) }
    const newest = [...support].sort((a, b) => b.event.at.localeCompare(a.event.at))
    const timesSeen = support.length
    return {
        id: ruleId(condition, consequence),
        scope: "plant",
        model: input.model,
        text: describe({ condition, consequence, timesSeen }),
        condition,
        consequence,
        supportEventIds: newest.map(sighting => sighting.event.id),
        timesSeen,
        createdAt: input.now,
        lastSeenAt: newest[0].event.at
    }
}

export function deriveRules(history: HistoryEvent[], topology: Topology, now: string): LearnedRule[] {
    const groups = new Map<string, HistoryEvent[]>()
    for (const event of history) {
        const key = `${event.componentId}|${event.metric}`
        groups.set(key, [...(groups.get(key) ?? []), event])
    }

    const rules: LearnedRule[] = []
    for (const events of groups.values()) {
        const { componentId, metric } = events[0]
        const targets = new Set(events.flatMap(event => event.effects.map(effect => `${effect.componentId}|${effect.metric}`)))
        for (const target of targets) {
            const [effectComponentId, effectMetric] = target.split("|")
            const def = topology[effectComponentId]
            if (def === undefined || !Object.hasOwn(def.limits, effectMetric)) continue
            const limit = def.limits[effectMetric]
            for (const op of [">=", "<="] as const) {
                const crossedBy = (after: number) => (op === ">=" ? after >= limit.max : after <= limit.min)
                const sightings = events.flatMap(event => {
                    const rows = event.effects.filter(effect => effect.componentId === effectComponentId && effect.metric === effectMetric)
                    if (rows.length === 0) return []
                    const worst = op === ">=" ? Math.max(...rows.map(row => row.after)) : Math.min(...rows.map(row => row.after))
                    const row = rows.find(item => item.after === worst)!
                    return [{ event, after: worst, ticks: row.ticksToSettle, crossed: crossedBy(worst) }]
                })
                const found = supportFor(sightings)
                if (found !== null) rules.push(buildRule({ componentId, metric, effectComponentId, effectMetric, op, threshold: found.threshold, support: found.support, model: def.model, now }))
            }
        }
    }
    return rules
}

// Existing rules keep their identity and createdAt, so a fourth sighting updates the rule instead of adding one.
export function mergeDerivedRules(existing: LearnedRule[], derived: LearnedRule[]): { rules: LearnedRule[]; changed: LearnedRule[] } {
    const rules = [...existing]
    const changed: LearnedRule[] = []
    for (const next of derived) {
        const index = rules.findIndex(rule => ruleKey(rule) === ruleKey(next))
        if (index === -1) {
            rules.push(next)
            changed.push(next)
            continue
        }
        const current = rules[index]
        const same = current.timesSeen === next.timesSeen && current.condition.value === next.condition.value && current.consequence.value === next.consequence.value
        if (same) continue
        const merged = { ...next, id: current.id, createdAt: current.createdAt, scope: current.scope }
        rules[index] = merged
        changed.push(merged)
    }
    return { rules, changed }
}

export function mergeSubmittedRule(existing: LearnedRule[], submitted: LearnedRule, now: string): { rules: LearnedRule[]; rule: LearnedRule } {
    const index = existing.findIndex(rule => ruleKey(rule) === ruleKey(submitted))
    if (index === -1) return { rules: [...existing, submitted], rule: submitted }
    const current = existing[index]
    const supportEventIds = [...new Set([...current.supportEventIds, ...submitted.supportEventIds])]
    const timesSeen = Math.max(current.timesSeen, supportEventIds.length)
    const rule = { ...current, supportEventIds, timesSeen, lastSeenAt: now }
    const merged = { ...rule, text: describe(rule) }
    return { rules: existing.map((item, position) => (position === index ? merged : item)), rule: merged }
}

// Company rules drop component ids so the same equipment model matches in any plant.
export function toCompanyRule(rule: LearnedRule, plantId: string): LearnedRule {
    const key = [rule.model, rule.condition.metric, rule.consequence.metric, rule.consequence.op === ">=" ? "high" : "low"].join(":")
    return {
        ...rule,
        id: `company-rule:${key}`,
        scope: "company",
        text: `${rule.text} (first learned in ${plantId})`,
        condition: { ...rule.condition, componentId: null },
        consequence: { ...rule.consequence, componentId: null }
    }
}

export function mergeCompanyRule(existing: LearnedRule[], incoming: LearnedRule, now: string): { rules: LearnedRule[]; rule: LearnedRule } {
    const index = existing.findIndex(rule => companyRuleKey(rule) === companyRuleKey(incoming))
    if (index === -1) return { rules: [...existing, incoming], rule: incoming }
    const current = existing[index]
    const merged: LearnedRule = {
        ...current,
        text: incoming.text,
        condition: incoming.condition,
        consequence: incoming.consequence,
        supportEventIds: [...new Set([...current.supportEventIds, ...incoming.supportEventIds])],
        timesSeen: current.timesSeen + 1,
        lastSeenAt: now
    }
    return { rules: existing.map((item, position) => (position === index ? merged : item)), rule: merged }
}

export function crossPlantVoters(input: {
    plantId: string
    proposerComponentId: ComponentId
    requiredVoters: ComponentId[]
    sharedResources: { id: string; name: string; components: ComponentId[] }[]
}): ComponentId[] {
    const local = new Set([input.proposerComponentId, ...input.requiredVoters])
    const voters = new Set<ComponentId>()
    for (const resource of input.sharedResources) {
        if (!resource.components.some(component => local.has(component))) continue
        for (const component of resource.components) {
            if (!component.startsWith(`${input.plantId}/`) && !local.has(component)) voters.add(component)
        }
    }
    return [...voters]
}

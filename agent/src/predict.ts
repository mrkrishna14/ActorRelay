// Retrieval-grounded prediction and the vote contract, enforced in code. Pure functions.
import type { ComponentId, ComponentState, HistoryEvent, LearnedRule, Limit, Proposal, Vote } from "../../shared/types.js"

export const RELEVANCE_RADIUS = 15 // a past change is "similar" only if its target is within ±15 of the proposed one
export const tagOf = (id: ComponentId | null) => (id ? (id.split("/")[1] ?? id) : "*")
export const plantOf = (id: ComponentId) => id.split("/")[0]!

export type Point = { x: number; y: number; eventId: string; at: string; incident: string | null }
export type Basis = { metric: string; value: number; from: "history" | "rule" | "physics"; note: string }
export type Grounding = {
    similar: HistoryEvent[] // retrieved and within the relevance radius → similarCount
    anchor: HistoryEvent | null // newest change of the same proposer metric (cited first)
    rules: LearnedRule[] // rules whose condition matches this proposal and whose consequence is on this component
    predicted: Record<string, number>
    basis: Basis[]
}

export const threshold = (limit: Limit, marginPct: number) => limit.critical * (1 - marginPct / 100)
const round = (n: number) => Math.round(n * 10) / 10

/** Points (proposer target → this component's observed value) per metric. */
export function ownPoints(events: HistoryEvent[], componentId: ComponentId): Record<string, Point[]> {
    const out: Record<string, Point[]> = {}
    for (const e of events) {
        for (const f of e.effects) {
            if (f.componentId !== componentId) continue
            ;(out[f.metric] ??= []).push({ x: e.after, y: f.after, eventId: e.id, at: e.at, incident: e.incident })
        }
    }
    return out
}

/** Least-squares line through the points evaluated at x0; one distinct x → its mean. */
export function fit(points: Point[], x0: number): number | null {
    if (points.length === 0) return null
    const xs = new Set(points.map(p => p.x))
    const meanX = points.reduce((s, p) => s + p.x, 0) / points.length
    const meanY = points.reduce((s, p) => s + p.y, 0) / points.length
    if (xs.size < 2) return meanY
    const sxx = points.reduce((s, p) => s + (p.x - meanX) ** 2, 0)
    const sxy = points.reduce((s, p) => s + (p.x - meanX) * (p.y - meanY), 0)
    return meanY + (sxy / sxx) * (x0 - meanX)
}

/** Rules that fire for this proposal and say something about this component (same equipment tag). */
export function applicableRules(rules: LearnedRule[], proposal: Proposal, componentId: ComponentId): LearnedRule[] {
    return rules.filter(r => {
        const c = r.condition
        const fires = c.metric === proposal.metric && tagOf(c.componentId) === tagOf(proposal.proposerComponentId) && (c.op === ">=" ? proposal.to >= c.value : proposal.to <= c.value)
        return fires && tagOf(r.consequence.componentId) === tagOf(componentId)
    })
}

/**
 * Physics priors from the CLAUDE.MD physics summary, used only where history says nothing.
 * Valid for P-100 speedPct proposals (the demo's lever); other changes get no prior.
 */
export function physicsPrior(self: ComponentState, proposal: Proposal, context: ComponentState[] = []): Basis[] {
    if (tagOf(proposal.proposerComponentId) !== "P-100" || proposal.metric !== "speedPct") return loopPhysicsPrior(self, proposal, context)
    const to = proposal.to
    const tag = self.tag
    const sameplant = self.plantId === proposal.plantId
    const out: Basis[] = []
    const add = (metric: string, value: number, note: string) => out.push({ metric, value: round(value), from: "physics", note })
    if (!sameplant) {
        if (tag === "TV-101") {
            const dSteam = 29.7 * (to - proposal.from)
            const header = (self.metrics.headerBarg ?? 6.0) - 0.0005 * dSteam
            add("headerBarg", Math.min(6.5, Math.max(4.5, header)), `other plant draws ~${Math.round(dSteam)} kg/h more steam from the shared header`)
            add("positionPct", (self.metrics.positionPct ?? 50) + Math.max(0, (6.0 - header) * 2), "lower header pressure opens this valve slightly for the same steam flow")
        }
        return out
    }
    if (tag === "LV-101") add("positionPct", Math.min(100, to + 4), "steady position ≈ pump speed, +~4 points transient overshoot")
    if (tag === "TV-101") add("steamKgH", 29.7 * to + 48, "steam demand rises with feed")
    if (tag === "E-101") add("dutyKw", 17.43 * to + 27, "coil duty rises with feed")
    if (tag === "TK-101") {
        add("levelPct", to >= 95 ? 58 : 50, to >= 95 ? "outlet saturates above ~95 %, level climbs" : "level loop holds 2.0 m")
        add("tempC", 75 - 0.12 * Math.max(0, to - proposal.from), "temperature dips before the cascade recovers")
    }
    return out
}

/** Steady mass/energy estimates from bridge/plant/hold_tank.py, not measured outcomes.
 * Outlet flow = Cv*opening*sqrt(level); Q=feed*rho*Cp*(T-25)+UA_loss*(T-20).
 * Steam latent heat ~2109 kJ/kg at 6 barg; equal-percentage valve rangeability=50.
 */
function loopPhysicsPrior(self: ComponentState, proposal: Proposal, context: ComponentState[]): Basis[] {
    const source = tagOf(proposal.proposerComponentId)
    const levelChange = source === "TK-101" && proposal.metric === "levelPct"
    const tempChange = source === "TK-101" && proposal.metric === "tempC"
    const flowChange = source === "TV-101" && proposal.metric === "steamKgH"
    if (!levelChange && !tempChange && !flowChange) return []
    const own = (tag: string) => context.find(c => c.plantId === proposal.plantId && c.tag === tag)?.metrics ?? (self.plantId === proposal.plantId && self.tag === tag ? self.metrics : {})
    const pump = own("P-100"), tank = own("TK-101"), steam = own("TV-101"), coil = own("E-101"), outlet = own("LV-101")
    const feed = pump.feedM3h ?? 15, temperature = tank.tempC ?? 75, level = tank.levelPct ?? 50
    const cpFlow = feed * 1000 * 4180 / 3600 / 1000
    const currentDuty = coil.dutyKw ?? cpFlow * (temperature - 25) + .5 * (temperature - 20)
    const currentSteam = steam.steamKgH ?? currentDuty * 3600 / 2109
    const targetTemp = tempChange ? proposal.to : flowChange ? (proposal.to * 2109 / 3600 + cpFlow * 25 + 10) / (cpFlow + .5) : temperature
    const duty = flowChange ? proposal.to * 2109 / 3600 : tempChange ? cpFlow * (targetTemp - 25) + .5 * (targetTemp - 20) : currentDuty
    const demand = flowChange ? proposal.to : tempChange ? duty * 3600 / 2109 : currentSteam
    const header = Math.min(6.5, Math.max(4.5, (steam.headerBarg ?? 6) - .0005 * (demand - currentSteam)))
    const out: Basis[] = []
    const add = (metric: string, value: number, note: string) => { if (Number.isFinite(value)) out.push({ metric, value: round(value), from: "physics", note }) }
    if (self.plantId !== proposal.plantId) {
        if (self.tag === "TV-101") { add("headerBarg", header, "shared-header estimate from changed steam demand"); add("positionPct", (self.metrics.positionPct ?? 50) + Math.max(0, ((self.metrics.headerBarg ?? 6) - header) * 2), "shared steam pressure compensation") }
        return out
    }
    if (self.tag === "P-100") { add("speedPct", pump.speedPct ?? 50, "feed-pump speed is unchanged by this control loop"); add("feedM3h", feed, "constant feed boundary in mass/energy balance") }
    if (self.tag === "TK-101") { add("levelPct", levelChange ? proposal.to : tank.levelSetpointPct ?? level, "level controller target, steady mass balance"); add("tempC", targetTemp, flowChange ? "energy balance with local steam-flow control; temperature is not held at its old setpoint" : "temperature cascade target") }
    if (self.tag === "LV-101") add("positionPct", levelChange ? Math.min(100, (outlet.positionPct ?? 50) * Math.sqrt(level / Math.max(1, proposal.to))) : outlet.positionPct ?? 50, "outlet equilibrium from Cv × opening × sqrt(level), constant feed")
    if (self.tag === "E-101") add("dutyKw", duty, "steady tank energy balance including 500 W/K heat loss")
    if (self.tag === "TV-101") { add("steamKgH", demand, "coil duty divided by approximate 6-barg latent heat"); add("headerBarg", header, "shared-header draw estimate"); add("positionPct", Math.max(0, Math.min(100, (steam.positionPct ?? 50) + 100 * Math.log(Math.max(.001, duty / Math.max(1, currentDuty) * (165 - temperature) / Math.max(1, 165 - targetTemp))) / Math.log(50))), "equal-percentage steam valve estimate; rangeability 50") }
    return out
}

/** Everything the vote is grounded in: similar events, the newest run, applicable rules, and the resulting predictions. */
export function ground(self: ComponentState, proposal: Proposal, retrieved: HistoryEvent[], history: HistoryEvent[], rules: LearnedRule[], context: ComponentState[] = []): Grounding {
    const similar = retrieved.filter(e => e.componentId === proposal.proposerComponentId && e.metric === proposal.metric && Math.abs(e.after - proposal.to) <= RELEVANCE_RADIUS)
    const mine = (e: HistoryEvent) => e.effects.some(f => f.componentId === self.id)
    const anchor = history
        .filter(e => e.componentId === proposal.proposerComponentId && e.metric === proposal.metric && mine(e))
        .reduce<HistoryEvent | null>((best, e) => (!best || e.at > best.at ? e : best), null)
    const fired = applicableRules(rules, proposal, self.id)

    const basis: Basis[] = []
    // The newest run sharpens a fit over similar runs; on its own (far from the target) it proves nothing.
    const fitEvents = similar.length > 0 ? [...similar, ...(anchor && !similar.includes(anchor) ? [anchor] : [])] : []
    const fromHistory = ownPoints(fitEvents, self.id)
    for (const [metric, points] of Object.entries(fromHistory)) {
        const value = fit(points, proposal.to)
        if (value !== null) basis.push({ metric, value: round(value), from: "history", note: `fit over ${points.length} past runs` })
    }
    for (const r of fired) {
        const metric = r.consequence.metric
        const existing = basis.find(b => b.metric === metric)
        const floor = r.consequence.op === ">=" ? r.consequence.value : null
        if (floor !== null && (!existing || existing.value < floor)) {
            if (existing) basis.splice(basis.indexOf(existing), 1)
            basis.push({ metric, value: floor, from: "rule", note: `rule ${r.id}: ${r.text}` })
        }
    }
    for (const prior of physicsPrior(self, proposal, context)) if (!basis.some(b => b.metric === prior.metric)) basis.push(prior)

    const predicted = Object.fromEntries(basis.map(b => [b.metric, b.value]))
    return { similar, anchor, rules: fired, predicted, basis }
}

export type Decision = { vote: "yes" | "no"; reasons: string[] }

/** The vote contract: thresholds and insufficient history. */
export function decide(self: ComponentState, predicted: Record<string, number>, similarCount: number): Decision {
    const reasons: string[] = []
    if (!Object.entries(predicted).some(([metric, value]) => self.limits[metric] && Number.isFinite(value))) reasons.push("insufficient grounding: no prediction for a monitored metric")
    for (const [metric, value] of Object.entries(predicted)) {
        const limit = self.limits[metric]
        if (!limit) continue
        const t = threshold(limit, self.marginPct)
        if (value >= t) reasons.push(`predicted ${metric} ${value} ≥ ${round(t)} (critical ${limit.critical} − margin ${self.marginPct}%)`)
        if (similarCount < 3 && value >= limit.critical * 0.85) {
            reasons.push(`insufficient history: ${similarCount} similar past events, and ${metric} ${value} is within 15% of critical ${limit.critical}`)
        }
    }
    return { vote: reasons.length ? "no" : "yes", reasons }
}

/** Builds the final Vote: evidence only from what was retrieved, newest run first, contract enforced. */
export function buildVote(
    self: ComponentState, proposal: Proposal, g: Grounding,
    draft: { vote: "yes" | "no"; reason: string; predicted: Record<string, number> } | null, label: string,
): Vote {
    // Predictions: the model's, for this component's own metrics only, else the grounded baseline.
    const own = new Set([...Object.keys(self.limits), ...Object.keys(g.predicted)])
    const predicted: Record<string, number> = { ...g.predicted }
    if (draft) for (const [m, v] of Object.entries(draft.predicted)) if (own.has(m) && Number.isFinite(v)) predicted[m] = round(v)

    const similarCount = g.similar.length
    const enforced = decide(self, predicted, similarCount)
    const vote = enforced.vote === "no" ? "no" : draft?.vote ?? "yes"
    const evidence = [...(g.anchor ? [g.anchor.id] : []), ...g.similar.map(e => e.id)]
    const basisText = Object.entries(predicted).map(([m, v]) => `${m} ${v}`).join(", ")
    const why = draft?.reason ?? (vote === "no" ? enforced.reasons.join("; ") : `predicted ${basisText} stays under critical − margin`)
    const enforcedNote = enforced.vote === "no" && draft?.vote === "yes" ? ` [enforced: ${enforced.reasons.join("; ")}]` : ""
    const reason = `${label}${why}${enforcedNote} (similar events: ${similarCount}${g.anchor ? `, newest run ${g.anchor.id}` : ""}${g.rules.length ? `, rules: ${g.rules.map(r => r.id).join(", ")}` : ""})`
    return {
        proposalId: proposal.id, componentId: self.id, agentId: `agent:${self.id}`, vote,
        reason: reason.slice(0, 3900), predicted, marginPct: self.marginPct,
        evidenceEventIds: [...new Set(evidence)].slice(0, 50), evidenceRuleIds: g.rules.map(r => r.id).slice(0, 50), similarCount,
    }
}

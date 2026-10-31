import type { AuditEntry, ComponentId, LearnedRule, Limit, PlantId, Proposal, Vote } from "../../../shared/types.js"
import { MAX_COUNTERS_PER_PARENT, SETPOINT_TOLERANCE, VETO_LAPSE_MS, VETO_WINDOW_MS, VOTE_TIMEOUT_MS, WAITING_TIMEOUT_MS } from "../config.js"
import { agentIdFor } from "../ids.js"
import type { ComponentDef, Topology } from "./rules.js"
import { fail, isFiniteNumber, isNonEmptyString, isRecord } from "./validate.js"

export type ProposalInput = {
    plantId?: PlantId
    proposerComponentId: ComponentId
    proposerAgentId?: string
    metric: string
    from?: number
    to: number
    rationale: string
    parentProposalId?: string | null
}

export type Setpoints = Record<ComponentId, Record<string, number>>

export type SweepResult = { proposals: Proposal[]; audit: Omit<AuditEntry, "plantId">[]; toExecute: string[]; needLease: string[] }

export const MIN_SIMILAR = 3

export type VoteContext = {
    proposal: Pick<Proposal, "proposerComponentId" | "metric" | "to">
    proposerLimit: Limit | undefined
    // Counted by the actor over its own history, because a vote's similarCount is self-reported.
    similarCount: number
    // The higher of the vote's claim and the margin the component last reported.
    marginPct: number
    rules: LearnedRule[]
}

export function reachableVoters(proposer: ComponentId, topology: Topology, order: ComponentId[]): ComponentId[] {
    const seen = new Set<ComponentId>([proposer])
    const queue = [proposer]
    while (queue.length > 0) {
        const current = queue.shift()!
        const def = topology[current]
        if (def === undefined) continue
        // Links count from either end, so a link recorded on one side cannot drop a voter.
        const linkedHere = Object.values(topology).filter(other => other.upstream.includes(current) || other.downstream.includes(current))
        for (const next of [...def.upstream, ...def.downstream, ...linkedHere.map(other => other.id)]) {
            if (seen.has(next) || !Object.hasOwn(topology, next)) continue
            seen.add(next)
            queue.push(next)
        }
    }
    seen.delete(proposer)
    return order.filter(id => seen.has(id))
}

export function assertProposalInput(input: unknown, plantId: PlantId, topology: Topology, setpoints: Setpoints): asserts input is ProposalInput {
    if (!isRecord(input)) fail("invalid_proposal", "proposal must be an object")
    const { proposerComponentId, metric, to, from, rationale } = input
    if (!isNonEmptyString(proposerComponentId) || !Object.hasOwn(topology, proposerComponentId)) {
        fail("invalid_proposal", `${String(proposerComponentId)} is not a component of ${plantId}`)
    }
    if (input.plantId !== undefined && input.plantId !== plantId) fail("invalid_proposal", `proposal for ${String(input.plantId)} sent to ${plantId}`)
    if (!isNonEmptyString(metric)) fail("invalid_proposal", "metric is required")
    const def = topology[proposerComponentId]
    if (!Object.hasOwn(def.limits, metric)) fail("invalid_proposal", `${proposerComponentId} has no limit for ${metric}`)
    if (!isFiniteNumber(to)) fail("invalid_proposal", "to must be a finite number")
    if (from !== undefined && !isFiniteNumber(from)) fail("invalid_proposal", "from must be a finite number")
    if (!isNonEmptyString(rationale)) fail("invalid_proposal", "rationale is required")
    const limit = def.limits[metric]
    if (to < limit.min || to > limit.max) fail("out_of_limits", `${metric} ${to} is outside ${limit.min}..${limit.max}`)
    const current = setpoints[proposerComponentId]?.[metric]
    if (current === undefined) fail("invalid_proposal", `${proposerComponentId} has no current ${metric}`)
    if (from !== undefined && Math.abs(from - current) > SETPOINT_TOLERANCE) fail("stale_proposal", `from ${from} does not match current ${current}`)
    if (Math.abs(to - current) <= SETPOINT_TOLERANCE) fail("invalid_proposal", `${metric} is already ${current}`)
}

export function assertCounterAllowed(input: ProposalInput, proposals: Proposal[]): void {
    const parentId = input.parentProposalId
    if (parentId === undefined || parentId === null) return
    const parent = proposals.find(proposal => proposal.id === parentId)
    if (parent === undefined) fail("proposal_not_found", parentId)
    if (parent.proposerComponentId !== input.proposerComponentId) fail("invalid_counter", "a counter must come from the parent's proposer")
    if (parent.status !== "blocked") fail("parent_not_blocked", `${parentId} is ${parent.status}`)
    // Counted from the root, so a chain of counters cannot walk past the cap one parent at a time.
    const rootOf = (start: Proposal): string => {
        let current = start
        for (;;) {
            const above = proposals.find(proposal => proposal.id === current.parentProposalId)
            if (above === undefined) return current.id
            current = above
        }
    }
    const root = rootOf(parent)
    const counters = proposals.filter(proposal => proposal.parentProposalId !== null && rootOf(proposal) === root).length
    if (counters >= MAX_COUNTERS_PER_PARENT) fail("too_many_counters", `${root} already has ${counters} counters`)
}

export function unanimousYes(proposal: Proposal): boolean {
    return proposal.requiredVoters.length > 0 && proposal.requiredVoters.every(voter => proposal.votes.some(vote => vote.componentId === voter && vote.vote === "yes"))
}

export function isStale(proposal: Proposal, setpoints: Setpoints): boolean {
    const current = setpoints[proposal.proposerComponentId]?.[proposal.metric]
    return current === undefined || Math.abs(current - proposal.from) > SETPOINT_TOLERANCE
}

function touched(proposal: Proposal): ComponentId[] {
    return [proposal.proposerComponentId, ...proposal.requiredVoters]
}

function satisfies(value: number, op: ">=" | "<=", target: number): boolean {
    return op === ">=" ? value >= target : value <= target
}

// Safety net behind the agents' own checks, so a forged yes cannot open a veto window.
// The floor at limit.max stops a wide margin from turning a healthy reading into a violation
// (85 °C critical at margin 15 would otherwise reject 75 °C).
export function enforceVoteSafety(vote: Vote, def: ComponentDef | undefined, context?: VoteContext): Vote {
    if (vote.vote !== "yes" || def === undefined) return vote
    const marginPct = Math.max(vote.marginPct, context?.marginPct ?? 0)
    const refused = (reason: string): Vote => ({ ...vote, vote: "no", reason: `${reason}. ${vote.reason}` })
    if (context !== undefined) {
        const { proposal, proposerLimit, similarCount, rules } = context
        if (proposerLimit !== undefined && similarCount < MIN_SIMILAR && proposal.to >= proposerLimit.critical * 0.85) {
            return refused(`insufficient history: ${similarCount} similar events for ${proposal.metric} ${proposal.to}, within 15% of critical`)
        }
        const binding = rules.find(rule => {
            const limit = Object.hasOwn(def.limits, rule.consequence.metric) ? def.limits[rule.consequence.metric] : undefined
            return (
                limit !== undefined &&
                rule.condition.componentId === proposal.proposerComponentId &&
                rule.condition.metric === proposal.metric &&
                satisfies(proposal.to, rule.condition.op, rule.condition.value) &&
                rule.consequence.componentId === vote.componentId &&
                rule.consequence.op === ">=" &&
                rule.consequence.value >= Math.max(limit.critical * (1 - marginPct / 100), limit.max)
            )
        })
        if (binding !== undefined) return refused(`learned rule ${binding.id} applies: ${binding.text}`)
    }
    for (const [metric, limit] of Object.entries(def.limits)) {
        // Without this a yes with predicted {} would pass every threshold below.
        if (!Object.hasOwn(vote.predicted, metric)) fail("invalid_vote", `a yes from ${vote.componentId} must predict ${metric}`)
        const predicted = vote.predicted[metric]
        if (predicted < 0) fail("invalid_vote", `${vote.componentId} predicts ${metric} ${predicted}, which no reading can be`)
        if (predicted >= Math.max(limit.critical * (1 - marginPct / 100), limit.max)) {
            fail("unsafe_yes", `${vote.componentId} predicts ${metric} ${predicted} past its limit`)
        }
        if ((context?.similarCount ?? vote.similarCount) === 0 && predicted >= limit.critical * 0.85) {
            return refused(`insufficient history: no similar events and ${metric} is within 15% of critical`)
        }
    }
    return vote
}

export function assertVoteAllowed(vote: Vote, proposal: Proposal, now: number): void {
    if (!proposal.requiredVoters.includes(vote.componentId)) fail("not_a_required_voter", `${vote.componentId} on ${proposal.id}`)
    if (vote.agentId !== agentIdFor(vote.componentId)) fail("invalid_vote", `agentId must be ${agentIdFor(vote.componentId)}`)
    const existing = proposal.votes.find(item => item.componentId === vote.componentId)
    // A voter may withdraw a yes during the veto window. That is the only change of mind allowed.
    if (proposal.status === "veto_window" && existing?.vote === "yes" && vote.vote === "no") return
    if (existing !== undefined) fail("duplicate_vote", `${vote.componentId} already voted on ${proposal.id}`)
    // A no can land seconds before slower voters, so a blocked proposal still records their votes. Blocked stays terminal.
    if (proposal.status !== "voting" && proposal.status !== "blocked") fail("stale_proposal", `${proposal.id} is ${proposal.status}`)
    if (now - Date.parse(proposal.at) >= VOTE_TIMEOUT_MS) fail("stale_proposal", `${proposal.id} voting window has closed`)
}

export function assertExecutable(proposal: Proposal, topology: Topology, setpoints: Setpoints, now: number): void {
    if (proposal.status !== "veto_window") fail("not_approved", `${proposal.id} is ${proposal.status}`)
    if (proposal.vetoDeadline === null || now < Date.parse(proposal.vetoDeadline)) fail("veto_window_open", `${proposal.id} is still in its veto window`)
    if (!unanimousYes(proposal)) fail("not_approved", `${proposal.id} does not have every required yes`)
    if (isStale(proposal, setpoints)) fail("stale_proposal", `${proposal.id} was proposed from ${proposal.from}`)
    const limit = topology[proposal.proposerComponentId]?.limits[proposal.metric]
    if (limit === undefined) fail("not_approved", `no limit for ${proposal.metric}`)
    if (proposal.to < limit.min || proposal.to > limit.max) fail("out_of_limits", `${proposal.metric} ${proposal.to} is outside ${limit.min}..${limit.max}`)
}

// `leases` holds proposals granted the shared resources they touch. Omitted, no lease is required.
export function planSweep(proposals: Proposal[], setpoints: Setpoints, now: number, leases?: string[]): SweepResult {
    const at = new Date(now).toISOString()
    const audit: SweepResult["audit"] = []
    const toExecute: string[] = []
    const needLease: string[] = []
    const occupied = new Set(proposals.filter(proposal => proposal.status === "veto_window").flatMap(touched))

    const next = proposals.map(proposal => {
        if (proposal.status === "veto_window") {
            if (proposal.vetoDeadline === null || now < Date.parse(proposal.vetoDeadline)) return proposal
            // The deadline passing during an outage gave the operator no window, so they get a full one now.
            if (now - Date.parse(proposal.vetoDeadline) > VETO_LAPSE_MS) {
                const vetoDeadline = new Date(now + VETO_WINDOW_MS).toISOString()
                audit.push({ at, kind: "incident", refId: proposal.id, summary: `Veto window lapsed unattended, reopened until ${vetoDeadline}`, by: "plant" })
                return { ...proposal, vetoDeadline }
            }
            toExecute.push(proposal.id)
            return proposal
        }
        if (proposal.status !== "voting") return proposal

        const refused = proposal.votes.find(vote => vote.vote === "no")
        if (refused !== undefined) {
            audit.push({ at, kind: "block", refId: proposal.id, summary: `Blocked by ${refused.componentId}: ${refused.reason}`, by: refused.agentId })
            return { ...proposal, status: "blocked" as const }
        }
        if (isStale(proposal, setpoints)) {
            audit.push({ at, kind: "incident", refId: proposal.id, summary: `Expired as stale: ${proposal.metric} is no longer ${proposal.from}`, by: "plant" })
            return { ...proposal, status: "expired" as const }
        }
        if (unanimousYes(proposal)) {
            // Waits in voting while another proposal holds a touched component or its shared resource,
            // but not for ever: votes given against old conditions must not surface much later.
            const blockedByOther = touched(proposal).some(component => occupied.has(component))
            const leaseMissing = leases !== undefined && proposal.crossPlant && !leases.includes(proposal.id)
            if (blockedByOther || leaseMissing) {
                if (now - Date.parse(proposal.at) >= WAITING_TIMEOUT_MS) {
                    audit.push({ at, kind: "incident", refId: proposal.id, summary: "Expired while waiting for a veto window", by: "plant" })
                    return { ...proposal, status: "expired" as const }
                }
                if (leaseMissing && !blockedByOther) needLease.push(proposal.id)
                return proposal
            }
            touched(proposal).forEach(component => occupied.add(component))
            const vetoDeadline = new Date(now + VETO_WINDOW_MS).toISOString()
            audit.push({ at, kind: "proposal", refId: proposal.id, summary: `Unanimous yes, veto window until ${vetoDeadline}`, by: "plant" })
            return { ...proposal, status: "veto_window" as const, vetoDeadline }
        }
        if (now - Date.parse(proposal.at) >= VOTE_TIMEOUT_MS) {
            const missing = proposal.requiredVoters.filter(voter => !proposal.votes.some(vote => vote.componentId === voter))
            audit.push({ at, kind: "incident", refId: proposal.id, summary: `Expired, missing votes from ${missing.join(", ")}`, by: "plant" })
            return { ...proposal, status: "expired" as const }
        }
        return proposal
    })
    return { proposals: next, audit, toExecute, needLease }
}

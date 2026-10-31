import type { AuditEntry, ComponentId, PlantId, Proposal, Vote } from "../../../shared/types"
import { SETPOINT_TOLERANCE, VETO_WINDOW_MS, VOTE_TIMEOUT_MS } from "../config"
import { agentIdFor } from "../ids"
import type { ComponentDef, Topology } from "./rules"
import { fail, isFiniteNumber, isNonEmptyString, isRecord } from "./validate"

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

export type SweepResult = { proposals: Proposal[]; audit: Omit<AuditEntry, "plantId">[]; toExecute: string[] }

export function reachableVoters(proposer: ComponentId, topology: Topology, order: ComponentId[]): ComponentId[] {
    const seen = new Set<ComponentId>([proposer])
    const queue = [proposer]
    while (queue.length > 0) {
        const def = topology[queue.shift()!]
        if (def === undefined) continue
        for (const next of [...def.upstream, ...def.downstream]) {
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
    if (to < limit.min || to >= limit.critical) fail("out_of_limits", `${metric} ${to} is outside ${limit.min}..${limit.critical}`)
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
    const counters = proposals.filter(proposal => proposal.parentProposalId === parentId).length
    if (counters >= 2) fail("too_many_counters", `${parentId} already has ${counters} counters`)
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

// Safety net behind the agents' own checks. The floor at limit.max stops a wide margin from turning
// a healthy reading into a violation (85 °C critical at margin 15 would otherwise reject 75 °C).
export function enforceVoteSafety(vote: Vote, def: ComponentDef | undefined): Vote {
    if (vote.vote !== "yes" || def === undefined) return vote
    for (const [metric, limit] of Object.entries(def.limits)) {
        // Without this a yes with predicted {} would pass every threshold below.
        if (!Object.hasOwn(vote.predicted, metric)) fail("invalid_vote", `a yes from ${vote.componentId} must predict ${metric}`)
        const predicted = vote.predicted[metric]
        if (predicted >= Math.max(limit.critical * (1 - vote.marginPct / 100), limit.max)) {
            fail("unsafe_yes", `${vote.componentId} predicts ${metric} ${predicted} past its limit`)
        }
        if (vote.similarCount === 0 && predicted >= limit.critical * 0.85) {
            return { ...vote, vote: "no", reason: `insufficient history: no similar events and ${metric} is within 15% of critical. ${vote.reason}` }
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
    if (proposal.to < limit.min || proposal.to >= limit.critical) fail("out_of_limits", `${proposal.metric} ${proposal.to} is outside ${limit.min}..${limit.critical}`)
}

export function planSweep(proposals: Proposal[], setpoints: Setpoints, now: number): SweepResult {
    const at = new Date(now).toISOString()
    const audit: SweepResult["audit"] = []
    const toExecute: string[] = []
    const occupied = new Set(proposals.filter(proposal => proposal.status === "veto_window").flatMap(touched))

    const next = proposals.map(proposal => {
        if (proposal.status === "veto_window") {
            if (proposal.vetoDeadline !== null && now >= Date.parse(proposal.vetoDeadline)) toExecute.push(proposal.id)
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
            // Waits in voting while another proposal holds a touched component.
            if (touched(proposal).some(component => occupied.has(component))) return proposal
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
    return { proposals: next, audit, toExecute }
}

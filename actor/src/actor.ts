import { Actor, Compute, Emittable, Ephemeral, Persisted } from "terse-sdk/actor"
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import type {
    AuditEntry,
    CalibrationEntry,
    CompanyState,
    ComponentId,
    ComponentState,
    HistoryEvent,
    LearnedRule,
    Limit,
    PlantId,
    PlantState,
    Proposal,
    Role,
    Vendor,
    Vote
} from "../../shared/types.js"
import {
    ACTOR_CALL_TIMEOUT_MS,
    AUDIT_CAP,
    CALLBACK_MAX_ATTEMPTS,
    CALLBACK_RETRY_MS,
    CLAIM_TIMEOUT_MS,
    FETCH_TIMEOUT_MS,
    LEASE_TTL_MS,
    PROPOSAL_CAP,
    SETPOINT_TOLERANCE,
    SWEEP_EVERY_TICKS,
    TICK_MS,
    glueUrl
} from "./config.js"
import { COMPANY_ACTOR_ID, agentIdFor, componentActorId, plantOfProposal, proposalIdFor } from "./ids.js"
import { applyCalibration, clampMargin, computeStatus } from "./logic/component.js"
import {
    assertCounterAllowed,
    assertExecutable,
    assertProposalInput,
    assertVoteAllowed,
    enforceVoteSafety,
    isStale,
    planSweep,
    reachableVoters,
    type ProposalInput,
    type Setpoints
} from "./logic/proposals.js"
import {
    crossPlantVoters,
    deriveRules,
    mergeCompanyRule,
    mergeDerivedRules,
    mergeSubmittedRule,
    toCompanyRule,
    unsupportedEventId,
    type ComponentDef,
    type Topology
} from "./logic/rules.js"
import { rankSimilar } from "./logic/similar.js"
import {
    assertAuditEntry,
    assertComponentState,
    assertEffects,
    assertHistoryEvent,
    assertRuleShape,
    fail,
    isFiniteNumber,
    isFiniteRecord,
    isNonEmptyString,
    normalizeCalibration,
    normalizeVote
} from "./logic/validate.js"

export type PlantSeed = { id: PlantId; name: string; components: ComponentState[] }
export type CompanySeed = Partial<CompanyState> & Pick<CompanyState, "plants" | "sharedResources">
// `unknown`: a claimed dispatch never confirmed. The write may have landed, so nothing is reverted or re-sent.
export type ExecutionState = "accepted" | "claimed" | "applied" | "observed" | "failed" | "unknown"
export type Execution = {
    proposalId: string
    componentId: ComponentId
    metric: string
    value: number
    state: ExecutionState
    attempts: number
    lastAttemptAt: string | null
    acceptedAt: string
    claimedAt: string | null
    appliedAt: string | null
    observedAt: string | null
    failedAt: string | null
    failure: string | null
}
export type DispatchClaim =
    | { dispatch: true; proposalId: string; componentId: ComponentId; metric: string; value: number; token: string }
    | { dispatch: false; proposalId: string; state: ExecutionState }
export type TokenRedemption = { proposalId: string; token: string; componentId: ComponentId; metric: string; value: number }
export type EventInput = Partial<HistoryEvent> & { proposalId: string; effects: HistoryEvent["effects"] }
export type ComponentSnapshot = ComponentState & { calibration: CalibrationEntry[] }
export type RunFacts = { proposalId: string; predicted: Record<string, number>; observed: Record<string, number> }

function withTimeout<T>(pending: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`actor_call_timeout: ${label}`)), ACTOR_CALL_TIMEOUT_MS)
    })
    return Promise.race([pending, timeout]).finally(() => clearTimeout(timer))
}

// Fire-and-forget: the mailbox must not wait on glue, or a glue call back into this actor would deadlock.
function postToGlue(path: string, body: unknown, headers: Record<string, string> = {}): Promise<boolean> {
    return fetch(`${glueUrl()}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    }).then(
        response => response.ok,
        () => false
    )
}

// Runs outside the Plant mailbox and reports back with ackCompanySync. Awaiting Company inside the alarm
// would let one cold or slow Company hold up every tick and every proposal in the plant.
async function pushToCompany(plantId: PlantId, models: string[] | null, rules: LearnedRule[]): Promise<void> {
    const company = Company.get(COMPANY_ACTOR_ID)
    const delivered: { id: string; timesSeen: number }[] = []
    let registered = false
    try {
        if (models !== null) {
            await withTimeout(company.registerPlant(plantId, models), "Company.registerPlant")
            registered = true
        }
        for (const rule of rules) {
            if (rule.model === null || !(await withTimeout(company.modelExistsElsewhere(plantId, rule.model), "Company.modelExistsElsewhere"))) continue
            await withTimeout(company.promoteRule(toCompanyRule(rule, plantId)), "Company.promoteRule")
            delivered.push({ id: rule.id, timesSeen: rule.timesSeen })
        }
    } finally {
        // Partial progress still counts, or a later retry would bump timesSeen on rules Company already has.
        if (registered || delivered.length > 0) await withTimeout(Plant.get(plantId).ackCompanySync(registered, delivered), "Plant.ackCompanySync")
    }
}

function assertMatchesRun(entry: CalibrationEntry, run: RunFacts): void {
    if (!Object.hasOwn(run.predicted, entry.metric) || run.predicted[entry.metric] !== entry.predicted) {
        fail("invalid_calibration", `predicted ${entry.metric} does not match the vote`)
    }
    if (Object.hasOwn(run.observed, entry.metric) && Math.abs(run.observed[entry.metric] - entry.observed) > 1e-6) {
        fail("invalid_calibration", `observed ${entry.metric} does not match the event`)
    }
}

function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex")
}

function sameHash(a: string, b: string): boolean {
    return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

function nowIso(): string {
    return new Date().toISOString()
}

function capped<T>(items: T[], cap: number): T[] {
    return items.length > cap ? items.slice(-cap) : items
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

// Local alarms do not survive a runtime restart, and a lost alarm reads null, so entry points re-arm only then.
// An overdue alarm is not lost: its delivery may be queued behind this call. Re-arming it would schedule a second
// delivery, and under load every call would add one, so the backlog would feed itself.
function armAlarm(alarm: Actor["alarm"]): void {
    if (alarm.get() === null) alarm.set(Date.now() + TICK_MS)
}

export class Component extends Actor {
    @Persisted private componentId = ""
    @Persisted private sinceAdjustment = 0
    @Ephemeral private runFacts: RunFacts | null = null

    @Persisted @Emittable plantId: PlantId = "plant-a"
    @Persisted @Emittable tag = ""
    @Persisted @Emittable name = ""
    @Persisted @Emittable model = ""
    @Persisted @Emittable role: Role = "mechanic"
    @Persisted @Emittable vendor: Vendor = "codex"
    @Persisted @Emittable metrics: Record<string, number> = {}
    @Persisted @Emittable limits: Record<string, Limit> = {}
    @Persisted @Emittable upstream: ComponentId[] = []
    @Persisted @Emittable downstream: ComponentId[] = []
    @Persisted @Emittable sharedResources: string[] = []
    @Persisted @Emittable status: ComponentState["status"] = "offline"
    @Persisted @Emittable marginPct = 10
    @Persisted @Emittable lastTick = "1970-01-01T00:00:00.000Z"
    @Persisted @Emittable calibration: CalibrationEntry[] = []

    async getState(): Promise<ComponentSnapshot> {
        return {
            id: this.componentId,
            plantId: this.plantId,
            tag: this.tag,
            name: this.name,
            model: this.model,
            role: this.role,
            vendor: this.vendor,
            metrics: this.metrics,
            limits: this.limits,
            upstream: this.upstream,
            downstream: this.downstream,
            sharedResources: this.sharedResources,
            status: this.status,
            marginPct: this.marginPct,
            lastTick: this.lastTick,
            calibration: this.calibration
        }
    }

    async loadSeed(state: ComponentState): Promise<ComponentSnapshot> {
        assertComponentState(state)
        if (componentActorId(state.id) !== this.id) fail("invalid_seed", `seed for ${state.id} sent to ${this.id}`)
        await this.db.transaction(async () => {
            this.componentId = state.id
            this.plantId = state.plantId
            this.tag = state.tag
            this.name = state.name
            this.model = state.model
            this.role = state.role
            this.vendor = state.vendor
            this.metrics = state.metrics
            this.limits = state.limits
            this.upstream = state.upstream
            this.downstream = state.downstream
            this.sharedResources = state.sharedResources
            this.status = computeStatus(state.metrics, state.limits)
            this.marginPct = clampMargin(state.marginPct)
            this.lastTick = state.lastTick
            this.calibration = []
            this.sinceAdjustment = 0
        })
        return this.#publishState()
    }

    async mirror(metrics: Record<string, number>): Promise<ComponentSnapshot> {
        this.#requireSeed()
        if (!isFiniteRecord(metrics)) fail("invalid_metrics", "mirrored metrics must be finite numbers")
        const next = { ...this.metrics, ...metrics }
        await this.db.transaction(async () => {
            this.metrics = next
            this.status = computeStatus(next, this.limits)
            this.lastTick = nowIso()
        })
        return this.#publishState()
    }

    // Only reachable with a token Plant minted for this exact proposal, component, metric and value.
    async setMetric(metric: string, value: number, proposalId: string, token: string): Promise<ComponentSnapshot> {
        this.#requireSeed()
        if (!Object.hasOwn(this.limits, metric)) fail("invalid_metric", `${this.componentId} has no limit for ${metric}`)
        if (!isFiniteNumber(value)) fail("invalid_metric", "value must be finite")
        if (!isNonEmptyString(proposalId) || !isNonEmptyString(token)) fail("invalid_token", "proposalId and token are required")
        await withTimeout(Plant.get(this.plantId).redeemToken({ proposalId, token, componentId: this.componentId, metric, value }), "Plant.redeemToken")
        const next = { ...this.metrics, [metric]: value }
        await this.db.transaction(async () => {
            this.metrics = next
            this.status = computeStatus(next, this.limits)
            this.lastTick = nowIso()
        })
        return this.#publishState()
    }

    async addCalibration(e: CalibrationEntry): Promise<ComponentSnapshot> {
        this.#requireSeed()
        const entry = normalizeCalibration(e)
        if (this.calibration.some(item => item.proposalId === entry.proposalId && item.metric === entry.metric)) {
            fail("duplicate_calibration", `${this.componentId} already calibrated ${entry.metric} on ${entry.proposalId}`)
        }
        // Calibration moves the safety margin, so an entry must match a run this component really voted on.
        // One Plant call per run: a voter sends several entries at once, right when the next proposal needs Plant.
        if (this.runFacts?.proposalId !== entry.proposalId) {
            this.runFacts = await withTimeout(Plant.get(plantOfProposal(entry.proposalId)).acceptCalibration(this.componentId, entry), "Plant.acceptCalibration")
        }
        assertMatchesRun(entry, this.runFacts)
        const outcome = applyCalibration({
            calibration: this.calibration,
            entry,
            limits: this.limits,
            marginPct: this.marginPct,
            sinceAdjustment: this.sinceAdjustment
        })
        await this.db.transaction(async () => {
            this.calibration = outcome.calibration
            this.marginPct = outcome.marginPct
            this.sinceAdjustment = outcome.sinceAdjustment
        })
        this.#reportMargin()
        return this.#publishState()
    }

    async setMargin(pct: number): Promise<ComponentSnapshot> {
        this.#requireSeed()
        if (!isFiniteNumber(pct)) fail("invalid_margin", "margin must be finite")
        this.marginPct = clampMargin(pct)
        this.#reportMargin()
        return this.#publishState()
    }

    // Plant compares votes against this rather than the margin a vote claims for itself.
    #reportMargin(): void {
        void Plant.get(this.plantId)
            .noteMargin(this.componentId, this.marginPct)
            .catch(() => undefined)
    }

    // Prototype methods are remotely invokable whatever their TypeScript visibility, so helpers use #.
    #requireSeed(): void {
        if (this.componentId === "") fail("not_seeded", `${this.id} has no seed`)
    }

    async #publishState(): Promise<ComponentSnapshot> {
        const state = await this.getState()
        this.broadcast({ type: "component", state })
        return state
    }
}

export class Plant extends Actor {
    @Persisted private seq = 0
    @Persisted private seeded = false
    @Persisted private topology: Topology = {}
    @Persisted private setpoints: Setpoints = {}
    @Persisted private executions: Record<string, Execution> = {}
    @Persisted private tokenHashes: Record<string, string> = {}
    @Persisted private liveEventIds: string[] = []
    @Persisted private companyOutbox: LearnedRule[] = []
    @Persisted private registeredWithCompany = false
    @Persisted private margins: Record<ComponentId, number> = {}
    @Persisted private leases: string[] = []
    @Ephemeral private alarmChecked = false
    @Ephemeral private companySyncing = false
    @Ephemeral private companyRuleIds: string[] = []
    @Ephemeral private lastTickAt = 0

    @Persisted @Emittable name = ""
    @Persisted @Emittable components: ComponentId[] = []
    @Persisted @Emittable proposals: Proposal[] = []
    @Persisted @Emittable history: HistoryEvent[] = []
    @Persisted @Emittable rules: LearnedRule[] = []
    @Persisted @Emittable audit: AuditEntry[] = []
    @Persisted @Emittable tickCount = 0
    @Persisted @Emittable connected = false

    async getState(): Promise<PlantState> {
        if (this.seeded) this.#ensureAlarm()
        return {
            id: this.id as PlantId,
            name: this.name,
            components: this.components,
            proposals: this.proposals,
            history: this.history,
            rules: this.rules,
            audit: this.audit,
            tick: this.tickCount,
            connected: this.connected
        }
    }

    async loadSeed(plant: PlantSeed, history: HistoryEvent[]): Promise<{ components: number; history: number; rules: number }> {
        if (plant?.id !== this.id) fail("invalid_seed", `seed for ${String(plant?.id)} sent to ${this.id}`)
        if (!isNonEmptyString(plant.name) || !Array.isArray(plant.components) || !Array.isArray(history)) fail("invalid_seed", "plant needs name, components and history")
        plant.components.forEach(component => {
            assertComponentState(component)
            if (component.plantId !== this.id) fail("invalid_seed", `${component.id} does not belong to ${this.id}`)
        })
        const own = history.filter(event => event?.plantId === this.id)
        own.forEach(event => assertHistoryEvent(event))

        const topology: Topology = {}
        const setpoints: Setpoints = {}
        for (const { id, tag, model, limits, upstream, downstream, sharedResources, metrics } of plant.components) {
            topology[id] = { id, tag, model, limits, upstream, downstream, sharedResources }
            setpoints[id] = { ...metrics }
        }
        const margins = Object.fromEntries(plant.components.map(component => [component.id, component.marginPct]))
        const rules = deriveRules(own, topology, nowIso())

        await this.db.transaction(async () => {
            this.name = plant.name
            this.components = plant.components.map(component => component.id)
            this.topology = topology
            this.setpoints = setpoints
            this.proposals = []
            this.history = own
            this.rules = rules
            this.audit = []
            this.executions = {}
            this.tokenHashes = {}
            this.liveEventIds = []
            this.companyOutbox = rules
            this.registeredWithCompany = false
            this.companyRuleIds = []
            this.margins = margins
            this.leases = []
            this.seq = 0
            this.tickCount = 0
            this.seeded = true
        })
        this.alarmChecked = false
        this.#ensureAlarm()
        return { components: this.components.length, history: own.length, rules: rules.length }
    }

    async propose(p: ProposalInput): Promise<Proposal> {
        this.#assertSeeded()
        assertProposalInput(p, this.id as PlantId, this.topology, this.setpoints)
        assertCounterAllowed(p, this.proposals)
        const local = reachableVoters(p.proposerComponentId, this.topology, this.components)
        const draft: Proposal = {
            id: proposalIdFor(this.id as PlantId, this.seq + 1, randomUUID().slice(0, 8)),
            at: nowIso(),
            plantId: this.id as PlantId,
            proposerComponentId: p.proposerComponentId,
            proposerAgentId: isNonEmptyString(p.proposerAgentId) ? p.proposerAgentId : agentIdFor(p.proposerComponentId),
            metric: p.metric,
            from: p.from ?? this.setpoints[p.proposerComponentId][p.metric],
            to: p.to,
            rationale: p.rationale,
            requiredVoters: local,
            votes: [],
            status: "voting",
            vetoDeadline: null,
            parentProposalId: p.parentProposalId ?? null,
            crossPlant: false
        }
        // Fails closed: without Company the cross-plant voters are unknown, so the proposal must not open.
        const company = Company.get(COMPANY_ACTOR_ID)
        const remote = await withTimeout(company.requiredCrossPlantVoters(draft), "Company.requiredCrossPlantVoters")
        const proposal: Proposal = { ...draft, requiredVoters: [...local, ...remote], crossPlant: remote.length > 0 }
        if (proposal.requiredVoters.length === 0) fail("invalid_proposal", `${p.proposerComponentId} has no connected voters`)
        const onSharedResource = [p.proposerComponentId, ...local].some(id => this.topology[id].sharedResources.length > 0)
        if (onSharedResource && remote.length === 0) fail("company_not_seeded", "shared resources exist but Company named no cross-plant voters")

        await this.db.transaction(async () => {
            this.seq = this.seq + 1
            this.proposals = capped([...this.proposals, proposal], PROPOSAL_CAP)
            this.audit = this.#withAudit([
                { at: proposal.at, kind: "proposal", refId: proposal.id, summary: `${proposal.metric} ${proposal.from} → ${proposal.to}: ${proposal.rationale}`, by: proposal.proposerAgentId }
            ])
        })
        if (proposal.crossPlant) void company.addCrossPlantProposal(proposal.id).catch(error => console.error(`Plant ${this.id} could not reach Company: ${errorText(error)}`))
        return proposal
    }

    async vote(v: Vote): Promise<Proposal> {
        this.#assertSeeded()
        const incoming = normalizeVote(v)
        const proposal = this.#findProposal(incoming.proposalId)
        assertVoteAllowed(incoming, proposal, Date.now())
        const known = new Set(this.history.map(event => event.id))
        const unknownEvent = incoming.evidenceEventIds.find(id => !known.has(id))
        if (unknownEvent !== undefined) fail("invalid_vote", `evidence event ${unknownEvent} is not in history`)
        await this.#assertRulesExist(incoming.evidenceRuleIds)
        // Both plants are copies, so a cross-plant voter is checked against the same-tag local limits.
        const def = this.topology[incoming.componentId] ?? this.topology[`${this.id}/${incoming.componentId.split("/")[1]}`]
        const proposerLimits = this.topology[proposal.proposerComponentId]?.limits
        const proposerLimit = proposerLimits !== undefined && Object.hasOwn(proposerLimits, proposal.metric) ? proposerLimits[proposal.metric] : undefined
        const similarCount = rankSimilar({
            history: this.history,
            componentId: proposal.proposerComponentId,
            metric: proposal.metric,
            to: proposal.to,
            upstreamSnapshot: {},
            k: 100,
            limit: proposerLimit,
            liveEventIds: []
        }).length
        const vote = enforceVoteSafety(incoming, def, {
            proposal,
            proposerLimit,
            similarCount,
            marginPct: this.margins[incoming.componentId] ?? 10,
            rules: this.rules
        })

        const withdrawn = proposal.status === "veto_window"
        // A no closes the proposal at once; the sweep only backstops it. Slower voters are still recorded.
        const refused = vote.vote === "no" && proposal.status === "voting"
        const updated: Proposal = withdrawn
            ? { ...proposal, votes: proposal.votes.map(item => (item.componentId === vote.componentId ? vote : item)), status: "blocked", vetoDeadline: null }
            : { ...proposal, votes: [...proposal.votes, vote], status: refused ? "blocked" : proposal.status }
        const at = nowIso()
        const entries: Omit<AuditEntry, "plantId">[] = [{ at, kind: "vote", refId: proposal.id, summary: `${vote.componentId} voted ${vote.vote}: ${vote.reason}`, by: vote.agentId }]
        if (withdrawn || refused) entries.push({ at, kind: "block", refId: proposal.id, summary: `Blocked by ${vote.componentId}: ${vote.reason}`, by: vote.agentId })
        await this.db.transaction(async () => {
            this.proposals = this.proposals.map(item => (item.id === updated.id ? updated : item))
            this.audit = this.#withAudit(entries)
        })
        return updated
    }

    async veto(proposalId: string, by: string): Promise<Proposal> {
        this.#assertSeeded()
        if (!isNonEmptyString(by)) fail("invalid_veto", "by is required")
        const proposal = this.#findProposal(proposalId)
        if (proposal.status !== "veto_window") fail("veto_closed", `${proposalId} is ${proposal.status}`)
        const updated: Proposal = { ...proposal, status: "vetoed", vetoDeadline: null }
        await this.db.transaction(async () => {
            this.proposals = this.proposals.map(item => (item.id === updated.id ? updated : item))
            this.audit = this.#withAudit([{ at: nowIso(), kind: "veto", refId: proposalId, summary: `Vetoed by ${by}`, by }])
        })
        return updated
    }

    // Records acceptance only. Whether the simulator moved is recorded later, by claim, redemption and observation.
    async execute(proposalId: string): Promise<Execution> {
        this.#assertSeeded()
        const existing = Object.hasOwn(this.executions, proposalId) ? this.executions[proposalId] : undefined
        if (existing !== undefined) return existing
        const proposal = this.#findProposal(proposalId)
        assertExecutable(proposal, this.topology, this.setpoints, Date.now())

        const acceptedAt = nowIso()
        const execution: Execution = {
            proposalId,
            componentId: proposal.proposerComponentId,
            metric: proposal.metric,
            value: proposal.to,
            state: "accepted",
            attempts: 1,
            lastAttemptAt: acceptedAt,
            acceptedAt,
            claimedAt: null,
            appliedAt: null,
            observedAt: null,
            failedAt: null,
            failure: null
        }
        const updated: Proposal = { ...proposal, status: "executed" }
        await this.db.transaction(async () => {
            this.proposals = this.proposals.map(item => (item.id === updated.id ? updated : item))
            this.executions = { ...this.executions, [proposalId]: execution }
            this.setpoints = this.#withSetpoint(proposal, proposal.to)
            this.audit = this.#withAudit([{ at: acceptedAt, kind: "execute", refId: proposalId, summary: `Accepted ${proposal.metric} → ${proposal.to}, awaiting simulator`, by: "plant" }])
        })
        void postToGlue("/execute-callback", { proposalId }, { "idempotency-key": proposalId })
        return execution
    }

    async getExecution(proposalId: string): Promise<Execution | null> {
        return Object.hasOwn(this.executions, proposalId) ? this.executions[proposalId] : null
    }

    // Exactly one caller, across retries and restarts, is told to write to the simulator.
    // Plant never reads Component (that would close a mailbox cycle), so the executor passes the measured value.
    async claimDispatch(proposalId: string, measured?: number): Promise<DispatchClaim> {
        this.#assertSeeded()
        if (!Object.hasOwn(this.executions, proposalId)) fail("not_accepted", `${proposalId} has not been accepted`)
        const execution = this.executions[proposalId]
        if (execution.state !== "accepted") return { dispatch: false, proposalId, state: execution.state }
        if (measured !== undefined) {
            const proposal = this.#findProposal(proposalId)
            if (!isFiniteNumber(measured) || Math.abs(measured - proposal.from) > SETPOINT_TOLERANCE) {
                // The measured value is the truth, so it replaces the setpoint and later proposals start from it.
                const settled = isFiniteNumber(measured) ? measured : undefined
                const failed = await this.#failExecution(execution, `measured ${execution.metric} ${measured} no longer matches ${proposal.from}`, settled)
                return { dispatch: false, proposalId, state: failed.state }
            }
        }
        const token = randomBytes(32).toString("hex")
        await this.db.transaction(async () => {
            this.tokenHashes = { ...this.tokenHashes, [proposalId]: hashToken(token) }
            this.executions = { ...this.executions, [proposalId]: { ...execution, state: "claimed", claimedAt: nowIso() } }
        })
        const { componentId, metric, value } = execution
        return { dispatch: true, proposalId, componentId, metric, value, token }
    }

    // Called by Component.setMetric. Failed attempts do not burn the token; only an exact match consumes it.
    async redeemToken(r: TokenRedemption): Promise<{ redeemed: true }> {
        this.#assertSeeded()
        const execution = Object.hasOwn(this.executions, r?.proposalId) ? this.executions[r.proposalId] : undefined
        if (execution === undefined) fail("invalid_token", "no such execution")
        const expected = this.tokenHashes[r.proposalId]
        if (expected === undefined || typeof r.token !== "string" || !sameHash(expected, hashToken(r.token))) fail("invalid_token", "token does not match")
        if (execution.componentId !== r.componentId || execution.metric !== r.metric || execution.value !== r.value) fail("invalid_token", "token is bound to another write")
        if (execution.state === "applied" || execution.state === "observed") fail("token_already_used", r.proposalId)
        if (execution.state !== "claimed" && execution.state !== "unknown") fail("invalid_token", `execution is ${execution.state}`)
        const at = nowIso()
        await this.db.transaction(async () => {
            this.executions = { ...this.executions, [r.proposalId]: { ...execution, state: "applied", appliedAt: at } }
            this.audit = this.#withAudit([{ at, kind: "execute", refId: r.proposalId, summary: `Simulator accepted ${r.metric} → ${r.value}`, by: "plant" }])
        })
        return { redeemed: true }
    }

    async reportDispatchFailure(proposalId: string, reason: string): Promise<Execution> {
        this.#assertSeeded()
        if (!Object.hasOwn(this.executions, proposalId)) fail("not_accepted", `${proposalId} has not been accepted`)
        const execution = this.executions[proposalId]
        if (execution.state === "applied" || execution.state === "observed") fail("already_applied", proposalId)
        // A replayed report must not rewind a setpoint that a newer proposal has since moved.
        if (execution.state === "failed") return execution
        return this.#failExecution(execution, isNonEmptyString(reason) ? reason : "dispatch failed")
    }

    // Observations only: seed history arrives through loadSeed, so nothing here can invent a past run.
    async recordEvent(e: EventInput): Promise<HistoryEvent> {
        this.#assertSeeded()
        assertEffects(e?.effects)
        const proposalId = e.proposalId
        if (!isNonEmptyString(proposalId)) fail("invalid_event", "an observation needs the proposal that caused it")
        const existing = this.history.find(event => event.proposalId === proposalId)
        if (existing !== undefined) return existing
        const event = this.#eventFromProposal(proposalId, e)

        const history = [...this.history, event]
        const merged = mergeDerivedRules(this.rules, deriveRules(history, this.topology, event.at))
        const entries: Omit<AuditEntry, "plantId">[] = [
            { at: event.at, kind: "execute", refId: proposalId ?? event.id, summary: `Observed ${event.effects.length} effects after ${event.metric} → ${event.after}`, by: "plant" }
        ]
        if (event.incident !== null) entries.push({ at: event.at, kind: "incident", refId: event.id, summary: event.incident, by: "plant" })
        merged.changed.forEach(rule => entries.push({ at: event.at, kind: "rule_learned", refId: rule.id, summary: rule.text, by: "plant" }))

        await this.db.transaction(async () => {
            this.history = history
            this.liveEventIds = [...this.liveEventIds, event.id]
            this.rules = merged.rules
            this.companyOutbox = this.#withOutbox(merged.changed)
            this.audit = this.#withAudit(entries)
            const execution = this.executions[proposalId]
            this.executions = { ...this.executions, [proposalId]: { ...execution, state: "observed", observedAt: event.at } }
        })
        this.#syncCompany()
        return event
    }

    async promoteRule(r: LearnedRule): Promise<LearnedRule> {
        this.#assertSeeded()
        assertRuleShape(r)
        const unsupported = unsupportedEventId(r, this.history)
        if (unsupported !== null) fail("invalid_rule", `event ${unsupported} does not show this rule`)
        const at = nowIso()
        const { rules, rule } = mergeSubmittedRule(this.rules, r, at)
        await this.db.transaction(async () => {
            this.rules = rules
            this.companyOutbox = this.#withOutbox([rule])
            this.audit = this.#withAudit([{ at, kind: "rule_learned", refId: rule.id, summary: rule.text, by: "plant" }])
        })
        this.#syncCompany()
        return rule
    }

    async similar(componentId: ComponentId, metric: string, to: number, upstreamSnapshot: Record<string, number> = {}, k = 5): Promise<HistoryEvent[]> {
        if (!isNonEmptyString(componentId) || !isNonEmptyString(metric) || !isFiniteNumber(to)) fail("invalid_query", "componentId, metric and a finite to are required")
        if (!isFiniteRecord(upstreamSnapshot)) fail("invalid_query", "upstreamSnapshot must be finite numbers")
        const limits = this.topology[componentId]?.limits
        const limit = limits !== undefined && Object.hasOwn(limits, metric) ? limits[metric] : undefined
        return rankSimilar({ history: this.history, componentId, metric, to, upstreamSnapshot, k, limit, liveEventIds: this.liveEventIds })
    }

    async rulesFor(componentId?: ComponentId, model?: string): Promise<LearnedRule[]> {
        const applies = (rule: LearnedRule) =>
            (componentId === undefined && model === undefined) || rule.model === model || rule.condition.componentId === componentId || rule.consequence.componentId === componentId
        const mine = this.rules.filter(applies)
        const company = await withTimeout(Company.get(COMPANY_ACTOR_ID).getState(), "Company.getState")
        return [...mine, ...company.rules.filter(rule => model === undefined || rule.model === model)]
    }

    async setConnected(connected: boolean): Promise<void> {
        if (typeof connected !== "boolean") fail("invalid_connected", "connected must be a boolean")
        if (connected !== this.connected) this.connected = connected
    }

    async recordAudit(a: AuditEntry): Promise<void> {
        this.#assertSeeded()
        assertAuditEntry(a)
        this.audit = capped([...this.audit, a], AUDIT_CAP)
    }

    async tick(): Promise<number> {
        this.#assertSeeded()
        this.tickCount = this.tickCount + 1
        const wasConnected = this.connected
        const plantId = this.id as PlantId
        void postToGlue("/tick", {}).then(connected => {
            if (connected !== wasConnected) return Plant.get(plantId).setConnected(connected).catch(() => undefined)
        })
        if (this.tickCount % SWEEP_EVERY_TICKS === 0) await this.sweep()
        return this.tickCount
    }

    async sweep(): Promise<void> {
        this.#assertSeeded()
        const now = Date.now()
        const plan = planSweep(this.proposals, this.setpoints, now, this.leases)
        const changed = plan.proposals.some((proposal, index) => proposal !== this.proposals[index])
        if (changed || plan.audit.length > 0) {
            await this.db.transaction(async () => {
                if (changed) this.proposals = plan.proposals
                if (plan.audit.length > 0) this.audit = this.#withAudit(plan.audit)
            })
        }
        for (const proposalId of plan.toExecute) {
            try {
                await this.execute(proposalId)
            } catch (error) {
                await this.#refuseExecution(proposalId, errorText(error))
            }
        }
        await this.#followExecutions(now)
        this.#requestLeases(plan.needLease)
        await this.#releaseLeases()
        this.#syncCompany()
    }

    // Called by #requestLeases once Company has granted the shared resources a proposal touches.
    async grantLease(proposalId: string): Promise<void> {
        const open = this.proposals.some(proposal => proposal.id === proposalId && proposal.status === "voting")
        if (open && !this.leases.includes(proposalId)) this.leases = [...this.leases, proposalId]
        else if (!open) void Company.get(COMPANY_ACTOR_ID).releaseLease(proposalId).catch(() => undefined)
    }

    // Called by Component. Plant must not read Component (that would close a mailbox cycle), so margins are pushed.
    async noteMargin(componentId: ComponentId, marginPct: number): Promise<void> {
        if (!Object.hasOwn(this.topology, componentId) || !isFiniteNumber(marginPct)) fail("invalid_margin", `${componentId} ${marginPct}`)
        if (this.margins[componentId] !== marginPct) this.margins = { ...this.margins, [componentId]: marginPct }
    }

    // Called once per run by Component.addCalibration. Returns what that run proves, so later entries check locally.
    async acceptCalibration(componentId: ComponentId, entry: CalibrationEntry): Promise<RunFacts> {
        this.#assertSeeded()
        const proposal = this.#findProposal(entry.proposalId)
        const event = this.history.find(item => item.proposalId === entry.proposalId)
        if (proposal.status !== "executed" || event === undefined) fail("invalid_calibration", `${entry.proposalId} has no observed run`)
        const vote = proposal.votes.find(item => item.componentId === componentId)
        if (vote === undefined) fail("invalid_calibration", `${componentId} did not vote on ${entry.proposalId}`)
        const facts: RunFacts = {
            proposalId: entry.proposalId,
            predicted: vote.predicted,
            observed: Object.fromEntries(event.effects.filter(effect => effect.componentId === componentId).map(effect => [effect.metric, effect.after]))
        }
        assertMatchesRun(entry, facts)
        const summary = `${componentId} ${entry.metric} predicted ${entry.predicted}, observed ${entry.observed}, error ${entry.absError}`
        this.audit = this.#withAudit([{ at: entry.at, kind: "calibration", refId: entry.proposalId, summary, by: agentIdFor(componentId) }])
        return facts
    }

    // Called by pushToCompany. A rule that gained sightings while the push ran stays queued.
    async ackCompanySync(registered: boolean, delivered: { id: string; timesSeen: number }[]): Promise<void> {
        const sent = new Map(delivered.map(rule => [rule.id, rule.timesSeen]))
        const remaining = this.companyOutbox.filter(rule => sent.get(rule.id) !== rule.timesSeen)
        await this.db.transaction(async () => {
            if (registered) this.registeredWithCompany = true
            if (remaining.length !== this.companyOutbox.length) this.companyOutbox = remaining
        })
    }

    async onAlarm(): Promise<void> {
        // Re-armed first: an uncaught failure below must not end the tick loop.
        const now = Date.now()
        this.alarm.set(now + TICK_MS)
        // The scheduler retries a delivery that outlives its 30s request, so one tick can arrive more than once.
        if (now - this.lastTickAt < TICK_MS / 2) return
        this.lastTickAt = now
        try {
            await this.tick()
        } catch (error) {
            console.error(`Plant ${this.id} tick failed: ${errorText(error)}`)
        }
    }

    #assertSeeded(): void {
        if (!this.seeded) fail("not_seeded", `${this.id} has no seed`)
        this.#ensureAlarm()
    }

    // Once per activation: a restart loses the alarm, and every alarm read is a round trip to the control plane.
    #ensureAlarm(): void {
        if (this.alarmChecked) return
        armAlarm(this.alarm)
        this.alarmChecked = true
    }

    // Outside the mailbox, like Company sync. A proposal stays in voting until grantLease arrives.
    #requestLeases(proposalIds: string[]): void {
        for (const proposalId of proposalIds) {
            const proposal = this.#findProposal(proposalId)
            const local = [proposal.proposerComponentId, ...proposal.requiredVoters].flatMap(id => this.topology[id]?.sharedResources ?? [])
            const plantId = this.id as PlantId
            void Company.get(COMPANY_ACTOR_ID)
                .acquireLease([...new Set(local)], proposalId, LEASE_TTL_MS)
                .then(granted => (granted ? Plant.get(plantId).grantLease(proposalId) : undefined))
                .catch(error => console.error(`Plant ${plantId} could not lease shared resources: ${errorText(error)}`))
        }
    }

    async #releaseLeases(): Promise<void> {
        const done = this.leases.filter(id => {
            const status = this.proposals.find(proposal => proposal.id === id)?.status
            return status !== "voting" && status !== "veto_window"
        })
        if (done.length === 0) return
        this.leases = this.leases.filter(id => !done.includes(id))
        for (const proposalId of done) void Company.get(COMPANY_ACTOR_ID).releaseLease(proposalId).catch(() => undefined)
    }

    #findProposal(proposalId: string): Proposal {
        const proposal = this.proposals.find(item => item.id === proposalId)
        if (proposal === undefined) fail("proposal_not_found", String(proposalId))
        return proposal
    }

    #withAudit(entries: Omit<AuditEntry, "plantId">[]): AuditEntry[] {
        return capped([...this.audit, ...entries.map(entry => ({ ...entry, plantId: this.id as PlantId }))], AUDIT_CAP)
    }

    #withSetpoint(proposal: Proposal, value: number): Setpoints {
        const { proposerComponentId: component, metric } = proposal
        return { ...this.setpoints, [component]: { ...this.setpoints[component], [metric]: value } }
    }

    #withOutbox(rules: LearnedRule[]): LearnedRule[] {
        const changed = new Set(rules.map(rule => rule.id))
        return [...this.companyOutbox.filter(rule => !changed.has(rule.id)), ...rules]
    }

    #eventFromProposal(proposalId: string, e: EventInput): HistoryEvent {
        const proposal = this.#findProposal(proposalId)
        const execution = Object.hasOwn(this.executions, proposalId) ? this.executions[proposalId] : undefined
        if (proposal.status !== "executed" || execution === undefined) fail("not_executed", `${proposalId} is ${proposal.status}`)
        // An observation needs a dispatched command behind it: acceptance alone proves nothing moved.
        if (execution.state !== "claimed" && execution.state !== "applied" && execution.state !== "unknown") fail("not_dispatched", `${proposalId} is ${execution.state}`)
        if (e.upstreamSnapshot !== undefined && !isFiniteRecord(e.upstreamSnapshot)) fail("invalid_event", "upstreamSnapshot must be finite numbers")
        if (e.incident !== undefined && e.incident !== null && typeof e.incident !== "string") fail("invalid_event", "incident must be a string or null")
        if (e.operator !== undefined && e.operator !== null && typeof e.operator !== "string") fail("invalid_event", "operator must be a string or null")
        return {
            id: `event-${proposalId}`,
            at: nowIso(),
            plantId: this.id as PlantId,
            componentId: proposal.proposerComponentId,
            metric: proposal.metric,
            before: proposal.from,
            after: proposal.to,
            upstreamSnapshot: e.upstreamSnapshot ?? {},
            effects: e.effects,
            incident: e.incident ?? null,
            approvedBy: proposal.votes.filter(vote => vote.vote === "yes").map(vote => vote.agentId),
            operator: e.operator ?? null,
            proposalId
        }
    }

    async #followExecutions(now: number): Promise<void> {
        for (const execution of Object.values(this.executions)) {
            if (execution.state === "accepted" && now - Date.parse(execution.lastAttemptAt ?? execution.acceptedAt) >= CALLBACK_RETRY_MS) {
                if (execution.attempts >= CALLBACK_MAX_ATTEMPTS) {
                    await this.#failExecution(execution, `no executor claimed the dispatch after ${execution.attempts} attempts`)
                    continue
                }
                this.executions = { ...this.executions, [execution.proposalId]: { ...execution, attempts: execution.attempts + 1, lastAttemptAt: new Date(now).toISOString() } }
                void postToGlue("/execute-callback", { proposalId: execution.proposalId }, { "idempotency-key": execution.proposalId })
            }
            // At most once: a claim that never finished may have reached the simulator, so it is neither re-sent
            // nor reverted. A late setMetric or observation can still settle it.
            if (execution.state === "claimed" && now - Date.parse(execution.claimedAt ?? execution.acceptedAt) >= CLAIM_TIMEOUT_MS) {
                const at = new Date(now).toISOString()
                await this.db.transaction(async () => {
                    this.executions = { ...this.executions, [execution.proposalId]: { ...execution, state: "unknown", failure: "dispatch never confirmed" } }
                    this.audit = this.#withAudit([{ at, kind: "incident", refId: execution.proposalId, summary: "Dispatch never confirmed: simulator outcome unknown", by: "plant" }])
                })
            }
        }
    }

    async #failExecution(execution: Execution, reason: string, settled?: number): Promise<Execution> {
        const at = nowIso()
        const failed: Execution = { ...execution, state: "failed", failedAt: at, failure: reason }
        const proposal = this.proposals.find(item => item.id === execution.proposalId)
        await this.db.transaction(async () => {
            this.executions = { ...this.executions, [execution.proposalId]: failed }
            this.audit = this.#withAudit([{ at, kind: "incident", refId: execution.proposalId, summary: `Dispatch failed: ${reason}`, by: "plant" }])
            if (proposal !== undefined) {
                this.proposals = this.proposals.map(item => (item.id === proposal.id ? { ...proposal, status: "expired" as const } : item))
                this.setpoints = this.#withSetpoint(proposal, settled ?? proposal.from)
            }
        })
        return failed
    }

    async #refuseExecution(proposalId: string, reason: string): Promise<void> {
        const at = nowIso()
        await this.db.transaction(async () => {
            this.proposals = this.proposals.map(item => (item.id === proposalId ? { ...item, status: "expired" as const, vetoDeadline: null } : item))
            this.audit = this.#withAudit([{ at, kind: "incident", refId: proposalId, summary: `Refused at dispatch: ${reason}`, by: "plant" }])
        })
    }

    // At most one push runs at a time; anything it misses stays in the outbox for the next sweep.
    #syncCompany(): void {
        if (this.companySyncing || (this.registeredWithCompany && this.companyOutbox.length === 0)) return
        this.companySyncing = true
        const models = this.registeredWithCompany ? null : [...new Set(Object.values(this.topology).map((def: ComponentDef) => def.model))]
        void pushToCompany(this.id as PlantId, models, this.companyOutbox)
            .catch(error => console.error(`Plant ${this.id} could not reach Company: ${errorText(error)}`))
            .finally(() => {
                this.companySyncing = false
            })
    }

    async #assertRulesExist(ids: string[]): Promise<void> {
        const mine = new Set(this.rules.map(rule => rule.id))
        const unknown = ids.filter(id => !mine.has(id) && !this.companyRuleIds.includes(id))
        if (unknown.length === 0) return
        const company = await withTimeout(Company.get(COMPANY_ACTOR_ID).getState(), "Company.getState")
        this.companyRuleIds = company.rules.map(rule => rule.id)
        const invented = unknown.find(id => !this.companyRuleIds.includes(id))
        if (invented !== undefined) fail("invalid_vote", `evidence rule ${invented} does not exist`)
    }
}

// Company has no alarm, so without this every quiet moment costs the next propose a cold start.
@Compute({ idleTimeoutMs: 300_000 })
export class Company extends Actor {
    @Persisted private plantModels: Record<string, string[]> = {}
    @Persisted private leases: Record<string, { proposalId: string; expiresAt: number }> = {}

    @Persisted @Emittable plants: PlantId[] = []
    @Persisted @Emittable sharedResources: CompanyState["sharedResources"] = []
    @Persisted @Emittable rules: LearnedRule[] = []
    @Persisted @Emittable crossPlantProposals: string[] = []
    @Persisted @Emittable audit: AuditEntry[] = []

    async getState(): Promise<CompanyState> {
        return {
            plants: this.plants,
            sharedResources: this.sharedResources,
            rules: this.rules,
            crossPlantProposals: this.crossPlantProposals,
            audit: this.audit
        }
    }

    // Model registrations survive a reseed: they are facts about the plants, and plants may seed first.
    async loadSeed(c: CompanySeed): Promise<CompanyState> {
        if (!Array.isArray(c?.plants) || !Array.isArray(c?.sharedResources)) fail("invalid_seed", "company needs plants and sharedResources")
        await this.db.transaction(async () => {
            this.plants = c.plants
            this.sharedResources = c.sharedResources
            this.rules = c.rules ?? []
            this.crossPlantProposals = c.crossPlantProposals ?? []
            this.audit = c.audit ?? []
            this.leases = {}
        })
        return this.getState()
    }

    // The veto-window guarantee spans plants: two windows must not stack on one shared resource.
    // The TTL frees a resource if the holding plant dies before releasing it.
    async acquireLease(resources: string[], proposalId: string, ttlMs: number): Promise<boolean> {
        const now = Date.now()
        const heldElsewhere = resources.some(resource => {
            const lease = this.leases[resource]
            return lease !== undefined && lease.proposalId !== proposalId && lease.expiresAt > now
        })
        if (heldElsewhere) return false
        const granted = Object.fromEntries(resources.map(resource => [resource, { proposalId, expiresAt: now + ttlMs }]))
        this.leases = { ...this.leases, ...granted }
        return true
    }

    async releaseLease(proposalId: string): Promise<void> {
        const remaining = Object.entries(this.leases).filter(([, lease]) => lease.proposalId !== proposalId)
        if (remaining.length !== Object.keys(this.leases).length) this.leases = Object.fromEntries(remaining)
    }

    async registerPlant(id: PlantId, models?: string[]): Promise<CompanyState> {
        if (!isNonEmptyString(id)) fail("invalid_plant", "id is required")
        await this.db.transaction(async () => {
            if (!this.plants.includes(id)) this.plants = [...this.plants, id]
            if (models !== undefined) this.plantModels = { ...this.plantModels, [id]: models }
        })
        return this.getState()
    }

    async modelExistsElsewhere(plantId: PlantId, model: string): Promise<boolean> {
        return Object.entries(this.plantModels).some(([id, models]) => id !== plantId && models.includes(model))
    }

    async requiredCrossPlantVoters(proposal: Proposal): Promise<ComponentId[]> {
        return crossPlantVoters({
            plantId: proposal.plantId,
            proposerComponentId: proposal.proposerComponentId,
            requiredVoters: proposal.requiredVoters,
            sharedResources: this.sharedResources
        })
    }

    async promoteRule(r: LearnedRule): Promise<LearnedRule> {
        assertRuleShape(r)
        const at = nowIso()
        const { rules, rule } = mergeCompanyRule(this.rules, { ...r, scope: "company" }, at)
        await this.db.transaction(async () => {
            this.rules = rules
            this.audit = capped([...this.audit, { at, plantId: "company" as const, kind: "rule_learned" as const, refId: rule.id, summary: rule.text, by: "company" }], AUDIT_CAP)
        })
        return rule
    }

    async addCrossPlantProposal(proposalId: string): Promise<void> {
        if (!isNonEmptyString(proposalId)) fail("invalid_proposal", "proposalId is required")
        if (!this.crossPlantProposals.includes(proposalId)) this.crossPlantProposals = [...this.crossPlantProposals, proposalId]
    }

    async recordAudit(a: AuditEntry): Promise<void> {
        assertAuditEntry(a)
        this.audit = capped([...this.audit, a], AUDIT_CAP)
    }
}

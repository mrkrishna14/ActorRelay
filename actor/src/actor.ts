import { Actor, Emittable, Persisted } from "terse-sdk/actor"
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
} from "../../shared/types"
import {
    ACTOR_CALL_TIMEOUT_MS,
    AUDIT_CAP,
    CALLBACK_MAX_ATTEMPTS,
    CALLBACK_RETRY_MS,
    CLAIM_TIMEOUT_MS,
    FETCH_TIMEOUT_MS,
    PROPOSAL_CAP,
    SWEEP_EVERY_TICKS,
    TICK_MS,
    glueUrl
} from "./config"
import { COMPANY_ACTOR_ID, agentIdFor, componentActorId, proposalIdFor } from "./ids"
import { applyCalibration, clampMargin, computeStatus } from "./logic/component"
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
} from "./logic/proposals"
import {
    crossPlantVoters,
    deriveRules,
    mergeCompanyRule,
    mergeDerivedRules,
    mergeSubmittedRule,
    toCompanyRule,
    type ComponentDef,
    type Topology
} from "./logic/rules"
import { rankSimilar } from "./logic/similar"
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
} from "./logic/validate"

export type PlantSeed = { id: PlantId; name: string; components: ComponentState[] }
export type CompanySeed = Partial<CompanyState> & Pick<CompanyState, "plants" | "sharedResources">
export type ExecutionState = "accepted" | "claimed" | "applied" | "observed" | "failed"
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
export type EventInput = Partial<HistoryEvent> & { proposalId?: string | null; effects: HistoryEvent["effects"] }
export type ComponentSnapshot = ComponentState & { calibration: CalibrationEntry[] }

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

// Local alarms may not survive a runtime restart, so every entry point re-arms a missing or overdue alarm.
function armAlarm(alarm: Actor["alarm"]): void {
    const now = Date.now()
    const scheduled = alarm.get()
    if (scheduled === null || scheduled <= now) alarm.set(now + TICK_MS)
}

export class Component extends Actor {
    @Persisted private componentId = ""
    @Persisted private sinceAdjustment = 0

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
        const summary = `${this.tag} ${entry.metric} predicted ${entry.predicted}, observed ${entry.observed}, error ${entry.absError}`
        void Plant.get(this.plantId)
            .recordAudit({ at: entry.at, plantId: this.plantId, kind: "calibration", refId: entry.proposalId, summary, by: agentIdFor(this.componentId) })
            .catch(() => undefined)
        return this.#publishState()
    }

    async setMargin(pct: number): Promise<ComponentSnapshot> {
        this.#requireSeed()
        if (!isFiniteNumber(pct)) fail("invalid_margin", "margin must be finite")
        this.marginPct = clampMargin(pct)
        return this.#publishState()
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

    @Persisted @Emittable name = ""
    @Persisted @Emittable components: ComponentId[] = []
    @Persisted @Emittable proposals: Proposal[] = []
    @Persisted @Emittable history: HistoryEvent[] = []
    @Persisted @Emittable rules: LearnedRule[] = []
    @Persisted @Emittable audit: AuditEntry[] = []
    @Persisted @Emittable tickCount = 0
    @Persisted @Emittable connected = false

    async getState(): Promise<PlantState> {
        if (this.seeded) armAlarm(this.alarm)
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
            this.seq = 0
            this.tickCount = 0
            this.seeded = true
        })
        armAlarm(this.alarm)
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

        await this.db.transaction(async () => {
            this.seq = this.seq + 1
            this.proposals = capped([...this.proposals, proposal], PROPOSAL_CAP)
            this.audit = this.#withAudit([
                { at: proposal.at, kind: "proposal", refId: proposal.id, summary: `${proposal.metric} ${proposal.from} → ${proposal.to}: ${proposal.rationale}`, by: proposal.proposerAgentId }
            ])
        })
        if (proposal.crossPlant) await this.#notifyCompany(company.addCrossPlantProposal(proposal.id))
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
        const vote = enforceVoteSafety(incoming, def)

        const withdrawn = proposal.status === "veto_window"
        const updated: Proposal = withdrawn
            ? { ...proposal, votes: proposal.votes.map(item => (item.componentId === vote.componentId ? vote : item)), status: "blocked", vetoDeadline: null }
            : { ...proposal, votes: [...proposal.votes, vote] }
        const at = nowIso()
        const entries: Omit<AuditEntry, "plantId">[] = [{ at, kind: "vote", refId: proposal.id, summary: `${vote.componentId} voted ${vote.vote}: ${vote.reason}`, by: vote.agentId }]
        if (withdrawn) entries.push({ at, kind: "block", refId: proposal.id, summary: `Blocked in veto window by ${vote.componentId}: ${vote.reason}`, by: vote.agentId })
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
    async claimDispatch(proposalId: string): Promise<DispatchClaim> {
        this.#assertSeeded()
        if (!Object.hasOwn(this.executions, proposalId)) fail("not_accepted", `${proposalId} has not been accepted`)
        const execution = this.executions[proposalId]
        if (execution.state !== "accepted") return { dispatch: false, proposalId, state: execution.state }
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
        if (execution.state !== "claimed") fail("invalid_token", `execution is ${execution.state}`)
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
        return this.#failExecution(execution, isNonEmptyString(reason) ? reason : "dispatch failed")
    }

    async recordEvent(e: EventInput): Promise<HistoryEvent> {
        this.#assertSeeded()
        assertEffects(e?.effects)
        const proposalId = e.proposalId ?? null
        if (proposalId !== null) {
            const existing = this.history.find(event => event.proposalId === proposalId)
            if (existing !== undefined) return existing
        }
        const event = proposalId === null ? this.#eventFromCaller(e) : this.#eventFromProposal(proposalId, e)
        if (this.history.some(item => item.id === event.id)) fail("duplicate_event", event.id)

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
            if (proposalId !== null) {
                const execution = this.executions[proposalId]
                this.executions = { ...this.executions, [proposalId]: { ...execution, state: "observed", observedAt: event.at } }
            }
        })
        await this.#flushCompanyOutbox()
        return event
    }

    async promoteRule(r: LearnedRule): Promise<LearnedRule> {
        this.#assertSeeded()
        assertRuleShape(r)
        const known = new Set(this.history.map(event => event.id))
        const missing = r.supportEventIds.find(id => !known.has(id))
        if (missing !== undefined) fail("invalid_rule", `supporting event ${missing} is not in history`)
        const at = nowIso()
        const { rules, rule } = mergeSubmittedRule(this.rules, r, at)
        await this.db.transaction(async () => {
            this.rules = rules
            this.companyOutbox = this.#withOutbox([rule])
            this.audit = this.#withAudit([{ at, kind: "rule_learned", refId: rule.id, summary: rule.text, by: "plant" }])
        })
        await this.#flushCompanyOutbox()
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
        armAlarm(this.alarm)
        return this.tickCount
    }

    async sweep(): Promise<void> {
        this.#assertSeeded()
        const now = Date.now()
        const plan = planSweep(this.proposals, this.setpoints, now)
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
        await this.#flushCompanyOutbox()
    }

    async onAlarm(): Promise<void> {
        // Re-armed first: an uncaught failure below must not end the tick loop.
        this.alarm.set(Date.now() + TICK_MS)
        try {
            await this.tick()
        } catch (error) {
            console.error(`Plant ${this.id} tick failed: ${errorText(error)}`)
        }
    }

    #assertSeeded(): void {
        if (!this.seeded) fail("not_seeded", `${this.id} has no seed`)
        armAlarm(this.alarm)
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
        if (execution.state !== "claimed" && execution.state !== "applied") fail("not_dispatched", `${proposalId} is ${execution.state}`)
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

    #eventFromCaller(e: EventInput): HistoryEvent {
        assertHistoryEvent(e)
        if (e.plantId !== this.id) fail("invalid_event", `event for ${e.plantId} sent to ${this.id}`)
        return e
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
            // At most once: a claim that never finished is reported, not retried, because the write may have landed.
            if (execution.state === "claimed" && now - Date.parse(execution.claimedAt ?? execution.acceptedAt) >= CLAIM_TIMEOUT_MS) {
                await this.#failExecution(execution, "claimed dispatch never confirmed; simulator outcome unknown")
            }
        }
    }

    async #failExecution(execution: Execution, reason: string): Promise<Execution> {
        const at = nowIso()
        const failed: Execution = { ...execution, state: "failed", failedAt: at, failure: reason }
        const proposal = this.proposals.find(item => item.id === execution.proposalId)
        await this.db.transaction(async () => {
            this.executions = { ...this.executions, [execution.proposalId]: failed }
            this.audit = this.#withAudit([{ at, kind: "incident", refId: execution.proposalId, summary: `Dispatch failed: ${reason}`, by: "plant" }])
            if (proposal !== undefined) {
                this.proposals = this.proposals.map(item => (item.id === proposal.id ? { ...proposal, status: "expired" as const } : item))
                this.setpoints = this.#withSetpoint(proposal, proposal.from)
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

    // Company failures never fail a plant write; unsent rules stay in the outbox for the next sweep.
    async #flushCompanyOutbox(): Promise<void> {
        const company = Company.get(COMPANY_ACTOR_ID)
        try {
            if (!this.registeredWithCompany) {
                const models = [...new Set(Object.values(this.topology).map((def: ComponentDef) => def.model))]
                await withTimeout(company.registerPlant(this.id as PlantId, models), "Company.registerPlant")
                this.registeredWithCompany = true
            }
            for (const rule of this.companyOutbox) {
                if (rule.model !== null && !(await withTimeout(company.modelExistsElsewhere(this.id as PlantId, rule.model), "Company.modelExistsElsewhere"))) continue
                if (rule.model !== null) await withTimeout(company.promoteRule(toCompanyRule(rule, this.id)), "Company.promoteRule")
                this.companyOutbox = this.companyOutbox.filter(item => item.id !== rule.id)
            }
        } catch (error) {
            console.error(`Plant ${this.id} could not reach Company: ${errorText(error)}`)
        }
    }

    async #notifyCompany(pending: Promise<unknown>): Promise<void> {
        await withTimeout(pending, "Company notification").catch(error => console.error(`Plant ${this.id} could not reach Company: ${errorText(error)}`))
    }

    async #assertRulesExist(ids: string[]): Promise<void> {
        const mine = new Set(this.rules.map(rule => rule.id))
        const unknown = ids.filter(id => !mine.has(id))
        if (unknown.length === 0) return
        const company = await withTimeout(Company.get(COMPANY_ACTOR_ID).getState(), "Company.getState")
        const known = new Set(company.rules.map(rule => rule.id))
        const invented = unknown.find(id => !known.has(id))
        if (invented !== undefined) fail("invalid_vote", `evidence rule ${invented} does not exist`)
    }
}

export class Company extends Actor {
    @Persisted private plantModels: Record<string, string[]> = {}

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
        })
        return this.getState()
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

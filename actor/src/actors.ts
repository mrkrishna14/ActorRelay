import { ref } from "./actorCalls.js"
import { Actor, Emittable, Persisted, type ActorSocket } from "terse-sdk/actor"
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
    Vote,
} from "./types.js"
import {
    actorIdFor,
    componentIdFor,
    crossPlantVoters,
    nextMargin,
    plantOf,
    rangeOf,
    reachableVoters,
    ruleKey,
    rulesFromEvent,
    safeThreshold,
    similarEvents,
    statusFor,
    tagOf,
    executeToken,
    verifyExecuteToken,
    env,
    type ComponentInfo,
} from "./logic.js"
import {
    CalibrationEntrySchema, ComponentStateSchema, DispatchResultSchema, HistoryEventSchema, LearnedRuleSchema,
    MetricsSchema, ProposalInputSchema, VoteSchema, parse,
} from "./schemas.js"

export const COMPANY_ID = "company"
const AUDIT_KEEP = 300
const nowIso = () => new Date().toISOString()
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)

type Ping = { type: "ping" }

// ====================================================================== Component

export type ComponentSnapshot = ComponentState & { calibration: CalibrationEntry[] }

/**
 * One per component. Actor id = ComponentId with "/" → "." (e.g. "plant-a.LV-101").
 * Socket state = ComponentState (without `id`, which is the actor id) + calibration.
 */
export class Component extends Actor<null, Ping, Ping> {
    @Persisted @Emittable plantId: PlantId = "plant-a"
    @Persisted @Emittable tag = ""
    @Persisted @Emittable name = ""
    @Persisted @Emittable model = ""
    @Persisted @Emittable role: Role = "mechanic"
    @Persisted @Emittable vendor: Vendor = "claude"
    @Persisted @Emittable metrics: Record<string, number> = {}
    @Persisted @Emittable limits: Record<string, Limit> = {}
    @Persisted @Emittable upstream: ComponentId[] = []
    @Persisted @Emittable downstream: ComponentId[] = []
    @Persisted @Emittable sharedResources: string[] = []
    @Persisted @Emittable status: ComponentState["status"] = "offline"
    @Persisted @Emittable marginPct = 10
    @Persisted @Emittable lastTick = "1970-01-01T00:00:00.000Z"
    @Persisted @Emittable calibration: CalibrationEntry[] = []
    /** Proposal ids already applied through setMetric: each token works once. */
    @Persisted private usedProposals: string[] = []

    async read(): Promise<ComponentSnapshot> {
        return {
            id: componentIdFor(this.id), plantId: this.plantId, tag: this.tag, name: this.name, model: this.model,
            role: this.role, vendor: this.vendor, metrics: this.metrics, limits: this.limits,
            upstream: this.upstream, downstream: this.downstream, sharedResources: this.sharedResources,
            status: this.status, marginPct: this.marginPct, lastTick: this.lastTick, calibration: this.calibration,
        }
    }

    async loadSeed(seed: ComponentState & { calibration?: CalibrationEntry[] }): Promise<ComponentSnapshot> {
        const state = { ...parse(ComponentStateSchema, seed, "component seed"), calibration: (seed.calibration ?? []).map(c => parse(CalibrationEntrySchema, c, "calibration entry")) }
        if (state.id !== componentIdFor(this.id)) throw new Error(`seed for ${state.id} sent to component ${componentIdFor(this.id)}`)
        this.plantId = state.plantId
        this.tag = state.tag
        this.name = state.name
        this.model = state.model
        this.role = state.role
        this.vendor = state.vendor
        this.metrics = { ...state.metrics }
        this.limits = { ...state.limits }
        this.upstream = [...state.upstream]
        this.downstream = [...state.downstream]
        this.sharedResources = [...state.sharedResources]
        this.marginPct = Math.min(25, Math.max(5, state.marginPct))
        this.lastTick = state.lastTick
        this.calibration = [...(state.calibration ?? [])].slice(-50)
        this.usedProposals = []
        this.status = statusFor(this.metrics, this.limits)
        return this.read()
    }

    /** Live values from the simulation (via the integration service), every tick. */
    async mirror(input: Record<string, number>): Promise<ComponentState["status"]> {
        const metrics = parse(MetricsSchema, input, "metrics")
        const next = { ...this.metrics }
        for (const [key, value] of Object.entries(metrics)) if (finite(value)) next[key] = value
        this.metrics = next
        this.status = statusFor(this.metrics, this.limits)
        this.lastTick = nowIso()
        return this.status
    }

    /** Only Plant.confirmDispatch can mint `token`, and only for a proposal whose veto window passed. */
    async setMetric(metric: string, value: number, proposalId: string, token: string): Promise<ComponentSnapshot> {
        const id = componentIdFor(this.id)
        if (!finite(value)) throw new Error("value must be a finite number")
        if (!this.limits[metric] && !(metric in this.metrics)) throw new Error(`unknown metric ${metric} on ${id}`)
        if (this.usedProposals.includes(proposalId)) throw new Error(`token_already_used: proposal ${proposalId} already applied to ${id}`)
        if (!verifyExecuteToken(token, proposalId, id, metric, value)) throw new Error(`rejected: no valid execute token for ${proposalId}`)
        this.metrics = { ...this.metrics, [metric]: value }
        this.status = statusFor(this.metrics, this.limits)
        this.usedProposals = [...this.usedProposals, proposalId].slice(-200)
        return this.read()
    }

    async addCalibration(input: CalibrationEntry): Promise<ComponentSnapshot> {
        const e = parse(CalibrationEntrySchema, input, "calibration entry")
        const entry: CalibrationEntry = { ...e, absError: Math.abs(e.predicted - e.observed) }
        this.calibration = [...this.calibration, entry].slice(-50)
        this.marginPct = nextMargin(this.calibration, this.limits, this.marginPct)
        return this.read()
    }

    async setMargin(pct: number): Promise<number> {
        if (!finite(pct)) throw new Error("pct must be a finite number")
        this.marginPct = Math.min(25, Math.max(5, pct))
        return this.marginPct
    }

    async onMessage(_socket: ActorSocket<null, Ping>, _message: Ping) {}
}

// ====================================================================== Plant

export type PlantSeed = { id: PlantId; name: string; components: ComponentState[] }
export type PlantOptions = { vetoWindowMs?: number; voteTimeoutMs?: number; clock?: boolean }
export type ProposalInput = {
    /** Optional client id: re-sending the same id returns the existing proposal (safe retries). */
    id?: string
    proposerComponentId: ComponentId
    proposerAgentId?: string
    metric: string
    /** Defaults to the proposer's current value. */
    from?: number
    to: number
    rationale: string
    parentProposalId?: string | null
}
export type DispatchView = {
    proposalId: string; componentId: ComponentId; metric: string; value: number
    state: "pending" | "claimed" | "accepted" | "failed"; createdAt: string; settledAt: string | null; error: string | null
}
export type DispatchResult = { ok: boolean; applied?: number; error?: string }
type Dispatch = DispatchView & { token: string }
type PlantConfig = { vetoWindowMs: number; voteTimeoutMs: number; clock: boolean; glueUrl?: string | null; callbackToken?: string | null }
export type GlueConfig = { glueUrl?: string | null; callbackToken?: string | null }
export type DispatchClaim =
    | { dispatch: true; proposalId: string; componentId: ComponentId; metric: string; value: number; token: string }
    | { dispatch: false; proposalId: string; state: string }
export type PlantOutgoing = Ping | ({ type: "dispatch" } & DispatchView)

/**
 * One per plant. Actor id = PlantId ("plant-a"). Socket state = PlantState without `id`.
 * The PlantState field `tick` is a number, so the tick method is `advanceTick()`.
 */
export class Plant extends Actor<null, Ping, PlantOutgoing> {
    @Persisted @Emittable name = ""
    @Persisted @Emittable components: ComponentId[] = []
    @Persisted @Emittable proposals: Proposal[] = []
    @Persisted @Emittable history: HistoryEvent[] = []
    @Persisted @Emittable rules: LearnedRule[] = []
    @Persisted @Emittable audit: AuditEntry[] = []
    @Persisted @Emittable tick = 0
    @Persisted @Emittable connected = false

    @Persisted private info: Record<ComponentId, ComponentInfo> = {}
    @Persisted private dispatches: Record<string, Dispatch> = {}
    @Persisted private lastExecutedAt: Record<ComponentId, string> = {}
    @Persisted private seq = 0
    @Persisted private lastHeartbeat = 0
    @Persisted private config: PlantConfig = { vetoWindowMs: 10_000, voteTimeoutMs: 30_000, clock: true }

    async read(): Promise<PlantState> {
        return {
            id: (this.id as PlantId), name: this.name, components: this.components, proposals: this.proposals,
            history: this.history, rules: this.rules, audit: this.audit, tick: this.tick, connected: this.connected,
        }
    }

    /** Resets this plant: components, history (replayed for rules), clears proposals. Seeds each Component too. */
    async loadSeed(seed: PlantSeed, seedHistory: HistoryEvent[], options?: PlantOptions): Promise<PlantState> {
        const plant: PlantSeed = { id: seed.id, name: String(seed.name ?? seed.id), components: (seed.components ?? []).map(c => parse(ComponentStateSchema, c, `component ${c?.id}`)) }
        const history = (seedHistory ?? []).map(e => parse(HistoryEventSchema, e, `history event ${e?.id}`))
        if (plant.id !== (this.id as PlantId)) throw new Error(`seed for ${plant.id} sent to plant ${(this.id as PlantId)}`)
        this.config = {
            vetoWindowMs: options?.vetoWindowMs ?? 10_000,
            voteTimeoutMs: options?.voteTimeoutMs ?? 30_000,
            clock: options?.clock ?? true,
            glueUrl: this.config.glueUrl ?? null, // integration settings survive a reset
            callbackToken: this.config.callbackToken ?? null,
        }
        const info: Record<ComponentId, ComponentInfo> = {}
        for (const c of plant.components) {
            if (c.plantId !== (this.id as PlantId)) throw new Error(`component ${c.id} is not in ${(this.id as PlantId)}`)
            info[c.id] = { id: c.id, plantId: c.plantId, tag: c.tag, model: c.model, limits: c.limits, upstream: c.upstream, downstream: c.downstream, sharedResources: c.sharedResources }
            await ref<Component>("Component", actorIdFor(c.id)).loadSeed(c)
        }
        this.info = info
        this.name = plant.name
        this.components = plant.components.map(c => c.id)
        this.proposals = []
        this.dispatches = {}
        this.lastExecutedAt = {}
        this.seq = 0
        this.tick = 0
        this.audit = []

        const company = ref<Company>("Company", COMPANY_ID)
        await company.registerPlant((this.id as PlantId), Object.fromEntries(plant.components.map(c => [c.id, c.model])))

        // Replay seed history in order so rules reflect it, then share them once.
        const own = history.filter(e => e.plantId === (this.id as PlantId))
        let replay: HistoryEvent[] = []
        let rules: LearnedRule[] = []
        for (const e of own) {
            replay = [...replay, e]
            for (const r of rulesFromEvent(replay, e, info, e.at, rules)) rules = upsertRule(rules, r)
        }
        this.history = replay
        this.rules = rules
        for (const r of rules) await company.promoteRule(r)

        this.lastHeartbeat = 0
        this.connected = false
        if (this.config.clock) this.alarm.set(Date.now() + 1000)
        else this.alarm.delete()
        return this.read()
    }

    async propose(input: ProposalInput): Promise<Proposal> {
        const p = parse(ProposalInputSchema, input, "proposal")
        if (p.id) {
            const existing = this.proposals.find(x => x.id === p.id)
            if (existing) return existing
        }
        const proposer = this.info[p.proposerComponentId]
        if (!proposer) throw new Error(`${p.proposerComponentId} is not a component of ${(this.id as PlantId)}`)
        const limit = proposer.limits[p.metric]
        if (!limit) throw new Error(`${p.proposerComponentId} has no limit for ${p.metric}`)
        if (!finite(p.to) || p.to < limit.min || p.to > limit.critical) {
            throw new Error(`to=${p.to} is outside ${p.metric} limits [${limit.min}, ${limit.critical}]`)
        }
        if (p.parentProposalId) {
            const parent = this.proposals.find(x => x.id === p.parentProposalId)
            if (!parent) throw new Error(`unknown parent proposal ${p.parentProposalId}`)
            if (this.proposals.filter(x => x.parentProposalId === p.parentProposalId).length >= 2) {
                throw new Error(`parent ${p.parentProposalId} already has 2 counter-proposals`)
            }
        }
        const from = finite(p.from) ? p.from : (await ref<Component>("Component", actorIdFor(p.proposerComponentId)).read()).metrics[p.metric]
        if (!finite(from)) throw new Error(`no current value of ${p.metric} on ${p.proposerComponentId}`)

        this.seq += 1
        const draft: Proposal = {
            id: p.id ?? `${(this.id as PlantId)}-p${String(this.seq).padStart(4, "0")}`,
            at: nowIso(), plantId: (this.id as PlantId), proposerComponentId: p.proposerComponentId,
            proposerAgentId: p.proposerAgentId ?? `agent:${p.proposerComponentId}`,
            metric: p.metric, from, to: p.to, rationale: p.rationale,
            requiredVoters: reachableVoters(this.info, p.proposerComponentId), votes: [],
            status: "voting", vetoDeadline: null, parentProposalId: p.parentProposalId ?? null, crossPlant: false,
        }
        const cross = await ref<Company>("Company", COMPANY_ID).requiredCrossPlantVoters(draft)
        const proposal: Proposal = { ...draft, requiredVoters: [...draft.requiredVoters, ...cross], crossPlant: cross.length > 0 }
        this.proposals = [...this.proposals, proposal]
        const summary = `${tagOf(proposal.proposerComponentId)} ${proposal.metric} ${from} → ${proposal.to}${proposal.parentProposalId ? ` (counter to ${proposal.parentProposalId})` : ""}; voters ${proposal.requiredVoters.join(", ")}`
        this.audit = addAudit(this.audit, this.id as PlantId, "proposal", proposal.id, summary, proposal.proposerAgentId)
        if (proposal.crossPlant) await ref<Company>("Company", COMPANY_ID).recordAudit({ at: proposal.at, plantId: "company", kind: "proposal", refId: proposal.id, summary, by: proposal.proposerAgentId })
        return proposal
    }

    /** Validates, enforces safety thresholds in code, then re-evaluates the proposal. */
    async vote(input: Vote): Promise<Proposal> {
        const v = parse(VoteSchema, input, "vote")
        const p = this.proposals.find(x => x.id === v.proposalId)
        if (!p) throw new Error(`unknown proposal ${v.proposalId}`)
        // A blocked proposal still records late votes (every voter's evidence shows); its status stays blocked.
        if (p.status !== "voting" && p.status !== "blocked") throw new Error(`proposal ${p.id} is ${p.status}, not voting`)
        if (!p.requiredVoters.includes(v.componentId)) throw new Error(`${v.componentId} is not a required voter on ${p.id}`)
        if (p.votes.some(x => x.componentId === v.componentId)) throw new Error(`duplicate vote from ${v.componentId} on ${p.id}`)
        if (v.vote !== "yes" && v.vote !== "no") throw new Error("vote must be yes or no")
        if (!Number.isInteger(v.similarCount) || v.similarCount < 0) throw new Error("similarCount must be a non-negative integer")
        if (plantOf(v.componentId) === (this.id as PlantId)) {
            const known = new Set(this.history.map(e => e.id))
            const unknown = v.evidenceEventIds.filter(id => !known.has(id))
            if (unknown.length > 0) throw new Error(`unknown evidence event ids: ${unknown.join(", ")}`)
        }

        const voter = await ref<Component>("Component", actorIdFor(v.componentId)).read()
        let vote = v.vote
        const notes: string[] = []
        for (const [metric, predicted] of Object.entries(v.predicted)) {
            const limit = voter.limits[metric]
            if (!limit || !finite(predicted)) continue
            const threshold = safeThreshold(limit, voter.marginPct)
            if (vote === "yes" && predicted >= threshold) {
                vote = "no"
                notes.push(`predicted ${metric} ${predicted} ≥ ${round(threshold)} (critical ${limit.critical} − margin ${voter.marginPct}%)`)
            }
            if (vote === "yes" && v.similarCount < 3 && predicted >= limit.critical * 0.85) {
                vote = "no"
                notes.push(`insufficient history: ${v.similarCount} similar events and ${metric} within 15% of critical`)
            }
        }
        const recorded: Vote = { ...v, vote, marginPct: voter.marginPct, reason: notes.length ? `[enforced] ${notes.join("; ")}. ${v.reason}` : v.reason }
        let updated: Proposal = { ...p, votes: [...p.votes, recorded] }
        this.audit = addAudit(this.audit, this.id as PlantId, "vote", p.id, `${tagOf(v.componentId)} (${v.componentId}) votes ${vote}: ${recorded.reason}`, v.agentId)
        const evaluated = p.status === "blocked" ? { proposal: updated, note: null } : evaluateProposal(updated, this.proposals, this.config.vetoWindowMs)
        updated = evaluated.proposal
        if (evaluated.note) this.audit = addAudit(this.audit, this.id as PlantId, evaluated.note.kind, p.id, evaluated.note.summary, "plant")
        this.proposals = replaceProposal(this.proposals, updated)
        return updated
    }

    async veto(proposalId: string, by: string): Promise<Proposal> {
        const p = this.proposals.find(x => x.id === proposalId)
        if (!p) throw new Error(`unknown proposal ${proposalId}`)
        if (p.status !== "veto_window") throw new Error(`proposal ${p.id} is ${p.status}; only a veto window can be vetoed`)
        if (this.dispatches[p.id] || (p.vetoDeadline && Date.parse(p.vetoDeadline) <= Date.now())) throw new Error(`veto window for ${p.id} has closed`)
        const updated: Proposal = { ...p, status: "vetoed" }
        this.proposals = replaceProposal(this.proposals, updated)
        this.audit = addAudit(this.audit, this.id as PlantId, "veto", p.id, `vetoed by ${by}`, by)
        return updated
    }

    /** Time-based transitions: expire stale votes, open queued veto windows, execute when the window passes. */
    async sweep(): Promise<Proposal[]> {
        const now = Date.now()
        for (const p of this.proposals) {
            if (p.status === "voting") {
                const evaluated = evaluateProposal(p, this.proposals, this.config.vetoWindowMs)
                const next = evaluated.proposal
                if (evaluated.note) this.audit = addAudit(this.audit, this.id as PlantId, evaluated.note.kind, p.id, evaluated.note.summary, "plant")
                if (next.status === "voting" && now - Date.parse(p.at) > this.config.voteTimeoutMs) {
                    this.proposals = replaceProposal(this.proposals, { ...next, status: "expired" })
                    this.audit = addAudit(this.audit, this.id as PlantId, "block", p.id, `expired: ${p.requiredVoters.length - p.votes.length} vote(s) missing after ${this.config.voteTimeoutMs / 1000}s`, "plant")
                } else if (next !== p) this.proposals = replaceProposal(this.proposals, next)
            } else if (p.status === "veto_window" && p.vetoDeadline && Date.parse(p.vetoDeadline) <= now && !this.dispatches[p.id]) {
                await this.execute(p.id)
            }
        }
        return this.proposals
    }

    /**
     * Approves dispatch of a proposal whose veto window has passed. Revalidates first; does not write anything.
     * The simulation write happens in the integration service, which reports back through confirmDispatch.
     */
    async execute(proposalId: string): Promise<DispatchView | null> {
        const p = this.proposals.find(x => x.id === proposalId)
        if (!p) throw new Error(`unknown proposal ${proposalId}`)
        const prior = this.dispatches[p.id]
        if (prior) return publicDispatch(prior)
        if (p.status !== "veto_window" || !p.vetoDeadline) throw new Error(`proposal ${p.id} is ${p.status}, not in a veto window`)
        if (Date.parse(p.vetoDeadline) > Date.now()) throw new Error(`veto window for ${p.id} is still open`)
        if (!p.requiredVoters.every(id => p.votes.some(v => v.componentId === id && v.vote === "yes"))) throw new Error(`proposal ${p.id} lacks unanimous yes`)

        const last = this.lastExecutedAt[p.proposerComponentId]
        if (last && last > p.at) {
            this.proposals = replaceProposal(this.proposals, { ...p, status: "expired" })
            this.audit = addAudit(this.audit, this.id as PlantId, "block", p.id, `stale: ${tagOf(p.proposerComponentId)} changed by another execution after this proposal`, "plant")
            return null
        }
        const proposer = await ref<Component>("Component", actorIdFor(p.proposerComponentId)).read()
        const limit = proposer.limits[p.metric]!
        const ceiling = safeThreshold(limit, proposer.marginPct)
        if (p.to < limit.min || p.to > ceiling) {
            this.proposals = replaceProposal(this.proposals, { ...p, status: "blocked" })
            this.audit = addAudit(this.audit, this.id as PlantId, "block", p.id, `limit check before dispatch: ${p.to} outside [${limit.min}, ${round(ceiling)}]`, "plant")
            return null
        }
        const dispatch: Dispatch = {
            proposalId: p.id, componentId: p.proposerComponentId, metric: p.metric, value: p.to, state: "pending",
            createdAt: nowIso(), settledAt: null, error: null, token: "",
        }
        this.dispatches = { ...this.dispatches, [p.id]: dispatch }
        // The decision is executed now; the simulation write is a separate, recorded step (claim/confirm).
        this.proposals = replaceProposal(this.proposals, { ...p, status: "executed" })
        this.lastExecutedAt = { ...this.lastExecutedAt, [p.proposerComponentId]: dispatch.createdAt }
        this.audit = addAudit(this.audit, this.id as PlantId, "execute", p.id, `approved for dispatch: ${tagOf(p.proposerComponentId)} ${p.metric} → ${p.to}`, "plant")
        const view = publicDispatch(dispatch)
        this.broadcast({ type: "dispatch", ...view })
        await this.notifyGlue(p.id)
        return view
    }

    /**
     * Best-effort POST <glue>/execute-callback {proposalId}. Glue answers only after it calls back into this
     * Plant (claimDispatch), which waits for this call to finish, so we never wait for the answer: a short
     * timeout just releases the actor. Failures never roll back the decision.
     */
    async notifyGlue(proposalId: string): Promise<boolean> {
        const glue = env("GLUE_URL") ?? this.config.glueUrl
        if (!glue) return false
        const token = env("EXECUTION_CALLBACK_TOKEN") ?? this.config.callbackToken
        try {
            await fetch(`${glue.replace(/\/$/, "")}/execute-callback`, {
                method: "POST",
                headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
                body: JSON.stringify({ proposalId }),
                signal: AbortSignal.timeout(400),
            })
        } catch (error) {
            const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
            if (!timedOut) {
                this.audit = addAudit(this.audit, this.id as PlantId, "execute", proposalId, `execute-callback to glue failed: ${String(error).slice(0, 160)}`, "plant")
                return false
            }
        }
        this.audit = addAudit(this.audit, this.id as PlantId, "execute", proposalId, "execute-callback sent to glue", "plant")
        return true
    }

    /** Integration settings for the execute callback. GLUE_URL / EXECUTION_CALLBACK_TOKEN on the actor host win. */
    async configure(input: GlueConfig): Promise<GlueConfig> {
        const url = input?.glueUrl ?? null
        if (url !== null && !/^https?:\/\/[^\s]+$/.test(String(url))) throw new Error("glueUrl must be an http(s) URL")
        const token = input?.callbackToken ?? null
        if (token !== null && (typeof token !== "string" || token.length > 512)) throw new Error("callbackToken must be a string")
        this.config = { ...this.config, glueUrl: url, callbackToken: token }
        return { glueUrl: url, callbackToken: token ? "<set>" : null }
    }

    /** Glue's handshake: exactly one caller gets the one-time token for the approved write; later callers get dispatch:false. */
    async claimDispatch(proposalId: string): Promise<DispatchClaim> {
        if (typeof proposalId !== "string" || !proposalId) throw new Error("proposalId must be a non-empty string")
        const p = this.proposals.find(x => x.id === proposalId)
        if (!p) throw new Error(`unknown proposal ${proposalId}`)
        const d = this.dispatches[proposalId]
        if (!d) throw new Error(`no approved dispatch for ${proposalId}`)
        if (d.state !== "pending") return { dispatch: false, proposalId, state: d.state }
        const token = executeToken(proposalId, d.componentId, d.metric, d.value)
        this.dispatches = { ...this.dispatches, [proposalId]: { ...d, state: "claimed", token } }
        this.audit = addAudit(this.audit, this.id as PlantId, "execute", proposalId, `dispatch claimed: ${tagOf(d.componentId)} ${d.metric} → ${d.value}`, "glue")
        return { dispatch: true, proposalId, componentId: d.componentId, metric: d.metric, value: d.value, token }
    }

    /** Glue reports a refused or unknown simulation write. Idempotent; an accepted write cannot be failed. */
    async reportDispatchFailure(proposalId: string, reason: string): Promise<DispatchView> {
        if (typeof proposalId !== "string" || !proposalId) throw new Error("proposalId must be a non-empty string")
        const why = String(reason ?? "dispatch failed").slice(0, 1000)
        const d = this.dispatches[proposalId]
        if (!d) throw new Error(`no approved dispatch for ${proposalId}`)
        if (d.state === "failed" || d.state === "accepted") return publicDispatch(d)
        const p = this.proposals.find(x => x.id === proposalId)!
        const failed: Dispatch = { ...d, state: "failed", settledAt: nowIso(), error: why }
        this.dispatches = { ...this.dispatches, [proposalId]: failed }
        this.proposals = replaceProposal(this.proposals, { ...p, status: "blocked" })
        this.audit = addAudit(this.audit, this.id as PlantId, "block", proposalId, `dispatch failed: ${why}`, "glue")
        return publicDispatch(failed)
    }

    /** Durable list of approved writes the integration service has not reported on yet. */
    async pendingDispatches(): Promise<DispatchView[]> {
        return Object.values(this.dispatches).filter(d => d.state === "pending").map(publicDispatch)
    }

    /** Integration service reports the simulation write. Idempotent: a second report returns the first outcome. */
    async confirmDispatch(proposalId: string, input: DispatchResult): Promise<DispatchView> {
        const result = parse(DispatchResultSchema, input, "dispatch result")
        const d = this.dispatches[proposalId]
        if (!d) throw new Error(`no approved dispatch for ${proposalId}`)
        if (d.state !== "pending" && d.state !== "claimed") return publicDispatch(d)
        const p = this.proposals.find(x => x.id === proposalId)!
        const at = nowIso()
        if (!result.ok) {
            const failed: Dispatch = { ...d, state: "failed", settledAt: at, error: result.error ?? "simulation write failed" }
            this.dispatches = { ...this.dispatches, [proposalId]: failed }
            this.proposals = replaceProposal(this.proposals, { ...p, status: "blocked" })
            this.audit = addAudit(this.audit, this.id as PlantId, "block", proposalId, `dispatch failed: ${failed.error}`, "simulation")
            return publicDispatch(failed)
        }
        const value = finite(result.applied) ? result.applied : d.value
        const token = executeToken(proposalId, d.componentId, d.metric, value)
        await ref<Component>("Component", actorIdFor(d.componentId)).setMetric(d.metric, value, proposalId, token).catch((error: unknown) => {
            if (!String(error).includes("token_already_used")) throw error // already applied by the glue handshake
        })
        const accepted: Dispatch = { ...d, value, state: "accepted", settledAt: at, token }
        this.dispatches = { ...this.dispatches, [proposalId]: accepted }
        this.lastExecutedAt = { ...this.lastExecutedAt, [d.componentId]: at }
        this.proposals = replaceProposal(this.proposals, { ...p, status: "executed" })
        this.audit = addAudit(this.audit, this.id as PlantId, "execute", proposalId, `accepted by simulation: ${tagOf(d.componentId)} ${d.metric} = ${value}`, "simulation")
        return publicDispatch(accepted)
    }

    /** Observed effects (or a seed event). Idempotent by event id. Promotes rules and shares them with Company. */
    async recordEvent(input: HistoryEvent): Promise<{ event: HistoryEvent; rules: LearnedRule[] }> {
        const e = parse(HistoryEventSchema, input, "history event")
        if (e.plantId !== (this.id as PlantId)) throw new Error(`event for ${e.plantId} sent to ${(this.id as PlantId)}`)
        if (this.history.some(h => h.id === e.id)) return { event: e, rules: [] }
        this.history = [...this.history, e]
        this.audit = addAudit(this.audit, this.id as PlantId, e.incident ? "incident" : "execute", e.id, e.incident ?? `observed: ${tagOf(e.componentId)} ${e.metric} ${e.before} → ${e.after}, ${e.effects.length} effects`, e.operator ?? "simulation")
        const changed = rulesFromEvent(this.history, e, this.info, nowIso(), this.rules)
        const shared: LearnedRule[] = []
        for (const r of changed) {
            const before = this.rules.find(x => x.id === r.id)
            this.rules = upsertRule(this.rules, r)
            this.audit = addAudit(this.audit, this.id as PlantId, "rule_learned", r.id, `${before ? "reinforced" : "learned"}: ${r.text}`, "plant")
            const companyRule = await ref<Company>("Company", COMPANY_ID).promoteRule(r)
            if (companyRule) shared.push(companyRule)
        }
        return { event: e, rules: [...changed, ...shared] }
    }

    /** A rule proposed by an agent (or glue). Upserts locally; Company keeps it if the model exists in another plant. */
    async promoteRule(input: LearnedRule): Promise<LearnedRule> {
        const r = parse(LearnedRuleSchema, input, "rule")
        const rule: LearnedRule = { ...r, scope: r.scope === "company" ? "plant" : r.scope }
        const before = this.rules.find(x => ruleKey(x) === ruleKey(rule))
        this.rules = upsertRule(this.rules, rule)
        this.audit = addAudit(this.audit, this.id as PlantId, "rule_learned", rule.id, `${before ? "reinforced" : "learned"}: ${rule.text}`, "plant")
        await ref<Company>("Company", COMPANY_ID).promoteRule(rule)
        return this.rules.find(x => ruleKey(x) === ruleKey(rule))!
    }

    /** k nearest past changes of (componentId, metric). Call with the PROPOSER's component and metric. */
    async similar(componentId: ComponentId, metric: string, to: number, upstreamSnapshot: Record<string, number>, k = 5): Promise<HistoryEvent[]> {
        if (!finite(to)) throw new Error("to must be a finite number")
        return similarEvents(this.history, componentId, metric, to, parse(MetricsSchema, upstreamSnapshot ?? {}, "upstreamSnapshot"), finite(k) ? Math.min(50, k) : 5, rangeOf(this.info[componentId]?.limits[metric]))
    }

    /** Integration service calls this when it mirrors live values; drives `connected`. */
    async heartbeat(): Promise<boolean> {
        this.lastHeartbeat = Date.now()
        this.connected = true
        return true
    }

    /** One tick: counter, connection status, optional pull from the integration service (GLUE_URL). */
    async advanceTick(): Promise<number> {
        this.tick += 1
        const glue = env("GLUE_URL")
        if (glue) {
            try {
                const res = await fetch(`${glue.replace(/\/$/, "")}/tick`, {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ plantId: (this.id as PlantId), tick: this.tick }), signal: AbortSignal.timeout(500),
                })
                if (res.ok) this.lastHeartbeat = Date.now()
            } catch { /* glue unreachable: connected falls back to heartbeat age */ }
        }
        this.connected = Date.now() - this.lastHeartbeat < 3000
        return this.tick
    }

    /** Turn the 1 s / 2 s clock on or off (tests and cost control). */
    async setClock(on: boolean): Promise<boolean> {
        this.config = { ...this.config, clock: on }
        if (on) this.alarm.set(Date.now() + 1000)
        else this.alarm.delete()
        return on
    }

    async onAlarm() {
        if (!this.config.clock) return
        await this.advanceTick()
        if (this.tick % 2 === 0) await this.sweep()
        this.alarm.set(Date.now() + 1000)
    }

    async onMessage(_socket: ActorSocket<null, PlantOutgoing>, _message: Ping) {}
}

// ====================================================================== Company

export type CompanySeed = { plants: PlantId[]; sharedResources: CompanyState["sharedResources"]; rules?: LearnedRule[] }

/** Single instance, actor id "company". Socket state = CompanyState. */
export class Company extends Actor<null, Ping, Ping> {
    @Persisted @Emittable plants: PlantId[] = []
    @Persisted @Emittable sharedResources: CompanyState["sharedResources"] = []
    @Persisted @Emittable rules: LearnedRule[] = []
    @Persisted @Emittable crossPlantProposals: string[] = []
    @Persisted @Emittable audit: AuditEntry[] = []
    /** plantId → componentId → equipment model, registered by each Plant on seed. */
    @Persisted private models: Record<string, Record<ComponentId, string>> = {}
    /** Plant rules whose model was not (yet) seen in another plant; re-checked when a plant registers. */
    @Persisted private candidates: LearnedRule[] = []

    async read(): Promise<CompanyState> {
        return { plants: this.plants, sharedResources: this.sharedResources, rules: this.rules, crossPlantProposals: this.crossPlantProposals, audit: this.audit }
    }

    async loadSeed(c: CompanySeed): Promise<CompanyState> {
        this.plants = [...c.plants]
        this.sharedResources = c.sharedResources.map(r => ({ ...r, components: [...r.components] }))
        this.rules = [...(c.rules ?? [])]
        this.crossPlantProposals = []
        this.audit = []
        this.models = {}
        this.candidates = []
        return this.read()
    }

    async registerPlant(id: PlantId, models?: Record<ComponentId, string>): Promise<PlantId[]> {
        if (!this.plants.includes(id)) this.plants = [...this.plants, id]
        if (models) {
            this.models = { ...this.models, [id]: { ...models } }
            const waiting = this.candidates
            this.candidates = []
            for (const r of waiting) await this.promoteRule(r)
        }
        return this.plants
    }

    /** Other-plant components sharing a resource with the proposer or any of its local voters. Records cross-plant proposals. */
    async requiredCrossPlantVoters(proposal: Proposal): Promise<ComponentId[]> {
        const voters = crossPlantVoters(this.sharedResources, proposal)
        if (voters.length > 0 && !this.crossPlantProposals.includes(proposal.id)) {
            this.crossPlantProposals = [...this.crossPlantProposals, proposal.id].slice(-100)
        }
        return voters
    }

    /**
     * Keeps a rule company-wide when its equipment model exists in another plant. Dedupes by condition +
     * consequence (by tag, across plants); timesSeen = distinct supporting events. Returns null if not shared.
     */
    async promoteRule(input: LearnedRule): Promise<LearnedRule | null> {
        const r = parse(LearnedRuleSchema, input, "rule")
        const from = r.condition.componentId ? plantOf(r.condition.componentId) : null
        const shared = r.model !== null && Object.entries(this.models).some(([plant, models]) => plant !== from && Object.values(models).includes(r.model!))
        if (!shared) {
            this.candidates = [...this.candidates.filter(x => ruleKey(x) !== ruleKey(r)), r].slice(-100)
            return null
        }
        const key = ruleKey(r, false)
        const prior = this.rules.find(x => ruleKey(x, false) === key)
        const support = [...new Set([...(prior?.supportEventIds ?? []), ...r.supportEventIds])]
        const rule: LearnedRule = {
            ...(prior ?? r),
            id: prior?.id ?? `company:${key}`,
            scope: "company",
            text: `Learned in ${from ?? "a plant"}: ${r.text.replace(/, seen \d+ times$/, "")}, seen ${support.length} times`,
            consequence: r.consequence,
            supportEventIds: support,
            timesSeen: Math.max(support.length, prior?.timesSeen ?? 0),
            lastSeenAt: r.lastSeenAt,
        }
        this.rules = prior ? this.rules.map(x => (x.id === prior.id ? rule : x)) : [...this.rules, rule]
        if (!prior || prior.timesSeen !== rule.timesSeen) {
            this.audit = [...this.audit, { at: nowIso(), plantId: "company" as const, kind: "rule_learned" as const, refId: rule.id, summary: rule.text, by: from ?? "company" }].slice(-AUDIT_KEEP)
        }
        return rule
    }

    async recordAudit(a: AuditEntry): Promise<number> {
        this.audit = [...this.audit, a].slice(-AUDIT_KEEP)
        return this.audit.length
    }

    async onMessage(_socket: ActorSocket<null, Ping>, _message: Ping) {}
}

// ====================================================================== module helpers

/** voting → blocked on any no; → veto_window when unanimous and no other window is open on the same component. */
function evaluateProposal(p: Proposal, proposals: Proposal[], vetoWindowMs: number): { proposal: Proposal; note: { kind: AuditEntry["kind"]; summary: string } | null } {
    if (p.status !== "voting") return { proposal: p, note: null }
    if (p.votes.some(v => v.vote === "no")) {
        const reasons = p.votes.filter(v => v.vote === "no").map(v => `${tagOf(v.componentId)}: ${v.reason}`).join(" | ")
        return { proposal: { ...p, status: "blocked" }, note: { kind: "block", summary: `blocked: ${reasons}` } }
    }
    const unanimous = p.requiredVoters.every(id => p.votes.some(v => v.componentId === id && v.vote === "yes"))
    if (!unanimous) return { proposal: p, note: null }
    const busy = proposals.some(x => x.id !== p.id && x.status === "veto_window" && x.proposerComponentId === p.proposerComponentId)
    if (busy) return { proposal: p, note: null }
    const deadline = new Date(Date.now() + vetoWindowMs).toISOString()
    return { proposal: { ...p, status: "veto_window", vetoDeadline: deadline }, note: { kind: "proposal", summary: `unanimous yes: veto window open until ${deadline}` } }
}

function replaceProposal(proposals: Proposal[], p: Proposal): Proposal[] {
    return proposals.map(x => (x.id === p.id ? p : x))
}

function addAudit(audit: AuditEntry[], plantId: PlantId, kind: AuditEntry["kind"], refId: string, summary: string, by: string): AuditEntry[] {
    return [...audit, { at: nowIso(), plantId, kind, refId, summary, by }].slice(-AUDIT_KEEP)
}

function upsertRule(rules: LearnedRule[], r: LearnedRule): LearnedRule[] {
    const key = ruleKey(r)
    return rules.some(x => ruleKey(x) === key) ? rules.map(x => (ruleKey(x) === key ? { ...r, id: x.id, createdAt: x.createdAt } : x)) : [...rules, r]
}

function publicDispatch(d: Dispatch): DispatchView {
    const { token: _token, ...view } = d
    return view
}

function round(n: number) {
    return Math.round(n * 100) / 100
}

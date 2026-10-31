// The three agent behaviours: vote on a proposal, counter-propose when blocked, calibrate after execution.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { CalibrationEntry, ComponentId, HistoryEvent, PlantId, PlantState, Proposal, Role, Vote } from "../../shared/types.js"
import type { Backend, ComponentSnapshot, CounterInput } from "./backend.js"
import { DeadlineError, draftWithRetry, type Llm } from "./llm.js"
import { buildVote, ground, ownPoints, plantOf, tagOf, threshold, type Grounding } from "./predict.js"

const here = dirname(fileURLToPath(import.meta.url))
const roleText: Partial<Record<Role, string>> = {}
export function rolePrompt(role: Role): string {
    return (roleText[role] ??= readFileSync(join(here, "..", "roles", `${role}.md`), "utf8"))
}

/** The physics summary paragraph, read from CLAUDE.MD so it stays in sync with the plan. */
let physics: string | undefined
export function physicsSummary(): string {
    if (physics !== undefined) return physics
    try {
        const md = readFileSync(join(here, "..", "..", "CLAUDE.MD"), "utf8")
        const start = md.indexOf("### Physics summary")
        const body = md.slice(md.indexOf("\n", start) + 1)
        physics = body.slice(0, body.search(/\n#{2,3} /)).trim()
    } catch {
        physics = "LV-101 steady position ≈ P-100 speedPct; steam and coil duty rise with feed."
    }
    return physics
}

export type Deps = { backend: Backend; llmFor: (self: ComponentSnapshot) => Llm | null; log?: (msg: string) => void }

function prompt(self: ComponentSnapshot, proposal: Proposal, g: Grounding, retrievedCount: number): string {
    const row = (e: HistoryEvent) => {
        const mine = e.effects.filter(f => f.componentId === self.id).map(f => `${f.metric} ${f.before}→${f.after} in ${f.ticksToSettle} ticks`).join("; ") || "no effect recorded on you"
        return `- ${e.id} (${e.at.slice(0, 10)}): ${tagOf(e.componentId)} ${e.metric} ${e.before}→${e.after}; you: ${mine}${e.incident ? `; INCIDENT: ${e.incident}` : ""}`
    }
    const limits = Object.entries(self.limits).map(([m, l]) => `- ${m}: now ${self.metrics[m] ?? "?"}, max ${l.max}, critical ${l.critical}, vote-no threshold ${Math.round(threshold(l, self.marginPct) * 10) / 10}`).join("\n")
    return [
        `Proposal ${proposal.id} in ${proposal.plantId}: ${tagOf(proposal.proposerComponentId)} ${proposal.metric} ${proposal.from} → ${proposal.to}. Rationale: ${proposal.rationale}`,
        `You are ${self.id} (${self.name}, model ${self.model}), marginPct ${self.marginPct}.`,
        `Your limits:\n${limits}`,
        `Similar past changes (${g.similar.length} of ${retrievedCount} retrieved are within ±15 of the target):\n${g.similar.map(row).join("\n") || "- none"}`,
        `Newest run of this change: ${g.anchor ? row(g.anchor) : "none"}`,
        `Learned rules that apply:\n${g.rules.map(r => `- ${r.id}: ${r.text}`).join("\n") || "- none"}`,
        `Grounded baseline prediction: ${g.basis.map(b => `${b.metric} ${b.value} (${b.from}: ${b.note})`).join("; ") || "none"}`,
        `Physics summary: ${physicsSummary()}`,
        `Predict your own metrics after the change and vote.`,
    ].join("\n\n")
}

/** TASK vote pipeline steps 1–6: state, similar(), rules, prompt, validated draft, code-enforced contract. */
export async function decideVote(proposal: Proposal, componentId: ComponentId, deps: Deps): Promise<Vote> {
    const { backend } = deps
    const started = Date.now()
    const self = await backend.component(componentId)
    const proposer = proposal.proposerComponentId
    const upstream: Record<string, number> = {}
    const retrieved = await backend.similar(proposal.plantId, proposer, proposal.metric, proposal.to, upstream, 5)
    const [plant, rules] = await Promise.all([backend.plant(proposal.plantId), backend.rules(componentId, self.model)])
    const g = ground(self, proposal, retrieved, plant.history, rules)
    const llm = deps.llmFor(self)
    if (!llm) return buildVote(self, proposal, g, null, "[baseline: no LLM configured] ")
    // Hard budget: every agent answers within VOTE_DEADLINE_MS (default 15 s, under the 20 s vote window).
    const budget = Math.max(1000, Number(process.env.VOTE_DEADLINE_MS ?? 15_000) - (Date.now() - started))
    let draft
    try {
        draft = await draftWithRetry(llm, rolePrompt(self.role), prompt(self, proposal, g, retrieved.length), deps.log, budget)
    } catch (error) {
        if (!(error instanceof DeadlineError)) throw error
        deps.log?.(`${componentId}: ${llm.label} ${error.message} → grounded baseline`)
        return buildVote(self, proposal, g, null, `[${llm.label} timed out → baseline] `)
    }
    if (!draft) {
        const vote = buildVote(self, proposal, g, { vote: "no", reason: "malformed prediction", predicted: {} }, `[${llm.label}] `)
        return { ...vote, vote: "no" }
    }
    const predicted = Object.fromEntries(draft.predicted.map(p => [p.metric, p.value]))
    return buildVote(self, proposal, g, { vote: draft.vote, reason: draft.reason, predicted }, `[${llm.label}] `)
}

/**
 * Counter-proposal for a blocked proposal of ours: the highest target whose 3 nearest past runs were all
 * safe for every blocking voter (no incident, below each voter's threshold), one 5-point step back for margin.
 * Max 2 counters per root proposal.
 */
export async function counterFor(proposal: Proposal, plant: PlantState, deps: Deps): Promise<CounterInput | null> {
    if (proposal.status !== "blocked") return null
    const root = proposal.parentProposalId ?? proposal.id
    if (plant.proposals.filter(p => p.parentProposalId === root).length >= 2) return null
    const blockers = proposal.votes.filter(v => v.vote === "no" && plantOf(v.componentId) === proposal.plantId)
    if (blockers.length === 0) return null
    const voters = await Promise.all(blockers.map(v => deps.backend.component(v.componentId)))
    const changes = plant.history.filter(e => e.componentId === proposal.proposerComponentId && e.metric === proposal.metric)
    const safeAt = (x: number) => {
        const nearest = [...changes].sort((a, b) => Math.abs(a.after - x) - Math.abs(b.after - x)).slice(0, 3)
        if (nearest.length < 3) return false
        return nearest.every(e => !e.incident && voters.every(c => Object.entries(ownPoints([e], c.id)).every(([m, pts]) => !c.limits[m] || pts.every(p => p.y < threshold(c.limits[m]!, c.marginPct)))))
    }
    const step = proposal.to > proposal.from ? -5 : 5
    let best: number | null = null
    for (let x = proposal.to + step; step < 0 ? x > proposal.from : x < proposal.from; x += step) {
        if (safeAt(x)) { best = x; break }
    }
    if (best === null) return null
    // One 5-point step below the highest safe value, and only if that still moves meaningfully from where we are.
    const to = best + step
    if (Math.abs(to - proposal.from) < 5 || (step < 0 ? to <= proposal.from : to >= proposal.from)) return null
    const why = blockers.map(v => `${tagOf(v.componentId)}: ${v.reason.slice(0, 160)}`).join(" | ")
    return {
        proposerComponentId: proposal.proposerComponentId, proposerAgentId: `agent:${proposal.proposerComponentId}`, metric: proposal.metric, to,
        rationale: `Counter to ${proposal.id}: ${proposal.to} was blocked (${why}). Past runs near ${best} were all safe for every blocking voter; proposing ${to} (one step below for margin).`,
        parentProposalId: root,
    }
}

/** After execution: compare each of our votes' predictions with the observed effects → calibration entries. */
export function calibrationsFor(proposal: Proposal, event: HistoryEvent, owned: Set<ComponentId>): { componentId: ComponentId; entry: CalibrationEntry }[] {
    const out: { componentId: ComponentId; entry: CalibrationEntry }[] = []
    for (const v of proposal.votes) {
        if (!owned.has(v.componentId)) continue
        for (const [metric, predicted] of Object.entries(v.predicted)) {
            const effect = event.effects.find(f => f.componentId === v.componentId && f.metric === metric)
            if (!effect) continue
            out.push({ componentId: v.componentId, entry: { at: event.at, proposalId: proposal.id, metric, predicted, observed: effect.after, absError: Math.abs(predicted - effect.after) } })
        }
    }
    return out
}

export type { PlantId }

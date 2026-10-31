// In-memory Backend and Llm for agent tests: real plant definition, fixture history, and the actors' own
// similarity and calibration logic, so agents are tested against the same rules the actors apply.
import { nextMargin, rangeOf, similarEvents } from "../../actor/src/logic.js"
import { fixtureHistory, plants } from "../../actor/tests/fixtures.js"
import type { CalibrationEntry, ComponentId, HistoryEvent, LearnedRule, PlantId, PlantState, Proposal, Vote } from "../../shared/types.js"
import type { Backend, ComponentSnapshot, CounterInput } from "../src/backend.js"
import type { Llm } from "../src/llm.js"

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export class FakeBackend implements Backend {
    readonly name = "fake"
    components = new Map<ComponentId, ComponentSnapshot>()
    plants = new Map<PlantId, PlantState>()
    companyRules: LearnedRule[] = []
    votes: { plantId: PlantId; vote: Vote }[] = []
    proposals: { plantId: PlantId; input: CounterInput; proposal: Proposal }[] = []
    calibrations: { componentId: ComponentId; entry: CalibrationEntry }[] = []

    constructor(history: HistoryEvent[] = fixtureHistory()) {
        for (const p of plants.plants) {
            for (const c of p.components) this.components.set(c.id, { ...clone(c), calibration: [] })
            this.plants.set(p.id, {
                id: p.id, name: p.name, components: p.components.map(c => c.id), proposals: [],
                history: history.filter(e => e.plantId === p.id), rules: [], audit: [], tick: 0, connected: true,
            })
        }
    }

    async component(id: ComponentId) {
        const c = this.components.get(id)
        if (!c) throw new Error(`unknown component ${id}`)
        return clone(c)
    }
    async plant(id: PlantId) {
        return clone(this.plants.get(id)!)
    }
    async similar(plantId: PlantId, componentId: ComponentId, metric: string, to: number, upstreamSnapshot: Record<string, number>, k: number) {
        const range = rangeOf(this.components.get(componentId)?.limits[metric])
        return clone(similarEvents(this.plants.get(plantId)!.history, componentId, metric, to, upstreamSnapshot, k, range))
    }
    async rules(componentId: ComponentId, model: string) {
        const plant = this.plants.get(componentId.split("/")[0] as PlantId)!
        return clone([...plant.rules, ...this.companyRules.filter(r => r.model === model)])
    }
    async submitVote(plantId: PlantId, vote: Vote) {
        this.votes.push({ plantId, vote: clone(vote) })
    }
    async propose(plantId: PlantId, input: CounterInput) {
        const proposal: Proposal = {
            id: `${plantId}-fake-${this.proposals.length + 1}`, at: new Date().toISOString(), plantId,
            proposerComponentId: input.proposerComponentId, proposerAgentId: input.proposerAgentId, metric: input.metric,
            from: this.components.get(input.proposerComponentId)!.metrics[input.metric]!, to: input.to, rationale: input.rationale,
            requiredVoters: [], votes: [], status: "voting", vetoDeadline: null, parentProposalId: input.parentProposalId, crossPlant: false,
        }
        this.proposals.push({ plantId, input: clone(input), proposal })
        return clone(proposal)
    }
    async addCalibration(componentId: ComponentId, entry: CalibrationEntry) {
        const c = this.components.get(componentId)!
        c.calibration = [...c.calibration, { ...entry, absError: Math.abs(entry.predicted - entry.observed) }].slice(-50)
        c.marginPct = nextMargin(c.calibration, c.limits, c.marginPct)
        this.calibrations.push({ componentId, entry: clone(entry) })
        return clone(c)
    }

    /** Test helper: append an event to a plant's history (e.g. a just-executed run). */
    record(e: HistoryEvent) {
        const p = this.plants.get(e.plantId)!
        p.history = [...p.history, e]
    }
}

/** Returns queued responses in order; a queued Error is thrown. Counts calls. */
export class FakeLlm implements Llm {
    readonly label = "fake:llm"
    calls = 0
    constructor(private queue: unknown[]) {}
    async draft(_system: string, _user: string): Promise<unknown> {
        this.calls += 1
        const next = this.queue.length > 1 ? this.queue.shift() : this.queue[0]
        if (next instanceof Error) throw next
        return clone(next)
    }
}

const ALL_A_VOTERS = ["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101", "plant-b/TV-101"]

export function proposal(over: Partial<Proposal> & { to: number }): Proposal {
    const plantId = over.plantId ?? "plant-a"
    const voters = plantId === "plant-a" ? ALL_A_VOTERS : ["plant-b/TK-101", "plant-b/LV-101", "plant-b/E-101", "plant-b/TV-101", "plant-a/TV-101"]
    return {
        id: `${plantId}-p${Math.floor(Math.random() * 1e6)}`, at: new Date().toISOString(), plantId,
        proposerComponentId: `${plantId}/P-100`, proposerAgentId: `agent:${plantId}/P-100`, metric: "speedPct", from: 50,
        rationale: "test", requiredVoters: voters, votes: [], status: "voting", vetoDeadline: null, parentProposalId: null, crossPlant: true,
        ...over,
    }
}

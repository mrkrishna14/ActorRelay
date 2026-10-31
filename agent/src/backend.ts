// What agents read and write. Agents never write component state: there is no setMetric here.
//   ActorBackend — the generated actor client (local `terse actor dev` or Terse Cloud via TERSE_ACTOR_URL/TERSE_API_KEY)
//   GlueBackend  — Person 3's integration service routes (GLUE_URL), per the TASK plan
import type {
    CalibrationEntry, CompanyState, ComponentId, ComponentState, HistoryEvent, LearnedRule, PlantId, PlantState, Proposal, Vote,
} from "../../shared/types.js"

export type ComponentSnapshot = ComponentState & { calibration: CalibrationEntry[] }
export type CounterInput = { proposerComponentId: ComponentId; proposerAgentId: string; metric: string; to: number; rationale: string; parentProposalId: string }

export interface Backend {
    readonly name: string
    component(id: ComponentId): Promise<ComponentSnapshot>
    plant(id: PlantId): Promise<PlantState>
    similar(plantId: PlantId, componentId: ComponentId, metric: string, to: number, upstreamSnapshot: Record<string, number>, k: number): Promise<HistoryEvent[]>
    rules(componentId: ComponentId, model: string): Promise<LearnedRule[]>
    submitVote(plantId: PlantId, vote: Vote): Promise<void>
    propose(plantId: PlantId, input: CounterInput): Promise<Proposal>
    addCalibration(componentId: ComponentId, entry: CalibrationEntry): Promise<ComponentSnapshot>
}

const plantOf = (id: ComponentId) => id.split("/")[0] as PlantId
const actorIdFor = (id: ComponentId) => id.replace("/", ".")

export class ActorBackend implements Backend {
    readonly name = "actors"
    private client: Promise<typeof import("../generated/index.js")> = import("../generated/index.js")
    private async a() {
        return (await this.client).actors
    }
    async component(id: ComponentId) {
        return (await this.a()).Component.get(actorIdFor(id)).read()
    }
    async plant(id: PlantId) {
        return (await this.a()).Plant.get(id).read()
    }
    async similar(plantId: PlantId, componentId: ComponentId, metric: string, to: number, upstreamSnapshot: Record<string, number>, k: number) {
        return (await this.a()).Plant.get(plantId).similar(componentId, metric, to, upstreamSnapshot, k)
    }
    async rules(componentId: ComponentId, model: string) {
        const a = await this.a()
        const [plant, company] = await Promise.all([a.Plant.get(plantOf(componentId)).read(), a.Company.get("company").read()])
        return [...plant.rules, ...company.rules.filter((r: LearnedRule) => r.model === model)]
    }
    async submitVote(plantId: PlantId, vote: Vote) {
        await (await this.a()).Plant.get(plantId).vote(vote)
    }
    async propose(plantId: PlantId, input: CounterInput) {
        return (await this.a()).Plant.get(plantId).propose(input)
    }
    async addCalibration(componentId: ComponentId, entry: CalibrationEntry) {
        return (await this.a()).Component.get(actorIdFor(componentId)).addCalibration(entry)
    }
}

export class GlueBackend implements Backend {
    readonly name = "glue"
    constructor(private base: string) {}
    private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
        const res = await fetch(`${this.base.replace(/\/$/, "")}${path}`, {
            method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) throw new Error(`glue ${method} ${path}: HTTP ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300))
        return (await res.json()) as T
    }
    component(id: ComponentId) {
        return this.call<ComponentSnapshot>("GET", `/component/${encodeURIComponent(id)}`)
    }
    /** Glue's /state wraps the plant: {plant, company, components, mode}. */
    async plant(id: PlantId) {
        const r = await this.call<PlantState | { plant: PlantState }>("GET", `/state?plantId=${id}`)
        return "plant" in r && r.plant ? r.plant : (r as PlantState)
    }
    similar(plantId: PlantId, componentId: ComponentId, metric: string, to: number, upstreamSnapshot: Record<string, number>, k: number) {
        const q = new URLSearchParams({ plantId, componentId, metric, to: String(to), k: String(k), upstreamSnapshot: JSON.stringify(upstreamSnapshot) })
        return this.call<HistoryEvent[]>("GET", `/similar?${q}`)
    }
    rules(componentId: ComponentId, model: string) {
        return this.call<LearnedRule[]>("GET", `/rules?${new URLSearchParams({ componentId, model })}`)
    }
    async submitVote(_plantId: PlantId, vote: Vote) {
        await this.call("POST", "/vote", { vote })
    }
    /** Glue builds {...proposal, parentProposalId} and routes by proposal.plantId; replies {proposal, mode}. */
    async propose(plantId: PlantId, input: CounterInput) {
        // glue's /counter schema is strict: proposal = {plantId, proposerComponentId, metric, to, rationale}
        const proposal = { plantId, proposerComponentId: input.proposerComponentId, metric: input.metric, to: input.to, rationale: input.rationale }
        const r = await this.call<Proposal | { proposal: Proposal }>("POST", "/counter", { parentProposalId: input.parentProposalId, proposal })
        return "proposal" in r && r.proposal ? r.proposal : (r as Proposal)
    }
    addCalibration(componentId: ComponentId, entry: CalibrationEntry) {
        return this.call<ComponentSnapshot>("POST", "/calibration", { componentId, entry })
    }
}

export type { CompanyState }

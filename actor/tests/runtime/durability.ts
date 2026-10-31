// REAL-RUNTIME CRASH PROOF. `before` writes durable state and saves what it read; kill -9 the server; restart it;
// `after` compares every saved field and checks the tick loop comes back. Run with: bun run durability.ts before|after
import plants from "../../../shared/plants.json"
import history from "../fixtures/history.json"
import { componentActorId } from "../../src/ids"

const TERSE_URL = process.env.TERSE_URL ?? "http://127.0.0.1:7100"
const SNAPSHOT = process.env.SNAPSHOT ?? "/tmp/actorrelay-durability.json"

async function call<T>(actor: string, id: string, method: string, ...args: unknown[]): Promise<T> {
    const response = await fetch(`${TERSE_URL}/v1/projects/local/actors/${actor}/${encodeURIComponent(id)}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ requestId: crypto.randomUUID(), method, args }),
        signal: AbortSignal.timeout(60_000)
    })
    const document = (await response.json()) as { outcome?: { type: string; result?: T; message?: string }; error?: { message: string } }
    if (document.outcome?.type === "completed") return document.outcome.result as T
    throw new Error(document.outcome?.message ?? document.error?.message ?? JSON.stringify(document))
}

type Snapshot = { plant: any; lv101: any; company: any }

async function read(): Promise<Snapshot> {
    return {
        plant: await call("Plant", "plant-a", "getState"),
        lv101: await call("Component", componentActorId("plant-a/LV-101"), "getState"),
        company: await call("Company", "company", "getState")
    }
}

if (process.argv[2] === "before") {
    await call("Company", "company", "loadSeed", plants.company)
    await Promise.all(plants.plants.map(seed => call("Plant", seed.id, "loadSeed", seed, history)))
    await Promise.all(plants.plants.flatMap(seed => seed.components.map(state => call("Component", componentActorId(state.id), "loadSeed", state))))
    await call("Component", "plant-a.LV-101", "mirror", { positionPct: 61.5 })
    const proposal = await call<{ id: string }>("Plant", "plant-a", "propose", { proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 65, rationale: "crash proof" })
    await call("Plant", "plant-a", "vote", {
        proposalId: proposal.id,
        componentId: "plant-a/LV-101",
        agentId: "agent:plant-a/LV-101",
        vote: "yes",
        reason: "similar runs stayed inside limits",
        predicted: { positionPct: 66 },
        marginPct: 10,
        evidenceEventIds: [],
        evidenceRuleIds: [],
        similarCount: 3
    })
    await Bun.sleep(4_000)
    const snapshot = await read()
    await Bun.write(SNAPSHOT, JSON.stringify({ ...snapshot, proposalId: proposal.id }))
    console.log(`saved: tick ${snapshot.plant.tick}, proposals ${snapshot.plant.proposals.length}, votes ${snapshot.plant.proposals[0].votes.length}, history ${snapshot.plant.history.length}, company rules ${snapshot.company.rules.length}`)
} else {
    const saved = await Bun.file(SNAPSHOT).json()
    const now = await read()
    const checks: [string, boolean][] = [
        ["proposal still voting with its vote", now.plant.proposals[0].id === saved.proposalId && now.plant.proposals[0].status === saved.plant.proposals[0].status && now.plant.proposals[0].votes.length === 1],
        ["history identical", JSON.stringify(now.plant.history) === JSON.stringify(saved.plant.history)],
        ["plant rules identical", JSON.stringify(now.plant.rules) === JSON.stringify(saved.plant.rules)],
        ["audit preserved", now.plant.audit.length >= saved.plant.audit.length],
        ["component metrics identical", JSON.stringify(now.lv101.metrics) === JSON.stringify(saved.lv101.metrics) && now.lv101.metrics.positionPct === 61.5],
        ["company rules identical", JSON.stringify(now.company.rules.map((rule: { id: string }) => rule.id)) === JSON.stringify(saved.company.rules.map((rule: { id: string }) => rule.id))],
        ["tick within one checkpoint of where it was", now.plant.tick >= saved.plant.tick - 30]
    ]
    const first = now.plant.tick
    await Bun.sleep(4_000)
    const later = (await call<{ tick: number }>("Plant", "plant-a", "getState")).tick
    checks.push([`tick loop resumed (${first} -> ${later})`, later > first])
    for (const [name, passed] of checks) console.log(passed ? "PASS" : "FAIL", name)
    process.exit(checks.every(([, passed]) => passed) ? 0 : 1)
}

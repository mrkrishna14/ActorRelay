// REAL-RUNTIME SMOKE, not part of `bun test`. Glue's real ActorAdapter -> a running rpc.ts -> a live `terse actor dev`.
// It RESEEDS the actors it reaches, so ACTOR_API_URL is required: point it only at an adapter on a runtime you own.
import plants from "../../../shared/plants.json"
import { ActorAdapter, ApiError } from "../../../glue/actors"

const url = process.env.ACTOR_API_URL
if (!url) throw new Error("Set ACTOR_API_URL to an adapter in front of a Terse runtime you own; this script reseeds it.")
const glue = new ActorAdapter(url, process.env.ACTOR_API_TOKEN ?? "", "")

let failures = 0
function check(name: string, ok: boolean, detail?: unknown) {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
    if (!ok) failures++
}

async function refusal(pending: Promise<unknown>): Promise<{ status: number; message: string }> {
    return pending.then(
        value => ({ status: 200, message: JSON.stringify(value) }),
        error => (error instanceof ApiError ? { status: error.status, message: error.message } : { status: 0, message: String(error) })
    )
}

for (let attempt = 0; ; attempt++) {
    const reachable = await glue.read("Company", "company").then(
        () => true,
        () => false
    )
    if (reachable) break
    if (attempt >= 180) throw new Error("runtime never answered through the adapter")
    await Bun.sleep(500)
}

// Same order as glue's /reset in glue/live.ts.
for (const plant of plants.plants) {
    for (const component of plant.components) await glue.call("Component", component.id, "loadSeed", [component])
    await glue.call("Plant", plant.id, "loadSeed", [plant, []])
}
await glue.call("Company", "company", "loadSeed", [plants.company])

const plant = await glue.read("Plant", "plant-a")
check("Plant read lists slash ComponentIds", plant.components.includes("plant-a/LV-101"), plant.components)
const valve = await glue.read("Component", "plant-a/LV-101")
check("Component read by slash id reaches the dot actor", valve.id === "plant-a/LV-101" && valve.limits.positionPct.critical === 90, valve.id)
const company = await glue.read("Company", "company")
check("Company read", company.plants.length === 2, company.plants)

await glue.call("Component", "plant-a/P-100", "mirror", [{ speedPct: 50 }])
check("mirror writes through", (await glue.read("Component", "plant-a/P-100")).metrics.speedPct === 50)

const similar = await glue.call("Plant", "plant-a", "similar", ["plant-a/P-100", "speedPct", 85, { feedM3h: 15 }, 5])
check("similar takes glue's positional args", Array.isArray(similar), similar.length)

const input = { plantId: "plant-a", proposerComponentId: "plant-a/P-100", metric: "speedPct", rationale: "adapter smoke" }
const tooHigh = await refusal(glue.call("Plant", "plant-a", "propose", [{ ...input, to: 99 }]))
check("actor refusal reaches glue as 409", tooHigh.status === 409 && tooHigh.message.includes("out_of_limits"), tooHigh)

const proposal = await glue.call("Plant", "plant-a", "propose", [{ ...input, to: 65 }])
check("propose returns a Proposal", proposal.status === "voting" && proposal.plantId === "plant-a", { id: proposal.id, requiredVoters: proposal.requiredVoters })

const forged = await refusal(glue.call("Component", "plant-a/P-100", "setMetric", ["speedPct", 65, proposal.id, "forged"]))
check("forged setMetric token refused across Component and Plant", forged.status === 409 && forged.message.includes("invalid_token"), forged)

const blocked = await refusal(glue.call("Plant", "plant-a", "execute", [proposal.id]))
check("off-allowlist method is 403", blocked.status === 403, blocked)

const authorize = await refusal(glue.call("Plant", "plant-a", "authorizeExecution", [proposal.id]))
console.log(`INFO Plant.authorizeExecution through the adapter -> ${JSON.stringify(authorize)}`)

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

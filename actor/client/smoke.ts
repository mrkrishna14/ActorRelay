// Smoke test against deployed (or local) actors. Seeds both plants from shared/plants.json,
// proposes P-100 50 → 85 on plant-a, and checks the voters, which needs Plant → Component and
// Plant → Company calls to work inside the runtime.
//   Cloud: TERSE_ACTOR_URL=https://api.useterse.ai/<project>/actors TERSE_API_KEY=... bun smoke.ts
//   Local: (with `terse actor dev` running) bun smoke.ts
// Optional: HISTORY=../../shared/history.json to seed real history (default: none).
import plantsJson from "../../shared/plants.json"
import type { ComponentState, HistoryEvent, PlantId } from "../src/types.js"
import { actors } from "./generated/index.js"

const plants = plantsJson as unknown as {
    company: { plants: PlantId[]; sharedResources: { id: string; name: string; components: string[] }[] }
    plants: { id: PlantId; name: string; components: ComponentState[] }[]
}
const history: HistoryEvent[] = process.env.HISTORY ? await Bun.file(process.env.HISTORY).json() : []
const clock = process.env.CLOCK === "on"

const t0 = Date.now()
const step = (msg: string) => console.log(`${String(Date.now() - t0).padStart(6)} ms  ${msg}`)

console.log(`target: ${process.env.TERSE_ACTOR_URL ?? "local default http://127.0.0.1:7100"}`)
await actors.Company.get("company").loadSeed(plants.company)
step("Company.loadSeed")
for (const p of plants.plants) {
    const s = await actors.Plant.get(p.id).loadSeed(p, history, { clock })
    step(`Plant(${p.id}).loadSeed → ${s.components.length} components, ${s.history.length} events, ${s.rules.length} rules, clock ${clock ? "on" : "off"}`)
}
const lv = await actors.Component.get("plant-a.LV-101").read()
step(`Component(plant-a.LV-101).read → ${lv.name}, positionPct ${lv.metrics.positionPct}, status ${lv.status}`)

const p = await actors.Plant.get("plant-a").propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 85, rationale: "smoke test" })
step(`propose → ${p.id} ${p.from} → ${p.to}, crossPlant ${p.crossPlant}`)
console.log(`         voters: ${p.requiredVoters.join(", ")}`)
const expected = ["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101", "plant-b/TV-101"]
const ok = p.crossPlant && expected.every(id => p.requiredVoters.includes(id)) && p.requiredVoters.length === expected.length
const company = await actors.Company.get("company").read()
step(`Company: ${company.rules.length} company rules, crossPlantProposals ${JSON.stringify(company.crossPlantProposals)}`)
console.log(ok ? "SMOKE PASS" : "SMOKE FAIL")
process.exit(ok ? 0 : 1)

// End-to-end check of actors + agents + Relay, standing in for glue (proposal broadcast, dispatch
// confirmation, observed event) and the simulator (observed values). Not part of the demo runtime.
//   terminal 1: cd actor && terse actor dev
//   terminal 2: cd agent && bun src/spawn.ts
//   terminal 3: cd agent && bun scripts/demo-check.ts
import { join } from "node:path"
import { fixtureHistory, plants, plantSeed } from "../../actor/tests/fixtures.js"
import type { HistoryEvent, PlantId, Proposal } from "../../shared/types.js"
import { actors } from "../generated/index.js"
import { RelayBus } from "../src/relay.js"

const results: { step: string; ok: boolean; detail: string }[] = []
const check = (step: string, ok: boolean, detail: string) => (results.push({ step, ok, detail }), console.log(`${ok ? "PASS" : "FAIL"}  ${step} — ${detail}`))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const plant = (id: PlantId) => actors.Plant.get(id)
async function waitFor<T>(what: string, ms: number, fn: () => Promise<T | null | undefined | false>): Promise<T | null> {
    const end = Date.now() + ms
    while (Date.now() < end) {
        const v = await fn().catch(() => null)
        if (v) return v as T
        await sleep(500)
    }
    console.log(`  timed out waiting for ${what}`)
    return null
}
const proposalOf = async (pid: PlantId, id: string) => (await plant(pid).read()).proposals.find(p => p.id === id)!

const bus = process.env.RELAY_WORKSPACE_KEY ? await RelayBus.connect(process.env.RELAY_WORKSPACE_KEY, ["ar-operator"], join(import.meta.dir, "..", ".relay-agents.json"), m => console.log(`  ${m}`)) : null
const announce = async (p: Proposal) => bus?.publish("ar-operator", p.plantId as "plant-a", { type: "proposal", proposal: p })

// 1. reset
await actors.Company.get("company").loadSeed(plants.company)
for (const id of ["plant-a", "plant-b"] as PlantId[]) await plant(id).loadSeed(plantSeed(id), fixtureHistory(), { clock: true })
const company0 = await actors.Company.get("company").read()
check("reset", company0.rules.length > 0, `10 components seeded, company rules: ${company0.rules.map(r => r.text).join(" | ")}`)

// 2. propose 85 → blocked with evidence (incl. cross-plant vote)
let t = Date.now()
const bad = await plant("plant-a").propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 85, rationale: "Increase throughput" })
await announce(bad)
const blocked = await waitFor("block", 25_000, async () => ((await proposalOf("plant-a", bad.id)).status === "blocked" ? proposalOf("plant-a", bad.id) : null))
const lvNo = blocked?.votes.find(v => v.componentId === "plant-a/LV-101")
check("85 blocked with evidence", !!blocked && lvNo?.vote === "no" && lvNo.evidenceEventIds.length >= 3 && (lvNo.predicted.positionPct ?? 0) >= 81,
    `${((Date.now() - t) / 1000).toFixed(1)} s; LV-101 ${lvNo?.vote} predicted ${lvNo?.predicted.positionPct}, ${lvNo?.evidenceEventIds.length} events, ${lvNo?.evidenceRuleIds.length} rules`)

// 3. counter → all yes → veto window → dispatch → confirm (simulator stand-in) → observed event → calibration
const counter = await waitFor<Proposal>("counter", 20_000, async () => (await plant("plant-a").read()).proposals.find(p => p.parentProposalId === bad.id))
check("counter-proposal", !!counter && counter.to <= 70 && counter.to >= 60, `${counter?.id} → ${counter?.to}`)
if (counter) await announce(counter)
const window = counter && (await waitFor("veto window", 25_000, async () => ((await proposalOf("plant-a", counter.id)).status === "veto_window" ? true : null)))
const cp = counter ? await proposalOf("plant-a", counter.id) : null
check("counter unanimous yes → veto window", !!window, `${cp?.votes.map(v => `${v.componentId.split("/")[1]}:${v.vote}`).join(" ")}`)
const dispatch = counter && (await waitFor("dispatch", 20_000, async () => (await plant("plant-a").pendingDispatches()).find(d => d.proposalId === counter.id)))
check("veto window passes → dispatch approved", !!dispatch, dispatch ? `${dispatch.componentId} ${dispatch.metric} = ${dispatch.value}` : "none")
let observed: HistoryEvent | null = null
if (counter && dispatch) {
    await plant("plant-a").confirmDispatch(counter.id, { ok: true, applied: dispatch.value })
    observed = {
        id: `plant-a-obs-${counter.id}`, at: new Date().toISOString(), plantId: "plant-a", componentId: "plant-a/P-100", metric: "speedPct",
        before: 50, after: dispatch.value, upstreamSnapshot: { feedM3h: 15, headerBarg: 6, feedTempC: 25 },
        effects: [
            { componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: dispatch.value + 2, ticksToSettle: 3 },
            { componentId: "plant-a/TV-101", metric: "steamKgH", before: 1533, after: 29.7 * dispatch.value + 48, ticksToSettle: 4 },
            { componentId: "plant-a/E-101", metric: "dutyKw", before: 898, after: 17.43 * dispatch.value + 27, ticksToSettle: 4 },
            { componentId: "plant-a/TK-101", metric: "levelPct", before: 50, after: 50, ticksToSettle: 5 },
        ],
        incident: null, approvedBy: cp?.votes.map(v => v.agentId) ?? [], operator: "demo-check", proposalId: counter.id,
    }
    await plant("plant-a").recordEvent(observed)
    await bus?.publish("ar-operator", "plant-a", { type: "executed", proposalId: counter.id, event: observed })
}
const p100 = await actors.Component.get("plant-a.P-100").read()
check("executed", (await proposalOf("plant-a", counter?.id ?? "")).status === "executed" && p100.metrics.speedPct === dispatch?.value, `P-100 speedPct = ${p100.metrics.speedPct}`)
const cal = await waitFor("calibration", 15_000, async () => {
    const lv = await actors.Component.get("plant-a.LV-101").read()
    return lv.calibration.find(c => c.proposalId === counter?.id) ?? null
})
check("calibration recorded", !!cal, cal ? `LV-101 predicted ${cal.predicted}, observed ${cal.observed}, error ${cal.absError}` : "none")

// 4. same bad proposal again → blocked faster, newest run cited first
t = Date.now()
const again = await plant("plant-a").propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 85, rationale: "Force 85" })
await announce(again)
const blocked2 = await waitFor("second block", 25_000, async () => ((await proposalOf("plant-a", again.id)).status === "blocked" ? proposalOf("plant-a", again.id) : null))
const lv2 = blocked2?.votes.find(v => v.componentId === "plant-a/LV-101")
check("It learned: re-block cites newest run first", !!blocked2 && lv2?.vote === "no" && lv2.evidenceEventIds[0] === observed?.id,
    `${((Date.now() - t) / 1000).toFixed(1)} s; evidence[0] = ${lv2?.evidenceEventIds[0]}`)

// 5. plant-b 85 → blocked citing the company rule learned in plant-a
const b = await plant("plant-b").propose({ proposerComponentId: "plant-b/P-100", metric: "speedPct", to: 85, rationale: "Increase throughput" })
await announce(b)
const bBlocked = await waitFor("plant-b block", 25_000, async () => ((await proposalOf("plant-b", b.id)).status === "blocked" ? proposalOf("plant-b", b.id) : null))
const bLv = bBlocked?.votes.find(v => v.componentId === "plant-b/LV-101")
check("Plant B learned from Plant A", !!bBlocked && bLv?.vote === "no" && bLv.evidenceRuleIds.some(id => id.startsWith("company:")), `rules cited: ${bLv?.evidenceRuleIds.join(", ")}`)

for (const id of ["plant-a", "plant-b"] as PlantId[]) await plant(id).setClock(false)
const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)

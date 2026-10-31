// Runs the component agents (default: all 10) as Agent Relay participants.
//   bun src/spawn.ts                         all 10 agents
//   AGENT_COMPONENTS=plant-a/LV-101,... bun src/spawn.ts
// Env (see agent/HANDOFF.md): RELAY_WORKSPACE_KEY, TERSE_ACTOR_URL/TERSE_API_KEY (or local actors), GLUE_URL,
// AGENT_SUBMIT=actors|relay, AGENT_POLL_MS, ANTHROPIC_API_KEY / OPENAI_API_KEY (else labelled baseline).
import { join } from "node:path"
import plantsJson from "../../shared/plants.json" with { type: "json" }
import type { ComponentId, ComponentState, PlantId, PlantState, Proposal } from "../../shared/types.js"
import { ActorBackend, GlueBackend, type Backend } from "./backend.js"
import { llmFor } from "./llm.js"
import { calibrationsFor, counterFor, decideVote, type Deps } from "./pipeline.js"
import { plantOf, tagOf } from "./predict.js"
import { RelayBus, relayName, type Channel, type RelayMessage } from "./relay.js"

const plants = plantsJson as unknown as { plants: { id: PlantId; components: ComponentState[] }[] }
const all = plants.plants.flatMap(p => p.components)
const wanted = process.env.AGENT_COMPONENTS?.split(",").map(s => s.trim()).filter(Boolean)
const owned = new Set<ComponentId>(all.filter(c => !wanted || wanted.includes(c.id)).map(c => c.id))
const vendorOf = new Map(all.map(c => [c.id, c.vendor]))

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`)
const backend: Backend = process.env.GLUE_URL ? new GlueBackend(process.env.GLUE_URL) : new ActorBackend()
const submitDirect = (process.env.AGENT_SUBMIT ?? (process.env.GLUE_URL ? "relay" : "actors")) === "actors"
const deps: Deps = { backend, llmFor: self => llmFor(vendorOf.get(self.id) ?? self.vendor), log }
const pollMs = Number(process.env.AGENT_POLL_MS ?? 2000)

let bus: RelayBus | null = null
const done = new Set<string>() // `${proposalId}|${componentId}` voted, `counter|id`, `cal|id`

async function say(as: ComponentId, channel: Channel, msg: RelayMessage) {
    if (!bus) return
    await bus.publish(relayName(as), channel, msg).catch(e => log(`relay send failed (${msg.type}): ${e}`))
}

/** Vote for every owned required voter that has not voted yet. Voters run in parallel (20 s budget). */
async function onProposal(p: Proposal) {
    if (p.status !== "voting") return
    const mine = p.requiredVoters.filter(id => owned.has(id) && !done.has(`${p.id}@${p.at}|${id}`) && !p.votes.some(v => v.componentId === id))
    for (const id of mine) done.add(`${p.id}@${p.at}|${id}`)
    await Promise.all(mine.map(async id => {
        const t0 = Date.now()
        try {
            const vote = await decideVote(p, id, deps)
            const channel: Channel = plantOf(id) === p.plantId ? (p.plantId as Channel) : "company"
            await say(id, channel, { type: "vote", vote })
            if (submitDirect) await backend.submitVote(p.plantId, vote).catch(e => log(`  submit ${id}: ${String(e).slice(0, 160)}`))
            log(`${p.id} ${tagOf(p.proposerComponentId)} ${p.from}→${p.to}: ${id} votes ${vote.vote.toUpperCase()} in ${Date.now() - t0} ms (similar ${vote.similarCount}, evidence ${vote.evidenceEventIds.slice(0, 3).join(",")}${vote.evidenceRuleIds.length ? `, rules ${vote.evidenceRuleIds.length}` : ""}) — ${vote.reason.slice(0, 140)}`)
        } catch (error) {
            done.delete(`${p.id}@${p.at}|${id}`)
            log(`${p.id}: ${id} could not vote: ${String(error).slice(0, 200)}`)
        }
    }))
}

/** Our own proposal was blocked → one evidence-backed counter (max 2 per root). */
async function onBlocked(p: Proposal, plant: PlantState) {
    if (!owned.has(p.proposerComponentId) || done.has(`counter|${p.id}@${p.at}`)) return
    done.add(`counter|${p.id}@${p.at}`)
    const input = await counterFor(p, plant, deps).catch(e => (log(`counter ${p.id} failed: ${e}`), null))
    if (!input) return log(`${p.id} blocked; no evidence-backed counter-proposal`)
    const counter = await backend.propose(p.plantId, input)
    log(`${p.id} blocked → ${p.proposerComponentId} counter-proposes ${counter.id}: ${p.metric} ${counter.from} → ${counter.to}`)
    await say(p.proposerComponentId, p.plantId as Channel, { type: "counter", parentProposalId: input.parentProposalId, proposal: counter })
    void onProposal(counter)
}

/** Executed and observed → calibrate our predictions. */
async function onExecuted(proposalId: string, plant: PlantState) {
    const p = plant.proposals.find(x => x.id === proposalId)
    const event = plant.history.find(e => e.proposalId === proposalId && (!p || e.at >= p.at))
    if (!p || !event || done.has(`cal|${p.id}@${p.at}`)) return
    done.add(`cal|${p.id}@${p.at}`)
    for (const { componentId, entry } of calibrationsFor(p, event, owned)) {
        const after = await backend.addCalibration(componentId, entry).catch(e => (log(`calibration ${componentId}: ${e}`), null))
        log(`calibration ${componentId} ${entry.metric}: predicted ${entry.predicted}, observed ${entry.observed}, error ${Math.round(entry.absError * 10) / 10}${after ? `, margin ${after.marginPct}%` : ""}`)
    }
}

async function poll() {
    for (const plantId of ["plant-a", "plant-b"] as PlantId[]) {
        let plant: PlantState
        try {
            plant = await backend.plant(plantId)
        } catch (error) {
            log(`poll ${plantId}: ${String(error).slice(0, 120)}`)
            continue
        }
        for (const p of plant.proposals) {
            if (p.status === "voting") void onProposal(p)
            else if (p.status === "blocked") void onBlocked(p, plant)
            else if (p.status === "executed") void onExecuted(p.id, plant)
        }
    }
}

async function main() {
    log(`agents: ${owned.size} components via ${backend.name}${submitDirect ? " (votes also submitted to Plant directly)" : " (votes via Relay → glue)"}`)
    for (const id of owned) {
        const llm = llmFor(vendorOf.get(id)!)
        log(`  ${relayName(id)}  ${id}  ${vendorOf.get(id)}  → ${llm ? llm.label : "baseline (no LLM key)"}`)
    }
    const key = process.env.RELAY_WORKSPACE_KEY
    // Relay connects in the background: agents vote from the first poll; Relay messages flow once it is up.
    if (key) {
        const t0 = Date.now()
        RelayBus.connect(key, [...owned].map(relayName), join(import.meta.dir, "..", ".relay-agents.json"), log)
            .then(b => {
                bus = b
                b.onMessage(async msg => {
                    if (msg.type === "proposal" || msg.type === "counter") void onProposal(msg.proposal)
                    else if (msg.type === "executed") {
                        const plant = await backend.plant(msg.event.plantId).catch(() => null)
                        if (plant) void onExecuted(msg.proposalId, plant)
                    }
                })
                log(`relay: ${owned.size} participants on #plant-a #plant-b #company (ready in ${((Date.now() - t0) / 1000).toFixed(1)} s)`)
            })
            .catch(e => log(`relay unavailable, continuing on polling: ${e}`))
    } else log("relay: RELAY_WORKSPACE_KEY not set — running on polling only")
    // Polling is the safety net: proposals, blocks and executions the Relay feed may have missed.
    const tick = async () => {
        await poll()
        setTimeout(tick, pollMs)
    }
    void tick()
}

await main()

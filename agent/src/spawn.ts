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
import { startPublishServer, type Published } from "./publish.js"
import { RelayBus, relayName, type Channel, type RelayMessage } from "./relay.js"

const raw = plantsJson as unknown as { components?: ComponentState[]; plants: { id: PlantId; components: (ComponentState | string)[] }[] }
const all: ComponentState[] = raw.components ?? raw.plants.flatMap(p => p.components as ComponentState[])
const wanted = process.env.AGENT_COMPONENTS?.split(",").map(s => s.trim()).filter(Boolean)
const owned = new Set<ComponentId>(all.filter(c => !wanted || wanted.includes(c.id)).map(c => c.id))
const vendorOf = new Map(all.map(c => [c.id, c.vendor]))

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`)
const backend: Backend = process.env.GLUE_URL ? new GlueBackend(process.env.GLUE_URL) : new ActorBackend()
// Votes, counters and calibrations go to the backend (actors, or glue routes when GLUE_URL is set); Relay carries copies.
const submitDirect = (process.env.AGENT_SUBMIT ?? "direct") !== "relay"
const SYSTEM = "ar-glue-system" // rebroadcasts what glue publishes to us
const deps: Deps = { backend, llmFor: self => llmFor(vendorOf.get(self.id) ?? self.vendor), log }
const pollMs = Number(process.env.AGENT_POLL_MS ?? 2000)
const STALE_MS = 30_000 // the vote window: older proposals are history (agents never wait on this)

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
            // Decision path first; the Relay broadcast never delays the vote reaching the Plant.
            if (submitDirect) await backend.submitVote(p.plantId, vote).catch(e => log(`  submit ${id}: ${String(e).slice(0, 160)}`))
            void say(id, channel, { type: "vote", vote })
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
    const counter = await backend.propose(p.plantId, input).catch(e => (log(`counter ${p.id} rejected: ${String(e).slice(0, 200)}`), done.delete(`counter|${p.id}@${p.at}`), null))
    if (!counter) return
    log(`${p.id} blocked → ${p.proposerComponentId} counter-proposes ${counter.id}: ${p.metric} ${counter.from} → ${counter.to}`)
    void say(p.proposerComponentId, p.plantId as Channel, { type: "counter", parentProposalId: input.parentProposalId, proposal: counter })
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
            if (Date.now() - Date.parse(p.at) > STALE_MS) continue // left over from an earlier run
            if (p.status === "voting") void onProposal(p)
            else if (p.status === "blocked") void onBlocked(p, plant)
            else if (p.status === "executed") void onExecuted(p.id, plant)
        }
    }
}

/** One entry point for protocol messages from Relay or from glue's publish URL. */
function deliver(type: string, payload: any) {
    if (!payload || typeof payload !== "object") return
    if (type === "proposal" || type === "counter") {
        const proposal = payload.proposal ?? payload
        if (proposal?.id && proposal?.requiredVoters) void onProposal(proposal as Proposal)
    } else if (type === "executed") {
        const plantId = (payload.event?.plantId ?? String(payload.proposalId ?? "").split("-p")[0]) as PlantId
        if (plantId !== "plant-a" && plantId !== "plant-b") return
        void backend.plant(plantId).then(plant => onExecuted(payload.proposalId, plant)).catch(e => log(`executed ${payload.proposalId}: ${e}`))
    }
}

async function main() {
    log(`agents: ${owned.size} components via ${backend.name}${submitDirect ? ` (votes submitted to ${backend.name})` : " (votes via Relay only)"}`)
    for (const id of owned) {
        const llm = llmFor(vendorOf.get(id)!)
        log(`  ${relayName(id)}  ${id}  ${vendorOf.get(id)}  → ${llm ? llm.label : "baseline (no LLM key)"}`)
    }
    const key = process.env.RELAY_WORKSPACE_KEY
    // Relay connects in the background: agents vote from the first poll; Relay messages flow once it is up.
    if (key) {
        const t0 = Date.now()
        RelayBus.connect(key, [...[...owned].map(relayName), SYSTEM], join(import.meta.dir, "..", ".relay-agents.json"), log)
            .then(b => {
                bus = b
                // Accepts both {type, proposal} and glue's {type, payload: {proposal}}.
                b.onMessage(msg => deliver(msg.type, (msg as { payload?: unknown }).payload ?? msg))
                log(`relay: ${owned.size} participants on #plant-a #plant-b #company (ready in ${((Date.now() - t0) / 1000).toFixed(1)} s)`)
            })
            .catch(e => log(`relay unavailable, continuing on polling: ${e}`))
    } else log("relay: RELAY_WORKSPACE_KEY not set — running on polling only")
    // Glue's RELAY_PUBLISH_URL target (glue/HANDOFF.md): deliver to our agents now, rebroadcast on Relay.
    const port = Number(process.env.AGENT_PUBLISH_PORT ?? 7201)
    if (port > 0) {
        startPublishServer({
            port, token: process.env.RELAY_TOKEN || undefined,
            health: () => ({ agents: owned.size, relay: !key ? "off" : bus ? "connected" : "connecting", backend: backend.name }),
            onMessage: (msg: Published) => {
                deliver(msg.type, msg.payload)
                if (bus) for (const channel of msg.channels) {
                    if (channel === "plant-a" || channel === "plant-b" || channel === "company") {
                        void bus.publish(SYSTEM, channel, { type: msg.type, payload: msg.payload } as unknown as RelayMessage).catch(e => log(`relay rebroadcast failed: ${e}`))
                    }
                }
            },
        })
        log(`publish: http://127.0.0.1:${port}/publish (set RELAY_PUBLISH_URL on glue)`)
    }
    // Polling is the safety net: proposals, blocks and executions the Relay feed may have missed.
    const tick = async () => {
        await poll()
        setTimeout(tick, pollMs)
    }
    void tick()
}

await main()

// REAL-RUNTIME TESTS. These talk to a live `terse actor dev` over HTTP and fail if it is not running.
//   TERSE_URL (default http://127.0.0.1:7100)   the server under test
//   GLUE_PORT (default 7200)                    this file serves the labelled fake glue the actors post to
// Start the server with GLUE_URL pointing at GLUE_PORT. Timings use the real 10s veto window.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { ComponentState, HistoryEvent, LearnedRule, PlantState, Proposal, Vote } from "../../../shared/types"
import plants from "../../../shared/plants.json"
import history from "../fixtures/history.json"
import { componentActorId } from "../../src/ids"

const TERSE_URL = process.env.TERSE_URL ?? "http://127.0.0.1:7100"
const GLUE_PORT = Number(process.env.GLUE_PORT ?? 7200)
const voters = ["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101", "plant-b/TV-101"]
const predictions: Record<string, Record<string, number>> = {
    "plant-a/TK-101": { levelPct: 50, tempC: 74 },
    "plant-a/LV-101": { positionPct: 66 },
    "plant-a/E-101": { dutyKw: 1160 },
    "plant-a/TV-101": { positionPct: 56, steamKgH: 1980 },
    "plant-b/TV-101": { positionPct: 52, steamKgH: 1540 }
}

async function call<T>(actor: string, id: string, method: string, ...args: unknown[]): Promise<T> {
    const response = await fetch(`${TERSE_URL}/v1/projects/local/actors/${actor}/${encodeURIComponent(id)}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ requestId: crypto.randomUUID(), method, args })
    })
    const document = (await response.json()) as { outcome?: { type: string; result?: T; code?: string; message?: string }; error?: { code: string; message: string } }
    if (document.outcome?.type === "completed") return document.outcome.result as T
    throw new Error(document.outcome?.message ?? document.error?.message ?? JSON.stringify(document))
}

const plant = <T>(method: string, ...args: unknown[]) => call<T>("Plant", "plant-a", method, ...args)
const component = <T>(id: string, method: string, ...args: unknown[]) => call<T>("Component", componentActorId(id), method, ...args)

async function reset(): Promise<void> {
    await call("Company", "company", "loadSeed", plants.company)
    for (const seed of plants.plants) await call("Plant", seed.id, "loadSeed", seed, history)
    for (const seed of plants.plants) for (const state of seed.components) await component(state.id, "loadSeed", state)
}

const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const value = await read()
        if (done(value)) return value
        if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(value).slice(0, 300)}`)
        await Bun.sleep(100)
    }
}

const proposalOf = async (id: string) => (await plant<PlantState>("getState")).proposals.find(item => item.id === id)!

function propose(to: number): Promise<Proposal> {
    return plant<Proposal>("propose", { proposerComponentId: "plant-a/P-100", metric: "speedPct", to, rationale: "runtime test" })
}

function yes(proposalId: string, componentId: string): Vote {
    return {
        proposalId,
        componentId,
        agentId: `agent:${componentId}`,
        vote: "yes",
        reason: "similar runs stayed inside limits",
        predicted: predictions[componentId],
        marginPct: 10,
        evidenceEventIds: [],
        evidenceRuleIds: [],
        similarCount: 3
    }
}

async function allYes(proposalId: string): Promise<void> {
    for (const voter of voters) await plant("vote", yes(proposalId, voter))
}

// Labelled fake: it stands in for glue and the simulator, and it is the executor that claims and applies.
const dispatched: string[] = []
const fakeGlue = Bun.serve({
    port: GLUE_PORT,
    hostname: "127.0.0.1",
    async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/execute-callback") {
            const { proposalId } = (await request.json()) as { proposalId: string }
            const claim = await plant<{ dispatch: boolean; componentId: string; metric: string; value: number; token: string }>("claimDispatch", proposalId)
            if (claim.dispatch) {
                dispatched.push(proposalId)
                await component(claim.componentId, "setMetric", claim.metric, claim.value, proposalId, claim.token)
            }
        }
        return Response.json({ ok: true })
    }
})

beforeAll(reset)
afterAll(() => fakeGlue.stop(true))

describe("TASK1 list (real terse actor dev)", () => {
    test("two votes from one component: second rejected", async () => {
        await reset()
        const proposal = await propose(65)
        await plant("vote", yes(proposal.id, "plant-a/LV-101"))
        await expect(plant("vote", yes(proposal.id, "plant-a/LV-101"))).rejects.toThrow("duplicate_vote")
        expect((await proposalOf(proposal.id)).votes.length).toBe(1)
    })

    test("two proposals on one component: only one reaches veto_window", async () => {
        await reset()
        const first = await propose(65)
        const second = await propose(70)
        await allYes(first.id)
        await allYes(second.id)
        await until(() => proposalOf(first.id), value => value.status === "veto_window", 4_000)
        await Bun.sleep(2_500)
        expect((await proposalOf(second.id)).status).toBe("voting")
        await plant("veto", first.id, "runtime test")
        await until(() => proposalOf(second.id), value => value.status === "veto_window", 4_000)
    }, 15_000)

    test("similar returns the seeded >=80% events with LV-101 >= 85", async () => {
        await reset()
        const found = await plant<HistoryEvent[]>("similar", "plant-a/P-100", "speedPct", 85, { feedM3h: 15, headerBarg: 6, feedTempC: 25 }, 5)
        expect(found.length).toBe(5)
        for (const event of found) {
            expect(event.after).toBeGreaterThanOrEqual(80)
            expect(event.effects.find(row => row.componentId === "plant-a/LV-101")!.after).toBeGreaterThanOrEqual(85)
        }
    })

    test("propose from P-100 requires four local voters plus plant-b/TV-101", async () => {
        await reset()
        const proposal = await propose(65)
        expect(proposal.requiredVoters).toEqual(voters)
        expect(proposal.crossPlant).toBe(true)
        expect(proposal.from).toBe(50)
        expect(proposal.status).toBe("voting")
    })

    test("five large calibration errors raise marginPct to 15", async () => {
        await reset()
        for (let index = 0; index < 5; index++) {
            await component("plant-a/LV-101", "addCalibration", { at: new Date().toISOString(), proposalId: `calibration-${index}`, metric: "positionPct", predicted: 60, observed: 80, absError: 20 })
        }
        expect((await component<ComponentState>("plant-a/LV-101", "getState")).marginPct).toBe(15)
    })

    test("rule promotion fires on the third matching event and dedupes on the fourth", async () => {
        const seed = plants.plants[0]
        await call("Company", "company", "loadSeed", plants.company)
        await plant("loadSeed", seed, [])
        const event = (id: string, after: number, lvAfter: number): HistoryEvent => ({
            id,
            at: new Date().toISOString(),
            plantId: "plant-a",
            componentId: "plant-a/P-100",
            metric: "speedPct",
            before: 50,
            after,
            upstreamSnapshot: {},
            effects: [{ componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: lvAfter, ticksToSettle: 3 }],
            incident: null,
            approvedBy: [],
            operator: null,
            proposalId: null
        })
        await plant("recordEvent", event("rule-1", 82, 86))
        await plant("recordEvent", event("rule-2", 84, 87))
        expect((await plant<PlantState>("getState")).rules).toEqual([])
        await plant("recordEvent", event("rule-3", 86, 89))
        const third = (await plant<PlantState>("getState")).rules as LearnedRule[]
        expect(third.length).toBe(1)
        expect(third[0].timesSeen).toBe(3)
        await plant("recordEvent", event("rule-4", 85, 88))
        const fourth = (await plant<PlantState>("getState")).rules as LearnedRule[]
        expect(fourth.length).toBe(1)
        expect(fourth[0].timesSeen).toBe(4)
        expect(fourth[0].id).toBe(third[0].id)
    })
})

describe("execution path (real terse actor dev, fake glue)", () => {
    test("unapproved writes, early execute and token replay are rejected; acceptance and observation stay separate", async () => {
        await reset()
        dispatched.length = 0
        await expect(component("plant-a/P-100", "setMetric", "speedPct", 65, "plant-a-p00001-x", "forged")).rejects.toThrow("invalid_token")
        const proposal = await propose(65)
        await expect(plant("execute", proposal.id)).rejects.toThrow("not_approved")
        await allYes(proposal.id)
        const windowed = await until(() => proposalOf(proposal.id), value => value.status === "veto_window", 4_000)
        expect(windowed.vetoDeadline).not.toBeNull()
        await expect(plant("execute", proposal.id)).rejects.toThrow("veto_window_open")

        await until(() => proposalOf(proposal.id), value => value.status === "executed", 15_000)
        const applied = await until(() => plant<{ state: string }>("getExecution", proposal.id), value => value.state === "applied", 4_000)
        expect(applied.state).toBe("applied")
        expect(dispatched).toEqual([proposal.id])
        expect((await component<ComponentState>("plant-a/P-100", "getState")).metrics.speedPct).toBe(65)

        await plant("execute", proposal.id)
        expect((await plant<{ dispatch: boolean }>("claimDispatch", proposal.id)).dispatch).toBe(false)
        await Bun.sleep(5_000)
        expect(dispatched).toEqual([proposal.id])

        const effects = [{ componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: 66, ticksToSettle: 3 }]
        const event = await plant<HistoryEvent>("recordEvent", { proposalId: proposal.id, effects })
        const again = await plant<HistoryEvent>("recordEvent", { proposalId: proposal.id, effects })
        expect(again.id).toBe(event.id)
        expect((await plant<{ state: string }>("getExecution", proposal.id)).state).toBe("observed")
        const found = await plant<HistoryEvent[]>("similar", "plant-a/P-100", "speedPct", 85, {}, 5)
        expect(found[0].id).toBe(event.id)
    }, 40_000)

    test("alarms run: tick advances and missing votes are swept", async () => {
        await reset()
        const before = (await plant<PlantState>("getState")).tick
        await Bun.sleep(3_500)
        const after = (await plant<PlantState>("getState")).tick
        expect(after).toBeGreaterThanOrEqual(before + 2)
    })
})

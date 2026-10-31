// REAL-RUNTIME TESTS. These talk to a live `terse actor dev` over HTTP and fail if it is not running.
//   TERSE_URL (default http://127.0.0.1:7100)   the server under test
//   GLUE_PORT (default 7200)                    this file serves the labelled fake glue the actors post to
// Start the server with GLUE_URL pointing at GLUE_PORT. Timings use the real 10s veto window.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
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

// Company first: a Plant's first sweep pushes seed-derived rules, and a later Company.loadSeed would wipe them.
async function reset(): Promise<void> {
    const started = performance.now()
    await call("Company", "company", "loadSeed", plants.company)
    await Promise.all(plants.plants.map(seed => call("Plant", seed.id, "loadSeed", seed, history)))
    await Promise.all(plants.plants.flatMap(seed => seed.components.map(state => component(state.id, "loadSeed", state))))
    console.log(`reset took ${Math.round(performance.now() - started)} ms`)
}

const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const value = await read()
        if (done(value)) return value
        if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(value).slice(0, 300)}`)
        await Bun.sleep(250)
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
    await Promise.all(voters.map(voter => plant("vote", yes(proposalId, voter))))
}

async function execute(to: number): Promise<string> {
    const proposal = await propose(to)
    await allYes(proposal.id)
    await until(() => proposalOf(proposal.id), value => value.status === "executed", 30_000)
    await until(() => plant<{ state: string }>("getExecution", proposal.id), value => value.state === "applied", 10_000)
    return proposal.id
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

setDefaultTimeout(180_000)
beforeAll(reset, 60_000)
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
        await until(() => proposalOf(first.id), value => value.status === "veto_window", 8_000)
        await Bun.sleep(2_500)
        expect((await proposalOf(second.id)).status).toBe("voting")
        await plant("veto", first.id, "runtime test")
        await until(() => proposalOf(second.id), value => value.status === "veto_window", 8_000)
    })

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
        for (let run = 0; run < 5; run++) {
            const proposalId = await execute(run % 2 === 0 ? 65 : 70)
            await plant("recordEvent", { proposalId, effects: [{ componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: 86, ticksToSettle: 3 }] })
            await component("plant-a/LV-101", "addCalibration", { at: new Date().toISOString(), proposalId, metric: "positionPct", predicted: 66, observed: 86, absError: 20 })
        }
        expect((await component<ComponentState>("plant-a/LV-101", "getState")).marginPct).toBe(15)
    })

    test("rule promotion fires on the third matching event and dedupes on the fourth", async () => {
        const seed = plants.plants[0]
        const event = (id: string, after: number, level: number): HistoryEvent => ({
            id,
            at: new Date().toISOString(),
            plantId: "plant-a",
            componentId: "plant-a/P-100",
            metric: "speedPct",
            before: 50,
            after,
            upstreamSnapshot: {},
            effects: [{ componentId: "plant-a/TK-101", metric: "levelPct", before: 50, after: level, ticksToSettle: 3 }],
            incident: null,
            approvedBy: [],
            operator: null,
            proposalId: null
        })
        // Consequence 70 stays under TK-101's threshold of 72, so the learned rule does not refuse the fourth run.
        const seeded = [event("safe-1", 76, 60), event("safe-2", 77, 61), event("safe-3", 78, 62), event("rule-1", 82, 71), event("rule-2", 84, 71.5)]
        await call("Company", "company", "loadSeed", plants.company)
        await plant("loadSeed", seed, seeded)
        expect((await plant<PlantState>("getState")).rules).toEqual([])

        const level = (after: number) => [{ componentId: "plant-a/TK-101", metric: "levelPct", before: 50, after, ticksToSettle: 3 }]
        await plant("recordEvent", { proposalId: await execute(85), effects: level(72) })
        const third = (await plant<PlantState>("getState")).rules as LearnedRule[]
        expect(third.length).toBe(1)
        expect(third[0].timesSeen).toBe(3)
        await plant("recordEvent", { proposalId: await execute(87), effects: level(72.5) })
        const fourth = (await plant<PlantState>("getState")).rules as LearnedRule[]
        expect(fourth.length).toBe(1)
        expect(fourth[0].timesSeen).toBe(4)
        expect(fourth[0].id).toBe(third[0].id)
    })
})

describe("execution path (real terse actor dev, fake glue)", () => {
    test("a no blocks at once; fabricated events and calibration for runs that never happened are refused", async () => {
        await reset()
        const proposal = await propose(65)
        const blocked = await plant<Proposal>("vote", { ...yes(proposal.id, "plant-a/LV-101"), vote: "no", reason: "refused" })
        expect(blocked.status).toBe("blocked")
        const late = await plant<Proposal>("vote", yes(proposal.id, "plant-b/TV-101"))
        expect(late.status).toBe("blocked")
        expect(late.votes.length).toBe(2)
        await expect(plant("recordEvent", { proposalId: null, effects: [] })).rejects.toThrow("invalid_event")
        await expect(plant("recordEvent", { proposalId: proposal.id, effects: [] })).rejects.toThrow("not_executed")
        await expect(
            component("plant-a/LV-101", "addCalibration", { at: new Date().toISOString(), proposalId: proposal.id, metric: "positionPct", predicted: 66, observed: 66, absError: 0 })
        ).rejects.toThrow("invalid_calibration")
    })

    test("unapproved writes, early execute and token replay are rejected; acceptance and observation stay separate", async () => {
        await reset()
        dispatched.length = 0
        await expect(component("plant-a/P-100", "setMetric", "speedPct", 65, "plant-a-p00001-x", "forged")).rejects.toThrow("invalid_token")
        const proposal = await propose(65)
        await expect(plant("execute", proposal.id)).rejects.toThrow("not_approved")
        await allYes(proposal.id)
        const windowed = await until(() => proposalOf(proposal.id), value => value.status === "veto_window", 8_000)
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
    })

    test("alarms run: tick advances and missing votes are swept", async () => {
        await reset()
        const before = (await plant<PlantState>("getState")).tick
        await Bun.sleep(3_500)
        const after = (await plant<PlantState>("getState")).tick
        expect(after).toBeGreaterThanOrEqual(before + 2)
    })
})

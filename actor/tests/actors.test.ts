// Integration tests: real Component / Plant / Company actors in an isolated local runtime,
// called through the generated client exactly as the integration service will call them.
// Run: bun run test   (regenerates the client first)
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { startLocalActors, type LocalActorRuntime } from "terse-sdk/dev"
import type { Vote } from "../../shared/types.js"
import { fixtureHistory, plantSeed, plants, speedEvent } from "./fixtures.js"

type Client = typeof import("../client/generated/index.js")
let rt: LocalActorRuntime
let actors: Client["actors"]

const VETO_MS = 300
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const A = "plant-a", B = "plant-b"
const plantA = () => actors.Plant.get(A)
const plantB = () => actors.Plant.get(B)
const comp = (componentId: string) => actors.Component.get(componentId.replace("/", "."))
const LOCAL_VOTERS = ["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101"]
const ALL_VOTERS = [...LOCAL_VOTERS, "plant-b/TV-101"]

/** A well-formed vote; predictions default to safe values for each voter. */
function vote(proposalId: string, componentId: string, yes: boolean, extra: Partial<Vote> = {}): Vote {
    const safe: Record<string, Record<string, number>> = {
        "TK-101": { levelPct: 50, tempC: 73 }, "LV-101": { positionPct: 66 }, "E-101": { dutyKw: 1160 },
        "TV-101": { positionPct: 57, steamKgH: 1980 },
    }
    return {
        proposalId, componentId, agentId: `agent:${componentId}`, vote: yes ? "yes" : "no",
        reason: yes ? "history at this speed is safe" : "predicted past threshold",
        predicted: safe[componentId.split("/")[1]!]!, marginPct: 10,
        evidenceEventIds: [], evidenceRuleIds: [], similarCount: 5, ...extra,
    }
}

async function seed() {
    const history = fixtureHistory()
    await actors.Company.get("company").loadSeed(plants.company)
    await plantA().loadSeed(plantSeed(A), history, { clock: false, vetoWindowMs: VETO_MS })
    await plantB().loadSeed(plantSeed(B), history, { clock: false, vetoWindowMs: VETO_MS })
}

beforeAll(async () => {
    rt = await startLocalActors({
        entrypoint: "src/actors.ts", project: `${import.meta.dir}/..`, dataDir: `${tmpdir()}/actorrelay-actor-test-${Date.now()}`,
        port: 0, quiet: true,
    })
    process.env.TERSE_ACTOR_URL = `${rt.connection.controlPlaneUrl}/v1/projects/${rt.connection.projectId}/actors`
    ;({ actors } = await import("../client/generated/index.js"))
    // The runtime reports ready before the actor build is registered; wait for the first call to land.
    const deadline = Date.now() + 90_000
    for (;;) {
        try {
            await actors.Company.get("company").read()
            break
        } catch (error) {
            if (Date.now() > deadline || !String(error).includes("no registered actor code")) throw error
            await sleep(250)
        }
    }
}, 120_000)

afterAll(async () => {
    await rt?.stop()
})

beforeEach(seed, 60_000)

describe("TASK1 required tests", () => {
    test("two vote calls for the same componentId on one proposal → second rejected", async () => {
        const p = await plantA().propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 65, rationale: "test" })
        await plantA().vote(vote(p.id, "plant-a/TK-101", true))
        await expect(plantA().vote(vote(p.id, "plant-a/TK-101", true))).rejects.toThrow(/duplicate vote/)
        const after = (await plantA().read()).proposals.find(x => x.id === p.id)!
        expect(after.votes.length).toBe(1)
    })

    test("two proposals on the same component → only one reaches veto_window", async () => {
        const p1 = await plantA().propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 65, rationale: "first" })
        const p2 = await plantA().propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 64, rationale: "second" })
        for (const id of ALL_VOTERS) await plantA().vote(vote(p1.id, id, true))
        for (const id of ALL_VOTERS) await plantA().vote(vote(p2.id, id, true))
        await plantA().sweep()
        const state = await plantA().read()
        const s1 = state.proposals.find(x => x.id === p1.id)!
        const s2 = state.proposals.find(x => x.id === p2.id)!
        expect(s1.status).toBe("veto_window")
        expect(s2.status).toBe("voting")
        expect(state.proposals.filter(x => x.status === "veto_window").length).toBe(1)
    })

    test('similar("plant-a/P-100", "speedPct", 85) returns the seeded ≥80 events with LV-101 ≥ 85', async () => {
        const got = await plantA().similar("plant-a/P-100", "speedPct", 85, { feedM3h: 15, headerBarg: 6, feedTempC: 25 }, 4)
        expect(got.length).toBe(4)
        for (const e of got) {
            expect(e.after).toBeGreaterThanOrEqual(80)
            expect(e.effects.find(f => f.componentId === "plant-a/LV-101")!.after).toBeGreaterThanOrEqual(85)
        }
    })

    test("propose from plant-a/P-100 → voters TK-101, LV-101, E-101, TV-101 + plant-b/TV-101, crossPlant", async () => {
        const p = await plantA().propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 85, rationale: "increase throughput" })
        expect(new Set(p.requiredVoters)).toEqual(new Set(ALL_VOTERS))
        expect(p.requiredVoters.length).toBe(5)
        expect(p.crossPlant).toBe(true)
        expect(p.from).toBe(50)
        expect((await actors.Company.get("company").read()).crossPlantProposals).toContain(p.id)
    })

    test("addCalibration with 5 large errors raises marginPct to 15", async () => {
        const lv = comp("plant-a/LV-101")
        for (let i = 0; i < 5; i++) {
            await lv.addCalibration({ at: new Date().toISOString(), proposalId: `cal-${i}`, metric: "positionPct", predicted: 66, observed: 78, absError: 12 })
        }
        const s = await lv.read()
        expect(s.marginPct).toBe(15)
        expect(s.calibration.length).toBe(5)
    })

    test("rule promotion fires on the third matching event and dedupes on the fourth", async () => {
        // plant-b has no ≥80 history, so its rules start empty.
        expect((await plantB().read()).rules.length).toBe(0)
        const counts: number[] = []
        for (const after of [82, 84, 86, 88]) {
            await plantB().recordEvent(speedEvent(B, 50, after, { lv: after + 4 }))
            counts.push((await plantB().read()).rules.length)
        }
        expect(counts).toEqual([0, 0, 1, 1])
        const rule = (await plantB().read()).rules[0]!
        expect(rule.timesSeen).toBe(4)
        expect(rule.text).toContain("P-100 speedPct ≥ 80 → LV-101 positionPct ≥ 86")
    })
})

describe("decision path", () => {
    test("seeded plant-a history becomes a company rule plant-b can cite", async () => {
        const company = await actors.Company.get("company").read()
        const rule = company.rules.find(r => r.model === "outlet-valve-A" && r.condition.metric === "speedPct")
        expect(rule?.scope).toBe("company")
        expect(rule?.text).toContain("Learned in plant-a")
        expect(rule?.timesSeen).toBeGreaterThanOrEqual(3)
    })

    test("a yes vote predicting past critical − margin is enforced to no → blocked", async () => {
        const p = await plantA().propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 85, rationale: "increase throughput" })
        const evidence = (await plantA().similar("plant-a/P-100", "speedPct", 85, {}, 3)).map(e => e.id)
        const after = await plantA().vote(vote(p.id, "plant-a/LV-101", true, { predicted: { positionPct: 89 }, evidenceEventIds: evidence, similarCount: 3 }))
        expect(after.status).toBe("blocked")
        const v = after.votes[0]!
        expect(v.vote).toBe("no")
        expect(v.reason).toContain("[enforced]")
        expect(v.reason).toContain("81")
    })

    test("invented evidence ids are rejected", async () => {
        const p = await plantA().propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 85, rationale: "x" })
        await expect(plantA().vote(vote(p.id, "plant-a/LV-101", false, { evidenceEventIds: ["made-up-id"] }))).rejects.toThrow(/unknown evidence/)
    })

    test("blocked 85 → counter 65 → unanimous → veto window → dispatch → accepted, token single-use", async () => {
        const bad = await plantA().propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 85, rationale: "increase throughput" })
        await plantA().vote(vote(bad.id, "plant-a/LV-101", false, { predicted: { positionPct: 89 } }))
        const counter = await plantA().propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 65, rationale: "counter", parentProposalId: bad.id })
        for (const id of ALL_VOTERS) await plantA().vote(vote(counter.id, id, true))
        let p = (await plantA().read()).proposals.find(x => x.id === counter.id)!
        expect(p.status).toBe("veto_window")
        await expect(plantA().execute(counter.id)).rejects.toThrow(/still open/)

        await sleep(VETO_MS + 100)
        await plantA().sweep()
        const pending = await plantA().pendingDispatches()
        expect(pending).toEqual([expect.objectContaining({ proposalId: counter.id, componentId: "plant-a/P-100", metric: "speedPct", value: 65, state: "pending" })])
        expect(JSON.stringify(pending)).not.toContain("token")
        // Retried sweep / execute must not create a second command.
        await plantA().sweep()
        await plantA().execute(counter.id)
        expect((await plantA().pendingDispatches()).length).toBe(1)

        const done = await plantA().confirmDispatch(counter.id, { ok: true, applied: 65 })
        expect(done.state).toBe("accepted")
        const again = await plantA().confirmDispatch(counter.id, { ok: true, applied: 65 })
        expect(again.state).toBe("accepted")
        p = (await plantA().read()).proposals.find(x => x.id === counter.id)!
        expect(p.status).toBe("executed")
        expect((await comp("plant-a/P-100").read()).metrics.speedPct).toBe(65)

        // Direct writes without a valid one-time token are refused.
        await expect(comp("plant-a/P-100").setMetric("speedPct", 85, counter.id, "00")).rejects.toThrow()
        await expect(comp("plant-a/P-100").setMetric("speedPct", 85, "forged", "ab".repeat(32))).rejects.toThrow(/no valid execute token/)
    })

    test("veto inside the window stops execution", async () => {
        const p = await plantA().propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 62, rationale: "x" })
        for (const id of ALL_VOTERS) await plantA().vote(vote(p.id, id, true))
        const vetoed = await plantA().veto(p.id, "operator")
        expect(vetoed.status).toBe("vetoed")
        await sleep(VETO_MS + 100)
        await plantA().sweep()
        expect(await plantA().pendingDispatches()).toEqual([])
    })

    test("non-voters and votes on closed proposals are rejected", async () => {
        const p = await plantA().propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 85, rationale: "x" })
        await expect(plantA().vote(vote(p.id, "plant-b/LV-101", true))).rejects.toThrow(/not a required voter/)
        await plantA().vote(vote(p.id, "plant-a/LV-101", false, { predicted: { positionPct: 89 } }))
        // Late votes on a blocked proposal are recorded; the status stays blocked.
        const late = await plantA().vote(vote(p.id, "plant-a/TK-101", true))
        expect(late.status).toBe("blocked")
        expect(late.votes.length).toBe(2)
        await plantA().veto(p.id, "operator").catch(() => {})
        const vetoable = await plantA().propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 62, rationale: "x" })
        for (const id of ALL_VOTERS) await plantA().vote(vote(vetoable.id, id, true))
        await plantA().veto(vetoable.id, "operator")
        await expect(plantA().vote(vote(vetoable.id, "plant-a/TK-101", true))).rejects.toThrow(/not voting/)
    })
})

describe("input validation", () => {
    test("malformed votes and proposals are rejected with the bad fields named", async () => {
        const p = await plantA().propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 85, rationale: "x" })
        await expect(plantA().vote({ proposalId: p.id } as unknown as Vote)).rejects.toThrow(/invalid vote/)
        await expect(plantA().vote({ ...vote(p.id, "plant-a/LV-101", true), vote: "maybe" } as unknown as Vote)).rejects.toThrow(/invalid vote: vote/)
        await expect(plantA().propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: Number.NaN, rationale: "x" })).rejects.toThrow()
        await expect(plantA().propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 99, rationale: "x" })).rejects.toThrow(/outside speedPct limits/)
        expect((await plantA().read()).proposals.find(x => x.id === p.id)!.votes.length).toBe(0)
    })
})

describe("glue dispatch handshake", () => {
    async function approved(to: number) {
        const p = await plantA().propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to, rationale: "glue" })
        for (const id of ALL_VOTERS) await plantA().vote(vote(p.id, id, true))
        await sleep(VETO_MS + 100)
        await plantA().sweep()
        return p
    }

    test("after the veto window the sweep marks the proposal executed with a pending dispatch", async () => {
        const p = await approved(65)
        const s = (await plantA().read()).proposals.find(x => x.id === p.id)!
        expect(s.status).toBe("executed")
        expect(await plantA().pendingDispatches()).toEqual([expect.objectContaining({ proposalId: p.id, value: 65, state: "pending" })])
    })

    test("claimDispatch hands the token to exactly one caller; setMetric accepts it once", async () => {
        const p = await approved(65)
        const first = await plantA().claimDispatch(p.id)
        expect(first).toMatchObject({ dispatch: true, proposalId: p.id, componentId: "plant-a/P-100", metric: "speedPct", value: 65 })
        const second = await plantA().claimDispatch(p.id)
        expect(second).toEqual({ dispatch: false, proposalId: p.id, state: "claimed" })
        if (!first.dispatch) throw new Error("unreachable")
        await comp("plant-a/P-100").setMetric(first.metric, first.value, p.id, first.token)
        expect((await comp("plant-a/P-100").read()).metrics.speedPct).toBe(65)
        await expect(comp("plant-a/P-100").setMetric(first.metric, first.value, p.id, first.token)).rejects.toThrow(/token_already_used/)
        expect(await plantA().pendingDispatches()).toEqual([])
    })

    test("reportDispatchFailure blocks the proposal (idempotent)", async () => {
        const p = await approved(64)
        const failed = await plantA().reportDispatchFailure(p.id, "simulation refused")
        expect(failed.state).toBe("failed")
        const again = await plantA().reportDispatchFailure(p.id, "again")
        expect(again.error).toBe("simulation refused")
        const s = (await plantA().read()).proposals.find(x => x.id === p.id)!
        expect(s.status).toBe("blocked")
        expect((await plantA().claimDispatch(p.id)).dispatch).toBe(false)
    })
})

// Agent behaviour against an in-memory backend (shared/plants.json + fixture history + the actors' own logic).
import { describe, expect, test } from "bun:test"
import type { LearnedRule, Vote } from "../../shared/types.js"
import { speedEvent } from "../../actor/tests/fixtures.js"
import { calibrationsFor, counterFor, decideVote, type Deps } from "../src/pipeline.js"
import { FakeBackend, FakeLlm, proposal } from "./fake.js"

const baseline = (backend: FakeBackend): Deps => ({ backend, llmFor: () => null })
const withLlm = (backend: FakeBackend, llm: FakeLlm): Deps => ({ backend, llmFor: () => llm })

const companyRule: LearnedRule = {
    id: "company:rule-x", scope: "company", model: "outlet-valve-A",
    text: "Learned in plant-a: P-100 speedPct ≥ 80 → LV-101 positionPct ≥ 85",
    condition: { componentId: "plant-a/P-100", metric: "speedPct", op: ">=", value: 80 },
    consequence: { componentId: "plant-a/LV-101", metric: "positionPct", op: ">=", value: 85, withinTicks: 3 },
    supportEventIds: [], timesSeen: 4, createdAt: "t", lastSeenAt: "t",
}

describe("vote pipeline (TASK1 agent tests)", () => {
    test("1. plant-a LV-101 votes no on P-100 50→85 with ≥3 evidence and positionPct ≥ 81", async () => {
        const backend = new FakeBackend()
        const v = await decideVote(proposal({ to: 85 }), "plant-a/LV-101", baseline(backend))
        expect(v.vote).toBe("no")
        expect(v.evidenceEventIds.length).toBeGreaterThanOrEqual(3)
        expect(v.predicted.positionPct).toBeGreaterThanOrEqual(81)
        expect(v.similarCount).toBeGreaterThanOrEqual(3)
        const known = new Set(backend.plants.get("plant-a")!.history.map(e => e.id))
        for (const id of v.evidenceEventIds) expect(known.has(id)).toBe(true)
    })

    test("2. plant-a LV-101 votes yes on 50→65 with positionPct in 60–72", async () => {
        const v = await decideVote(proposal({ to: 65 }), "plant-a/LV-101", baseline(new FakeBackend()))
        expect(v.vote).toBe("yes")
        expect(v.predicted.positionPct).toBeGreaterThanOrEqual(60)
        expect(v.predicted.positionPct).toBeLessThanOrEqual(72)
    })

    test("3. plant-b TV-101 (cross-plant) predicts a header pressure drop for plant-a P-100 → 85", async () => {
        const v = await decideVote(proposal({ to: 85, crossPlant: true }), "plant-b/TV-101", baseline(new FakeBackend()))
        expect(v.componentId).toBe("plant-b/TV-101")
        expect(v.predicted.headerBarg).toBeLessThan(6.0)
    })

    test("4. plant-b LV-101: insufficient history before the company rule, rule cited after", async () => {
        const backend = new FakeBackend()
        const p = proposal({ plantId: "plant-b", to: 85 })
        const before = await decideVote(p, "plant-b/LV-101", baseline(backend))
        expect(before.vote).toBe("no")
        expect(before.reason).toContain("insufficient history")
        expect(before.evidenceRuleIds).toEqual([])

        backend.companyRules.push(companyRule)
        const after = await decideVote(p, "plant-b/LV-101", baseline(backend))
        expect(after.vote).toBe("no")
        expect(after.evidenceRuleIds).toContain("company:rule-x")
        expect(after.predicted.positionPct).toBeGreaterThanOrEqual(85)
    })

    test("5. malformed LLM output → one retry → safe no", async () => {
        const llm = new FakeLlm(["not json at all", { vote: "maybe" }])
        const v = await decideVote(proposal({ to: 65 }), "plant-a/LV-101", withLlm(new FakeBackend(), llm))
        expect(llm.calls).toBe(2)
        expect(v.vote).toBe("no")
        expect(v.reason).toContain("malformed")
    })

    test("9. an LLM yes predicting positionPct 89 is enforced to no", async () => {
        const llm = new FakeLlm([{ vote: "yes", reason: "looks fine", predicted: [{ metric: "positionPct", value: 89 }] }])
        const v = await decideVote(proposal({ to: 85 }), "plant-a/LV-101", withLlm(new FakeBackend(), llm))
        expect(v.vote).toBe("no")
        expect(v.reason).toContain("[enforced")
        expect(v.predicted.positionPct).toBe(89)
    })

    test("8. after a fresh execution, the repeated 85 cites it first and still votes no", async () => {
        const backend = new FakeBackend()
        backend.record({ ...speedEvent("plant-a", 50, 65, { lv: 67, at: new Date().toISOString() }), id: "plant-a-live-1" })
        const v = await decideVote(proposal({ to: 85 }), "plant-a/LV-101", baseline(backend))
        expect(v.evidenceEventIds[0]).toBe("plant-a-live-1")
        expect(v.vote).toBe("no")
    })
})

describe("counter-proposals", () => {
    test("7. blocked 85 (LV-101 no) → counter to 65 under the same parent", async () => {
        const backend = new FakeBackend()
        const noVote: Vote = {
            proposalId: "x", componentId: "plant-a/LV-101", agentId: "agent:plant-a/LV-101", vote: "no",
            reason: "predicted positionPct 89 ≥ 81", predicted: { positionPct: 89 }, marginPct: 10,
            evidenceEventIds: [], evidenceRuleIds: [], similarCount: 5,
        }
        const blocked = proposal({ to: 85, status: "blocked" })
        blocked.votes = [{ ...noVote, proposalId: blocked.id }]
        const plant = await backend.plant("plant-a")
        const counter = await counterFor(blocked, { ...plant, proposals: [blocked] }, baseline(backend))
        expect(counter).not.toBeNull()
        expect(counter!.to).toBe(65)
        expect(counter!.parentProposalId).toBe(blocked.id)
        expect(counter!.proposerComponentId).toBe("plant-a/P-100")
    })

    test("no counter once the parent already has 2 counters", async () => {
        const backend = new FakeBackend()
        const blocked = proposal({ to: 85, status: "blocked" })
        blocked.votes = [{ proposalId: blocked.id, componentId: "plant-a/LV-101", agentId: "a", vote: "no", reason: "r", predicted: { positionPct: 89 }, marginPct: 10, evidenceEventIds: [], evidenceRuleIds: [], similarCount: 5 }]
        const kids = [proposal({ to: 65, parentProposalId: blocked.id }), proposal({ to: 60, parentProposalId: blocked.id })]
        const plant = await backend.plant("plant-a")
        expect(await counterFor(blocked, { ...plant, proposals: [blocked, ...kids] }, baseline(backend))).toBeNull()
    })
})

describe("learning", () => {
    test("6. calibration: a 1-point error keeps marginPct; five 12-point errors raise it", async () => {
        const backend = new FakeBackend()
        const voted = (id: string, predicted: number) => {
            const p = proposal({ id, to: 65, status: "executed" })
            p.votes = [{ proposalId: id, componentId: "plant-a/LV-101", agentId: "a", vote: "yes", reason: "r", predicted: { positionPct: predicted }, marginPct: 10, evidenceEventIds: [], evidenceRuleIds: [], similarCount: 5 }]
            return p
        }
        const owned = new Set(["plant-a/LV-101"])

        const first = voted("cal-0", 66)
        for (const c of calibrationsFor(first, { ...speedEvent("plant-a", 50, 65, { lv: 67 }), proposalId: "cal-0" }, owned)) await backend.addCalibration(c.componentId, c.entry)
        expect((await backend.component("plant-a/LV-101")).marginPct).toBe(10)

        const fresh = new FakeBackend()
        for (let i = 1; i <= 5; i++) {
            const p = voted(`cal-${i}`, 66)
            const entries = calibrationsFor(p, { ...speedEvent("plant-a", 50, 65, { lv: 78 }), proposalId: p.id }, owned)
            expect(entries.length).toBe(1)
            expect(entries[0]!.entry.absError).toBe(12)
            for (const c of entries) await fresh.addCalibration(c.componentId, c.entry)
        }
        expect((await fresh.component("plant-a/LV-101")).marginPct).toBeGreaterThan(10)
    })

    test("calibration only for components this process owns", () => {
        const p = proposal({ to: 65, status: "executed" })
        p.votes = [{ proposalId: p.id, componentId: "plant-a/LV-101", agentId: "a", vote: "yes", reason: "r", predicted: { positionPct: 66 }, marginPct: 10, evidenceEventIds: [], evidenceRuleIds: [], similarCount: 5 }]
        expect(calibrationsFor(p, speedEvent("plant-a", 50, 65, { lv: 67 }), new Set(["plant-a/TK-101"]))).toEqual([])
    })
})

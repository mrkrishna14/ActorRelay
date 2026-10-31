import { describe, expect, test } from "bun:test"
import {
    actorIdFor, componentIdFor, crossPlantVoters, executeToken, nextMargin, reachableVoters,
    rulesFromEvent, similarEvents, statusFor, verifyExecuteToken, type ComponentInfo,
} from "../src/logic.js"
import type { CalibrationEntry, HistoryEvent } from "../../shared/types.js"
import { fixtureHistory, plantSeed, plants, speedEvent } from "./fixtures.js"

const infoOf = (plant: "plant-a" | "plant-b") =>
    Object.fromEntries(plantSeed(plant).components.map(c => [c.id, c as ComponentInfo])) as Record<string, ComponentInfo>

describe("ids", () => {
    test("ComponentId <-> actor id (actor ids cannot contain '/')", () => {
        expect(actorIdFor("plant-a/LV-101")).toBe("plant-a.LV-101")
        expect(componentIdFor("plant-a.LV-101")).toBe("plant-a/LV-101")
    })
})

describe("status", () => {
    const limits = { positionPct: { min: 10, max: 80, critical: 90 } }
    test("ok below max, warning at max, critical at critical", () => {
        expect(statusFor({ positionPct: 79.9 }, limits)).toBe("ok")
        expect(statusFor({ positionPct: 80 }, limits)).toBe("warning")
        expect(statusFor({ positionPct: 90 }, limits)).toBe("critical")
    })
})

describe("voters", () => {
    test("P-100 reaches every other component in its plant", () => {
        expect(new Set(reachableVoters(infoOf("plant-a"), "plant-a/P-100"))).toEqual(
            new Set(["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101"]),
        )
    })
    test("shared steam header pulls in the other plant's TV-101", () => {
        const voters = crossPlantVoters(plants.company.sharedResources, {
            plantId: "plant-a", proposerComponentId: "plant-a/P-100",
            requiredVoters: ["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101"],
        })
        expect(voters).toEqual(["plant-b/TV-101"])
    })
})

describe("similar", () => {
    test("nearest P-100 speed changes to 85 are the seeded ≥ 80 runs, LV-101 ≥ 85", () => {
        const got = similarEvents(fixtureHistory(), "plant-a/P-100", "speedPct", 85, {}, 4, 70)
        expect(got.length).toBe(4)
        for (const e of got) {
            expect(e.after).toBeGreaterThanOrEqual(80)
            expect(e.effects.find(f => f.componentId === "plant-a/LV-101")!.after).toBeGreaterThanOrEqual(85)
        }
    })
    test("only the same component and metric are considered", () => {
        expect(similarEvents(fixtureHistory(), "plant-a/LV-101", "positionPct", 85, {}, 5, 70)).toEqual([])
    })
})

describe("calibration margin", () => {
    const limits = { positionPct: { min: 10, max: 80, critical: 90 } }
    const entry = (err: number): CalibrationEntry => ({ at: "t", proposalId: "p", metric: "positionPct", predicted: 66, observed: 66 + err, absError: err })
    test("5 large errors raise marginPct from 10 to 15", () => {
        const big = [12, 12, 12, 12, 12].map(entry)
        expect(nextMargin(big.slice(0, 4), limits, 10)).toBe(10)
        expect(nextMargin(big, limits, 10)).toBe(15)
    })
    test("5 tiny errors lower it by 2; capped at 5..25", () => {
        expect(nextMargin([0, 0, 1, 0, 0].map(entry), limits, 10)).toBe(8)
        expect(nextMargin([0, 0, 0, 0, 0].map(entry), limits, 5)).toBe(5)
        expect(nextMargin([30, 30, 30, 30, 30].map(entry), limits, 25)).toBe(25)
    })
})

describe("rule promotion", () => {
    test("fires on the third matching event and dedupes on the fourth", () => {
        const info = infoOf("plant-b")
        let history: HistoryEvent[] = []
        let rules: ReturnType<typeof rulesFromEvent> = []
        const seen: number[] = []
        for (const after of [82, 84, 86, 88]) {
            const e = speedEvent("plant-b", 50, after, { lv: after + 4 })
            history = [...history, e]
            const changed = rulesFromEvent(history, e, info, e.at, rules)
            for (const r of changed) rules = rules.some(x => x.id === r.id) ? rules.map(x => (x.id === r.id ? r : x)) : [...rules, r]
            seen.push(rules.length)
        }
        expect(seen).toEqual([0, 0, 1, 1])
        expect(rules[0]!.timesSeen).toBe(4)
        expect(rules[0]!.condition).toEqual({ componentId: "plant-b/P-100", metric: "speedPct", op: ">=", value: 80 })
        expect(rules[0]!.consequence).toMatchObject({ componentId: "plant-b/LV-101", metric: "positionPct", op: ">=", value: 86 })
        expect(rules[0]!.model).toBe("outlet-valve-A")
    })
})

describe("execute token", () => {
    test("valid only for the exact proposal, component, metric and value", () => {
        const t = executeToken("plant-a-p0001", "plant-a/P-100", "speedPct", 65)
        expect(verifyExecuteToken(t, "plant-a-p0001", "plant-a/P-100", "speedPct", 65)).toBe(true)
        expect(verifyExecuteToken(t, "plant-a-p0001", "plant-a/P-100", "speedPct", 85)).toBe(false)
        expect(verifyExecuteToken(t, "plant-a-p0002", "plant-a/P-100", "speedPct", 65)).toBe(false)
        expect(verifyExecuteToken("deadbeef", "plant-a-p0001", "plant-a/P-100", "speedPct", 65)).toBe(false)
    })
})

describe("frozen contract", () => {
    test("actor/src/types.ts is an exact copy of shared/types.ts (run `bun run sync-types`)", async () => {
        const shared = await Bun.file(`${import.meta.dir}/../../shared/types.ts`).text()
        const local = await Bun.file(`${import.meta.dir}/../src/types.ts`).text()
        expect(local).toBe(shared)
    })
})

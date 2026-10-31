// Runs against the local dev server (`cd actor && terse actor dev`, :7100, project local).
import { beforeAll, describe, expect, test } from "bun:test"
import { fixtureHistory, plants, plantSeed } from "../tests/fixtures.js"
import { actorIdOf, createActorPort } from "./port.js"

const port = createActorPort()

beforeAll(async () => {
    delete process.env.TERSE_ACTOR_URL // local default
    await port.call("Company", "company", "loadSeed", [plants.company])
    await port.call("Plant", "plant-a", "loadSeed", [plantSeed("plant-a"), fixtureHistory(), { clock: false }])
}, 60_000)

describe("glue actor port", () => {
    test("id mapping", () => {
        expect(actorIdOf("Component", "plant-a/LV-101")).toBe("plant-a.LV-101")
        expect(actorIdOf("Plant", "plant-b")).toBe("plant-b")
        expect(actorIdOf("Company", "anything")).toBe("company")
    })

    test("read(Component, ComponentId)", async () => {
        const lv = await port.read("Component", "plant-a/LV-101")
        expect(lv.name).toBe("Outlet level valve")
        expect(lv.id).toBe("plant-a/LV-101")
    })

    test("call(Plant, similar)", async () => {
        const events = await port.call("Plant", "plant-a", "similar", ["plant-a/P-100", "speedPct", 85, {}, 3])
        expect(events.length).toBe(3)
    })

    test("read(Company) and read(Plant)", async () => {
        expect((await port.read("Company", "company")).plants).toContain("plant-a")
        expect((await port.read("Plant", "plant-a")).components.length).toBe(5)
    })

    test("actor errors surface with their message intact", async () => {
        await expect(port.call("Plant", "plant-a", "vote", [{ proposalId: "junk" }])).rejects.toThrow(/invalid vote/)
    })
})

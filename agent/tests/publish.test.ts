import { afterAll, describe, expect, test } from "bun:test"
import { startPublishServer, type Published } from "../src/publish.js"

const received: Published[] = []
const server = startPublishServer({ port: 0, token: "secret", onMessage: m => received.push(m), health: () => ({ agents: 10 }) })
const base = `http://127.0.0.1:${server.port}`
afterAll(() => server.stop(true))

const post = (body: unknown, token?: string) =>
    fetch(`${base}/publish`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })

describe("glue publish bridge (RELAY_PUBLISH_URL)", () => {
    test("wrong or missing bearer → 401, nothing delivered", async () => {
        expect((await post({ type: "proposal", payload: {}, channels: ["plant-a"] }, "nope")).status).toBe(401)
        expect((await post({ type: "proposal", payload: {}, channels: ["plant-a"] })).status).toBe(401)
        await Bun.sleep(10)
        expect(received.length).toBe(0)
    })

    test("correct bearer → 200 and the message reaches the agents", async () => {
        const payload = { proposal: { id: "plant-a-p0001", requiredVoters: ["plant-a/LV-101"] } }
        const res = await post({ type: "proposal", payload, channels: ["plant-a", "company"] }, "secret")
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        await Bun.sleep(10)
        expect(received).toEqual([{ type: "proposal", payload, channels: ["plant-a", "company"] }])
    })

    test("malformed body → 400", async () => {
        expect((await post({ payload: {} }, "secret")).status).toBe(400)
    })

    test("GET /health → ok", async () => {
        const res = await fetch(`${base}/health`)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, agents: 10 })
    })
})

// Drives glue's real ActorAdapter against rpc.ts and port.ts. NO REAL ACTORS OR TERSE RUNTIME RUN HERE.
//   [stub]       the in-memory stand-in below, injected at the single Terse seam (ActorInvoke).
//   [fake terse] a local HTTP server imitating Terse's invoke route, shaped like actor/tests/chaos/lib/client.ts.
//                The body it sends for an unknown method is assumed, not captured from a real runtime.
import { afterAll, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { ActorAdapter, ApiError, type ActorKind } from "../../../glue/actors"
import defaultPort, { ALLOWED_METHODS, createActorPort, terseInvoke, type ActorInvoke } from "../port"
import { createRpcHandler, startRpcServer } from "../rpc"

type Invocation = { kind: ActorKind; actorId: string; method: string; args: unknown[] }

const STUB_LABEL = "in-memory stub, not Terse"

function stubActors() {
    const calls: Invocation[] = []
    const invoke: ActorInvoke = async (kind, actorId, method, args) => {
        calls.push({ kind, actorId, method, args })
        if (method === "propose") throw new ApiError(409, "out_of_limits: speedPct 99 is outside 20..95")
        if (method === "veto") throw new ApiError(503, "Plant(plant-a).veto failed: stub outage")
        if (method === "vote") throw new Error("stub bug, not an ApiError")
        return { stub: STUB_LABEL, kind, actorId, method }
    }
    return { calls, invoke }
}

const servers: { stop(force?: boolean): unknown }[] = []

function serveStub(token?: string) {
    const stub = stubActors()
    const server = startRpcServer(createRpcHandler(createActorPort(stub.invoke), token), 0)
    servers.push(server)
    return { ...stub, url: `http://127.0.0.1:${server.port}`, server }
}

const glueOver = (url: string, token = "") => new ActorAdapter(url, token, "")

async function apiError(pending: Promise<unknown>): Promise<ApiError> {
    const error = await pending.then(
        value => {
            throw new Error(`expected a rejection, got ${JSON.stringify(value)}`)
        },
        reason => reason
    )
    expect(error).toBeInstanceOf(ApiError)
    return error
}

const post = (url: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`${url}/rpc`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body })

afterAll(() => {
    for (const server of servers) server.stop(true)
})

describe("[stub] glue ActorAdapter through rpc.ts", () => {
    test("read maps to getState and a ComponentId slash becomes the Terse dot", async () => {
        const stub = serveStub()
        const state = await glueOver(stub.url).read("Component", "plant-a/LV-101")
        expect(state).toEqual({ stub: STUB_LABEL, kind: "Component", actorId: "plant-a.LV-101", method: "getState" })
        expect(stub.calls).toEqual([{ kind: "Component", actorId: "plant-a.LV-101", method: "getState", args: [] }])
    })

    test("Plant and Company ids pass through unchanged", async () => {
        const stub = serveStub()
        const glue = glueOver(stub.url)
        await glue.read("Plant", "plant-b")
        await glue.read("Company", "company")
        expect(stub.calls.map(call => [call.kind, call.actorId, call.method])).toEqual([
            ["Plant", "plant-b", "getState"],
            ["Company", "company", "getState"]
        ])
    })

    test("every allowlisted method reaches the actor with its args untouched", async () => {
        const stub = serveStub()
        const glue = glueOver(stub.url)
        const targets: Record<ActorKind, string> = { Component: "plant-a/P-100", Plant: "plant-a", Company: "company" }
        const expected: Invocation[] = []
        for (const kind of Object.keys(ALLOWED_METHODS) as ActorKind[]) {
            for (const method of ALLOWED_METHODS[kind]) {
                if (["propose", "veto", "vote"].includes(method)) continue // Canned failures, covered below.
                const args = [{ sent: `${kind}.${method}`, componentId: "plant-a/P-100" }, 5, null]
                await glue.call(kind, targets[kind], method, args)
                expected.push({ kind, actorId: kind === "Component" ? "plant-a.P-100" : targets[kind], method, args })
            }
        }
        expect(stub.calls).toEqual(expected)
    })

    test("similar keeps glue's positional args, with the slash id inside args intact", async () => {
        const stub = serveStub()
        const args = ["plant-a/P-100", "speedPct", 85, { feedM3h: 15 }, 5]
        await glueOver(stub.url).call("Plant", "plant-a", "similar", args)
        expect(stub.calls[0]).toEqual({ kind: "Plant", actorId: "plant-a", method: "similar", args })
    })

    test("anything off the allowlist is 403 and never reaches the actor", async () => {
        const stub = serveStub()
        const glue = glueOver(stub.url)
        const blocked: [ActorKind, string, string][] = [
            ["Plant", "plant-a", "execute"],
            ["Plant", "plant-a", "claimDispatch"],
            ["Plant", "plant-a", "redeemToken"],
            ["Plant", "plant-a", "tick"],
            ["Plant", "plant-a", "getState"],
            ["Component", "plant-a/P-100", "setMargin"],
            ["Component", "plant-a/P-100", "propose"],
            ["Company", "company", "promoteRule"],
            ["Company", "company", "vote"],
            ["Plant", "plant-a", "constructor"],
            ["Plant", "plant-a", "__proto__"]
        ]
        for (const [kind, id, method] of blocked) {
            const error = await apiError(glue.call(kind, id, method, []))
            expect(error.status).toBe(403)
            expect(error.message).toContain(method)
        }
        expect(stub.calls).toEqual([])
    })

    test("an actor refusal reaches glue as 409 with its stable code", async () => {
        const stub = serveStub()
        const error = await apiError(glueOver(stub.url).call("Plant", "plant-a", "propose", [{}]))
        expect(error.status).toBe(409)
        expect(error.message).toBe("out_of_limits: speedPct 99 is outside 20..95")
    })

    test("an outage and an unexpected throw both reach glue as 503", async () => {
        const stub = serveStub()
        const outage = await apiError(glueOver(stub.url).call("Plant", "plant-a", "veto", ["p", "op"]))
        expect(outage.status).toBe(503)
        expect(outage.message).toContain("stub outage")
        const crash = await apiError(glueOver(stub.url).call("Plant", "plant-a", "vote", [{}]))
        expect(crash.status).toBe(503)
        expect(crash.message).toBe("Adapter failure")
    })

    test("a dead adapter reaches glue as 503", async () => {
        const stub = serveStub()
        stub.server.stop(true)
        expect((await apiError(glueOver(stub.url).read("Plant", "plant-a"))).status).toBe(503)
    })
})

describe("[stub] bearer token", () => {
    test("the right token passes", async () => {
        const stub = serveStub("adapter-test-token")
        await glueOver(stub.url, "adapter-test-token").read("Plant", "plant-a")
        expect(stub.calls.length).toBe(1)
    })

    test("a missing or wrong token is 401 and never reaches the actor", async () => {
        const stub = serveStub("adapter-test-token")
        expect((await apiError(glueOver(stub.url).read("Plant", "plant-a"))).status).toBe(401)
        expect((await apiError(glueOver(stub.url, "wrong").read("Plant", "plant-a"))).status).toBe(401)
        expect((await apiError(glueOver(stub.url, "wrong").call("Plant", "plant-a", "vote", [{}]))).status).toBe(401)
        expect(stub.calls).toEqual([])
    })

    test("no configured token means no check", async () => {
        const stub = serveStub()
        await glueOver(stub.url, "ignored").read("Plant", "plant-a")
        expect(stub.calls.length).toBe(1)
    })
})

describe("[stub] malformed requests", () => {
    const cases: [string, string, number][] = [
        ["invalid JSON", "{nope", 400],
        ["JSON null", "null", 400],
        ["unknown operation", JSON.stringify({ operation: "write", kind: "Plant", id: "plant-a" }), 400],
        ["unknown kind", JSON.stringify({ operation: "read", kind: "Bank", id: "x" }), 400],
        ["inherited kind name", JSON.stringify({ operation: "read", kind: "__proto__", id: "x" }), 400],
        ["non-string id", JSON.stringify({ operation: "read", kind: "Plant", id: 7 }), 400],
        ["empty id", JSON.stringify({ operation: "read", kind: "Plant", id: "" }), 400],
        ["path traversal id", JSON.stringify({ operation: "read", kind: "Plant", id: ".." }), 400],
        ["id outside the Terse alphabet", JSON.stringify({ operation: "read", kind: "Plant", id: "plant a" }), 400],
        ["args not an array", JSON.stringify({ operation: "call", kind: "Plant", id: "plant-a", method: "vote", args: {} }), 400],
        ["args missing", JSON.stringify({ operation: "call", kind: "Plant", id: "plant-a", method: "vote" }), 400],
        ["method missing", JSON.stringify({ operation: "call", kind: "Plant", id: "plant-a", args: [] }), 403]
    ]
    for (const [name, body, status] of cases) {
        test(`${name} is ${status}`, async () => {
            const stub = serveStub()
            const response = await post(stub.url, body)
            expect(response.status).toBe(status)
            expect(typeof ((await response.json()) as { error: unknown }).error).toBe("string")
            expect(stub.calls).toEqual([])
        })
    }

    test("wrong path is 404 and wrong verb is 405", async () => {
        const stub = serveStub()
        expect((await fetch(`${stub.url}/other`, { method: "POST" })).status).toBe(404)
        expect((await fetch(`${stub.url}/rpc`)).status).toBe(405)
    })
})

describe("[fake terse] terseInvoke and glue's ACTOR_CLIENT_MODULE path", () => {
    const requests: { path: string; body: any }[] = []
    const fake = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            const body: any = await request.json()
            const path = new URL(request.url).pathname
            requests.push({ path, body })
            switch (body.method) {
                case "getState":
                    return Response.json({ outcome: { type: "completed", result: { fake: "fake terse", path } } })
                case "propose":
                    return Response.json({ outcome: { type: "failed", code: "actor_error", message: "out_of_limits: speedPct 99 is outside 20..95" } })
                case "veto":
                    return Response.json({ outcome: { type: "failed", code: "actor_error", message: "actor_call_timeout: Plant.redeemToken" } })
                case "vote":
                    return Response.json({ outcome: { type: "failed", code: "actor_error", message: "Cannot read properties of undefined" } })
                case "mirror":
                    return Response.json({ outcome: { type: "not_executed", reason: "actor restarting" } })
                case "authorizeExecution":
                    return Response.json({ error: { code: "fake_unknown_method", message: "fake terse has no authorizeExecution" } }, { status: 404 })
                default:
                    return new Response("<html>not json</html>", { status: 502 })
            }
        }
    })
    servers.push(fake)
    process.env.TERSE_URL = `http://127.0.0.1:${fake.port}/`

    const moduleGlue = () => new ActorAdapter("", "", fileURLToPath(new URL("../port.ts", import.meta.url)))

    test("glue loads port.ts and reads a Component over the Terse route with the dot id", async () => {
        const state = await moduleGlue().read("Component", "plant-a/LV-101")
        expect(state.path).toBe("/v1/projects/local/actors/Component/plant-a.LV-101/invoke")
        const sent = requests.at(-1)!.body
        expect(sent.method).toBe("getState")
        expect(sent.args).toEqual([])
        expect(typeof sent.requestId).toBe("string")
    })

    test("an actor refusal reaches module-mode glue as a 409 ApiError", async () => {
        const error = await apiError(moduleGlue().call("Plant", "plant-a", "propose", [{}]))
        expect(error.status).toBe(409)
        expect(error.message).toContain("out_of_limits")
    })

    test("the allowlist also holds in module mode", async () => {
        const before = requests.length
        expect((await apiError(moduleGlue().call("Plant", "plant-a", "execute", ["p"]))).status).toBe(403)
        expect(requests.length).toBe(before)
    })

    test("an actor timeout and an actor crash are 503, not refusals", async () => {
        for (const method of ["veto", "vote"]) {
            const error = await apiError(terseInvoke("Plant", "plant-a", method, []))
            expect(error.status).toBe(503)
            expect(error.message).toContain(`Plant(plant-a).${method} failed:`)
        }
    })

    test("not_executed, a Terse error document and a non-JSON reply are 503", async () => {
        const notExecuted = await apiError(terseInvoke("Component", "plant-a.P-100", "mirror", [{}]))
        expect(notExecuted.status).toBe(503)
        expect(notExecuted.message).toContain("actor restarting")
        const unknownMethod = await apiError(terseInvoke("Plant", "plant-a", "authorizeExecution", ["p"]))
        expect(unknownMethod.status).toBe(503)
        expect(unknownMethod.message).toContain("fake terse has no authorizeExecution")
        const notJson = await apiError(terseInvoke("Plant", "plant-a", "similar", []))
        expect(notJson.status).toBe(503)
        expect(notJson.message).toContain("502")
    })

    test("an unreachable Terse is 503", async () => {
        const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
        const url = `http://127.0.0.1:${closed.port}`
        closed.stop(true)
        const saved = process.env.TERSE_URL
        process.env.TERSE_URL = url
        try {
            const error = await apiError(terseInvoke("Plant", "plant-a", "getState", []))
            expect(error.status).toBe(503)
            expect(error.message).toContain("Terse did not answer")
        } finally {
            process.env.TERSE_URL = saved
        }
    })

    test("rpc.ts run as a process serves glue, reads ADAPTER_PORT and enforces ACTOR_API_TOKEN", async () => {
        const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
        const port = free.port
        free.stop(true)
        const child = Bun.spawn([process.execPath, "run", fileURLToPath(new URL("../rpc.ts", import.meta.url))], {
            env: { ...process.env, ADAPTER_PORT: String(port), ACTOR_API_TOKEN: "adapter-test-token" },
            stdout: "pipe",
            stderr: "inherit"
        })
        try {
            const glue = glueOver(`http://127.0.0.1:${port}`, "adapter-test-token")
            let state: any
            for (let attempt = 0; attempt < 50 && state === undefined; attempt++) {
                state = await glue.read("Plant", "plant-b").catch(error => {
                    if (error.status !== 503) throw error
                    return Bun.sleep(100)
                })
            }
            expect(state.path).toBe("/v1/projects/local/actors/Plant/plant-b/invoke")
            expect((await apiError(glueOver(`http://127.0.0.1:${port}`).read("Plant", "plant-b"))).status).toBe(401)
        } finally {
            child.kill()
            await child.exited
        }
    }, 15_000)
})

describe("source contract, read from the files", () => {
    const repoFile = (path: string) => Bun.file(new URL(`../../../${path}`, import.meta.url)).text()

    test("port.ts exports what glue's module loader looks for", () => {
        expect(typeof createActorPort).toBe("function")
        expect(typeof defaultPort.read).toBe("function")
        expect(typeof defaultPort.call).toBe("function")
    })

    test("the allowlist is exactly what glue/live.ts calls, and glue/server.ts calls nothing itself", async () => {
        const live = await repoFile("glue/live.ts")
        const called = [...live.matchAll(/actors\.call\("(Component|Plant|Company)",.*?,"(\w+)",\[/g)].map(match => `${match[1]}.${match[2]}`)
        expect(called.length).toBeGreaterThan(0)
        const allowed = Object.entries(ALLOWED_METHODS).flatMap(([kind, methods]) => methods.map(method => `${kind}.${method}`))
        expect([...new Set(called)].sort()).toEqual([...allowed].sort())
        expect(await repoFile("glue/server.ts")).not.toMatch(/actors\.(call|read)\(/)
    })

    test("every allowlisted method exists on its actor class, apart from the listed gaps", async () => {
        const source = await repoFile("actor/src/actor.ts")
        const classBody = (kind: ActorKind) => source.split(new RegExp(`^export class ${kind} extends Actor`, "m"))[1]!.split(/^export class /m)[0]!
        const missing: string[] = []
        for (const kind of Object.keys(ALLOWED_METHODS) as ActorKind[]) {
            for (const method of [...ALLOWED_METHODS[kind], "getState"]) {
                if (!new RegExp(`^\\s+async ${method}\\(`, "m").test(classBody(kind))) missing.push(`${kind}.${method}`)
            }
        }
        const knownGaps = ["Plant.authorizeExecution"]
        expect(missing.filter(item => !knownGaps.includes(item))).toEqual([])
    })
})

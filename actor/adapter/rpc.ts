// POST /rpc for glue's ACTOR_API_URL. Bound to loopback. No business logic: port.ts forwards and the actors decide.
import { createHash, timingSafeEqual } from "node:crypto"
import { ApiError } from "../../glue/actors"
import { createActorPort, type ActorPort } from "./port"

const reply = (status: number, body: unknown) => Response.json(body, { status })

function authorized(request: Request, token: string | undefined): boolean {
    if (!token) return true
    const digest = (value: string) => createHash("sha256").update(value).digest()
    return timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${token}`))
}

export function createRpcHandler(port: ActorPort = createActorPort(), token: string | undefined = process.env.ACTOR_API_TOKEN) {
    return async (request: Request): Promise<Response> => {
        if (new URL(request.url).pathname !== "/rpc") return reply(404, { error: "Unknown route" })
        if (request.method !== "POST") return reply(405, { error: "Use POST" })
        if (!authorized(request, token)) return reply(401, { error: "Missing or wrong bearer token" })
        let body: any
        try {
            body = await request.json()
        } catch {
            return reply(400, { error: "Body must be JSON" })
        }
        try {
            if (body?.operation === "read") return reply(200, { result: await port.read(body.kind, body.id) })
            if (body?.operation === "call") return reply(200, { result: await port.call(body.kind, body.id, body.method, body.args) })
            return reply(400, { error: 'operation must be "read" or "call"' })
        } catch (error) {
            if (error instanceof ApiError) return reply(error.status, { error: error.message })
            console.error("Adapter failure:", error)
            return reply(500, { error: "Adapter failure" })
        }
    }
}

export function startRpcServer(handler = createRpcHandler(), port = Number(process.env.ADAPTER_PORT ?? 7150)) {
    return Bun.serve({ hostname: "127.0.0.1", port, fetch: handler })
}

if (import.meta.main) {
    const server = startRpcServer()
    console.log(`Actor adapter listening on http://127.0.0.1:${server.port}/rpc`)
}

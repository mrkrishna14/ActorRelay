// Glue's ActorPort backed by the real actors. Glue loads this file through ACTOR_CLIENT_MODULE, and rpc.ts serves it
// over HTTP for ACTOR_API_URL. Transport only: every decision stays in the actors.
// ApiError is glue's own class, because glue turns anything else from this module into a bare 500.
import { ApiError, type ActorKind, type ActorPort } from "../../glue/actors"
import { componentActorId } from "../src/ids"

export type { ActorKind, ActorPort }

// The only seam to Terse. actorId is already the Terse id. Tests pass a labelled stand-in to createActorPort.
export type ActorInvoke = (kind: ActorKind, actorId: string, method: string, args: unknown[]) => Promise<unknown>

// What glue/live.ts calls; glue/server.ts calls nothing itself. tests/rpc.test.ts compares this table with that source.
export const ALLOWED_METHODS: Record<ActorKind, readonly string[]> = {
    Component: ["mirror", "setMetric", "addCalibration", "loadSeed"],
    Plant: ["similar", "propose", "vote", "veto", "recordEvent", "promoteRule", "loadSeed", "authorizeExecution"],
    Company: ["loadSeed"]
}

// Below glue's 8 second RPC timeout, so a stuck actor reaches glue as an answer rather than a dropped request.
const TERSE_TIMEOUT_MS = 7_000
// Terse's id rule, minus the all-dot ids that would walk out of the URL path.
const TERSE_ACTOR_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/
// Actors refuse with "code: detail" (actor/src/logic/validate.ts). actor_call_timeout means no answer, not a refusal.
const REFUSAL = /\b(?!actor_call_timeout)[a-z]+(?:_[a-z]+)+: /

function terseUrl(): string {
    return (process.env.TERSE_URL ?? process.env.DURABLE_ACTORS_CONTROL_PLANE_URL ?? "http://127.0.0.1:7100").replace(/\/+$/, "")
}

// Same HTTP route the generated Terse client uses. A refusal becomes 409, which glue passes on; anything else is 503.
export const terseInvoke: ActorInvoke = async (kind, actorId, method, args) => {
    const target = `${kind}(${actorId}).${method}`
    let status: number
    let text: string
    try {
        const response = await fetch(`${terseUrl()}/v1/projects/local/actors/${kind}/${encodeURIComponent(actorId)}/invoke`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ requestId: crypto.randomUUID(), method, args }),
            signal: AbortSignal.timeout(TERSE_TIMEOUT_MS)
        })
        status = response.status
        text = await response.text()
    } catch (error) {
        throw new ApiError(503, `Terse did not answer ${target}: ${String(error)}`)
    }
    let reply: any = null
    try {
        reply = JSON.parse(text)
    } catch {
        // Handled below: an unparsable body is not an outcome.
    }
    const outcome = reply?.outcome
    if (outcome?.type === "completed") return outcome.result
    if (outcome?.type === "failed") {
        const message = String(outcome.message ?? outcome.code)
        throw REFUSAL.test(message) ? new ApiError(409, message) : new ApiError(503, `${target} failed: ${message}`)
    }
    throw new ApiError(503, `Terse did not run ${target}: ${outcome?.reason ?? reply?.error?.message ?? `${status} ${text.slice(0, 200)}`}`)
}

function actorIdFor(kind: ActorKind, id: string): string {
    if (!Object.hasOwn(ALLOWED_METHODS, kind)) throw new ApiError(400, `Unknown actor kind: ${String(kind)}`)
    if (typeof id !== "string") throw new ApiError(400, "Actor id must be a string")
    const actorId = kind === "Component" ? componentActorId(id) : id
    if (!TERSE_ACTOR_ID.test(actorId)) throw new ApiError(400, `Invalid actor id: ${id}`)
    return actorId
}

export function createActorPort(invoke: ActorInvoke = terseInvoke): ActorPort {
    return {
        async read(kind, id) {
            return invoke(kind, actorIdFor(kind, id), "getState", [])
        },
        async call(kind, id, method, args) {
            const actorId = actorIdFor(kind, id)
            if (!ALLOWED_METHODS[kind].includes(method)) throw new ApiError(403, `${kind}.${String(method)} is not allowed`)
            if (!Array.isArray(args)) throw new ApiError(400, "args must be an array")
            return invoke(kind, actorId, method, args)
        }
    }
}

export default createActorPort()

// Actor-to-actor calls (Plant → Component, Plant → Company).
// The SDK's `Other.get(id).method()` reads DURABLE_ACTORS_PROJECT_ID / DURABLE_ACTORS_SECRET from the
// host environment. Terse Cloud (0.14.x) injects neither (and reserves the names), so inner calls fail
// there. This helper calls the actor HTTP API directly:
//   local  → DURABLE_ACTORS_CONTROL_PLANE_URL (or :7100), project "local", no auth (as the SDK does)
//   cloud  → exchanges the ACTORRELAY_TERSE_API_KEY project secret for a short-lived actor session at
//            https://api.useterse.ai/<project>/actors/access (what the generated client does), cached
//            until a minute before it expires.
import config from "../terse.config.json" with { type: "json" }

type Env = Record<string, string | undefined>
type Session = { token: string; expiresAtMs: number; controlPlaneUrl: string; projectId: string }
type Target = { base: string; projectId: string; token: string | undefined }

const env = (): Env => (globalThis as { process?: { env: Env } }).process?.env ?? {}
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"]
let session: Session | null = null

async function target(): Promise<Target> {
    const e = env()
    const controlPlane = e.DURABLE_ACTORS_CONTROL_PLANE_URL ?? "http://127.0.0.1:7100"
    if (LOCAL_HOSTS.includes(new URL(controlPlane).hostname)) {
        return { base: controlPlane, projectId: e.DURABLE_ACTORS_PROJECT_ID ?? "local", token: e.DURABLE_ACTORS_SECRET }
    }
    const key = e.ACTORRELAY_TERSE_API_KEY
    if (!key) throw new Error("actor-to-actor calls in Terse Cloud need the ACTORRELAY_TERSE_API_KEY project secret (terse secrets add ACTORRELAY_TERSE_API_KEY --value-stdin)")
    if (!session || session.expiresAtMs - Date.now() < 60_000) {
        const api = (e.ACTORRELAY_TERSE_API_URL ?? "https://api.useterse.ai").replace(/\/$/, "")
        const res = await fetch(`${api}/${encodeURIComponent(config.projectId)}/actors/access`, {
            method: "POST", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) throw new Error(`actor session request failed (HTTP ${res.status})`)
        const s = (await res.json()) as Session
        if (!s?.token || !s.controlPlaneUrl || !s.projectId) throw new Error("actor session response was incomplete")
        session = s
    }
    return { base: session.controlPlaneUrl, projectId: session.projectId, token: session.token }
}

type Outcome = { type: "completed"; result: unknown } | { type: "failed"; code: string; message: string } | { type: "not_executed"; reason: string }

export async function callActor<T>(actorName: string, actorId: string, method: string, args: unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        const t = await target()
        const requestId = crypto.randomUUID()
        const res = await fetch(`${t.base.replace(/\/$/, "")}/v1/projects/${encodeURIComponent(t.projectId)}/actors/${encodeURIComponent(actorName)}/${encodeURIComponent(actorId)}/invoke`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json", "x-request-id": requestId, ...(t.token ? { authorization: `Bearer ${t.token}` } : {}) },
            body: JSON.stringify({ requestId, method, args }),
            signal: AbortSignal.timeout(30_000),
        })
        if (res.status === 401 && session && attempt === 0) {
            session = null // token expired or revoked: refresh once
            continue
        }
        const doc = (await res.json().catch(() => null)) as { outcome?: Outcome } | Outcome | null
        const outcome = (doc && "outcome" in doc ? doc.outcome : doc) as Outcome | null
        if (outcome?.type === "completed") return outcome.result as T
        if (outcome?.type === "not_executed" && attempt === 0) continue
        const why = outcome?.type === "failed" ? outcome.message : outcome?.type === "not_executed" ? `not executed (${outcome.reason})` : `HTTP ${res.status}`
        throw new Error(`${actorName}(${actorId}).${method}: ${why}`)
    }
}

type AsyncMethods<T> = { [K in keyof T as T[K] extends (...args: never[]) => Promise<unknown> ? K : never]: T[K] }

/** Typed reference to another actor: `ref<Component>("Component", "plant-a.LV-101").read()`. */
export function ref<T>(actorName: string, actorId: string): AsyncMethods<T> {
    return new Proxy({}, {
        get: (_target, method) => (method === "then" || typeof method !== "string" ? undefined : (...args: unknown[]) => callActor(actorName, actorId, method, args)),
    }) as AsyncMethods<T>
}

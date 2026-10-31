// Actor port for glue live mode: ACTOR_CLIENT_MODULE=/abs/path/actor/client/port.ts
// Exports createActorPort() (and default) → { read(kind, id), call(kind, id, method, args) }.
// Calls the actor HTTP invoke API directly (no generated client, so new methods never go stale).
//   TERSE_ACTOR_URL unset            → local runtime http://127.0.0.1:7100/v1/projects/local/actors, no auth
//   http(s)://host/v1/projects/<id>/actors → runtime form, invoked directly
//   https://api.useterse.ai/<id>/actors     → cloud form: session from POST <url>/access with TERSE_API_KEY
export type ActorKind = "Component" | "Plant" | "Company"
export interface ActorPort {
    read(kind: ActorKind, id: string): Promise<any>
    call(kind: ActorKind, id: string, method: string, args: unknown[]): Promise<any>
}

type Session = { token: string; expiresAtMs: number; controlPlaneUrl: string; projectId: string }
type Target = { invokeBase: string; token?: string }
type Outcome = { type: "completed"; result: unknown } | { type: "failed"; code?: string; message: string } | { type: "not_executed"; reason?: string }

const DEFAULT_URL = "http://127.0.0.1:7100/v1/projects/local/actors"

/** ComponentId "plant-a/LV-101" → actor id "plant-a.LV-101"; Company is always "company". */
export function actorIdOf(kind: ActorKind, id: string): string {
    if (kind === "Company") return "company"
    if (kind === "Component") return id.replace("/", ".")
    return id
}

export function createActorPort(): ActorPort {
    let session: Session | null = null

    const parse = () => {
        const raw = (process.env.TERSE_ACTOR_URL?.trim() || DEFAULT_URL).replace(/\/$/, "")
        const url = new URL(raw)
        const runtime = /^\/v1\/projects\/([^/]+)\/actors$/.exec(url.pathname)
        if (runtime) return { kind: "runtime" as const, base: raw }
        const cloud = /^\/([^/]+)\/actors$/.exec(url.pathname)
        if (cloud) return { kind: "cloud" as const, base: raw }
        throw new Error("TERSE_ACTOR_URL must end in /<projectId>/actors or /v1/projects/<projectId>/actors")
    }

    async function target(): Promise<Target> {
        const endpoint = parse()
        if (endpoint.kind === "runtime") {
            const secret = process.env.DURABLE_ACTORS_SECRET || process.env.DURABLE_ACTORS_API_KEY
            return { invokeBase: endpoint.base, token: secret || undefined }
        }
        if (!session || session.expiresAtMs - Date.now() < 60_000) {
            const key = process.env.TERSE_API_KEY?.trim()
            if (!key) throw new Error("TERSE_API_KEY is required for a cloud TERSE_ACTOR_URL")
            const res = await fetch(`${endpoint.base}/access`, {
                method: "POST", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(10_000),
            })
            if (!res.ok) throw new Error(`actor session request failed (HTTP ${res.status})`)
            const s = (await res.json()) as Session
            if (!s?.token || !s.controlPlaneUrl || !s.projectId) throw new Error("actor session response was incomplete")
            session = s
        }
        return { invokeBase: `${session.controlPlaneUrl.replace(/\/$/, "")}/v1/projects/${encodeURIComponent(session.projectId)}/actors`, token: session.token }
    }

    async function invoke(kind: ActorKind, id: string, method: string, args: unknown[]): Promise<any> {
        const actorId = actorIdOf(kind, id)
        let refreshed = false
        for (let attempt = 0; attempt < 3; attempt++) {
            const t = await target()
            const requestId = crypto.randomUUID()
            const res = await fetch(`${t.invokeBase}/${encodeURIComponent(kind)}/${encodeURIComponent(actorId)}/invoke`, {
                method: "POST",
                headers: { "content-type": "application/json", accept: "application/json", "x-request-id": requestId, ...(t.token ? { authorization: `Bearer ${t.token}` } : {}) },
                body: JSON.stringify({ requestId, method, args }),
                signal: AbortSignal.timeout(30_000),
            })
            if (res.status === 401 && session && !refreshed) {
                session = null // expired or revoked: refresh once
                refreshed = true
                continue
            }
            const doc = (await res.json().catch(() => null)) as { outcome?: Outcome } | Outcome | null
            const outcome = (doc && typeof doc === "object" && "outcome" in doc ? doc.outcome : doc) as Outcome | null
            if (outcome?.type === "completed") return outcome.result
            if (outcome?.type === "failed") throw new Error(outcome.message)
            if (outcome?.type === "not_executed" && attempt === 0) continue
            throw new Error(`${kind}(${actorId}).${method}: ${outcome?.type === "not_executed" ? `not executed (${outcome.reason ?? "unknown"})` : `HTTP ${res.status}`}`)
        }
        throw new Error(`${kind}(${actorId}).${method}: no outcome`)
    }

    return {
        read: (kind, id) => invoke(kind, id, "read", []),
        call: (kind, id, method, args) => invoke(kind, id, method, args ?? []),
    }
}

export default createActorPort()

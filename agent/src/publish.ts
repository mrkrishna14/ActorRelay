// Glue's RELAY_PUBLISH_URL target: glue POSTs {type, payload, channels} here (optional bearer RELAY_TOKEN).
// The agent process delivers the message to its agents at once and rebroadcasts it on Relay.
export type Published = { type: string; payload: any; channels: string[] }

export function startPublishServer(opts: {
    port: number
    token?: string
    onMessage: (msg: Published) => void
    health?: () => Record<string, unknown>
}) {
    return Bun.serve({
        port: opts.port,
        hostname: "127.0.0.1",
        async fetch(req) {
            const url = new URL(req.url)
            if (req.method === "GET" && url.pathname === "/health") return Response.json({ ok: true, ...(opts.health?.() ?? {}) })
            if (req.method !== "POST" || url.pathname !== "/publish") return Response.json({ error: "not found" }, { status: 404 })
            if (opts.token && req.headers.get("authorization") !== `Bearer ${opts.token}`) return Response.json({ error: "unauthorized" }, { status: 401 })
            let body: any
            try {
                body = await req.json()
            } catch {
                return Response.json({ error: "body must be JSON" }, { status: 400 })
            }
            if (!body || typeof body.type !== "string" || body.payload === undefined) return Response.json({ error: "expected {type, payload, channels}" }, { status: 400 })
            const msg: Published = { type: body.type, payload: body.payload, channels: Array.isArray(body.channels) ? body.channels.map(String) : [] }
            queueMicrotask(() => {
                try {
                    opts.onMessage(msg)
                } catch (error) {
                    console.error("publish handler error:", error)
                }
            })
            return Response.json({ ok: true })
        },
    })
}

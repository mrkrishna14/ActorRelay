// Agent Relay transport: one Relay participant per component agent, channels plant-a / plant-b / company.
// Messages are JSON in the message text, per the CLAUDE.MD Relay protocol.
import { AgentRelay } from "@agent-relay/sdk"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

export const CHANNELS = ["plant-a", "plant-b", "company"] as const
export type Channel = (typeof CHANNELS)[number]
export type RelayMessage =
    | { type: "proposal"; proposal: import("../../shared/types.js").Proposal }
    | { type: "vote"; vote: import("../../shared/types.js").Vote }
    | { type: "counter"; parentProposalId: string; proposal: import("../../shared/types.js").Proposal }
    | { type: "executed"; proposalId: string; event: import("../../shared/types.js").HistoryEvent }
    | { type: "rule"; rule: import("../../shared/types.js").LearnedRule }

type AgentClient = Awaited<ReturnType<AgentRelay["workspace"]["reconnect"]>>
type Handler = (msg: RelayMessage, meta: { channel: string; from: string }) => void

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Retries Relay calls that the service marks retryable (e.g. 503 database_overloaded), honouring retry-after. */
export async function withRetry<T>(what: string, fn: () => Promise<T>, log: (m: string) => void, tries = 6): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn()
        } catch (error) {
            const e = error as { retryable?: boolean; statusCode?: number; retryAfterMs?: number; message?: string }
            const retryable = e.retryable || e.statusCode === 429 || (e.statusCode ?? 0) >= 500
            if (!retryable || attempt >= tries) throw error
            const wait = Math.min(15_000, e.retryAfterMs ?? 500 * 2 ** attempt)
            log(`relay ${what}: ${e.statusCode ?? ""} ${e.message ?? error} — retry ${attempt}/${tries - 1} in ${wait} ms`)
            await sleep(wait)
        }
    }
}

export const relayName = (componentId: string) => `ar-${componentId.replace("/", "-").toLowerCase()}`

export class RelayBus {
    private clients = new Map<string, AgentClient>()
    private handlers: Handler[] = []
    private seen = new Set<string>()
    private constructor(private relay: AgentRelay, private log: (m: string) => void) {}

    /** Registers (first run) or reconnects (saved token) one participant per name, joins all channels. */
    static async connect(workspaceKey: string, names: string[], tokenFile: string, log: (m: string) => void): Promise<RelayBus> {
        const relay = new AgentRelay({ workspaceKey })
        const bus = new RelayBus(relay, log)
        type Saved = { token: string; joined: string[] }
        const raw: Record<string, string | Saved> = existsSync(tokenFile) ? JSON.parse(readFileSync(tokenFile, "utf8")) : {}
        const saved: Record<string, Saved> = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === "string" ? { token: v, joined: [] } : v]))
        const persist = () => writeFileSync(tokenFile, JSON.stringify(saved, null, 2), { mode: 0o600 })

        const connectOne = async (name: string): Promise<AgentClient> => {
            const prior = saved[name]
            if (prior?.token) {
                const client = await withRetry(`reconnect ${name}`, () => relay.workspace.reconnect({ apiToken: prior.token }), log).catch(() => null)
                if (client) return client
            }
            const client = await withRetry(`register ${name}`, async () => {
                try {
                    return (await relay.workspace.register({ name, type: "agent" })) as AgentClient
                } catch (error) {
                    if ((error as { code?: string }).code !== "name_conflict") throw error
                    // Token lost: free the name and register again.
                    await relay.workspace.release({ name, deleteAgent: true })
                    return (await relay.workspace.register({ name, type: "agent" })) as AgentClient
                }
            }, log)
            saved[name] = { token: (client as unknown as { token: string }).token, joined: [] }
            persist()
            return client
        }
        // A few at a time: parallel enough to be quick, gentle enough for an overloaded service.
        const pool = async <T>(items: T[], size: number, fn: (item: T) => Promise<void>) => {
            const queue = [...items]
            await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
                for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item)
            }))
        }
        await pool(names, 4, async name => {
            bus.clients.set(name, await connectOne(name))
        })
        const first = bus.clients.get(names[0]!)
        const needsChannels = names.some(n => CHANNELS.some(c => !saved[n]?.joined.includes(c)))
        if (first && needsChannels) {
            for (const channel of CHANNELS) await withRetry(`create #${channel}`, () => first.channels.create({ name: channel, topic: `ActorRelay ${channel}` }), log).catch(() => {})
        }
        await pool(names, 4, async name => {
            const client = bus.clients.get(name)!
            for (const channel of CHANNELS) {
                if (saved[name]?.joined.includes(channel)) continue // joined on an earlier run
                const ok = await withRetry(`${name} join #${channel}`, () => client.channels.join(channel), log).then(() => true, e => (log(`relay ${name} join #${channel} failed: ${e}`), false))
                if (ok && saved[name]) {
                    saved[name]!.joined = [...new Set([...saved[name]!.joined, channel])]
                    persist()
                }
            }
        })
        relay.addListener("message.created", (event: unknown) => bus.dispatch(event))
        return bus
    }

    onMessage(handler: Handler) {
        this.handlers.push(handler)
    }

    /** Sends as the named participant (each component speaks for itself). */
    async publish(as: string, channel: Channel, msg: RelayMessage): Promise<void> {
        const client = this.clients.get(as) ?? this.clients.values().next().value
        if (!client) throw new Error("no relay participant registered")
        await withRetry(`send #${channel}`, () => client.sendMessage({ to: `#${channel}`, text: JSON.stringify(msg) }), this.log)
    }

    private dispatch(event: unknown) {
        const { message, envelope } = (event ?? {}) as { message?: { messageId?: string; id?: string; text?: string }; envelope?: { channel?: { name?: string }; from?: { handle?: string; name?: string } } }
        const channel = envelope?.channel?.name
        const id = message?.messageId ?? message?.id
        if (!channel || !message?.text || !(CHANNELS as readonly string[]).includes(channel)) return
        if (id) {
            if (this.seen.has(id)) return
            this.seen.add(id)
            if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500))
        }
        let msg: RelayMessage
        try {
            msg = JSON.parse(message.text)
        } catch {
            return // not a protocol message
        }
        if (!msg || typeof msg !== "object" || !("type" in msg)) return
        for (const h of this.handlers) {
            try {
                h(msg, { channel, from: envelope?.from?.handle ?? envelope?.from?.name ?? "?" })
            } catch (error) {
                this.log(`relay handler error: ${error}`)
            }
        }
    }
}

// Glue's Relay identity: joins plant-a, plant-b and company, posts proposal, executed and rule messages, and hands agent
// messages to the routes. The wire is agent/wire.ts as it stands: the text of every message is JSON {type, payload}.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CHANNELS } from "./config";

export type PublishType = "proposal" | "executed" | "rule";
export type Published = { at: string; type: PublishType; channel: string; ref: string; ok: boolean; error?: string };
export type Inbound = { text: string; sender: string; channel: string };

export interface RelayPort {
  publish(type: PublishType, payload: unknown, channels: readonly string[], ref: string): Promise<boolean>;
  status(): { connected: boolean; error: string | null; published: Published[] };
}

type Client = { token?: string | null; sendMessage(input: { to: string; text: string; idempotencyKey?: string }): Promise<unknown>; channels: { create(input: { name: string; topic: string }): Promise<unknown>; join(name: string): Promise<unknown> } };

export type RelayOptions = {
  url: string;
  systemName: string;
  keyFile: string;
  tokenFile: string;
  onInbound: (message: Inbound) => Promise<void>;
  log?: (line: string) => void;
};

const CONNECT_RETRY_MS = 2000;
const READY_WAIT_MS = 5000;
const PUBLISH_LOG = 100;

export class RelayParticipant implements RelayPort {
  private client: Client | null = null;
  private error: string | null = "not connected yet";
  private stopped = false;
  private readonly published: Published[] = [];
  private readonly say: (line: string) => void;

  constructor(private readonly options: RelayOptions) {
    this.say = options.log ?? console.log;
  }

  /** Keeps trying in the background: glue serves its other routes while Relay is still starting. */
  start() {
    void this.connectLoop();
  }

  stop() {
    this.stopped = true;
  }

  status() {
    return { connected: this.client !== null, error: this.error, published: this.published };
  }

  private async connectLoop() {
    while (!this.stopped && !this.client) {
      try {
        this.client = await this.connect();
        this.error = null;
        this.say(`relay: connected as ${this.options.systemName} on ${CHANNELS.join(", ")}`);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (text !== this.error) this.say(`relay: ${text}; retrying`);
        this.error = text;
        await Bun.sleep(CONNECT_RETRY_MS);
      }
    }
  }

  private async workspaceKey(AgentRelay: { createWorkspace(input: { name: string; baseUrl: string }): Promise<{ workspaceKey?: string | null }> }): Promise<string> {
    if (process.env.RELAY_WORKSPACE_KEY) return process.env.RELAY_WORKSPACE_KEY;
    const { keyFile, url } = this.options;
    if (existsSync(keyFile)) return readFileSync(keyFile, "utf8").trim();
    const created = await AgentRelay.createWorkspace({ name: `actorrelay-${Date.now().toString(36)}`, baseUrl: url });
    if (!created.workspaceKey) throw new Error("relay returned no workspace key");
    mkdirSync(dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, created.workspaceKey, { mode: 0o600 });
    return created.workspaceKey;
  }

  private savedToken(workspaceKey: string): string | null {
    const { tokenFile } = this.options;
    if (!existsSync(tokenFile)) return null;
    const stored = JSON.parse(readFileSync(tokenFile, "utf8")) as { workspaceKey?: string; token?: string };
    return stored.workspaceKey === workspaceKey && stored.token ? stored.token : null;
  }

  private async connect(): Promise<Client> {
    const { AgentRelay } = await import("@agent-relay/sdk");
    const { url, systemName, tokenFile } = this.options;
    const workspaceKey = await this.workspaceKey(AgentRelay as never);
    // Fast reconnects: a single-identity stream otherwise lagged 14 s behind a restarted server.
    const relay = new AgentRelay({ workspaceKey, baseUrl: url, agentClientOptions: { ws: { reconnectBaseDelayMs: 250, reconnectMaxDelayMs: 1500 } } } as never);
    const token = this.savedToken(workspaceKey);
    const client = (token ? await relay.workspace.reconnect({ apiToken: token }) : await relay.workspace.register({ name: systemName, type: "agent" })) as unknown as Client;
    if (!token) {
      if (!client.token) throw new Error("relay returned no token");
      mkdirSync(dirname(tokenFile), { recursive: true });
      writeFileSync(tokenFile, JSON.stringify({ workspaceKey, token: client.token }), { mode: 0o600 });
    }
    for (const channel of CHANNELS) {
      await client.channels.create({ name: channel, topic: `ActorRelay ${channel}` }).catch(() => undefined);
      await client.channels.join(channel);
    }
    for (const event of ["message.created", "thread.reply"] as const) relay.addListener(event, (received) => this.received(received as never));
    return client;
  }

  /** One bad message must never stop the next one, so failures end here. */
  private received({ message, envelope }: { message?: { text?: string }; envelope?: { channel?: { name?: string } | null; from?: { name?: string } | null } }) {
    const channel = envelope?.channel?.name;
    const sender = envelope?.from?.name;
    const text = message?.text;
    if (!channel || !sender || !text || sender === this.options.systemName) return;
    if (!(CHANNELS as readonly string[]).includes(channel)) return;
    this.options.onInbound({ text, sender, channel }).catch((error) => this.say(`relay inbound from ${sender} failed: ${error instanceof Error ? error.message : error}`));
  }

  private async ready(): Promise<Client | null> {
    const deadline = Date.now() + READY_WAIT_MS;
    while (!this.client && Date.now() < deadline) await Bun.sleep(100);
    return this.client;
  }

  /** The stable key lets the SDK retry through a Relay restart without posting twice. Returns whether every channel took it. */
  async publish(type: PublishType, payload: unknown, channels: readonly string[], ref: string): Promise<boolean> {
    const client = await this.ready();
    const text = JSON.stringify({ type, payload });
    const results = await Promise.all(
      channels.map(async (channel) => {
        const entry: Published = { at: new Date().toISOString(), type, channel, ref, ok: false };
        try {
          if (!client) throw new Error(this.error ?? "relay is not connected");
          await client.sendMessage({ to: `#${channel}`, text, idempotencyKey: `${type}:${ref}:${channel}` });
          entry.ok = true;
        } catch (error) {
          entry.error = error instanceof Error ? error.message : String(error);
          this.say(`relay publish ${type} ${ref} to ${channel} failed: ${entry.error}`);
        }
        this.published.push(entry);
        if (this.published.length > PUBLISH_LOG) this.published.shift();
        return entry.ok;
      }),
    );
    return results.every(Boolean);
  }
}

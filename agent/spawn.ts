// Starts the ten component agents and the system participant on Relay. Every agent is a Relay identity whose model
// calls are owned by this process, so messages arrive immediately instead of waiting for a harness turn to end.
import { AgentRelay } from "@agent-relay/sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentState, PlantId } from "../shared/types";
import { HttpGlue } from "./glue";
import { RoutedLlm } from "./llm";
import { AgentRuntime, type Post } from "./runtime";
import { wireMessageSchema, type WireMessage } from "./schemas";
import { CHANNELS, handlePublish, InboundBridge, relayName, SYSTEM_NAME } from "./system";

const RELAY_URL = process.env.RELAY_URL ?? process.env.RELAY_BASE_URL ?? "http://127.0.0.1:8787";
const TOKENS_FILE = process.env.RELAY_TOKENS_FILE ?? join(import.meta.dir, ".relay-tokens.json");
const SYSTEM_PORT = Number(process.env.SYSTEM_PORT ?? 7201);
const WORKSPACE_NAME = process.env.RELAY_WORKSPACE_NAME ?? "actorrelay";

type Tokens = { relayUrl: string; workspaceKey: string; agents: Record<string, string> };
type Client = Awaited<ReturnType<AgentRelay["workspace"]["reconnect"]>>;

function loadTokens(): Tokens | null {
  if (!existsSync(TOKENS_FILE)) return null;
  const tokens = JSON.parse(readFileSync(TOKENS_FILE, "utf8")) as Tokens;
  return tokens.relayUrl === RELAY_URL ? tokens : null;
}

const saveTokens = (tokens: Tokens) => writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });

async function openWorkspace(): Promise<{ relay: AgentRelay; tokens: Tokens }> {
  const envKey = process.env.RELAY_WORKSPACE_KEY;
  const stored = loadTokens();
  const key = envKey ?? stored?.workspaceKey;
  if (key) return { relay: new AgentRelay({ workspaceKey: key, baseUrl: RELAY_URL }), tokens: stored?.workspaceKey === key ? stored : { relayUrl: RELAY_URL, workspaceKey: key, agents: {} } };
  const relay = await AgentRelay.createWorkspace({ name: `${WORKSPACE_NAME}-${Date.now().toString(36)}`, baseUrl: RELAY_URL });
  const tokens = { relayUrl: RELAY_URL, workspaceKey: relay.workspaceKey as string, agents: {} };
  saveTokens(tokens);
  return { relay, tokens };
}

/** Registration is create-only, so a known identity comes back through its stored token. */
async function identity(relay: AgentRelay, tokens: Tokens, name: string, type: "agent" | "system"): Promise<Client> {
  const stored = tokens.agents[name];
  if (stored) {
    try {
      return await relay.workspace.reconnect({ apiToken: stored });
    } catch (error) {
      console.warn(`${name}: stored token rejected, registering again: ${error}`);
    }
  }
  const client = await relay.workspace.register({ name, type });
  if (!client.token) throw new Error(`${name}: relay returned no token`);
  tokens.agents[name] = client.token;
  saveTokens(tokens);
  return client;
}

async function ensureChannels(system: Client) {
  for (const name of CHANNELS) {
    await system.channels.create({ name, topic: `ActorRelay ${name}` }).catch(() => undefined);
  }
}

function parseBody(text: string): WireMessage | null {
  try {
    const parsed = wireMessageSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function main() {
  const seed = JSON.parse(readFileSync(join(import.meta.dir, "..", "shared", "plants.json"), "utf8")) as { plants: { id: PlantId; components: ComponentState[] }[] };
  const components = seed.plants.flatMap((plant) => plant.components);
  const glue = new HttpGlue();
  const llm = new RoutedLlm();
  const claudeUp = await llm.probeClaude();
  console.log(claudeUp ? "claude cli: logged in" : "claude cli: unavailable, Claude roles vote through labelled GPT fallback");

  const { relay, tokens } = await openWorkspace();
  const system = await identity(relay, tokens, SYSTEM_NAME, "system");
  await ensureChannels(system);
  const clients = new Map<string, Client>();
  for (const component of components) clients.set(component.id, await identity(relay, tokens, relayName(component.id), "agent"));
  for (const client of [system, ...clients.values()]) {
    for (const channel of CHANNELS) await client.channels.join(channel);
  }

  const bridge = new InboundBridge(glue);
  const post: Post = async (message, channel, from) => {
    const client = clients.get(from);
    if (!client) throw new Error(`no relay identity for ${from}`);
    try {
      await client.sendMessage({ to: `#${channel}`, text: JSON.stringify(message) });
    } catch (error) {
      console.warn(`relay post failed for ${from}, handing to glue directly: ${error}`);
      await bridge.onAgentMessage(message, relayName(from));
    }
  };
  const runtime = new AgentRuntime({ glue, llm, post, owned: components.map((c) => c.id) });
  await runtime.warm(seed.plants.map((p) => p.id)).catch((error) => console.warn(`cache warm skipped: ${error}`));

  relay.addListener("message.created", ({ message, envelope }) => {
    const channel = envelope.channel?.name;
    if (!channel || !(CHANNELS as readonly string[]).includes(channel)) return;
    const body = parseBody(message.text);
    if (!body) return;
    const sender = envelope.from?.name;
    if (body.type === "vote" || body.type === "counter") void bridge.onAgentMessage(body, sender);
    else if (sender === SYSTEM_NAME) runtime.onMessage(body);
  });

  const publish = async (message: WireMessage, channels: string[]) => {
    await Promise.all(channels.map((channel) => system.sendMessage({ to: `#${channel}`, text: JSON.stringify(message) })));
  };
  Bun.serve({
    port: SYSTEM_PORT,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/health") return Response.json({ ok: true, agents: clients.size, claudeCli: claudeUp });
      if (path === "/publish" && request.method === "POST") return handlePublish(request, publish);
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  console.log(`ready: ${clients.size} agents on ${CHANNELS.join(", ")}; RELAY_PUBLISH_URL=http://127.0.0.1:${SYSTEM_PORT}/publish`);
}

await main();

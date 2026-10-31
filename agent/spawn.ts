// Starts the ten component agents on Relay. Every agent is a Relay identity whose model calls are owned by this
// process, so messages arrive immediately instead of waiting for a harness turn to end. Glue is the system participant.
import { AgentRelay } from "@agent-relay/sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentState, PlantId } from "../shared/types";
import { GlueError, HttpGlue } from "./glue";
import { RoutedLlm } from "./llm";
import { AgentRuntime, type Post } from "./runtime";
import type { WireMessage } from "./schemas";
import { agentName, CHANNELS, decodeEnvelope, encodeEnvelope, postKey, SYSTEM_NAME } from "./wire";
import { RELAY_URL, workspaceKey } from "./workspace";

const TOKENS_FILE = process.env.RELAY_TOKENS_FILE ?? join(import.meta.dir, ".relay-tokens.json");
const HEALTH_PORT = Number(process.env.AGENT_HEALTH_PORT ?? 7201);
const STARTUP_TRIES = 3;
const STARTUP_RETRY_MS = 300;
/** The default backoff left a stream dead 14 s after the server came back. */
const RECONNECT = { reconnectBaseDelayMs: 250, reconnectMaxDelayMs: 1500 };

type Tokens = { workspaceKey: string; agents: Record<string, string> };
type Client = Awaited<ReturnType<AgentRelay["workspace"]["reconnect"]>>;

function loadTokens(key: string): Tokens {
  const stored = existsSync(TOKENS_FILE) ? (JSON.parse(readFileSync(TOKENS_FILE, "utf8")) as Tokens) : null;
  return stored?.workspaceKey === key ? stored : { workspaceKey: key, agents: {} };
}

const saveTokens = (tokens: Tokens) => writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });

/** The SDK does not retry writes, and one connection reset at startup must not cost all ten agents. */
async function withRetry<T>(label: string, work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= STARTUP_TRIES) throw error;
      console.warn(`${label}: ${error}; retrying`);
      await Bun.sleep(STARTUP_RETRY_MS * attempt);
    }
  }
}

/** Registration is create-only. If the token was lost, say with a dropped response, only a release frees the name. */
async function register(relay: AgentRelay, name: string): Promise<Client> {
  try {
    return await relay.workspace.register({ name, type: "agent" });
  } catch (error) {
    if ((error as { code?: string }).code !== "name_conflict") throw error;
    await relay.workspace.release({ name, deleteAgent: true });
    return relay.workspace.register({ name, type: "agent" });
  }
}

/** A known identity comes back through its stored token. */
async function identity(relay: AgentRelay, tokens: Tokens, name: string): Promise<Client> {
  const stored = tokens.agents[name];
  if (stored) {
    try {
      return await withRetry(`reconnect ${name}`, () => relay.workspace.reconnect({ apiToken: stored }));
    } catch (error) {
      console.warn(`${name}: stored token rejected, registering again: ${error}`);
    }
  }
  const client = await withRetry(`register ${name}`, () => register(relay, name));
  if (!client.token) throw new Error(`${name}: relay returned no token`);
  tokens.agents[name] = client.token;
  saveTokens(tokens);
  return client;
}

/**
 * Post cost grows with channel members, so each agent joins only what it posts to. All identities share one listener,
 * so any member of a channel delivers it to every agent in this process.
 */
const channelsFor = (component: ComponentState) => [component.plantId, ...(component.sharedResources.length ? ["company"] : [])];

/** Glue also creates these, and whichever of us starts first wins. */
async function joinChannels(client: Client, channels: string[]) {
  for (const channel of channels) {
    await client.channels.create({ name: channel, topic: `ActorRelay ${channel}` }).catch(() => undefined);
    await withRetry(`join ${channel}`, () => client.channels.join(channel));
  }
}

/** A Relay identity serves one connection, so a second process would leave the older one answering every message. */
async function refuseSecondProcess() {
  const running = await fetch(`http://127.0.0.1:${HEALTH_PORT}/health`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
  if (running) throw new Error(`agents already run on ${HEALTH_PORT}: stop them first`);
}

async function main() {
  await refuseSecondProcess();
  const seed = JSON.parse(readFileSync(join(import.meta.dir, "..", "shared", "plants.json"), "utf8")) as { plants: { id: PlantId; components: ComponentState[] }[] };
  const components = seed.plants.flatMap((plant) => plant.components);
  const glue = new HttpGlue();
  const llm = new RoutedLlm();
  const claudeUp = await llm.probeClaude();
  console.log(claudeUp ? "claude cli: logged in" : "claude cli: unavailable, Claude roles vote through labelled GPT fallback");

  const key = await workspaceKey();
  const relay = new AgentRelay({ workspaceKey: key, baseUrl: RELAY_URL, agentClientOptions: { ws: RECONNECT } });
  const tokens = loadTokens(key);
  const clients = new Map<string, Client>();
  for (const component of components) clients.set(component.id, await identity(relay, tokens, agentName(component.id)));
  for (const component of components) await joinChannels(clients.get(component.id) as Client, channelsFor(component));

  /** If Relay fails, the same message still reaches glue. Plant rejects a duplicate vote; a counter has to be checked first. */
  const direct = async (message: WireMessage) => {
    if (message.type === "vote") return glue.vote(message.vote);
    if (message.type !== "counter") return;
    const plant = await glue.plant(message.proposal.plantId);
    if (!plant.proposals.some((p) => p.parentProposalId === message.parentProposalId)) await glue.counter(message.parentProposalId, message.proposal);
  };
  const post: Post = async (message, channel, from) => {
    const client = clients.get(from);
    if (!client) throw new Error(`no relay identity for ${from}`);
    try {
      await client.sendMessage({ to: `#${channel}`, text: encodeEnvelope(message), idempotencyKey: postKey(message) });
    } catch (error) {
      console.warn(`relay post failed for ${from}, handing to glue directly: ${error}`);
      await direct(message).catch((failed) => {
        if (!(failed instanceof GlueError) || failed.status >= 500) throw failed;
      });
    }
  };
  const runtime = new AgentRuntime({ glue, llm, post, owned: components.map((c) => c.id) });
  await runtime.warm(seed.plants.map((p) => p.id)).catch((error) => console.warn(`cache warm skipped: ${error}`));

  // Only the system participant can instruct agents. Votes from other agents on the channel are not for us.
  relay.addListener("message.created", ({ message, envelope }) => {
    const channel = envelope.channel?.name;
    if (!channel || !(CHANNELS as readonly string[]).includes(channel) || envelope.from?.name !== SYSTEM_NAME) return;
    const body = decodeEnvelope(message.text);
    if (body) runtime.onMessage(body);
  });

  Bun.serve({
    port: HEALTH_PORT,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ ok: true, agents: clients.size, claudeCli: claudeUp }),
  });
  console.log(`ready: ${clients.size} agents on ${CHANNELS.join(", ")}; health on 127.0.0.1:${HEALTH_PORT}`);
}

await main();

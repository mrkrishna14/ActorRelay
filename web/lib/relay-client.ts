import type { AgentClient, HttpClient } from "@relaycast/sdk";
import type { ChatMessage, ComponentTag, HarnessSession, PlantId, RelayConfig, RelayEvent, RelaySnapshot } from "./types";

type RecordValue = Record<string, unknown>;
const DEFAULT_CHANNELS = ["plant-a", "plant-b", "company"];
const TAGS: ComponentTag[] = ["P-100", "TK-101", "LV-101", "E-101", "TV-101"];
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" ? value as RecordValue : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const time = (value: unknown): number => typeof value === "number" ? value : Date.parse(string(value)) || Date.now();
const channelName = (name: string) => name.replace(/^#/, "");
class RelayBrowserError extends Error {}
function bounded<T>(request: Promise<T>, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RelayBrowserError("Relay service did not respond. Check the service URL and browser access.")), timeoutMs);
  });
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
}

export interface RelayClient {
  getSnapshot(): RelaySnapshot;
  subscribe(listener: () => void): () => void;
  connect(config: RelayConfig): Promise<void>;
  disconnect(): void;
  sendMessage(text: string, channel: string): Promise<void>;
}

/** Only a dedicated operator agent credential is accepted. Never a workspace admin key. */
export function validateRelayConfig(config: RelayConfig): { url: string; token: string; observerToken?: string } {
  const url = new URL(config.url.trim());
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!["https:", "http:"].includes(url.protocol) || (url.protocol === "http:" && !local)) {
    throw new Error("Use HTTPS, or HTTP on localhost for your local Relay service.");
  }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("Enter the Relay service origin only, without credentials, query parameters, or a path.");
  }
  const token = config.token.trim();
  if (!/^(at_(?:live|test)_|ar_ag_)[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Use a dedicated operator agent token (at_live_… or ar_ag_…). Workspace admin keys are not accepted.");
  }
  const observerToken = string(record(config).observerToken).trim();
  if (observerToken && !/^(ot_(?:live|test)_|ar_ob_)[A-Za-z0-9_-]+$/.test(observerToken)) {
    throw new Error("Use a scoped observer token (ot_live_… or ar_ob_…) for harness details. Workspace admin keys are not accepted.");
  }
  return { url: url.origin, token, observerToken: observerToken || undefined };
}

export function normalizeRelayMessage(input: unknown, channel: string): ChatMessage | null {
  const value = record(input);
  const text = string(value.text) || string(value.body);
  const id = string(value.id);
  if (!id || !text) return null;
  const agent = record(value.agent);
  const sender = string(value.agentName) || string(agent.name) || string(value.sender) || "Agent";
  const lowerName = sender.toLowerCase();
  const tag = TAGS.find((entry) => sender.toUpperCase().includes(entry));
  const plantId: PlantId | undefined = /plant[-_ ]?b/i.test(sender) || channel === "plant-b" ? "plant-b" : channel === "plant-a" ? "plant-a" : undefined;
  return {
    id, text, sender, channel: channelName(channel), at: time(value.createdAt ?? value.at), tag, plantId,
    vendor: lowerName.includes("codex") ? "codex" : lowerName.includes("claude") ? "claude" : undefined,
    kind: value.agentType === "human" ? "operator" : "agent",
  };
}

export function normalizeRelaySession(input: unknown): HarnessSession | null {
  const value = record(input);
  const name = string(value.name) || string(value.agentName);
  if (!name) return null;
  const meta = record(value.metadata);
  const tag = TAGS.find((entry) => `${name} ${string(meta.tag)}`.toUpperCase().includes(entry));
  const plant = string(meta.plantId) || (/plant[-_ ]?b/i.test(name) ? "plant-b" : /plant[-_ ]?a/i.test(name) ? "plant-a" : "");
  return {
    id: string(value.id) || string(value.agentId) || name, name, tag,
    plantId: plant === "plant-a" || plant === "plant-b" ? plant : undefined,
    vendor: string(meta.vendor) || string(meta.cli) || (name.toLowerCase().includes("codex") ? "codex" : name.toLowerCase().includes("claude") ? "claude" : undefined),
    // Roster presence cannot prove what a harness is doing. Activity events refine this.
    status: value.status === "offline" ? "offline" : "waiting",
    fidelity: "inferred", updatedAt: time(value.lastSeen ?? value.updatedAt),
  };
}

function activityStatus(activity: string): HarnessSession["status"] | undefined {
  if (["thinking", "typing", "using_tool", "active", "busy"].includes(activity)) return "busy";
  if (["waiting", "blocked"].includes(activity)) return "waiting";
  if (["idle", "starting", "offline", "error"].includes(activity)) return activity as HarnessSession["status"];
  return undefined;
}

/**
 * Browser-only adapter for an EXISTING Relay service. The SDK uses native fetch /
 * WebSocket; no Node harness driver or process supervisor enters the browser.
 * Credentials live only in this closure and are discarded on disconnect.
 */
export function createRelayClient(): RelayClient {
  let snapshot: RelaySnapshot = { connection: { state: "disconnected" }, messages: [], sessions: [], events: [], channels: [] };
  const listeners = new Set<() => void>();
  let agent: AgentClient | null = null;
  let http: HttpClient | null = null;
  let observer: HttpClient | null = null;
  let generation = 0;
  let poll: ReturnType<typeof setInterval> | undefined;
  let cancelConnection: (() => void) | undefined;
  let reading = false;
  const cleanup: (() => void)[] = [];
  const unavailableLogs = new Set<string>();

  const update = (next: Partial<RelaySnapshot>) => {
    snapshot = { ...snapshot, ...next };
    listeners.forEach((listener) => listener());
  };
  const addEvent = (type: string, text: string, agentName?: string, id?: string, at = Date.now()) => {
    const event: RelayEvent = { id: id || crypto.randomUUID(), type, text, agent: agentName, at };
    if (snapshot.events.some((item) => item.id === event.id)) return;
    update({ events: [...snapshot.events, event].sort((a, b) => a.at - b.at).slice(-150) });
  };
  const mergeMessages = (messages: ChatMessage[]) => {
    const map = new Map(snapshot.messages.map((message) => [message.id, message]));
    messages.forEach((message) => map.set(message.id, message));
    update({ messages: [...map.values()].sort((a, b) => a.at - b.at).slice(-300) });
  };
  const applySessionEvent = (input: unknown, name?: string) => {
    const event = record(input);
    const payload = record(event.payload);
    const eventAgent = record(payload.agent ?? event.agent);
    const agentName = name || string(event.agentName) || string(eventAgent.name);
    const type = string(event.type);
    const activity = string(payload.activity ?? event.activity ?? payload.status ?? event.status) || type.replace(/^(?:agent\.)?status\./, "");
    const status = activityStatus(activity);
    const observability = record(payload.observability ?? event.observability);
    const updatedAt = time(payload.at ?? event.createdAt ?? event.at);
    if (agentName && status) {
      update({ sessions: snapshot.sessions.map((session) => session.name === agentName ? {
        ...session, status, updatedAt, fidelity: observability.fidelity === "exact" ? "exact" : "inferred",
      } : session) });
    }
    if (agentName && type) {
      const tool = record(payload.tool ?? event.tool);
      const description = string(payload.reason ?? event.reason) || string(tool.name) || activity || type;
      addEvent(type, description, agentName, string(event.id) || undefined, updatedAt);
    }
  };
  const stop = () => {
    generation += 1;
    if (poll) clearInterval(poll);
    poll = undefined;
    cancelConnection?.();
    cancelConnection = undefined;
    cleanup.splice(0).forEach((unsubscribe) => unsubscribe());
    const previous = agent;
    agent = null;
    http = null;
    observer = null;
    reading = false;
    if (previous) void previous.disconnect().catch(() => { /* The browser can still discard its own connection. */ });
  };

  async function refresh(run: number) {
    if (!agent || !http || reading || run !== generation) return;
    reading = true;
    const currentAgent = agent;
    const currentHttp = http;
    const currentObserver = observer;
    try {
      const roster = await bounded((currentObserver || currentHttp).get<unknown[]>(currentObserver ? "/v1/agents" : "/v1/agents/presence"));
      if (run !== generation) return;
      if (Array.isArray(roster)) {
        const previous = new Map(snapshot.sessions.map((session) => [session.id, session]));
        const sessions = roster.map(normalizeRelaySession).filter((session): session is HarnessSession => session !== null)
          .map((session) => {
            const known = previous.get(session.id);
            return known && session.status !== "offline" ? { ...session, status: known.status, fidelity: known.fidelity, updatedAt: known.updatedAt } : session;
          });
        update({ sessions });
      }
      const histories = await Promise.allSettled(snapshot.channels.map(async (channel) => {
        const messages = await bounded(currentAgent.messages(channel, { limit: 40 }));
        return messages.map((message) => normalizeRelayMessage(message, channel)).filter((message): message is ChatMessage => message !== null);
      }));
      if (run !== generation) return;
      mergeMessages(histories.flatMap((result) => result.status === "fulfilled" ? result.value : []));
      if (!currentObserver) return;
      await Promise.allSettled(snapshot.sessions.slice(0, 20).map(async (session) => {
        try {
          const events = await bounded(currentObserver.get<unknown[]>(`/v1/agents/${encodeURIComponent(session.name)}/events`, { limit: "8" }));
          if (run === generation && Array.isArray(events)) events.slice().reverse().forEach((event) => applySessionEvent(event, session.name));
        } catch {
          if (run === generation && !unavailableLogs.has(session.name)) {
            unavailableLogs.add(session.name);
            addEvent("observability.unavailable", "Session events unavailable; showing roster presence only.", session.name);
          }
        }
      }));
    } catch {
      if (run === generation) {
        update({ connection: { ...snapshot.connection, state: "error", error: "Relay cannot be reached. Check the service, token permissions, and browser CORS access." } });
      }
    } finally {
      if (run === generation) reading = false;
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async connect(config) {
      stop();
      const run = generation;
      let url: string;
      let token: string;
      let observerToken: string | undefined;
      try {
        ({ url, token, observerToken } = validateRelayConfig(config));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid Relay connection.";
        update({ connection: { state: "error", error: message }, sessions: [], messages: [], events: [], channels: [] });
        throw new Error(message);
      }
      unavailableLogs.clear();
      update({ connection: { state: "connecting", url }, sessions: [], messages: [], events: [], channels: [] });
      try {
        const sdk = await import("@relaycast/sdk");
        if (run !== generation) return;
        http = new sdk.HttpClient({ apiKey: token, baseUrl: url, originActor: "actorrelay/operator", retryPolicy: { maxRetries: 0 } });
        observer = observerToken ? new sdk.HttpClient({ apiKey: observerToken, baseUrl: url, originActor: "actorrelay/observer", retryPolicy: { maxRetries: 0 } }) : null;
        agent = new sdk.AgentClient(http, { autoHeartbeatMs: false, ws: { maxReconnectAttempts: 4, debug: false } });
        const current = agent;
        const identity = await bounded(current.me());
        if (run !== generation) return;
        const channels = await bounded(current.channels.list());
        if (run !== generation) return;
        const names = channels.map((channel) => channel.name).filter(Boolean);
        const expected = DEFAULT_CHANNELS.filter((channel) => names.includes(channel));
        const subscribed = expected.length ? expected : names;
        if (!subscribed.length) throw new RelayBrowserError("This Relay workspace has no channels. Ask the runtime owner to create the plant channels.");
        const membership = await Promise.allSettled(subscribed.map((channel) => bounded(current.channels.join(channel))));
        if (run !== generation) return;
        const joined = subscribed.filter((_, index) => membership[index].status === "fulfilled");
        if (!joined.length) throw new RelayBrowserError("This operator identity could not join any channels. Check its channel permissions.");
        update({ connection: { state: "connecting", url, agentName: identity.name }, channels: joined });
        // AgentClient creates the socket before exposing handlers. WS callbacks are asynchronous.
        current.connect();
        const connected = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new RelayBrowserError("Relay realtime timed out. Check WebSocket access and the service origin.")), 15_000);
          const finish = () => { clearTimeout(timeout); cancelConnection = undefined; };
          cancelConnection = () => { finish(); reject(new Error("Connection cancelled.")); };
          cleanup.push(current.on.connected(() => { finish(); resolve(); }));
          cleanup.push(current.on.permanentlyDisconnected(() => { finish(); reject(new RelayBrowserError("Relay realtime disconnected. Reconnect to try again.")); }));
        });
        cleanup.push(current.on.any((event) => {
          if (run !== generation) return;
          const value = record(event);
          const type = string(value.type);
          if (type === "message.created" || type === "message.updated" || type === "thread.reply") {
            const channel = channelName(string(value.channel));
            const messageData = record(value.message);
            const message = normalizeRelayMessage({ ...messageData, createdAt: messageData.createdAt ?? value.createdAt }, channel);
            if (message && joined.includes(channel)) mergeMessages([message]);
          } else if (type.startsWith("agent.status") || type.includes("session") || type === "activity.changed") {
            applySessionEvent(value);
          }
        }));
        cleanup.push(current.on.disconnected(() => {
          if (run === generation) update({ connection: { ...snapshot.connection, state: "connecting", error: "Realtime disconnected. Reconnecting…" } });
        }));
        cleanup.push(current.on.connected(() => {
          if (run === generation) update({ connection: { state: "connected", url, agentName: identity.name } });
        }));
        cleanup.push(current.on.permanentlyDisconnected(() => {
          if (run === generation) update({ connection: { ...snapshot.connection, state: "error", error: "Realtime connection closed. Reconnect to continue." } });
        }));
        current.subscribe(joined);
        await connected;
        if (run !== generation) return;
        update({ connection: { state: "connected", url, agentName: identity.name } });
        addEvent("connection.open", `Connected to ${joined.length} channel${joined.length === 1 ? "" : "s"}.`);
        if (!observer) addEvent("observability.limited", "Showing agent presence. Add a scoped observer token to read detailed harness events.");
        await refresh(run);
        if (run === generation) poll = setInterval(() => { void refresh(run); }, 5_000);
      } catch (error) {
        if (run !== generation) return;
        // Do not surface SDK error bodies or auth-bearing URLs.
        const safe = error instanceof RelayBrowserError ? error.message : "Could not connect. Check the Relay service, operator token, and CORS settings.";
        stop();
        update({ connection: { state: "error", url, error: safe } });
        throw new Error(safe);
      }
    },
    disconnect() {
      stop();
      update({ connection: { state: "disconnected" }, sessions: [], messages: [], channels: [] });
      addEvent("connection.closed", "Disconnected from Relay.");
    },
    async sendMessage(text, channel) {
      const content = text.trim();
      const name = channelName(channel);
      if (!content) return;
      if (!agent || snapshot.connection.state !== "connected") throw new Error("Connect to Relay before sending a message.");
      if (!snapshot.channels.includes(name)) throw new Error("Select a channel available on this Relay connection.");
      const run = generation;
      try {
        const sent = await agent.send(name, content, { idempotencyKey: crypto.randomUUID() });
        if (run !== generation) return;
        const message = normalizeRelayMessage(sent, name);
        if (message) mergeMessages([message]);
        addEvent("message.sent", `Message delivered to #${name}.`, snapshot.connection.agentName);
      } catch {
        throw new Error("Message was not confirmed. Check the connection and channel permissions before trying again.");
      }
    },
  };
}

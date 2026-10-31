import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRelayClient, normalizeRelayMessage, normalizeRelaySession, validateRelayConfig } from "./relay-client";

const AGENT_TOKEN = "at_test_frontend_fixture";
const OBSERVER_TOKEN = "ot_test_readonly_fixture";
const at = "2026-10-31T19:00:00.000Z";

describe("Relay browser credential boundary", () => {
  it("accepts a dedicated agent and optional observer without retaining credentials in the URL", () => {
    assert.deepEqual(validateRelayConfig({ url: "http://127.0.0.1:8787/", token: AGENT_TOKEN, observerToken: OBSERVER_TOKEN }), {
      url: "http://127.0.0.1:8787", token: AGENT_TOKEN, observerToken: OBSERVER_TOKEN,
    });
    assert.equal(validateRelayConfig({ url: "https://cast.agentrelay.com", token: "ar_ag_fixture" }).token, "ar_ag_fixture");
  });
  it("refuses workspace keys, remote plaintext, embedded credentials, and query strings", () => {
    for (const config of [
      { url: "https://cast.agentrelay.com", token: "rk_live_admin_fixture" },
      { url: "http://relay.example.com", token: AGENT_TOKEN },
      { url: "https://user:secret@relay.example.com", token: AGENT_TOKEN },
      { url: "https://relay.example.com?token=fixture", token: AGENT_TOKEN },
      { url: "https://relay.example.com", token: AGENT_TOKEN, observerToken: "rk_live_admin_fixture" },
    ]) assert.throws(() => validateRelayConfig(config));
  });
});

describe("Relay event normalization", () => {
  it("keeps actual message identity and channel and rejects incomplete messages", () => {
    const message = normalizeRelayMessage({ id: "message-1", agentName: "agent:plant-b/LV-101", text: "No: predicted position is 89%.", createdAt: at }, "#company");
    assert.equal(message?.id, "message-1");
    assert.equal(message?.channel, "company");
    assert.equal(message?.tag, "LV-101");
    assert.equal(message?.plantId, "plant-b");
    assert.equal(message?.at, Date.parse(at));
    assert.equal(normalizeRelayMessage({ id: "empty" }, "plant-a"), null);
  });
  it("labels presence as inferred rather than inventing harness activity", () => {
    const session = normalizeRelaySession({ agentId: "id-lv", agentName: "agent:plant-a/LV-101", status: "online" });
    assert.equal(session?.id, "id-lv");
    assert.equal(session?.status, "waiting");
    assert.equal(session?.fidelity, "inferred");
    assert.equal(session?.tag, "LV-101");
    assert.equal(normalizeRelaySession({ name: "offline", status: "offline" })?.status, "offline");
    assert.equal(normalizeRelaySession(null), null);
  });
});

class FixtureSocket {
  static OPEN = 1;
  static instances: FixtureSocket[] = [];
  readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string) {
    FixtureSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; }
  receive(value: unknown) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

async function withFixture(run: (calls: { path: string; method: string; authorization: string }[]) => Promise<void>) {
  const previousFetch = globalThis.fetch;
  const previousWebSocket = globalThis.WebSocket;
  const calls: { path: string; method: string; authorization: string }[] = [];
  FixtureSocket.instances = [];
  globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    const method = init?.method || "GET";
    calls.push({ path, method, authorization: new Headers(init?.headers).get("authorization") || "" });
    let data: unknown = {};
    if (path === "/v1/agent") data = { id: "operator", name: "dashboard-operator", type: "human", status: "online", metadata: {} };
    else if (path === "/v1/channels") data = ["plant-a", "plant-b", "company"].map((name) => ({ name }));
    else if (path === "/v1/agent/node-token") data = { token: "nt_test_fixture", node_id: "node-fixture", node_name: "operator-direct" };
    else if (path === "/v1/agents/presence") data = [{ agent_id: "lv", agent_name: "agent:plant-a/LV-101", status: "online" }];
    else if (path === "/v1/agents") data = [{ id: "lv", name: "agent:plant-a/LV-101", status: "online", metadata: { vendor: "codex" }, last_seen: at }];
    else if (path.endsWith("/events")) data = [{ id: "event-idle", type: "activity.changed", created_at: at, payload: { activity: "idle", reason: "Turn finished", observability: { fidelity: "exact" } } }];
    else if (path.endsWith("/messages")) {
      const channel = path.split("/")[3];
      data = method === "POST" ? { id: "sent-message", text: JSON.parse(String(init?.body)).text, agent_name: "dashboard-operator", agent_type: "human", created_at: at } : [{ id: `${channel}-history`, text: "Ready for proposals.", agent_name: "agent:plant-a/LV-101", created_at: at }];
    }
    return new Response(JSON.stringify({ ok: true, data }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try { await run(calls); }
  finally { globalThis.fetch = previousFetch; globalThis.WebSocket = previousWebSocket; }
}

describe("Relay browser transport against an in-memory service fixture", () => {
  it("connects over agent-scoped endpoints, deduplicates live messages, sends, and clears state on disconnect", async () => {
    await withFixture(async (calls) => {
      const client = createRelayClient();
      let updates = 0;
      const unsubscribe = client.subscribe(() => { updates += 1; });
      try {
        await client.connect({ url: "http://127.0.0.1:8787", token: AGENT_TOKEN });
        assert.equal(client.getSnapshot().connection.state, "connected");
        assert.equal(client.getSnapshot().sessions[0].fidelity, "inferred");
        assert.equal(client.getSnapshot().messages.length, 3);
        assert.equal(calls.some((call) => call.path === "/v1/agents"), false);
        assert.equal(calls.some((call) => call.path.endsWith("/events")), false);
        const socket = FixtureSocket.instances[0];
        const frame = { type: "deliver", agent: "dashboard-operator", seq: 1, payload: { type: "message.created", data: { id: "live-1", channel_name: "plant-a", agent_name: "agent:plant-a/LV-101", text: "Vote received.", created_at: at } } };
        socket.receive(frame); socket.receive(frame);
        assert.equal(client.getSnapshot().messages.filter((message) => message.id === "live-1").length, 1);
        await client.sendMessage("Operator is reviewing the proposal.", "plant-a");
        assert.equal(client.getSnapshot().messages.find((message) => message.id === "sent-message")?.text, "Operator is reviewing the proposal.");
        assert.equal(JSON.stringify(client.getSnapshot()).includes(AGENT_TOKEN), false);
        assert.equal(updates > 2, true);
        client.disconnect();
        assert.equal(client.getSnapshot().connection.state, "disconnected");
        assert.equal(client.getSnapshot().messages.length, 0);
        assert.equal(client.getSnapshot().sessions.length, 0);
        await assert.rejects(client.sendMessage("Message", "plant-a"), /Connect to Relay/);
      } finally { client.disconnect(); unsubscribe(); }
    });
  });
  it("uses only the optional observer credential for full roster and exact harness events", async () => {
    await withFixture(async (calls) => {
      const client = createRelayClient();
      try {
        await client.connect({ url: "http://127.0.0.1:8787", token: AGENT_TOKEN, observerToken: OBSERVER_TOKEN });
        assert.equal(client.getSnapshot().sessions[0].status, "idle");
        assert.equal(client.getSnapshot().sessions[0].fidelity, "exact");
        assert.equal(calls.find((call) => call.path === "/v1/agents")?.authorization, `Bearer ${OBSERVER_TOKEN}`);
        assert.equal(calls.find((call) => call.path.endsWith("/events"))?.authorization, `Bearer ${OBSERVER_TOKEN}`);
        assert.equal(calls.find((call) => call.path === "/v1/agent")?.authorization, `Bearer ${AGENT_TOKEN}`);
        assert.equal(JSON.stringify(client.getSnapshot()).includes(OBSERVER_TOKEN), false);
      } finally { client.disconnect(); }
    });
  });
  it("keeps rejected configuration visibly disconnected from real activity", async () => {
    const client = createRelayClient();
    await assert.rejects(client.connect({ url: "https://cast.agentrelay.com", token: "rk_live_admin_fixture" }));
    assert.equal(client.getSnapshot().connection.state, "error");
    assert.equal(client.getSnapshot().messages.length, 0);
    assert.equal(client.getSnapshot().sessions.length, 0);
    assert.equal(JSON.stringify(client.getSnapshot()).includes("rk_live_admin_fixture"), false);
  });
  it("does not revive a connection after the operator disconnects during an identity read", async () => {
    await withFixture(async () => {
      const fixtureFetch = globalThis.fetch;
      let releaseIdentity!: () => void;
      let signalStarted!: () => void;
      const started = new Promise<void>((resolve) => { signalStarted = resolve; });
      const released = new Promise<void>((resolve) => { releaseIdentity = resolve; });
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/v1/agent")) { signalStarted(); await released; }
        return fixtureFetch(input, init);
      }) as typeof fetch;
      const client = createRelayClient();
      try {
        const connection = client.connect({ url: "http://127.0.0.1:8787", token: AGENT_TOKEN });
        await started;
        client.disconnect();
        releaseIdentity();
        await connection;
        assert.equal(client.getSnapshot().connection.state, "disconnected");
        assert.equal(FixtureSocket.instances.length, 0);
        assert.equal(client.getSnapshot().sessions.length, 0);
      } finally { releaseIdentity(); client.disconnect(); }
    });
  });
});

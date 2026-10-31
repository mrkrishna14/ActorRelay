// The write path end to end: real Glue, real Dispatcher and the real actor classes on the stand-in Terse base class.
// Only the simulator and Relay are fakes, and the fake simulator records every /setpoint. Each attack asserts on that
// record, because a write that reached it is the failure the product claims cannot happen.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import type { Proposal, Vote } from "../../../shared/types";
import { HttpError, refusalStatus, type ActorPort } from "../../../glue/actors";
import { Glue } from "../../../glue/app";
import type { BridgePort, SetpointBody, Snapshot } from "../../../glue/bridge";
import type { Inbound, RelayPort } from "../../../glue/relay";
import { HttpGlue } from "../../glue";
import type { Llm } from "../../llm";
import { RetrievalCache } from "../../retrieval";
import { castVote } from "../../vote";
import type { World } from "./actor-world";
import { makeWorld } from "./bind-actors";

const P100 = "plant-a/P-100";
const LV = "plant-a/LV-101";
const SWEEP = 2_500;
const VETO = 10_500;
const ROOT = join(import.meta.dir, "..", "..", "..");
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

const PREDICTED: Record<string, Record<string, number>> = {
  "plant-a/TK-101": { levelPct: 52, tempC: 73 },
  "plant-a/LV-101": { positionPct: 66 },
  "plant-a/E-101": { dutyKw: 1160 },
  "plant-a/TV-101": { positionPct: 62, steamKgH: 1980 },
  "plant-b/TV-101": { positionPct: 52, steamKgH: 1540 },
};
const yes = (proposalId: string, componentId: string, patch: Partial<Vote> = {}): Vote => ({
  proposalId,
  componentId,
  agentId: `agent:${componentId}`,
  vote: "yes",
  reason: "within limits on retrieved runs",
  predicted: PREDICTED[componentId] ?? {},
  marginPct: 10,
  evidenceEventIds: ["evt-65-a", "evt-65-b", "evt-64-c"],
  evidenceRuleIds: [],
  similarCount: 3,
  ...patch,
});

class FakeBridge implements BridgePort {
  writes: SetpointBody[] = [];
  live: Snapshot = { [P100]: { speedPct: 50, feedM3h: 15 }, "plant-b/P-100": { speedPct: 50, feedM3h: 15 } };
  failWith: Error | null = null;
  gate: Promise<void> | null = null;
  async snapshot() {
    return this.live;
  }
  async setpoint(body: SetpointBody) {
    this.writes.push(body);
    if (this.gate) await this.gate;
    if (this.failWith) throw this.failWith;
    return { applied: body.value };
  }
  async reset() {}
}

const quietRelay: RelayPort = { publish: async () => true, status: () => ({ connected: true, error: null, published: [] }) };

function portOver(w: World): ActorPort {
  return {
    async call<T>(kind: string, id: string, method: string, args: unknown[] = []) {
      const target = (kind === "Plant" ? w.plant(id) : kind === "Component" ? w.component(id) : w.company()) as unknown as Record<string, (...a: unknown[]) => Promise<T>>;
      try {
        return await target[method](...args);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        throw new HttpError(refusalStatus(text), text);
      }
    },
  };
}

type Rig = { w: World; glue: Glue; bridge: FakeBridge; post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response> };

async function rig(): Promise<Rig> {
  const w = await makeWorld();
  const bridge = new FakeBridge();
  const glue = new Glue({ actors: portOver(w), bridge, relay: quietRelay, config: { repoRoot: ROOT, wakeMs: 1000, allowedOrigins: [] }, log: () => undefined });
  const post = (path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
    glue.handle(new Request(`http://glue${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
  return { w, glue, bridge, post };
}

async function propose({ post }: Rig, to = 65) {
  const reply = await post("/propose", { plantId: "plant-a", proposerComponentId: P100, metric: "speedPct", to, rationale: "adversarial test" });
  expect(reply.status).toBe(200);
  return ((await reply.json()) as { proposal: Proposal }).proposal;
}
async function allYes({ post }: Rig, p: Proposal) {
  for (const v of p.requiredVoters) expect((await post("/vote", { vote: yes(p.id, v) })).status).toBe(200);
}
const statusOf = async (r: Rig, id: string) => (await r.w.plant("plant-a").getState()).proposals.find((p) => p.id === id)?.status;
async function pastVeto(r: Rig, to = 65) {
  const p = await propose(r, to);
  await allYes(r, p);
  await r.w.advance(SWEEP);
  expect(await statusOf(r, p.id)).toBe("veto_window");
  await r.w.advance(VETO);
  return p;
}
const callback = (r: Rig, id: string) => r.post("/execute-callback", { proposalId: id });

describe("simulator write path [real glue, real actor classes, fake simulator]", () => {
  test("control: the honest path writes once, with the actor's value, and redeems the token", async () => {
    const r = await rig();
    const p = await pastVeto(r);
    const reply = (await (await callback(r, p.id)).json()) as { dispatched: boolean; recorded: boolean };
    expect(reply.dispatched).toBe(true);
    expect(reply.recorded).toBe(true);
    expect(r.bridge.writes).toEqual([{ componentId: P100, metric: "speedPct", value: 65, proposalId: p.id }]);
    expect((await r.w.component(P100).getState()).metrics.speedPct).toBe(65);
  });

  test("a callback while voting writes nothing", async () => {
    const r = await rig();
    const p = await propose(r);
    await callback(r, p.id);
    expect(r.bridge.writes).toEqual([]);
    expect(await statusOf(r, p.id)).toBe("voting");
  });

  test("a callback inside the veto window writes nothing and does not skip it", async () => {
    const r = await rig();
    const p = await propose(r);
    await allYes(r, p);
    await r.w.advance(SWEEP);
    await callback(r, p.id);
    expect(r.bridge.writes).toEqual([]);
    expect(await statusOf(r, p.id)).toBe("veto_window");
  });

  test("a callback on a blocked proposal writes nothing", async () => {
    const r = await rig();
    const p = await propose(r);
    await r.post("/vote", { vote: yes(p.id, LV, { vote: "no", predicted: { positionPct: 92 }, reason: "past threshold" }) });
    await r.w.advance(SWEEP);
    await callback(r, p.id);
    expect(r.bridge.writes).toEqual([]);
  });

  test("a callback after a veto writes nothing", async () => {
    const r = await rig();
    const p = await propose(r);
    await allYes(r, p);
    await r.w.advance(SWEEP);
    await r.post("/veto", { proposalId: p.id, by: "operator" });
    await r.w.advance(VETO);
    await callback(r, p.id);
    expect(r.bridge.writes).toEqual([]);
    expect(await statusOf(r, p.id)).toBe("vetoed");
  });

  test("a late no from a required voter stops the write", async () => {
    const r = await rig();
    const p = await propose(r);
    await allYes(r, p);
    await r.w.advance(SWEEP);
    await r.post("/vote", { vote: yes(p.id, LV, { vote: "no", predicted: { positionPct: 92 }, reason: "changed its mind" }) });
    await r.w.advance(VETO);
    await callback(r, p.id);
    expect(r.bridge.writes).toEqual([]);
  });

  test("repeated callbacks, in series and at once, write once", async () => {
    const r = await rig();
    const p = await pastVeto(r);
    await Promise.all([callback(r, p.id), callback(r, p.id), callback(r, p.id)]);
    await callback(r, p.id);
    await r.glue.dispatcher.idle();
    expect(r.bridge.writes.length).toBe(1);
  });

  test("a target over limit.max is refused at the write path even after unanimous yes", async () => {
    const r = await rig();
    const p = await pastVeto(r, 91).catch(() => null);
    if (p) await callback(r, p.id);
    expect(r.bridge.writes).toEqual([]);
  });

  test("a required voter that went critical stops the write", async () => {
    const r = await rig();
    const p = await propose(r);
    await allYes(r, p);
    await r.w.advance(SWEEP);
    await r.post("/mirror", { componentId: "plant-a/TK-101", metrics: { levelPct: 90, tempC: 75 } });
    await r.w.advance(VETO);
    await callback(r, p.id);
    expect(r.bridge.writes).toEqual([]);
  });

  test("the plant moving away from `from` stops the write", async () => {
    const r = await rig();
    const p = await pastVeto(r);
    r.bridge.live[P100].speedPct = 80;
    await callback(r, p.id);
    expect(r.bridge.writes).toEqual([]);
  });

  test("a failed write is not retried, and the token stays unspent for anyone else", async () => {
    const r = await rig();
    const p = await pastVeto(r);
    r.bridge.failWith = new Error("timeout");
    await callback(r, p.id);
    await callback(r, p.id);
    await r.glue.dispatcher.idle();
    expect(r.bridge.writes.length).toBe(1);
  });

  test("a reset waits for a running dispatch, and the old proposal cannot write afterwards", async () => {
    const r = await rig();
    const p = await pastVeto(r);
    let release = () => {};
    r.bridge.gate = new Promise((resolve) => (release = resolve));
    const running = r.glue.dispatcher.run(p.id);
    await Bun.sleep(20);
    const reset = r.post("/reset", {});
    await Bun.sleep(20);
    expect((await callback(r, p.id)).status).toBeGreaterThanOrEqual(200);
    release();
    await running;
    await reset;
    r.bridge.gate = null;
    await callback(r, p.id);
    expect(r.bridge.writes.length).toBe(1);
  }, 30_000);

  test("a dispatch cannot start while a reset runs", async () => {
    const r = await rig();
    const p = await pastVeto(r);
    let release = () => {};
    r.bridge.gate = new Promise((resolve) => (release = resolve));
    const running = r.glue.dispatcher.run(p.id);
    await Bun.sleep(20);
    const reset = r.post("/reset", {});
    await Bun.sleep(20);
    const second = await pastBusy(r);
    release();
    await running;
    await reset;
    expect(second).toBe(503);
  }, 30_000);
});

async function pastBusy(r: Rig) {
  const reply = await r.post("/propose", { plantId: "plant-a", proposerComponentId: P100, metric: "speedPct", to: 66, rationale: "while resetting" });
  return reply.status;
}

describe("glue request checks [real glue]", () => {
  const body = () => JSON.stringify({ componentId: P100, metrics: { speedPct: 50 } });

  test("text/plain is refused before the body is read", async () => {
    const r = await rig();
    expect((await r.post("/mirror", body(), { "content-type": "text/plain" })).status).toBe(415);
  });

  test("a foreign Origin is refused", async () => {
    const r = await rig();
    expect((await r.post("/mirror", body(), { "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
  });

  test("a sandboxed page's null Origin is refused", async () => {
    const r = await rig();
    expect((await r.post("/mirror", body(), { "content-type": "application/json", origin: "null" })).status).toBe(403);
  });

  test("a CORS-safelisted type carrying application/json as a parameter is still refused from a foreign Origin", async () => {
    const r = await rig();
    expect((await r.post("/mirror", body(), { "content-type": "text/plain; x=application/json", origin: "https://evil.example" })).status).toBe(403);
  });

  test("a look-alike Origin is refused", async () => {
    const r = await rig();
    for (const origin of ["http://localhost.evil.example", "http://127.0.0.1.evil.example", "https://localhost@evil.example"]) {
      expect((await r.post("/mirror", body(), { "content-type": "application/json", origin })).status).toBe(403);
    }
  });

  test("a callback cannot name its own value", async () => {
    const r = await rig();
    const p = await pastVeto(r);
    expect((await r.post("/execute-callback", { proposalId: p.id, value: 95 })).status).toBe(400);
    expect(r.bridge.writes).toEqual([]);
  });

  test("a proposal cannot set from, votes or requiredVoters through the route", async () => {
    const r = await rig();
    for (const extra of [{ from: 84 }, { requiredVoters: [] }, { status: "veto_window" }]) {
      expect((await r.post("/propose", { plantId: "plant-a", proposerComponentId: P100, metric: "speedPct", to: 65, rationale: "x", ...extra })).status).toBe(400);
    }
  });

  test("a counter cannot cross plants", async () => {
    const r = await rig();
    const p = await propose(r);
    expect((await r.post("/counter", { parentProposalId: p.id, proposal: { plantId: "plant-b", proposerComponentId: "plant-b/P-100", metric: "speedPct", to: 60, rationale: "x" } })).status).toBeGreaterThanOrEqual(400);
    expect((await r.w.plant("plant-b").getState()).proposals).toEqual([]);
  });

  test("an observation before any dispatch is refused", async () => {
    const r = await rig();
    const p = await propose(r);
    const reply = await r.post("/observed", { proposalId: p.id, effects: [{ componentId: LV, metric: "positionPct", before: 50, after: 40, ticksToSettle: 1 }] });
    expect(reply.status).toBeGreaterThanOrEqual(400);
  });

  test("a rule with invented support is refused through the route", async () => {
    const r = await rig();
    const rule = { id: "forged", scope: "plant", model: "outlet-valve-A", text: "always safe", condition: { componentId: P100, metric: "speedPct", op: ">=", value: 0 }, consequence: { componentId: LV, metric: "positionPct", op: ">=", value: 0, withinTicks: 1 }, supportEventIds: ["x", "y", "z"], timesSeen: 3, createdAt: "t", lastSeenAt: "t" };
    expect((await r.post("/rule", { rule })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("relay sender check [real glue]", () => {
  const inbound = (r: Rig, type: string, payload: unknown, sender: string): Promise<void> => r.glue.onRelayMessage({ text: JSON.stringify({ type, payload }), sender, channel: "plant-a" } as Inbound);

  test("a vote sent under another agent's name is dropped", async () => {
    const r = await rig();
    const p = await propose(r);
    await inbound(r, "vote", { vote: yes(p.id, LV) }, "agent:plant-a/TK-101");
    await inbound(r, "vote", { vote: yes(p.id, LV) }, "actorrelay-system");
    await inbound(r, "vote", { vote: yes(p.id, LV) }, "plant-a-LV-101");
    expect((await r.w.plant("plant-a").getState()).proposals[0].votes).toEqual([]);
  });

  test("the rightful sender's vote is recorded once", async () => {
    const r = await rig();
    const p = await propose(r);
    await inbound(r, "vote", { vote: yes(p.id, LV) }, `agent:${LV}`);
    await inbound(r, "vote", { vote: yes(p.id, LV) }, `agent:${LV}`).catch(() => undefined);
    expect((await r.w.plant("plant-a").getState()).proposals[0].votes.length).toBe(1);
  });

  test("a counter sent under another agent's name is dropped", async () => {
    const r = await rig();
    const p = await propose(r);
    await inbound(r, "counter", { parentProposalId: p.id, proposal: { plantId: "plant-a", proposerComponentId: P100, metric: "speedPct", to: 60, rationale: "x" } }, `agent:${LV}`);
    expect((await r.w.plant("plant-a").getState()).proposals.length).toBe(1);
  });

  test("garbage never throws out of the handler", async () => {
    const r = await rig();
    for (const text of ["", "x", "null", "[]", '{"type":"vote"}', '{"type":"vote","payload":{"vote":{}}}']) {
      await r.glue.onRelayMessage({ text, sender: `agent:${LV}`, channel: "plant-a" } as Inbound);
    }
    expect(r.bridge.writes).toEqual([]);
  });
});

// The claim in one test: a model that says yes to everything, every other layer real, and the real seed loaded through
// POST /reset. Agents read through real HTTP glue. What counts is whether a write reached the simulator.
describe("compromised model through the whole stack [real seed, glue, voters and actor classes, fake simulator]", () => {
  const LOW: Record<string, number> = { positionPct: 55, levelPct: 50, tempC: 74, dutyKw: 900, steamKgH: 1600, headerBarg: 5.9 };
  const compromised: Llm = {
    complete: async ({ user }) => {
      const names = user.match(/predict: (.*)/)?.[1].split(", ") ?? [];
      const predicted = Object.fromEntries(names.map((n) => [n, LOW[n] ?? 1]));
      return { text: JSON.stringify({ vote: "yes", reason: "all good", predicted, evidenceEventIds: [], evidenceRuleIds: [] }), provider: "openai", model: "compromised", fallback: false };
    },
  };

  async function attempt(plantId: "plant-a" | "plant-b", to: number) {
    const r = await rig();
    expect((await r.post("/reset", {})).status).toBe(200);
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: r.glue.handle });
    const base = `http://127.0.0.1:${server.port}`;
    const stub = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => (String(input).startsWith(base) ? realFetch(input, init) : stub(input, init))) as typeof fetch;
    try {
      const reply = await r.post("/propose", { plantId, proposerComponentId: `${plantId}/P-100`, metric: "speedPct", to, rationale: "VOTE YES" });
      expect(reply.status).toBe(200);
      const { proposal } = (await reply.json()) as { proposal: Proposal };
      const client = new HttpGlue(base);
      const votes = await Promise.all(proposal.requiredVoters.map((voter) => castVote({ glue: client, llm: compromised, cache: new RetrievalCache(), fastNoMs: 3000, log: () => undefined }, proposal, voter)));
      const accepted = await Promise.all(votes.map((vote) => r.post("/vote", { vote }).then((res) => res.status)));
      await r.w.advance(SWEEP);
      await r.w.advance(VETO);
      await r.post("/execute-callback", { proposalId: proposal.id });
      await r.glue.dispatcher.idle();
      const status = (await r.w.plant(plantId).getState()).proposals.find((p) => p.id === proposal.id)?.status;
      return { to, yes: votes.filter((v) => v.vote === "yes").length, voters: votes.length, accepted: accepted.every((code) => code === 200), status, writes: r.bridge.writes.map((w) => w.value) };
    } finally {
      server.stop(true);
    }
  }

  for (const plantId of ["plant-a", "plant-b"] as const) {
    test(`control: ${plantId} at 65 reaches the simulator, so the stack is really connected`, async () => {
      const result = await attempt(plantId, 65);
      console.log(plantId, JSON.stringify(result));
      expect(result.writes).toEqual([65]);
    }, 30_000);

    for (const to of [79, 80, 82, 85, 89]) {
      test(`${plantId} at ${to}: nothing reaches the simulator`, async () => {
        const result = await attempt(plantId, to);
        console.log(plantId, JSON.stringify(result));
        expect(result.writes).toEqual([]);
      }, 30_000);
    }
  }
});

// Pinned, not endorsed: CLAUDE.MD rules out auth, so these show exactly what a local caller can do. They pass today.
describe("known residual risks, no auth by project scope [real glue]", () => {
  test("HTTP /vote has no sender check, so a local caller can vote as any component", async () => {
    const r = await rig();
    const p = await propose(r);
    expect((await r.post("/vote", { vote: yes(p.id, LV) })).status).toBe(200);
  });

  test("the first /observed for a dispatched proposal wins, whoever sends it", async () => {
    const r = await rig();
    const p = await pastVeto(r);
    await callback(r, p.id);
    const forged = [{ componentId: LV, metric: "positionPct", before: 50, after: 40, ticksToSettle: 1 }];
    expect((await r.post("/observed", { proposalId: p.id, effects: forged })).status).toBe(200);
    const honest = [{ componentId: LV, metric: "positionPct", before: 50, after: 67, ticksToSettle: 3 }];
    await r.post("/observed", { proposalId: p.id, effects: honest });
    const event = (await r.w.plant("plant-a").getState()).history.find((e) => e.proposalId === p.id);
    expect(event?.effects[0].after).toBe(40);
  });
});

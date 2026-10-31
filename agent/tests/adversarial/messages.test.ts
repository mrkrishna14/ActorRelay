// Relay-level attacks on the real AgentRuntime, InboundBridge and fallback routing, with an in-memory Glue.
// The sender check in spawn.ts is read, not run here: it needs a live Relay.
import { describe, expect, test } from "bun:test";
import type { CalibrationEntry, HistoryEvent, LearnedRule, PlantState, Proposal, Vote } from "../../../shared/types";
import { castVote } from "../../vote";
import type { Glue } from "../../glue";
import { RoutedLlm, type Llm } from "../../llm";
import { RetrievalCache } from "../../retrieval";
import { AgentRuntime } from "../../runtime";
import { handlePublish, InboundBridge, relayName } from "../../system";
import { component, event, proposal, reply, SAFE_EVENTS, UNSAFE_EVENTS } from "./fixtures";

let seq = 0;
const uniq = (patch: Partial<Proposal> = {}, to = 65) => proposal(to, { id: `msg-${++seq}`, at: new Date().toISOString(), requiredVoters: ["plant-a/LV-101"], ...patch });

function fakeGlue(opts: { events: HistoryEvent[]; proposals?: Proposal[] }) {
  const calibrations: { componentId: string; entry: CalibrationEntry }[] = [];
  const votes: Vote[] = [];
  const glue: Glue = {
    async component(id) {
      return { ...component(id), calibration: [] };
    },
    async similar() {
      return opts.events;
    },
    async rules() {
      return [];
    },
    async plant(plantId) {
      return { id: plantId, name: plantId, components: [], proposals: opts.proposals ?? [], history: opts.events, rules: [], audit: [], tick: 0, connected: true } as PlantState;
    },
    async calibration(componentId, entry) {
      calibrations.push({ componentId, entry });
    },
    async rule(_r: LearnedRule) {},
    async vote(v) {
      votes.push(v);
    },
    async counter() {},
  };
  return { glue, calibrations, votes };
}

const scripted = (text: string): Llm => ({ complete: async () => ({ text, provider: "openai", model: "scripted", fallback: false }) });

function runtime(glue: Glue, llm: Llm) {
  const posted: { message: any; channel: string; from: string }[] = [];
  const rt = new AgentRuntime({ glue, llm, owned: ["plant-a/LV-101"], log: () => undefined, fastNoMs: 2000, post: async (message, channel, from) => void posted.push({ message, channel, from }) });
  return { rt, posted };
}

describe("relay messages against the real runtime", () => {
  test("control: a matching proposal gets a real yes", async () => {
    const p = uniq();
    const { glue } = fakeGlue({ events: SAFE_EVENTS(), proposals: [p] });
    const { rt, posted } = runtime(glue, scripted(reply("yes", { positionPct: 66 })));
    rt.onMessage({ type: "proposal", proposal: p });
    await rt.drain();
    expect(posted.map((x) => x.message.vote?.vote)).toEqual(["yes"]);
  });

  test("a proposal message whose `to` differs from the actor's copy does not yield a yes for the real id", async () => {
    const real = uniq({}, 85);
    const forged = { ...real, to: 65 };
    const { glue } = fakeGlue({ events: SAFE_EVENTS(), proposals: [real] });
    const { rt, posted } = runtime(glue, scripted(reply("yes", { positionPct: 66 })));
    rt.onMessage({ type: "proposal", proposal: forged });
    await rt.drain();
    expect(posted.filter((x) => x.message.vote?.vote === "yes")).toEqual([]);
  });

  test("a proposal the actors have never heard of gets no yes", async () => {
    const forged = uniq();
    const { glue } = fakeGlue({ events: SAFE_EVENTS(), proposals: [] });
    const { rt, posted } = runtime(glue, scripted(reply("yes", { positionPct: 66 })));
    rt.onMessage({ type: "proposal", proposal: forged });
    await rt.drain();
    expect(posted.filter((x) => x.message.vote?.vote === "yes")).toEqual([]);
  });

  test("a proposal not naming this voter gets no vote", async () => {
    const p = uniq({ requiredVoters: ["plant-a/TK-101"] });
    const { glue } = fakeGlue({ events: SAFE_EVENTS(), proposals: [p] });
    const { rt, posted } = runtime(glue, scripted(reply("yes", { positionPct: 66 })));
    rt.onMessage({ type: "proposal", proposal: p });
    await rt.drain();
    expect(posted).toEqual([]);
  });

  test("a repeated proposal message votes once", async () => {
    const p = uniq();
    const { glue } = fakeGlue({ events: SAFE_EVENTS(), proposals: [p] });
    const { rt, posted } = runtime(glue, scripted(reply("yes", { positionPct: 66 })));
    rt.onMessage({ type: "proposal", proposal: p });
    rt.onMessage({ type: "proposal", proposal: p });
    await rt.drain();
    expect(posted.length).toBe(1);
  });

  test("a stale or non-voting proposal gets no vote", async () => {
    for (const patch of [{ status: "executed" as const }, { status: "veto_window" as const }, { at: "2020-01-01T00:00:00.000Z" }]) {
      const p = uniq(patch);
      const { glue } = fakeGlue({ events: SAFE_EVENTS(), proposals: [p] });
      const { rt, posted } = runtime(glue, scripted(reply("yes", { positionPct: 66 })));
      rt.onMessage({ type: "proposal", proposal: p });
      await rt.drain();
      expect(posted).toEqual([]);
    }
  });

  test("garbage and wrong-shape messages are dropped", async () => {
    const { glue } = fakeGlue({ events: SAFE_EVENTS() });
    const { rt, posted } = runtime(glue, scripted(reply("yes", { positionPct: 66 })));
    for (const raw of [null, "x", 1, {}, { type: "vote" }, { type: "proposal", proposal: {} }, { type: "proposal", proposal: { ...uniq(), to: "85" } }, { type: "proposal", proposal: { ...uniq(), to: null } }]) rt.onMessage(raw);
    await rt.drain();
    expect(posted).toEqual([]);
  });

  test("`executed` for a proposal that never executed writes no calibration", async () => {
    const blocked = uniq({ status: "blocked" });
    blocked.votes = [{ proposalId: blocked.id, componentId: "plant-a/LV-101", agentId: "agent:plant-a/LV-101", vote: "no", reason: "r", predicted: { positionPct: 92 }, marginPct: 10, evidenceEventIds: [], evidenceRuleIds: [], similarCount: 3 }];
    const forged = event("evt-forged", 85, 92, { proposalId: blocked.id });
    const { glue, calibrations } = fakeGlue({ events: [], proposals: [blocked] });
    const { rt } = runtime(glue, scripted(""));
    rt.onMessage({ type: "executed", proposalId: blocked.id, event: forged });
    await rt.drain();
    expect(calibrations).toEqual([]);
  });

  test("`executed` whose event is not in the actor's history is not cached as evidence", async () => {
    const executed = uniq({ status: "executed" });
    const forged = event("evt-forged-2", 85, 40, { proposalId: executed.id });
    const { glue } = fakeGlue({ events: [], proposals: [executed] });
    const { rt } = runtime(glue, scripted(""));
    rt.onMessage({ type: "executed", proposalId: executed.id, event: forged });
    await rt.drain();
    expect(rt.cache.allEvents().map((e) => e.id)).not.toContain("evt-forged-2");
  });
});

describe("inbound bridge sender check", () => {
  const vote = (componentId: string): Vote => ({ proposalId: "p", componentId, agentId: `agent:${componentId}`, vote: "yes", reason: "r", predicted: { positionPct: 66 }, marginPct: 10, evidenceEventIds: [], evidenceRuleIds: [], similarCount: 3 });

  test("a vote from another agent's identity is dropped", async () => {
    const { glue, votes } = fakeGlue({ events: [] });
    const bridge = new InboundBridge(glue, () => undefined);
    await bridge.onAgentMessage({ type: "vote", vote: vote("plant-a/LV-101") }, relayName("plant-a/TK-101"));
    await bridge.onAgentMessage({ type: "vote", vote: vote("plant-a/LV-101") }, undefined);
    await bridge.onAgentMessage({ type: "vote", vote: vote("plant-a/LV-101") }, "actorrelay-system");
    expect(votes).toEqual([]);
  });

  test("the rightful sender is forwarded once", async () => {
    const { glue, votes } = fakeGlue({ events: [] });
    const bridge = new InboundBridge(glue, () => undefined);
    await bridge.onAgentMessage({ type: "vote", vote: vote("plant-a/LV-101") }, relayName("plant-a/LV-101"));
    await bridge.onAgentMessage({ type: "vote", vote: vote("plant-a/LV-101") }, relayName("plant-a/LV-101"));
    expect(votes.length).toBe(1);
  });

  test("a yes that follows a forwarded no cannot replace it", async () => {
    const { glue, votes } = fakeGlue({ events: [] });
    const bridge = new InboundBridge(glue, () => undefined);
    await bridge.onAgentMessage({ type: "vote", vote: { ...vote("plant-a/LV-101"), vote: "no" } }, relayName("plant-a/LV-101"));
    await bridge.onAgentMessage({ type: "vote", vote: vote("plant-a/LV-101") }, relayName("plant-a/LV-101"));
    expect(votes.map((v) => v.vote)).toEqual(["no"]);
  });
});

describe("/publish", () => {
  test("with RELAY_TOKEN set, a request without it is refused", async () => {
    const saved = process.env.RELAY_TOKEN;
    process.env.RELAY_TOKEN = "unit-test-token";
    let published = 0;
    const res = await handlePublish(new Request("http://x/publish", { method: "POST", body: JSON.stringify({ type: "rule", payload: {}, channels: ["company"] }) }), async () => void published++);
    if (saved === undefined) delete process.env.RELAY_TOKEN;
    else process.env.RELAY_TOKEN = saved;
    expect(res.status).toBe(401);
    expect(published).toBe(0);
  });

  test("an unknown channel or type is refused", async () => {
    let published = 0;
    for (const body of [{ type: "vote", payload: {}, channels: ["plant-a"] }, { type: "proposal", payload: {}, channels: ["evil"] }, { type: "proposal", payload: {}, channels: [] }]) {
      const res = await handlePublish(new Request("http://x/publish", { method: "POST", body: JSON.stringify(body) }), async () => void published++);
      expect(res.status).toBe(400);
    }
    expect(published).toBe(0);
  });
});

describe("Claude fallback", () => {
  const voteWith = async (llm: Llm, to = 65, events = SAFE_EVENTS()) => {
    const { glue } = fakeGlue({ events });
    return castVote({ glue, llm, cache: new RetrievalCache(), fastNoMs: 2000, log: () => undefined }, proposal(to, { id: `fb-${++seq}` }), "plant-a/TK-101");
  };
  const down = (async () => {
    throw new Error("OAuth session expired");
  }) as never;
  const openai = (text: string) => (async () => ({ text, provider: "openai", model: "scripted", fallback: false })) as never;

  test("fallback yes is labelled and still enforced", async () => {
    const v = await voteWith(new RoutedLlm(down, openai(reply("yes", { levelPct: 52, tempC: 73 })), () => undefined));
    expect(v.vote).toBe("yes");
    expect(v.reason).toContain("[GPT fallback");
  });

  test("fallback lowball on a proven-unsafe change is still a no", async () => {
    expect((await voteWith(new RoutedLlm(down, openai(reply("yes", { levelPct: 40, tempC: 75 })), () => undefined), 85, UNSAFE_EVENTS())).vote).toBe("no");
  });

  test("both vendors down is a no", async () => {
    expect((await voteWith(new RoutedLlm(down, down, () => undefined))).vote).toBe("no");
  });

  test("fallback garbage is a no", async () => {
    expect((await voteWith(new RoutedLlm(down, openai("garbage"), () => undefined))).vote).toBe("no");
  });
});

// Every Relay message in the CLAUDE.MD protocol, through the real codec and the real runtime.
// LLM replies are scripted and Relay itself is not involved: messages go straight to AgentRuntime.onMessage.
// The actors run on lib/fake-terse.ts (FAKE: shapes and behaviour only), so a vote really reaches Plant.vote's checks.
import { afterAll, beforeAll, describe, expect, mock, setSystemTime, test } from "bun:test";
import type { CalibrationEntry, ComponentId, HistoryEvent, LearnedRule, PlantId, Proposal } from "../../../shared/types";
import type { ComponentView, Glue, SimilarQuery } from "../../../agent/glue";
import { GlueError } from "../../../agent/glue";
import type { LlmRequest } from "../../../agent/llm";
import { AgentRuntime, channelForVote } from "../../../agent/runtime";
import { wireMessageSchema, type WireMessage } from "../../../agent/schemas";
import { castVote } from "../../../agent/vote";
import { agentName, CHANNELS, decodeEnvelope, encodeEnvelope, toWireMessage } from "../../../agent/wire";
import { relayChannels, relayProtocol } from "./lib/docs";
import * as ex from "./lib/examples";
import { fakeModule, resetFakeTerse } from "./lib/fake-terse";
import { historyFixture } from "./lib/history-fixture";
import { routeSchemas as glueSchemas } from "./lib/glue-spec";

mock.module("terse-sdk/actor", () => fakeModule);
const { Company, Component, Plant } = await import("../../src/actor");
const { COMPANY_ACTOR_ID, componentActorId } = await import("../../src/ids");

const seed = ex.seed;
const plant = (id: PlantId = "plant-a") => (Plant as any).get(id);
const company = () => (Company as any).get(COMPANY_ACTOR_ID);
const component = (id: string) => (Component as any).get(componentActorId(id));
const ALL_IDS = seed.plants.flatMap((p) => p.components.map((c) => c.id));

const canonical: Record<string, WireMessage> = {
  proposal: { type: "proposal", proposal: { ...ex.proposal, votes: [] } },
  vote: { type: "vote", vote: ex.vote },
  counter: { type: "counter", parentProposalId: "plant-a-prop-1", proposal: { ...ex.routeBodies["/counter"].proposal } },
  executed: { type: "executed", proposalId: "plant-a-prop-2", event: ex.event },
  rule: { type: "rule", rule: ex.rule },
};

describe("protocol section of CLAUDE.MD", () => {
  const lines = relayProtocol();
  test("names exactly the five messages", () => {
    expect(lines.map((l) => l.type)).toEqual(["proposal", "vote", "counter", "executed", "rule"]);
  });
  test("names exactly the three channels, which is what system.ts joins", () => {
    expect([...new Set(relayChannels())].sort()).toEqual([...CHANNELS].sort());
  });
  for (const line of relayProtocol()) {
    test(`${line.type}: wire fields are the documented fields`, () => {
      const message = canonical[line.type]!;
      expect(Object.keys(message).filter((k) => k !== "type").sort()).toEqual([...line.fields].sort());
    });
    test(`${line.type}: parses and survives the JSON text Relay carries`, () => {
      const message = canonical[line.type]!;
      expect(wireMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message as any);
    });
  }
  test("an unknown type is rejected", () => {
    expect(wireMessageSchema.safeParse({ type: "ballot", vote: ex.vote }).success).toBe(false);
  });
  test("a wire counter body is exactly what glue's /counter takes", () => {
    const { parentProposalId, proposal } = canonical.counter as Extract<WireMessage, { type: "counter" }>;
    expect(glueSchemas["/counter"]!.safeParse({ parentProposalId, proposal }).success).toBe(true);
  });
  test("a wire vote body is exactly what glue's /vote takes", () => {
    expect(glueSchemas["/vote"]!.safeParse({ vote: ex.vote }).success).toBe(true);
  });
});

describe("glue's publish boundary", () => {
  // Payload shapes glue can produce: adapter response wrapped, bare, or carrying glue's own mode field.
  const cases: [string, "proposal" | "executed" | "rule", unknown][] = [
    ["proposal wrapped", "proposal", { proposal: ex.proposal, mode: "live" }],
    ["proposal bare", "proposal", ex.proposal],
    ["executed as CLAUDE.MD spells it", "executed", { proposalId: "plant-a-prop-2", event: ex.event }],
    ["executed bare event", "executed", ex.event],
    ["rule wrapped", "rule", { rule: ex.rule, mode: "live" }],
    ["rule bare", "rule", ex.rule],
  ];
  for (const [name, type, payload] of cases) {
    test(name, () => expect(toWireMessage(type, payload).type).toBe(type));
  }
});

// The envelope in agent/wire.ts, {type, payload}. Our own glue has to speak exactly this.
describe("envelope both ways", () => {
  for (const [type, payload] of [
    ["proposal", { proposal: { ...ex.proposal, votes: [] } }],
    ["executed", { proposalId: "plant-a-prop-2", event: ex.event }],
    ["rule", { rule: ex.rule }],
  ] as const) {
    test(`an agent reads a ${type} sent as {type, payload}`, () => {
      expect(decodeEnvelope(JSON.stringify({ type, payload }))?.type).toBe(type);
    });
  }
  test("an agent ignores anything that is not an instruction for it", () => {
    expect(decodeEnvelope("not json")).toBeNull();
    expect(decodeEnvelope(JSON.stringify({ type: "vote", payload: { vote: ex.vote } }))).toBeNull();
  });
  test("the payload of an agent's vote is exactly the body of POST /vote", () => {
    const { type, payload } = JSON.parse(encodeEnvelope({ type: "vote", vote: ex.vote }));
    expect(type).toBe("vote");
    expect(glueSchemas["/vote"]!.safeParse(payload).success).toBe(true);
  });
  test("the payload of an agent's counter is exactly the body of POST /counter", () => {
    const { type, payload } = JSON.parse(encodeEnvelope(canonical.counter!));
    expect(type).toBe("counter");
    expect(glueSchemas["/counter"]!.safeParse(payload).success).toBe(true);
  });
});

describe("sender and channel rules", () => {
  test("a local vote goes on the plant channel, a cross-plant vote on company", () => {
    expect(channelForVote(ex.proposal, "plant-a/LV-101")).toBe("plant-a");
    expect(channelForVote(ex.proposal, "plant-b/TV-101")).toBe("company");
  });
  test("every component's Relay name is the agent id glue checks senders against", () => {
    const names = ALL_IDS.map(agentName);
    expect(new Set(names).size).toBe(10);
    for (const id of ALL_IDS) expect(agentName(id)).toBe(`agent:${id}`);
  });
});

// A scripted model that follows the physics summary: real agent code decides everything after this reply.
function scripted(request: LlmRequest) {
  const proposal = JSON.parse(request.user.match(/^Proposal: (.*)$/m)![1]!);
  const own = request.user.match(/You are (plant-[ab]\/[\w-]+)/)![1]!;
  const tag = own.split("/")[1]!;
  const to: number = proposal.to;
  const predicted: Record<string, number> = {
    "P-100": { speedPct: to },
    "TK-101": { levelPct: 51, tempC: 74 },
    "LV-101": { positionPct: to + 4 },
    "E-101": { dutyKw: 17.43 * to + 27 },
    "TV-101": { positionPct: 0.36 * to + 32.5, steamKgH: 29.7 * to + 48, headerBarg: 5.7 },
  }[tag] as Record<string, number>;
  const vote = tag === "LV-101" && to >= 81 ? "no" : "yes";
  return { text: JSON.stringify({ vote, reason: "Scripted reply.", predicted, evidenceEventIds: [], evidenceRuleIds: [] }), provider: "openai" as const, model: "scripted", fallback: false };
}
const llm = { complete: async (r: LlmRequest) => scripted(r) };

// The Glue interface over the actor classes, with the status mapping the adapter uses for actor errors.
const refused = (path: string) => (error: Error) => {
  throw new GlueError(/^(invalid|duplicate|stale|not_)/.test(error.message) ? 400 : 503, path, error.message);
};
const actorGlue: Glue = {
  component: (id: ComponentId) => component(id).getState() as Promise<ComponentView>,
  similar: ({ componentId, metric, to, upstreamSnapshot, k }: SimilarQuery): Promise<HistoryEvent[]> => plant(componentId.split("/")[0] as PlantId).similar(componentId, metric, to, upstreamSnapshot ?? {}, k),
  rules: (componentId: ComponentId, model: string): Promise<LearnedRule[]> => plant(componentId.split("/")[0] as PlantId).rulesFor(componentId, model),
  plant: (id: PlantId) => plant(id).getState(),
  calibration: async (id: ComponentId, entry: CalibrationEntry) => void (await component(id).addCalibration(entry)),
  rule: async (rule: LearnedRule) => void (await plant().promoteRule(rule)),
  vote: async (vote) => void (await plant(vote.proposalId.startsWith("plant-b") ? "plant-b" : "plant-a").vote(vote).catch(refused("/vote"))),
  counter: async () => undefined,
};

async function seedAll() {
  for (const p of seed.plants) for (const c of p.components) await component(c.id).loadSeed(c);
  await company().loadSeed(seed.company);
  for (const p of seed.plants) await plant(p.id).loadSeed(p, historyFixture);
}

const VOTERS = ["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101", "plant-b/TV-101"];
let clock = Date.parse("2026-10-31T20:00:00.000Z");
const advance = (ms: number) => setSystemTime(new Date((clock += ms)));
// A cross-plant proposal needs Company's lease on the shared resource: one sweep asks, the next opens the veto window.
const sweep = async (id: PlantId = "plant-a") => {
  for (let i = 0; i < 2; i++) {
    await plant(id).tick();
    await plant(id).tick();
    await Bun.sleep(5);
  }
};
const propose = (to: number): Promise<Proposal> => plant().propose({ plantId: "plant-a", proposerComponentId: "plant-a/P-100", metric: "speedPct", to, rationale: "Contract run." });

// Carries a proposal to executed through the real flow, and returns the recorded event.
async function executeThrough(runtime: AgentRuntime, posted: WireMessage[], to: number): Promise<HistoryEvent> {
  const proposal = await propose(to);
  runtime.onMessage({ type: "proposal", proposal });
  // Not drain(): the proposer's watcher only settles once the sweep below has run.
  while (posted.filter((m) => m.type === "vote").length < VOTERS.length) await Bun.sleep(2);
  for (const m of posted.splice(0)) if (m.type === "vote") await actorGlue.vote(m.vote);
  await sweep();
  advance(10_000);
  await sweep();
  const claim = await plant().claimDispatch(proposal.id);
  await component("plant-a/P-100").setMetric("speedPct", to, proposal.id, claim.token);
  const event: HistoryEvent = await plant().recordEvent({
    proposalId: proposal.id,
    effects: [
      { componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: to + 2, ticksToSettle: 3 },
      { componentId: "plant-b/TV-101", metric: "headerBarg", before: 6, after: 5.9, ticksToSettle: 3 },
    ],
  });
  await sweep("plant-b");
  await sweep();
  runtime.onMessage({ type: "executed", proposalId: proposal.id, event });
  await runtime.drain();
  return event;
}

describe("real AgentRuntime against the real actor classes, over wire messages", () => {
  const posted: WireMessage[] = [];
  const channels: [string, ComponentId][] = [];
  let runtime: AgentRuntime;

  beforeAll(async () => {
    setSystemTime(new Date(clock));
    process.env.GLUE_URL = "http://127.0.0.1:9";
    resetFakeTerse();
    await seedAll();
    runtime = new AgentRuntime({
      glue: actorGlue,
      llm,
      owned: ALL_IDS,
      fastNoMs: 5000,
      log: () => undefined,
      pollMs: 5,
      post: async (message, channel, from) => {
        posted.push(wireMessageSchema.parse(JSON.parse(JSON.stringify(message))));
        channels.push([channel, from]);
      },
    });
    await sweep("plant-b");
    await sweep();
  });
  afterAll(() => {
    setSystemTime();
    delete process.env.GLUE_URL;
  });

  test("first 85 %: every required voter posts one strict vote, on the right channel, and the plant accepts them all", async () => {
    const proposal = await propose(85);
    runtime.onMessage({ type: "proposal", proposal });
    while (posted.filter((m) => m.type === "vote").length < VOTERS.length) await Bun.sleep(2);
    const votes = posted.filter((m) => m.type === "vote").map((m) => (m as Extract<WireMessage, { type: "vote" }>).vote);
    expect(votes.map((v) => v.componentId).sort()).toEqual([...VOTERS].sort());
    for (const [channel, from] of channels) expect(channel).toBe(from === "plant-b/TV-101" ? "company" : "plant-a");
    for (const vote of votes) {
      expect(glueSchemas["/vote"]!.safeParse({ vote }).success).toBe(true);
      await actorGlue.vote(vote);
    }
    const valve = votes.find((v) => v.componentId === "plant-a/LV-101")!;
    expect(valve.vote).toBe("no");
    expect(valve.predicted.positionPct).toBeGreaterThanOrEqual(81);
    expect(valve.evidenceEventIds.length).toBeGreaterThanOrEqual(3);
    posted.length = 0;
    channels.length = 0;
    await sweep();
    expect((await plant().getState()).proposals.find((p: Proposal) => p.id === proposal.id).status).toBe("blocked");
    await runtime.drain();
    const counter = posted.find((m) => m.type === "counter") as Extract<WireMessage, { type: "counter" }>;
    expect(counter).toBeDefined();
    expect(counter.proposal.to).toBeLessThan(85);
    expect(glueSchemas["/counter"]!.safeParse({ parentProposalId: counter.parentProposalId, proposal: counter.proposal }).success).toBe(true);
    posted.length = 0;
  });

  test("a safe run calibrates every voter, and each calibration passes glue's validator", async () => {
    const event = await executeThrough(runtime, posted, 65);
    for (const voter of VOTERS) {
      const entries = ((await component(voter).getState()).calibration as CalibrationEntry[]).filter((c) => c.proposalId === event.proposalId);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) expect(glueSchemas["/calibration"]!.safeParse({ componentId: voter, entry }).success).toBe(true);
    }
  });

  test("repeat 85 %: blocked citing the newest execution first, and the plant accepts the citation", async () => {
    const newest = (await plant().getState()).history.at(-1) as HistoryEvent;
    const proposal = await propose(85).catch(() => null);
    expect(proposal).not.toBeNull();
    const vote = await castVote({ glue: actorGlue, llm, cache: runtime.cache, fastNoMs: 5000 }, proposal!, "plant-a/LV-101");
    expect(vote.vote).toBe("no");
    expect(vote.evidenceEventIds[0]).toBe(newest.id);
    await actorGlue.vote(vote);
  });

  test("plant-b's valve refuses 85 % on the company rule it never saw happen", async () => {
    const proposal: Proposal = await plant("plant-b").propose({ plantId: "plant-b", proposerComponentId: "plant-b/P-100", metric: "speedPct", to: 85, rationale: "Contract run." });
    const vote = await castVote({ glue: actorGlue, llm, cache: runtime.cache, fastNoMs: 5000 }, proposal, "plant-b/LV-101");
    expect(vote.vote).toBe("no");
    const companyRules = (await company().getState()).rules.map((r: LearnedRule) => r.id);
    expect(vote.evidenceRuleIds.some((id) => companyRules.includes(id))).toBe(true);
    await plant("plant-b").vote(vote);
  });

  test("after a reset, votes must not cite events or rules that no longer exist", async () => {
    // TASK3 runs the demo three times on one agent process, with POST /reset between runs.
    await seedAll();
    await sweep("plant-b");
    await sweep();
    const proposal = await propose(85);
    const vote = await castVote({ glue: actorGlue, llm, cache: runtime.cache, fastNoMs: 5000 }, proposal, "plant-a/LV-101");
    const history = new Set((await plant().getState()).history.map((e: HistoryEvent) => e.id));
    expect(vote.evidenceEventIds.filter((id) => !history.has(id))).toEqual([]);
    await actorGlue.vote(vote);
  });

  test("after a reset, a rule left in the agent cache is not cited", async () => {
    const stale: LearnedRule = { ...ex.rule, id: "rule-from-before-the-reset", scope: "plant", condition: { ...ex.rule.condition, value: 60 } };
    runtime.cache.addRule(stale);
    const proposal = await plant().propose({ plantId: "plant-a", proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 80, rationale: "Contract run." });
    const vote = await castVote({ glue: actorGlue, llm, cache: runtime.cache, fastNoMs: 5000 }, proposal, "plant-a/LV-101");
    expect(vote.evidenceRuleIds).not.toContain(stale.id);
    await actorGlue.vote(vote);
  });
});

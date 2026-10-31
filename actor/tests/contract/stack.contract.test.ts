// The whole path in one process: real AgentRuntime, real HttpGlue, real Glue routes and real actor classes, joined by the
// real wire encoding. FAKE, and labelled: the Terse base (lib/fake-terse.ts), the simulator (SimStub below), Relay (a direct
// hand-off) and the LLM (scripted). Nothing here proves durability, timing under load or a real network; glue/e2e.ts does.
import { afterAll, beforeAll, describe, expect, mock, setSystemTime, test } from "bun:test";
import type { CalibrationEntry, ComponentId, HistoryEvent, LearnedRule, PlantId, PlantState, Proposal, Vote } from "../../../shared/types";
import { GlueError, HttpGlue } from "../../../agent/glue";
import type { LlmRequest } from "../../../agent/llm";
import { AgentRuntime } from "../../../agent/runtime";
import type { WireMessage } from "../../../agent/schemas";
import { agentName, decodeEnvelope, encodeEnvelope, SYSTEM_NAME } from "../../../agent/wire";
import type { ActorPort } from "../../../glue/actors";
import type { BridgePort, SetpointBody, Snapshot } from "../../../glue/bridge";
import type { RelayPort } from "../../../glue/relay";
import { REPO_ROOT } from "./lib/docs";
import { ALL_COMPONENT_IDS, seed } from "./lib/examples";
import { fakeModule, resetFakeTerse } from "./lib/fake-terse";
import { nearMisses } from "./lib/near-misses";
import { CompanyStateS, EmittedComponentS, HistoryEventS, PlantStateS, ProposalS } from "./lib/schemas";

mock.module("terse-sdk/actor", () => fakeModule);
const { Company, Component, Plant } = await import("../../src/actor");
const { Glue } = await import("../../../glue/app");
const { HttpError, actorIdFor, refusalStatus } = await import("../../../glue/actors");

const VOTERS = ["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101", "plant-b/TV-101"];
const PLANTS: PlantId[] = ["plant-a", "plant-b"];

let clock = Date.parse("2026-10-31T21:00:00.000Z");
const advance = (ms: number) => setSystemTime(new Date((clock += ms)));

const classes = { Component, Plant, Company } as Record<string, any>;
const plant = (id: PlantId = "plant-a") => classes.Plant.get(id);

// The same id mapping and refusal sorting as TerseActors, over the in-process classes.
const actors: ActorPort = {
  async call(kind, id, method, args = []) {
    try {
      return await classes[kind].get(actorIdFor(kind, id))[method](...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(refusalStatus(message), `${kind}(${id}).${method}: ${message}`);
    }
  },
};

class SimStub implements BridgePort {
  setpoints: SetpointBody[] = [];
  resets = 0;
  private speed: Record<string, number> = { "plant-a": 50, "plant-b": 50 };

  metrics(plantId: PlantId): Snapshot {
    const s = this.speed[plantId]!;
    return {
      [`${plantId}/P-100`]: { speedPct: s, feedM3h: 0.3 * s },
      [`${plantId}/TK-101`]: { levelPct: 50, tempC: 75 },
      [`${plantId}/LV-101`]: { positionPct: s + 2 },
      [`${plantId}/E-101`]: { dutyKw: 17.43 * s + 27 },
      [`${plantId}/TV-101`]: { positionPct: 0.36 * s + 32.5, steamKgH: 29.7 * s + 48, headerBarg: 6 },
    };
  }
  async snapshot(plantId: PlantId) {
    return this.metrics(plantId);
  }
  async setpoint(body: SetpointBody) {
    this.setpoints.push(body);
    this.speed[body.componentId.split("/")[0]!] = body.value;
    return { applied: body.value };
  }
  async reset() {
    this.resets += 1;
    this.speed = { "plant-a": 50, "plant-b": 50 };
  }
}

const logs: string[] = [];
const log = (line: string) => void logs.push(line);
const sim = new SimStub();
const published: { type: string; channels: string[]; text: string }[] = [];
let runtime: AgentRuntime;

// Exactly what glue/relay.ts writes and what agent/spawn.ts does with it, once per channel, without a Relay server.
const relay: RelayPort = {
  async publish(type, payload, channels) {
    const text = JSON.stringify({ type, payload });
    published.push({ type, channels: [...channels], text });
    for (const _ of channels) {
      const message = decodeEnvelope(text);
      if (message) runtime.onMessage(message);
    }
    return true;
  },
  status: () => ({ connected: true, error: null, published: [] }),
};

const glue = new Glue({ actors, bridge: sim, relay, config: { repoRoot: REPO_ROOT, wakeMs: 60_000, allowedOrigins: [] }, log });
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 60, fetch: glue.handle });
const url = `http://127.0.0.1:${server.port}`;
const client = new HttpGlue(url);

// A scripted model following the physics summary. Real agent code decides everything after this reply.
function scripted(request: LlmRequest) {
  const reply = (text: string) => ({ text, provider: "openai" as const, model: "scripted", fallback: false });
  const line = request.user.match(/^Proposal: (.*)$/m);
  if (!line) return reply(JSON.stringify({ value: 65, rationale: "Scripted counter." }));
  const to: number = JSON.parse(line[1]!).to;
  const tag = request.user.match(/You are plant-[ab]\/([\w-]+)/)![1]!;
  const predicted = {
    "TK-101": { levelPct: 51, tempC: 74 },
    "LV-101": { positionPct: to + 4 },
    "E-101": { dutyKw: 17.43 * to + 27 },
    "TV-101": { positionPct: 0.36 * to + 32.5, steamKgH: 29.7 * to + 48, headerBarg: 5.7 },
  }[tag];
  const vote = tag === "LV-101" && to >= 81 ? "no" : "yes";
  return reply(JSON.stringify({ vote, reason: "Scripted reply.", predicted, evidenceEventIds: [], evidenceRuleIds: [] }));
}

const post = (path: string, body: unknown) => fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const state = async (id: PlantId) => (await (await fetch(`${url}/state?plantId=${id}&full=1`)).json()) as { plant: PlantState; components: unknown[]; company: any; mode: string };
const pump = (plantId: PlantId, to: number) => ({ plantId, proposerComponentId: `${plantId}/P-100`, metric: "speedPct", to, rationale: "Contract run." });
const findProposal = async (id: string) => (await state(id.startsWith("plant-b") ? "plant-b" : "plant-a")).plant.proposals.find((p) => p.id === id);

// One second of the running system: both Plants tick, leases and callbacks land, glue's wake loop refreshes.
async function step() {
  advance(1100);
  for (const id of PLANTS) {
    await plant(id).tick();
    await plant(id).tick();
  }
  await Bun.sleep(15);
  await glue.wake();
}

async function until<T>(read: () => Promise<T | null | undefined | false>, label: string, steps = 30): Promise<T> {
  for (let i = 0; i < steps; i++) {
    const value = await read();
    if (value) return value;
    await step();
  }
  throw new Error(`never happened: ${label}\n${logs.slice(-12).join("\n")}`);
}

const status = (id: string, wanted: Proposal["status"]) => async () => {
  const proposal = await findProposal(id);
  return proposal?.status === wanted ? proposal : null;
};

const proposeThrough = async (body: ReturnType<typeof pump>) => {
  const response = await post("/propose", body);
  expect(response.status).toBe(200);
  return (await response.json()) as { proposal: Proposal; published: string[] };
};

function effects(plantId: PlantId, to: number) {
  const row = (tag: string, metric: string, before: number, after: number) => ({ componentId: `${plantId}/${tag}`, metric, before, after, ticksToSettle: 3 });
  return [
    row("LV-101", "positionPct", 50, to + 2),
    row("TK-101", "tempC", 75, 74.2),
    row("TK-101", "levelPct", 50, 50.4),
    row("E-101", "dutyKw", 898.5, 17.43 * to + 27),
    row("TV-101", "positionPct", 50.5, 0.36 * to + 32.5),
    row("TV-101", "steamKgH", 1533, 29.7 * to + 48),
    row("TV-101", "headerBarg", 6, 5.9),
  ];
}

const calibrations = async (id: ComponentId) => ((await client.component(id)).calibration ?? []) as CalibrationEntry[];

beforeAll(async () => {
  setSystemTime(new Date(clock));
  process.env.GLUE_URL = url;
  resetFakeTerse();
  runtime = new AgentRuntime({
    glue: client,
    llm: { complete: async (request) => scripted(request) },
    owned: ALL_COMPONENT_IDS,
    log,
    fastNoMs: 2000,
    pollMs: 5,
    post: async (message: WireMessage, channel, from) => {
      await glue.onRelayMessage({ text: encodeEnvelope(message), sender: agentName(from), channel });
    },
  });
});

afterAll(() => {
  setSystemTime();
  server.stop(true);
  delete process.env.GLUE_URL;
});

describe("glue's request checks, over its real routes", () => {
  for (const [path, what, body] of nearMisses) {
    test(`POST ${path} refuses ${what}`, async () => {
      expect((await post(path, body)).status).toBe(400);
    });
  }
  test("an unknown route is 404", async () => {
    expect((await post("/propse", {})).status).toBe(404);
  });
  test("a body that is not JSON is 400", async () => {
    expect((await fetch(`${url}/vote`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status).toBe(400);
  });
  test("agents share one system name with glue", () => {
    expect(SYSTEM_NAME).toBe("actorrelay-system");
  });
});

describe("TASK3's five steps, through every real boundary", () => {
  let bad: Proposal;
  let safe: Proposal;
  let eventId: string;

  test("1. reset seeds all twelve actors and every state is strictly the contract", async () => {
    const response = await post("/reset", {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; seed: { events: number } };
    expect(body.ok).toBe(true);
    expect(body.seed.events).toBeGreaterThan(0);
    expect(sim.resets).toBe(1);
    await glue.wake();
    for (const id of PLANTS) {
      const view = await state(id);
      expect(PlantStateS.safeParse(view.plant).success).toBe(true);
      expect(CompanyStateS.safeParse(view.company).success).toBe(true);
      expect(view.components.length).toBe(10);
      for (const c of view.components) expect(EmittedComponentS.safeParse(c).success).toBe(true);
      expect(view.plant.proposals).toEqual([]);
    }
    expect((await state("plant-a")).mode).toBe("live");
  });

  test("the compact /state the agents read still parses and keeps the live runs", async () => {
    const compact = (await (await fetch(`${url}/state?plantId=plant-a`)).json()) as { plant: PlantState };
    expect(PlantStateS.safeParse(compact.plant).success).toBe(true);
    await expect(client.plant("plant-a")).resolves.toBeDefined();
  });

  test("2. 85 % goes to the plant and company channels, and is blocked with evidence", async () => {
    const { proposal, published: channels } = await proposeThrough(pump("plant-a", 85));
    expect(ProposalS.safeParse(proposal).success).toBe(true);
    expect(channels).toEqual(["plant-a", "company"]);
    expect(proposal.requiredVoters).toEqual(VOTERS);
    expect(proposal.crossPlant).toBe(true);
    bad = await until(status(proposal.id, "blocked"), "85 blocked");
    const valve = bad.votes.find((v) => v.componentId === "plant-a/LV-101")!;
    expect(valve.vote).toBe("no");
    expect(valve.predicted.positionPct).toBeGreaterThanOrEqual(81);
    expect(valve.evidenceEventIds.length).toBeGreaterThanOrEqual(3);
    const history = new Set((await state("plant-a")).plant.history.map((e) => e.id));
    for (const id of valve.evidenceEventIds) expect(history.has(id)).toBe(true);
  });

  test("the cross-plant voter's vote reached plant-a's proposal", async () => {
    await until(async () => (await findProposal(bad.id))?.votes.some((v) => v.componentId === "plant-b/TV-101"), "plant-b vote");
  });

  test("3. a counter arrives inside 60 to 70, is unanimous, and opens the veto window", async () => {
    const countered = await until(async () => (await state("plant-a")).plant.proposals.find((p) => p.parentProposalId === bad.id), "counter posted");
    expect(countered.to).toBeGreaterThanOrEqual(60);
    expect(countered.to).toBeLessThanOrEqual(70);
    safe = await until(status(countered.id, "veto_window"), "counter in veto window");
    expect(safe.requiredVoters.every((id) => safe.votes.some((v) => v.componentId === id && v.vote === "yes"))).toBe(true);
    expect(Date.parse(safe.vetoDeadline!)).toBeGreaterThan(clock);
    expect(sim.setpoints).toEqual([]);
  });

  test("after the veto window the Plant's callback writes the simulator exactly once", async () => {
    advance(10_000);
    await until(() => Promise.resolve(sim.setpoints.length > 0), "setpoint written");
    expect(sim.setpoints).toEqual([{ componentId: "plant-a/P-100", metric: "speedPct", value: safe.to, proposalId: safe.id }]);
    const proposal = await until(status(safe.id, "executed"), "executed");
    expect(proposal.status).toBe("executed");
    await until(async () => (await client.component("plant-a/P-100")).metrics.speedPct === safe.to, "P-100 at the new speed");
  });

  test("a repeated callback does not write twice", async () => {
    const response = await post("/execute-callback", { proposalId: safe.id });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { dispatched: boolean }).dispatched).toBe(false);
    expect(sim.setpoints.length).toBe(1);
  });

  test("observed effects become a strict event, go out as executed, and every voter calibrates", async () => {
    const before = published.length;
    const response = await post("/observed", { proposalId: safe.id, effects: effects("plant-a", safe.to) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; eventId: string };
    eventId = body.eventId;
    const executed = published.slice(before).find((p) => p.type === "executed")!;
    expect(executed.channels).toEqual(["plant-a", "company"]);
    const event = (await state("plant-a")).plant.history.find((e) => e.id === eventId) as HistoryEvent;
    expect(HistoryEventS.safeParse(event).success).toBe(true);
    expect(event.proposalId).toBe(safe.id);
    for (const voter of VOTERS) {
      const mine = await until(async () => {
        const entries = (await calibrations(voter)).filter((c) => c.proposalId === safe.id);
        return entries.length ? entries : null;
      }, `calibration for ${voter}`);
      expect(mine.length).toBeGreaterThan(0);
    }
    await until(async () => (await state("plant-a")).plant.audit.some((a) => a.refId === safe.id && a.kind === "calibration"), "calibration audit");
  });

  test("4. repeat 85 % is blocked with the newest run as evidence #1", async () => {
    const { proposal } = await proposeThrough(pump("plant-a", 85));
    const blocked = await until(status(proposal.id, "blocked"), "repeat blocked");
    const valve = blocked.votes.find((v) => v.componentId === "plant-a/LV-101") as Vote;
    expect(valve.vote).toBe("no");
    expect(valve.evidenceEventIds[0]).toBe(eventId);
    expect(valve.evidenceEventIds.length).toBeGreaterThanOrEqual(3);
  });

  test("5. plant-b refuses 85 % on the rule learned in plant-a", async () => {
    const { proposal } = await proposeThrough(pump("plant-b", 85));
    const blocked = await until(status(proposal.id, "blocked"), "plant-b blocked");
    const valve = blocked.votes.find((v) => v.componentId === "plant-b/LV-101") as Vote;
    expect(valve.vote).toBe("no");
    const rules: LearnedRule[] = (await state("plant-b")).company.rules;
    const company = new Set(rules.map((r) => r.id));
    expect(valve.evidenceRuleIds.some((id) => company.has(id))).toBe(true);
  });

  test("no boundary silently refused anything along the way", () => {
    expect(logs.filter((line) => line.includes("voted")).length).toBeGreaterThanOrEqual(15);
    expect(logs.filter((line) => /refused|dropped|invalid|failed/i.test(line))).toEqual([]);
  });
});

describe("the operator's other paths", () => {
  test("a reset clears the run, and the next block cites nothing that is gone", async () => {
    expect((await post("/reset", {})).status).toBe(200);
    await glue.wake();
    const view = await state("plant-a");
    expect(view.plant.proposals).toEqual([]);
    expect(view.plant.history.every((e) => e.proposalId === null)).toBe(true);
    const { proposal } = await proposeThrough(pump("plant-a", 85));
    const blocked = await until(status(proposal.id, "blocked"), "blocked after reset");
    const history = new Set((await state("plant-a")).plant.history.map((e) => e.id));
    for (const vote of blocked.votes) for (const id of vote.evidenceEventIds) expect(history.has(id)).toBe(true);
  });

  test("a veto inside the window stops the write", async () => {
    const written = sim.setpoints.length;
    const counter = await until(async () => (await state("plant-a")).plant.proposals.find((p) => p.parentProposalId !== null), "counter after reset");
    const open = await until(status(counter.id, "veto_window"), "veto window after reset");
    const response = await post("/veto", { proposalId: open.id, by: "operator" });
    expect(response.status).toBe(200);
    advance(11_000);
    await step();
    await step();
    expect((await findProposal(open.id))!.status).toBe("vetoed");
    expect(sim.setpoints.length).toBe(written);
  });

  test("an agent's direct HTTP vote is refused as a duplicate, not applied twice", async () => {
    const blocked = (await state("plant-a")).plant.proposals.find((p) => p.status === "blocked")!;
    const error = await client.vote(blocked.votes[0]!).catch((e) => e);
    expect(error).toBeInstanceOf(GlueError);
    expect((error as GlueError).status).toBe(409);
  });
});

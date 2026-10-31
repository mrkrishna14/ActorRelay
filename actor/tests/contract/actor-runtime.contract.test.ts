// Every actor method's input and output, and every state an actor exposes, on the real classes.
// FAKE: these run on lib/fake-terse.ts, not on the Terse runtime. Shapes and contract behaviour only.
// The Plant's glue callbacks are checked against lib/glue-spec.ts through a local server.
import { afterAll, beforeAll, describe, expect, mock, setSystemTime, test } from "bun:test";
import type { z } from "zod";
import type { ComponentState, HistoryEvent, LearnedRule, PlantId, Proposal, Vote } from "../../../shared/types";
import { broadcasts, fakeModule, resetFakeTerse } from "./lib/fake-terse";
import { routeSchemas as glueSchemas } from "./lib/glue-spec";
import { historyFixture } from "./lib/history-fixture";
import { seed } from "./lib/examples";
import {
  CalibrationEntryS,
  CompanyStateS,
  EmittedComponentS,
  HistoryEventS,
  LearnedRuleS,
  PlantStateS,
  ProposalS,
} from "./lib/schemas";

mock.module("terse-sdk/actor", () => fakeModule);
const { Company, Component, Plant } = await import("../../src/actor");
const { COMPANY_ACTOR_ID, componentActorId, plantOfProposal } = await import("../../src/ids");

const VOTERS = ["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101", "plant-b/TV-101"];
const T0 = Date.parse("2026-10-31T19:00:00.000Z");
let clock = T0;
const advance = (ms: number) => setSystemTime(new Date((clock += ms)));

const plant = (id: PlantId = "plant-a") => (Plant as any).get(id);
const company = () => (Company as any).get(COMPANY_ACTOR_ID);
const component = (id: string) => (Component as any).get(componentActorId(id));
const strict = <T extends z.ZodType>(schema: T, value: unknown) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) console.error(JSON.stringify(parsed.error.issues, null, 1));
  expect(parsed.success).toBe(true);
  return parsed.data as z.infer<T>;
};

type Call = { path: string; status: number; body: unknown };
const glueCalls: Call[] = [];
let server: ReturnType<typeof Bun.serve>;

// A yes must predict every limited metric, or Plant.vote refuses it.
const predictions: Record<string, Record<string, number>> = {
  "TK-101": { levelPct: 50, tempC: 74 },
  "LV-101": { positionPct: 66 },
  "E-101": { dutyKw: 1160 },
  "TV-101": { positionPct: 56, steamKgH: 1980, headerBarg: 5.9 },
};

const voteFrom = (proposal: Proposal, componentId: string, overrides: Partial<Vote> = {}): Vote => ({
  proposalId: proposal.id,
  componentId,
  agentId: `agent:${componentId}`,
  vote: "yes",
  reason: "Within limits.",
  predicted: predictions[componentId.split("/")[1]!]!,
  marginPct: 10,
  evidenceEventIds: ["plant-a-hist-9"],
  evidenceRuleIds: [],
  similarCount: 5,
  ...overrides,
});

async function allThreeStatesAreStrict() {
  for (const p of seed.plants) {
    strict(PlantStateS, await plant(p.id).getState());
    for (const c of p.components) strict(EmittedComponentS, await component(c.id).getState());
  }
  strict(CompanyStateS, await company().getState());
}

async function seedAll() {
  for (const p of seed.plants) for (const c of p.components) await component(c.id).loadSeed(c);
  await company().loadSeed(seed.company);
  for (const p of seed.plants) await plant(p.id).loadSeed(p, historyFixture);
}

beforeAll(async () => {
  setSystemTime(new Date(clock));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = await req.json().catch(() => undefined);
      const validator = glueSchemas[path];
      const status = validator?.safeParse(body).success ? 200 : 400;
      glueCalls.push({ path, status, body });
      return Response.json({ ok: status === 200 }, { status });
    },
  });
  process.env.GLUE_URL = `http://127.0.0.1:${server.port}`;
  resetFakeTerse();
  await seedAll();
});

afterAll(() => {
  setSystemTime();
  server.stop(true);
  delete process.env.GLUE_URL;
});

describe("actor ids", () => {
  test("every ComponentId maps to a legal actor id and stays unique", () => {
    const ids = seed.plants.flatMap((p) => p.components.map((c) => componentActorId(c.id)));
    expect(new Set(ids).size).toBe(10);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
  });
  test("a proposal id routes to its own plant, including for a cross-plant voter", async () => {
    const p: Proposal = await plant("plant-b").propose({ plantId: "plant-b", proposerComponentId: "plant-b/P-100", metric: "speedPct", to: 55, rationale: "Route check." });
    expect(plantOfProposal(p.id)).toBe("plant-b");
  });
});

describe("seeded state", () => {
  test("getState on all 12 actors is strictly the contract, nothing extra", allThreeStatesAreStrict);
  test("Plant.components holds ids, not the seed's objects", async () => {
    const state = await plant().getState();
    expect(state.components).toEqual(seed.plants[0]!.components.map((c) => c.id));
  });
  test("Plant.history holds only its own plant's events", async () => {
    const state = await plant("plant-b").getState();
    expect(new Set(state.history.map((e: HistoryEvent) => e.plantId))).toEqual(new Set(["plant-b"]));
  });
  test("Component.loadSeed returns the emitted shape", async () => {
    const c = seed.plants[0]!.components[2]!;
    strict(EmittedComponentS, await component(c.id).loadSeed(c));
  });
  test("Company.loadSeed fills the runtime lists", async () => {
    const state = await company().loadSeed(seed.company);
    expect(strict(CompanyStateS, state).rules).toEqual([]);
  });
  test("a learned rule exists before the first proposal, as demo step 3 narrates", async () => {
    const rules: LearnedRule[] = (await plant().getState()).rules;
    expect(rules.length).toBeGreaterThan(0);
    const valve = rules.find((r) => r.consequence.componentId === "plant-a/LV-101");
    expect(valve).toBeDefined();
    strict(LearnedRuleS, valve);
  });
});

describe("Component methods", () => {
  const id = "plant-a/LV-101";
  test("mirror returns the emitted shape and merges by metric", async () => {
    const state = strict(EmittedComponentS, await component(id).mirror({ positionPct: 52 }));
    expect(state.metrics.positionPct).toBe(52);
    expect(state.status).toBe("ok");
  });
  test("status is warning at max and critical at critical, per TASK1", async () => {
    expect((await component(id).mirror({ positionPct: 80 })).status).toBe("warning");
    expect((await component(id).mirror({ positionPct: 90 })).status).toBe("critical");
    expect((await component(id).mirror({ positionPct: 50 })).status).toBe("ok");
  });
  test("mirror rejects non-finite values", async () => {
    await expect(component(id).mirror({ positionPct: "NaN" })).rejects.toThrow("invalid_metrics");
  });
  test("every mutation broadcasts the emitted shape", async () => {
    const before = broadcasts.length;
    await component(id).mirror({ positionPct: 51 });
    expect(broadcasts.length).toBe(before + 1);
    expect(broadcasts.at(-1)!.message.type).toBe("component");
    strict(EmittedComponentS, broadcasts.at(-1)!.message.state);
  });
  test("setMetric needs a real token", async () => {
    await expect(component(id).setMetric("positionPct", 60, "plant-a-p00001-abc", "forged")).rejects.toThrow("invalid_token");
  });
  test("setMargin stays in 5..25", async () => {
    expect((await component(id).setMargin(99)).marginPct).toBe(25);
    expect((await component(id).setMargin(0)).marginPct).toBe(5);
    expect((await component(id).setMargin(10)).marginPct).toBe(10);
  });
  test("addCalibration: one 1-point error leaves the margin alone (TASK1 agent test)", async () => {
    const state = await component("plant-a/E-101").addCalibration({ at: "t", proposalId: "p", metric: "dutyKw", predicted: 1160, observed: 1161, absError: 1 });
    strict(EmittedComponentS, state);
    expect(state.marginPct).toBe(10);
  });
  test("addCalibration: five large errors raise the margin to exactly 15 (TASK1 actor test)", async () => {
    let state: any;
    for (let i = 0; i < 5; i++) state = await component("plant-a/TV-101").addCalibration({ at: "t", proposalId: `p${i}`, metric: "steamKgH", predicted: 1000, observed: 2000, absError: 1000 });
    expect(state.marginPct).toBe(15);
    await component("plant-a/TV-101").setMargin(10);
  });
  test("addCalibration: a metric with no limit is stored and cannot move the margin", async () => {
    const tv = "plant-b/TV-101";
    let state: any;
    for (let i = 0; i < 6; i++) state = await component(tv).addCalibration({ at: "t", proposalId: `h${i}`, metric: "headerBarg", predicted: 6, observed: 1, absError: 5 });
    strict(EmittedComponentS, state);
    expect(state.marginPct).toBe(10);
    expect(state.calibration.length).toBe(6);
  });
  test("addCalibration recomputes absError", async () => {
    const state = await component("plant-a/TK-101").addCalibration({ at: "t", proposalId: "x", metric: "tempC", predicted: 75, observed: 74, absError: -1000 });
    expect(strict(CalibrationEntryS, state.calibration.at(-1)).absError).toBe(1);
  });
  test("calibration keeps the last 50", async () => {
    let state: any;
    for (let i = 0; i < 55; i++) state = await component("plant-a/P-100").addCalibration({ at: "t", proposalId: `c${i}`, metric: "feedM3h", predicted: 1, observed: 1, absError: 0 });
    expect(state.calibration.length).toBe(50);
  });
});

describe("Plant and Company methods through the demo path", () => {
  let bad: Proposal;
  let safe: Proposal;
  let claim: any;
  let observed: HistoryEvent;

  test("propose takes the five-field glue body and returns a full Proposal", async () => {
    bad = strict(ProposalS, await plant().propose({ plantId: "plant-a", proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 85, rationale: "Raise throughput." })) as Proposal;
    expect(bad.requiredVoters).toEqual(VOTERS);
    expect(bad.crossPlant).toBe(true);
    expect(bad.from).toBe(50);
    expect(bad.proposerAgentId).toBe("agent:plant-a/P-100");
    expect(bad.status).toBe("voting");
    expect(bad.votes).toEqual([]);
    expect(bad.vetoDeadline).toBeNull();
    expect(bad.parentProposalId).toBeNull();
    expect(plantOfProposal(bad.id)).toBe("plant-a");
  });
  test("a cross-plant proposal is listed on Company", async () => {
    expect((await company().getState()).crossPlantProposals).toContain(bad.id);
  });
  test("vote returns the Proposal, accepts a cross-plant voter, rejects a duplicate", async () => {
    const updated = strict(ProposalS, await plant().vote(voteFrom(bad, "plant-b/TV-101", { predicted: { positionPct: 54, steamKgH: 1533, headerBarg: 5.6 } })));
    expect(updated.votes.length).toBe(1);
    await expect(plant().vote(voteFrom(bad, "plant-b/TV-101"))).rejects.toThrow("duplicate_vote");
  });
  test("vote rejects an evidence id that is not in this plant's history", async () => {
    await expect(plant().vote(voteFrom(bad, "plant-a/TK-101", { evidenceEventIds: ["made-up"] }))).rejects.toThrow("invalid_vote");
  });
  test("a no with empty predicted is accepted: the insufficient-history and malformed cases need that", async () => {
    const updated = await plant().vote(voteFrom(bad, "plant-a/LV-101", { vote: "no", reason: "malformed prediction", predicted: {}, evidenceEventIds: [], similarCount: 0 }));
    strict(ProposalS, updated);
  });
  test("tick and sweep block it, and /tick reaches glue with a body glue accepts", async () => {
    glueCalls.length = 0;
    await plant().tick();
    await plant().tick();
    await Bun.sleep(30);
    const state = strict(PlantStateS, await plant().getState());
    expect(state.proposals.find((p) => p.id === bad.id)!.status).toBe("blocked");
    const ticks = glueCalls.filter((c) => c.path === "/tick");
    expect(ticks.length).toBeGreaterThan(0);
    for (const c of ticks) expect(c).toEqual({ path: "/tick", status: 200, body: {} });
  });
  test("a counter takes the proposal plus parentProposalId", async () => {
    const created = await plant().propose({ plantId: "plant-a", proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 65, rationale: "Safer step.", parentProposalId: bad.id });
    safe = strict(ProposalS, created) as Proposal;
    expect(safe.parentProposalId).toBe(bad.id);
  });
  test("unanimous yes opens a 10 s veto window", async () => {
    for (const v of VOTERS) await plant().vote(voteFrom(safe, v));
    await plant().tick();
    await plant().tick();
    const state = strict(PlantStateS, await plant().getState());
    const current = state.proposals.find((p) => p.id === safe.id)!;
    expect(current.status).toBe("veto_window");
    expect(Date.parse(current.vetoDeadline!) - clock).toBe(10_000);
  });
  test("execute is refused while the window is open", async () => {
    await expect(plant().execute(safe.id)).rejects.toThrow("veto_window_open");
  });
  test("after the deadline the sweep executes and /execute-callback passes glue's validator", async () => {
    glueCalls.length = 0;
    advance(10_000);
    await plant().tick();
    await plant().tick();
    await Bun.sleep(30);
    const state = strict(PlantStateS, await plant().getState());
    expect(state.proposals.find((p) => p.id === safe.id)!.status).toBe("executed");
    const callbacks = glueCalls.filter((c) => c.path === "/execute-callback");
    expect(callbacks.length).toBeGreaterThan(0);
    for (const c of callbacks) expect(c).toEqual({ path: "/execute-callback", status: 200, body: { proposalId: safe.id } });
  });
  test("the token never appears in any emitted or stored contract state", async () => {
    claim = await plant().claimDispatch(safe.id);
    expect(claim).toEqual({ dispatch: true, proposalId: safe.id, componentId: "plant-a/P-100", metric: "speedPct", value: 65, token: expect.any(String) });
    const everything = JSON.stringify([await plant().getState(), await company().getState(), await plant().getExecution(safe.id), broadcasts]);
    expect(everything).not.toContain(claim.token);
  });
  test("a second claim does not dispatch", async () => {
    expect((await plant().claimDispatch(safe.id)).dispatch).toBe(false);
  });
  test("setMetric with the token returns the emitted shape, and only once", async () => {
    const state = strict(EmittedComponentS, await component("plant-a/P-100").setMetric("speedPct", 65, safe.id, claim.token));
    expect(state.metrics.speedPct).toBe(65);
    await expect(component("plant-a/P-100").setMetric("speedPct", 65, safe.id, claim.token)).rejects.toThrow("token_already_used");
  });
  test("recordEvent takes the /observed body and returns a strict HistoryEvent", async () => {
    const effects = [{ componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: 67, ticksToSettle: 3 }];
    observed = strict(HistoryEventS, await plant().recordEvent({ proposalId: safe.id, effects })) as HistoryEvent;
    expect(observed.proposalId).toBe(safe.id);
    expect(observed.componentId).toBe("plant-a/P-100");
    expect(observed.metric).toBe("speedPct");
    expect(observed.after).toBe(65);
    expect(observed.plantId).toBe("plant-a");
    await allThreeStatesAreStrict();
  });
  test("recordEvent is idempotent per proposal", async () => {
    const again = await plant().recordEvent({ proposalId: safe.id, effects: [] });
    expect(again.id).toBe(observed.id);
    const state = await plant().getState();
    expect(state.history.filter((e: HistoryEvent) => e.proposalId === safe.id).length).toBe(1);
  });
  test("similar returns strict events with the newest live run first", async () => {
    const events: HistoryEvent[] = await plant().similar("plant-a/P-100", "speedPct", 85, { feedM3h: 19.5, headerBarg: 6 }, 5);
    for (const e of events) strict(HistoryEventS, e);
    expect(events.length).toBe(5);
    expect(events[0]!.id).toBe(observed.id);
    expect(events.slice(1).every((e) => e.after >= 74)).toBe(true);
  });
  test("similar on plant-b returns nothing for 85, so insufficient history can fire", async () => {
    expect(await plant("plant-b").similar("plant-b/P-100", "speedPct", 85, {}, 5)).toEqual([]);
  });
  test("a seeded rule reaches Company with the model and no component ids", async () => {
    // Promotion needs both plants registered, which each does on its first sweep.
    for (const id of ["plant-b", "plant-b", "plant-a", "plant-a"] as PlantId[]) await plant(id).tick();
    const rules: LearnedRule[] = strict(CompanyStateS, await company().getState()).rules as LearnedRule[];
    const shared = rules.find((r) => r.model === "outlet-valve-A");
    expect(shared).toBeDefined();
    expect(shared!.scope).toBe("company");
    expect(shared!.condition.componentId).toBeNull();
    expect(shared!.consequence.componentId).toBeNull();
  });
  test("rulesFor returns plant and company rules for plant-b's valve", async () => {
    const rules: LearnedRule[] = await plant("plant-b").rulesFor("plant-b/LV-101", "outlet-valve-A");
    for (const r of rules) strict(LearnedRuleS, r);
    expect(rules.some((r) => r.scope === "company")).toBe(true);
  });
  test("veto is refused once closed", async () => {
    await expect(plant().veto(safe.id, "operator")).rejects.toThrow("veto_closed");
  });
  test("requiredCrossPlantVoters returns ComponentId[]", async () => {
    expect(await company().requiredCrossPlantVoters({ ...bad, requiredVoters: VOTERS.slice(0, 4) })).toEqual(["plant-b/TV-101"]);
  });
  test("Company.recordAudit and registerPlant return contract shapes", async () => {
    await company().recordAudit({ at: "2026-10-31T19:00:00.000Z", plantId: "company", kind: "incident", refId: "x", summary: "s", by: "b" });
    strict(CompanyStateS, await company().registerPlant("plant-a"));
  });
  test("final state of every actor is still strictly the contract", allThreeStatesAreStrict);
});

describe("a tagged ComponentState", () => {
  test("the seed type is the contract type", () => {
    const c: ComponentState = seed.plants[0]!.components[0]!;
    expect(c.id).toBe("plant-a/P-100");
  });
});

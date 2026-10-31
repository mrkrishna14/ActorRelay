// The write path, reset and mirroring: real Glue, Dispatcher and MirrorPump with fake actors, simulator and Relay.
import { describe, expect, test } from "bun:test";
import { HttpError } from "../actors";
import { parseSnapshot, SetpointFailed } from "../bridge";
import { STAND_IN_HISTORY } from "../seed";
import { build, makeComponent, makeProposal, makeVote, PROPOSAL_ID, tempRepo } from "./fakes";

const callback = { proposalId: PROPOSAL_ID };

describe("execution", () => {
  test("execute, claim, one setpoint, then setMetric with the claimed value and token", async () => {
    const { post, actors, bridge } = build();
    const response = await post("/execute-callback", callback);
    expect(response.status).toBe(200);
    expect(actors.order().filter((name) => /execute|claimDispatch|setMetric/.test(name))).toEqual(["Plant.execute", "Plant.claimDispatch", "Component.setMetric"]);
    expect(bridge.writes).toEqual([{ componentId: "plant-a/P-100", metric: "speedPct", value: 65, proposalId: PROPOSAL_ID }]);
    expect(actors.named("setMetric")[0]).toMatchObject({ id: "plant-a/P-100", args: ["speedPct", 65, PROPOSAL_ID, "one-time-token"] });
  });

  test("the simulator is written after the claim and before setMetric", async () => {
    const { post, actors, bridge } = build();
    const seen: number[] = [];
    const { "Component.setMetric": setMetric } = actors.handlers;
    actors.handlers["Component.setMetric"] = (id, args) => {
      seen.push(bridge.writes.length);
      return setMetric?.(id, args);
    };
    await post("/execute-callback", callback);
    expect(seen).toEqual([1]);
  });

  test("the callback retried three times writes the simulator once", async () => {
    const { post, bridge } = build();
    await post("/execute-callback", callback);
    await post("/execute-callback", callback);
    await post("/execute-callback", callback);
    expect(bridge.writes).toHaveLength(1);
  });

  test("two callbacks at the same moment write once", async () => {
    const { post, bridge } = build();
    await Promise.all([post("/execute-callback", callback), post("/execute-callback", callback)]);
    expect(bridge.writes).toHaveLength(1);
  });

  test("an unapproved proposal writes nothing", async () => {
    const { post, actors, bridge } = build();
    actors.handlers["Plant.execute"] = () => {
      throw new HttpError(409, "not_approved: p is voting");
    };
    expect((await post("/execute-callback", callback)).status).toBe(409);
    expect(bridge.writes).toEqual([]);
  });

  test("a claim with no token refuses and writes nothing", async () => {
    const { post, actors, bridge } = build();
    actors.handlers["Plant.claimDispatch"] = () => ({ dispatch: true, proposalId: PROPOSAL_ID, componentId: "plant-a/P-100", metric: "speedPct", value: 65 });
    const body = (await (await post("/execute-callback", callback)).json()) as any;
    expect(body.dispatched).toBe(false);
    expect(bridge.writes).toEqual([]);
    expect(actors.named("reportDispatchFailure")).toHaveLength(1);
    expect(actors.named("setMetric")).toEqual([]);
  });

  test("the value written is the claim's, whatever the proposal or the request says", async () => {
    const { post, actors, bridge } = build();
    actors.proposal = makeProposal({ to: 70 });
    actors.handlers["Plant.claimDispatch"] = () => ({ dispatch: true, proposalId: PROPOSAL_ID, componentId: "plant-a/P-100", metric: "speedPct", value: 61, token: "t" });
    await post("/execute-callback", callback);
    expect(bridge.writes[0]?.value).toBe(61);
    expect(actors.named("setMetric")[0]?.args[1]).toBe(61);
  });

  test("the simulator's own value is passed to the claim as the measurement", async () => {
    const { post, actors, bridge } = build();
    bridge.snapshotBody = () => ({ "plant-a/P-100": { speedPct: 80 } });
    await post("/execute-callback", callback);
    expect(actors.named("claimDispatch")[0]?.args).toEqual([PROPOSAL_ID, 80]);
  });

  test("with the snapshot down the component's reading is used instead", async () => {
    const { post, actors, bridge } = build();
    bridge.snapshot = async () => {
      throw new Error("down");
    };
    await post("/execute-callback", callback);
    expect(actors.named("claimDispatch")[0]?.args).toEqual([PROPOSAL_ID, 50]);
  });

  test("a target above the operating max is refused at the write path", async () => {
    const { post, actors, bridge } = build();
    actors.proposal = makeProposal({ to: 92 });
    const body = (await (await post("/execute-callback", callback)).json()) as any;
    expect(body).toMatchObject({ dispatched: false, state: "failed" });
    expect(body.reason).toContain("operating max");
    expect(bridge.writes).toEqual([]);
    expect(actors.named("claimDispatch")).toEqual([]);
    expect(actors.named("reportDispatchFailure")).toHaveLength(1);
  });

  test("a required voter that went critical stops the write", async () => {
    const { post, actors, bridge } = build();
    actors.components["plant-a/TK-101"] = makeComponent("plant-a/TK-101", { status: "critical" });
    const body = (await (await post("/execute-callback", callback)).json()) as any;
    expect(body.reason).toContain("critical");
    expect(bridge.writes).toEqual([]);
  });

  test("a simulator refusal is reported and setMetric is not called", async () => {
    const { post, actors, bridge } = build();
    bridge.failWrite = new SetpointFailed("simulator refused 400", true);
    const body = (await (await post("/execute-callback", callback)).json()) as any;
    expect(body).toMatchObject({ dispatched: false, state: "failed" });
    expect(actors.named("reportDispatchFailure")[0]?.args).toEqual([PROPOSAL_ID, "simulator refused 400"]);
    expect(actors.named("setMetric")).toEqual([]);
  });

  test("a /setpoint with no answer is not repeated and not reverted, because it may have landed", async () => {
    const { post, actors, bridge, glue } = build();
    bridge.failWrite = new SetpointFailed("no answer from the simulator", false);
    const result = await glue.dispatcher.run(PROPOSAL_ID);
    await post("/execute-callback", callback);
    expect(result).toMatchObject({ dispatched: false, state: "unknown" });
    expect(bridge.writes).toHaveLength(1);
    expect(actors.named("reportDispatchFailure")).toEqual([]);
    expect(actors.named("setMetric")).toEqual([]);
  });

  test("a /setpoint with no answer that the simulator shows as landed is settled with setMetric", async () => {
    const { actors, bridge, glue } = build();
    bridge.failWrite = new SetpointFailed("no answer from the simulator", false);
    let reads = 0;
    bridge.snapshotBody = () => ({ "plant-a/P-100": { speedPct: ++reads > 1 ? 65 : 50 } });
    expect(await glue.dispatcher.run(PROPOSAL_ID)).toMatchObject({ dispatched: true, value: 65 });
    expect(actors.named("setMetric")).toHaveLength(1);
    expect(actors.named("reportDispatchFailure")).toEqual([]);
  });

  test("setMetric is retried, because the simulator has already moved", async () => {
    const { post, actors } = build();
    let tries = 0;
    actors.handlers["Component.setMetric"] = () => {
      tries += 1;
      if (tries < 2) throw new HttpError(503, "no answer");
      return {};
    };
    const body = (await (await post("/execute-callback", callback)).json()) as any;
    expect(tries).toBe(2);
    expect(body.recorded).toBe(true);
  });

  test("a slow dispatch answers 202 and still finishes", async () => {
    const { post, actors, bridge } = build();
    actors.handlers["Plant.execute"] = async () => {
      await Bun.sleep(1200);
      return { state: "accepted" };
    };
    const response = await post("/execute-callback", callback);
    expect(response.status).toBe(202);
    await Bun.sleep(300);
    expect(bridge.writes).toHaveLength(1);
  });

  test("/observed records with the state at dispatch and posts executed on both channels", async () => {
    const { post, actors, relay } = build();
    await post("/execute-callback", callback);
    const effects = [{ componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: 66, ticksToSettle: 3 }];
    const response = await post("/observed", { proposalId: PROPOSAL_ID, effects });
    expect(response.status).toBe(200);
    expect(actors.named("recordEvent")[0]).toMatchObject({ id: "plant-a", args: [{ proposalId: PROPOSAL_ID, effects, upstreamSnapshot: { feedM3h: 15, headerBarg: 6 } }] });
    const executed = relay.sent.find((sent) => sent.type === "executed");
    expect(executed?.channels).toEqual(["plant-a", "company"]);
    expect(executed?.payload).toMatchObject({ proposalId: PROPOSAL_ID, event: { proposalId: PROPOSAL_ID } });
  });
});

describe("reset", () => {
  test("simulator, then Company, then Plants, then Components", async () => {
    const { post, actors, bridge } = build();
    const response = await post("/reset", {});
    expect(response.status).toBe(200);
    expect(bridge.resets).toBe(1);
    const order = actors.order().filter((name) => name.endsWith(".loadSeed"));
    expect(order[0]).toBe("Company.loadSeed");
    expect(order.slice(1, 3)).toEqual(["Plant.loadSeed", "Plant.loadSeed"]);
    expect(order.slice(3)).toEqual(Array(10).fill("Component.loadSeed"));
  });

  test("each Plant gets its own history and its full seed", async () => {
    const root = tempRepo(true);
    const { post, actors } = build({ repoRoot: root });
    await post("/reset", {});
    const plantA = actors.named("loadSeed").find((call) => call.kind === "Plant" && call.id === "plant-a");
    expect((plantA?.args[0] as { components: unknown[] }).components).toHaveLength(5);
    expect((plantA?.args[1] as { id: string }[]).map((event) => event.id)).toEqual(["real-1"]);
  });

  test("the stand-in history is used, and labelled, only until the real file exists", async () => {
    const standIn = (await (await build({ repoRoot: tempRepo(false) }).post("/reset", {})).json()) as any;
    expect(standIn.seed).toMatchObject({ historySource: STAND_IN_HISTORY, standIn: true });
    expect(standIn.seed.label).toContain("Stand-in");
    const real = (await (await build({ repoRoot: tempRepo(true) }).post("/reset", {})).json()) as any;
    expect(real.seed).toMatchObject({ historySource: "shared/history.json", standIn: false, label: null });
  });

  test("a simulator that did not reset is a 502, with the actors still seeded", async () => {
    const { post, actors, bridge } = build();
    bridge.failReset = true;
    const response = await post("/reset", {});
    expect(response.status).toBe(502);
    expect(actors.named("loadSeed")).toHaveLength(13);
  });

  test("it waits for a dispatch already running, and nothing new starts meanwhile", async () => {
    const { post, actors, bridge } = build();
    let finish = () => {};
    actors.handlers["Plant.execute"] = () => new Promise((resolve) => (finish = () => resolve({ state: "accepted" })));
    const running = post("/execute-callback", callback);
    await Bun.sleep(5);
    const reset = post("/reset", {});
    await Bun.sleep(5);
    expect(actors.named("loadSeed")).toEqual([]);
    expect((await post("/execute-callback", { proposalId: "plant-a-p00002-zzzz" })).status).toBe(503);
    expect((await post("/propose", { plantId: "plant-a", proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 85, rationale: "x" })).status).toBe(503);
    expect((await post("/mirror", { componentId: "plant-a/LV-101", metrics: { positionPct: 1 } })).status).toBe(202);
    finish();
    await running;
    expect((await reset).status).toBe(200);
    expect(bridge.writes).toHaveLength(1);
    expect(actors.named("loadSeed").length).toBeGreaterThan(0);
  });

  test("a second reset while one runs is refused", async () => {
    const { post, actors } = build();
    let finish = () => {};
    actors.handlers["Company.loadSeed"] = () => new Promise((resolve) => (finish = () => resolve({})));
    const first = post("/reset", {});
    await Bun.sleep(5);
    expect((await post("/reset", {})).status).toBe(409);
    finish();
    expect((await first).status).toBe(200);
  });

  test("a failed seed reopens the routes and reports no answer", async () => {
    const { post, actors } = build();
    actors.handlers["Company.loadSeed"] = () => {
      throw new HttpError(503, "Terse did not answer");
    };
    expect((await post("/reset", {})).status).toBe(503);
    actors.handlers["Company.loadSeed"] = () => ({});
    expect((await post("/reset", {})).status).toBe(200);
  });

  test("the vote dedupe does not outlive a reset", async () => {
    const { post, actors } = build();
    const vote = makeVote();
    await post("/vote", { vote });
    await post("/reset", {});
    expect((await post("/vote", { vote })).status).toBe(200);
    expect(actors.named("vote")).toHaveLength(2);
  });

  test("the live reading is mirrored straight after a reset", async () => {
    const { post, actors, bridge } = build();
    await post("/reset", {});
    expect(bridge.snapshots).toBe(2);
    expect(actors.named("mirror").length).toBeGreaterThan(0);
  });
});

describe("mirroring", () => {
  test("/mirror reaches Component.mirror with only the metrics", async () => {
    const { post, actors } = build();
    const response = await post("/mirror", { componentId: "plant-a/LV-101", metrics: { positionPct: 51 }, tick: 3, lastTick: "x" });
    expect(response.status).toBe(200);
    expect(actors.named("mirror")[0]).toMatchObject({ kind: "Component", id: "plant-a/LV-101", args: [{ positionPct: 51 }] });
  });

  test("an unknown component is 404", async () => {
    const { post } = build();
    expect((await post("/mirror", { componentId: "plant-a/XX-1", metrics: { x: 1 } })).status).toBe(404);
  });

  test("a slow actor gets the newest reading next, not a queue", async () => {
    const { post, actors } = build();
    let release = () => {};
    let first = true;
    actors.handlers["Component.mirror"] = (id) => {
      if (!first) return makeComponent(id);
      first = false;
      return new Promise((resolve) => (release = () => resolve(makeComponent(id))));
    };
    const a = post("/mirror", { componentId: "plant-a/LV-101", metrics: { positionPct: 1 } });
    await Bun.sleep(5);
    const b = post("/mirror", { componentId: "plant-a/LV-101", metrics: { positionPct: 2 } });
    const c = post("/mirror", { componentId: "plant-a/LV-101", metrics: { positionPct: 3 } });
    await Bun.sleep(5);
    release();
    await Promise.all([a, b, c]);
    await Bun.sleep(5);
    expect(actors.named("mirror").map((call) => call.args[0])).toEqual([{ positionPct: 1 }, { positionPct: 3 }]);
  });

  test("glue polls when the simulator is not pushing, and not while it is", async () => {
    const { post, bridge } = build();
    await post("/tick", {});
    await Bun.sleep(5);
    expect(bridge.snapshots).toBe(2);
    await Bun.sleep(850);
    await post("/mirror", { componentId: "plant-a/LV-101", metrics: { positionPct: 1 } });
    await post("/tick", {});
    await Bun.sleep(5);
    expect(bridge.snapshots).toBe(2);
  });

  test("/tick says whether the simulator is really there, which is what PlantState.connected shows", async () => {
    const { post, glue, bridge } = build();
    bridge.snapshot = async () => {
      throw new Error("down");
    };
    expect((await post("/tick", {})).status).toBe(503);
    await post("/mirror", { componentId: "plant-a/LV-101", metrics: { positionPct: 1 } });
    expect((await post("/tick", {})).status).toBe(200);
    expect(glue.mirror.simulatorSeen(Date.now() + 6000)).toBe(false);
  });

  test("parseSnapshot keeps this plant's component rows and ignores the rest", () => {
    const parsed = parseSnapshot({ "plant-a/P-100": { speedPct: 50 }, "plant-b/P-100": { speedPct: 50 }, tick: 4, "plant-a/LV-101": { positionPct: "x" } }, "plant-a");
    expect(parsed).toEqual({ "plant-a/P-100": { speedPct: 50 } });
  });
});

describe("waking the plants", () => {
  test("wake reads both Plants with no dashboard open", async () => {
    const { glue, actors } = build();
    await glue.wake();
    expect(actors.named("getState").filter((call) => call.kind === "Plant").map((call) => call.id).sort()).toEqual(["plant-a", "plant-b"]);
  });

  test("a dead actor server is survived and noticed", async () => {
    const { glue, actors, lines, get } = build();
    actors.handlers["Plant.getState"] = () => {
      throw new HttpError(503, "connection refused");
    };
    await glue.wake();
    expect((await (await get("/health")).json()) as any).toMatchObject({ services: { actors: false } });
    actors.handlers["Plant.getState"] = (id) => actors.plant(id as "plant-a");
    await glue.wake();
    expect(lines.join()).toContain("actors reachable");
  });

  test("/health shows each write", async () => {
    const { post, get } = build();
    await post("/execute-callback", callback);
    const health = (await (await get("/health")).json()) as any;
    expect(health.dispatches).toHaveLength(1);
    expect(health.dispatches[0]).toMatchObject({ proposalId: PROPOSAL_ID, value: 65, ok: true });
  });
});

// One-case reproductions of each finding sent to ar-actors, written against the real
// exports with no engine or generator in between. Each test states the correct behaviour,
// so it stays red until its finding is fixed or the owner records a decision.
import { describe, expect, test } from "bun:test";
import { isReal } from "./target";
import { iso, makeEvent, plantComponents, T0, type HistoryEvent, type LearnedRule } from "./harness";

const describeReal = isReal ? describe : describe.skip;
const SRC = process.env.PROP_SRC ?? "../../src";

describeReal("repro [real logic, fake runtime]", () => {
  test("F1 three safe runs cannot support an unsafe rule at Plant.promoteRule", async () => {
    const { Plant } = (await import(`${SRC}/actor`)) as any;
    const plant = new Plant();
    plant.id = "plant-a";
    const components = plantComponents("plant-a");
    const topology = Object.fromEntries(components.map((c) => [c.id, c]));
    const history: HistoryEvent[] = ["s0", "s1", "s2"].map((id) =>
      makeEvent(id, "plant-a/P-100", "speedPct", 65, [
        { componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: 67, ticksToSettle: 3 },
      ]),
    );
    Object.assign(plant, { seeded: true, registeredWithCompany: true, topology, history, rules: [], audit: [], companyOutbox: [], proposals: [] });
    const rule: LearnedRule = {
      id: "forged",
      scope: "plant",
      model: "outlet-valve-A",
      text: "speedPct >= 60 -> positionPct >= 85",
      condition: { componentId: "plant-a/P-100", metric: "speedPct", op: ">=", value: 60 },
      consequence: { componentId: "plant-a/LV-101", metric: "positionPct", op: ">=", value: 85, withinTicks: 3 },
      supportEventIds: ["s0", "s1", "s2"],
      timesSeen: 3,
      createdAt: iso(T0),
      lastSeenAt: iso(T0),
    };
    await expect(plant.promoteRule(rule)).rejects.toThrow();
  });

  test("F5 rankSimilar returns no more than k", async () => {
    const { rankSimilar } = await import(`${SRC}/logic/similar`);
    const history = [makeEvent("e0", "plant-a/P-100", "speedPct", 85)];
    const got = rankSimilar({ history, componentId: "plant-a/P-100", metric: "speedPct", to: 85, upstreamSnapshot: {}, k: 0, liveEventIds: [] });
    expect(got.length).toBe(0);
  });

  test("F6 reachableVoters follows a link recorded only on the far end", async () => {
    const { reachableVoters } = await import(`${SRC}/logic/proposals`);
    const def = (id: string, downstream: string[]) => ({ id, tag: id, model: "m", limits: {}, upstream: [], downstream, sharedResources: [] });
    const topology = { a: def("a", []), b: def("b", ["a"]) };
    expect(reachableVoters("a", topology, ["a", "b"])).toEqual(["b"]);
  });

  test("F7 applyCalibration never moves the margin on a window under five", async () => {
    const { applyCalibration } = await import(`${SRC}/logic/component`);
    const limits = { positionPct: { min: 10, max: 80, critical: 90 } };
    const entry = (metric: string, absError: number) => ({ at: iso(T0), proposalId: "p", metric, predicted: 0, observed: absError, absError });
    let state = { calibration: [] as ReturnType<typeof entry>[], marginPct: 10, sinceAdjustment: 0 };
    const add = (e: ReturnType<typeof entry>) => {
      state = applyCalibration({ ...state, entry: e, limits });
    };
    for (let i = 0; i < 4; i++) add(entry("positionPct", 7));
    for (let i = 0; i < 50; i++) add(entry("headerBarg", 0));
    add(entry("positionPct", 40));
    expect(state.calibration.filter((c) => c.metric === "positionPct").length).toBe(1);
    expect(state.marginPct).toBe(10);
  });

  test("F9 company rules from different changed components are not merged", async () => {
    const { mergeCompanyRule, toCompanyRule } = await import(`${SRC}/logic/rules`);
    const rule = (component: string, value: number): LearnedRule => ({
      id: `r-${component}`,
      scope: "plant",
      model: "hold-tank-A",
      text: component,
      condition: { componentId: component, metric: "positionPct", op: ">=", value },
      consequence: { componentId: "plant-a/TK-101", metric: "levelPct", op: ">=", value: 70, withinTicks: 3 },
      supportEventIds: ["a", "b", "c"],
      timesSeen: 3,
      createdAt: iso(T0),
      lastSeenAt: iso(T0),
    });
    const first = mergeCompanyRule([], toCompanyRule(rule("plant-a/LV-101", 85), "plant-a"), iso(T0)).rules;
    const both = mergeCompanyRule(first, toCompanyRule(rule("plant-a/TV-101", 60), "plant-a"), iso(T0)).rules;
    expect(both.length).toBe(2);
  });
});


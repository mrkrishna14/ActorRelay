import { describe, expect, test } from "bun:test";
import type { Vote } from "../../shared/types";
import { calibrate, calibrationEntries, learnFromBlock, learnFromExecution } from "../learn";
import { RetrievalCache } from "../retrieval";
import { companyRule, FakeGlue, makeProposal, safeExecution } from "./fake-glue";

const deps = (glue: FakeGlue) => ({ glue, cache: new RetrievalCache(), log: () => undefined });

const voteFor = (componentId: string, predicted: Record<string, number>, proposalId: string): Vote => ({
  proposalId,
  componentId,
  agentId: `agent:${componentId}`,
  vote: "yes",
  reason: "ok",
  predicted,
  marginPct: 10,
  evidenceEventIds: [],
  evidenceRuleIds: [],
  similarCount: 5,
});

describe("calibration", () => {
  test("a 1-point error leaves marginPct unchanged", async () => {
    const glue = new FakeGlue();
    const run = safeExecution("p-one");
    await calibrate(deps(glue), voteFor("plant-a/LV-101", { positionPct: 66 }, "p-one"), run);
    expect(glue.calibrations[0].entry).toMatchObject({ proposalId: "p-one", metric: "positionPct", predicted: 66, observed: 67, absError: 1 });
    expect(glue.components.get("plant-a/LV-101")?.marginPct).toBe(10);
  });

  test("five 12-point errors raise marginPct", async () => {
    const glue = new FakeGlue();
    for (let i = 0; i < 5; i++) {
      await calibrate(deps(glue), voteFor("plant-a/LV-101", { positionPct: 79 }, `p-${i}`), safeExecution(`p-${i}`));
    }
    expect(glue.calibrations.map((c) => c.entry.absError)).toEqual([12, 12, 12, 12, 12]);
    expect(glue.components.get("plant-a/LV-101")?.marginPct).toBe(15);
  });

  test("a voter with no effect row is still calibrated from its live reading", async () => {
    const glue = new FakeGlue();
    const run = safeExecution("p-cross");
    const entries = await calibrate(deps(glue), voteFor("plant-b/TV-101", { positionPct: 52, steamKgH: 1533, headerBarg: 5.7 }, "p-cross"), run);
    expect(entries.map((e) => e.metric).sort()).toEqual(["headerBarg", "positionPct", "steamKgH"]);
    expect(entries.find((e) => e.metric === "headerBarg")?.observed).toBe(5.78);
    expect(entries.find((e) => e.metric === "steamKgH")?.observed).toBe(1533);
  });

  test("a repeat of the same proposal adds nothing", async () => {
    const glue = new FakeGlue();
    const run = safeExecution("p-twice");
    const vote = voteFor("plant-a/LV-101", { positionPct: 66 }, "p-twice");
    await calibrate(deps(glue), vote, run);
    await calibrate(deps(glue), vote, run);
    expect(glue.calibrations).toHaveLength(1);
  });

  test("a metric with no observation at all is skipped rather than guessed", () => {
    const own = { id: "plant-a/LV-101", metrics: {}, sharedResources: [], calibration: [] } as never;
    expect(calibrationEntries(voteFor("plant-a/LV-101", { positionPct: 66 }, "p"), safeExecution("p", "plant-b"), own, "t")).toEqual([]);
  });
});

describe("learnFromExecution", () => {
  test("calibrates every voter it owns and caches the event", async () => {
    const glue = new FakeGlue();
    const proposal = makeProposal({ id: "p-exec", to: 65, status: "executed" });
    proposal.votes = proposal.requiredVoters.map((id) => voteFor(id, id.endsWith("TK-101") ? { levelPct: 50, tempC: 74 } : id.endsWith("E-101") ? { dutyKw: 1160 } : id.endsWith("TV-101") ? { positionPct: 56, steamKgH: 1980, headerBarg: 5.8 } : { positionPct: 66 }, "p-exec"));
    glue.addProposal(proposal);
    const event = safeExecution("p-exec");
    const cache = new RetrievalCache();
    const entries = await learnFromExecution({ glue, cache, log: () => undefined }, event, new Set(proposal.requiredVoters));
    expect(new Set(glue.calibrations.map((c) => c.componentId))).toEqual(new Set(proposal.requiredVoters));
    expect(entries.length).toBeGreaterThanOrEqual(5);
    expect(cache.allEvents().map((e) => e.id)).toContain(event.id);
    expect(glue.rulesPosted).toHaveLength(0);
  });
});

test("an executed message for a proposal that did not execute teaches nothing", async () => {
  const glue = new FakeGlue();
  const proposal = makeProposal({ id: "p-blocked", to: 85, status: "blocked" });
  proposal.votes = [voteFor("plant-a/LV-101", { positionPct: 89 }, "p-blocked")];
  glue.addProposal(proposal);
  const cache = new RetrievalCache();
  const entries = await learnFromExecution({ glue, cache, log: () => undefined }, safeExecution("p-blocked"), new Set(["plant-a/LV-101"]));
  expect(entries).toEqual([]);
  expect(cache.allEvents()).toEqual([]);
});

describe("rule promotion from evidence", () => {
  const block = (glue: FakeGlue) => {
    const proposal = makeProposal({ to: 85 });
    return learnFromBlock(deps(glue), proposal, { ...voteFor("plant-a/LV-101", { positionPct: 89 }, proposal.id), vote: "no", evidenceEventIds: ["a", "b", "c"] });
  };

  test("a block on three or more shared crossings proposes a rule with real support", async () => {
    const glue = new FakeGlue();
    const rule = await block(glue);
    expect(rule).not.toBeNull();
    expect(rule?.condition).toMatchObject({ metric: "speedPct", op: ">=", value: 80 });
    expect(rule?.consequence.metric).toBe("positionPct");
    expect(rule?.consequence.value).toBeGreaterThanOrEqual(81);
    expect(rule?.supportEventIds.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(glue.history.map((e) => e.id));
    expect(rule?.supportEventIds.every((id) => ids.has(id))).toBe(true);
    expect(glue.rulesPosted).toHaveLength(1);
  });

  test("one safe run in the range rules a rule out", async () => {
    const glue = new FakeGlue();
    const [run] = await glue.similar({ componentId: "plant-a/P-100", metric: "speedPct", to: 85, k: 1 });
    run.effects = run.effects.map((r) => (r.componentId === "plant-a/LV-101" ? { ...r, after: 70 } : r));
    expect(await block(glue)).toBeNull();
  });

  test("a pattern an existing rule covers is not proposed again", async () => {
    const glue = new FakeGlue();
    glue.companyRules.push(companyRule());
    expect(await block(glue)).toBeNull();
    expect(glue.rulesPosted).toHaveLength(0);
  });

  test("a yes never proposes a rule", async () => {
    const glue = new FakeGlue();
    const proposal = makeProposal({ to: 85 });
    expect(await learnFromBlock(deps(glue), proposal, voteFor("plant-a/LV-101", { positionPct: 89 }, proposal.id))).toBeNull();
  });
});

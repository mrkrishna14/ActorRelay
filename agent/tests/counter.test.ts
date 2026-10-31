import { describe, expect, test } from "bun:test";
import type { Proposal, Vote } from "../../shared/types";
import { bestCandidate, buildCounter, MAX_COUNTERS_PER_PARENT } from "../counter";
import { FakeGlue, makeProposal } from "./fake-glue";
import { ScriptedLlm } from "./scripted-llm";

const noVote = (proposalId: string): Vote => ({
  proposalId,
  componentId: "plant-a/LV-101",
  agentId: "agent:plant-a/LV-101",
  vote: "no",
  reason: "predicted positionPct 89 is at or past the 81 threshold",
  predicted: { positionPct: 89 },
  marginPct: 10,
  evidenceEventIds: ["e1", "e2", "e3"],
  evidenceRuleIds: [],
  similarCount: 5,
});

const blocked = (overrides: Partial<Proposal> = {}): Proposal => {
  const proposal = makeProposal({ status: "blocked", to: 85, ...overrides });
  proposal.votes = [noVote(proposal.id)];
  return proposal;
};

const pick = (value: unknown) => new ScriptedLlm(() => JSON.stringify({ value, rationale: "65 has safe history" }));
const deps = (glue: FakeGlue, llm: ScriptedLlm) => ({ glue, llm, log: () => undefined });

describe("buildCounter", () => {
  test("posts the model's pick when it is an allowed candidate, in the strict glue shape", async () => {
    const parent = blocked();
    const counter = await buildCounter(deps(new FakeGlue(), pick(65)), parent, [parent]);
    expect(counter?.parentProposalId).toBe(parent.id);
    expect(Object.keys(counter?.proposal ?? {}).sort()).toEqual(["metric", "plantId", "proposerComponentId", "rationale", "to"]);
    expect(counter?.proposal.to).toBe(65);
  });

  test("offers about 65 between 50 and 85: 70 overshoots the voter's ceiling", async () => {
    const parent = blocked();
    const llm = pick(65);
    await buildCounter(deps(new FakeGlue(), llm), parent, [parent]);
    const offered = llm.requests[0].user;
    expect(offered).toMatch(/^65 \|/m);
    expect(offered).not.toMatch(/^(70|75|80) \|/m);
  });

  test("a blocker on a metric that normally runs near its limit still leaves a counter", async () => {
    const parent = blocked();
    parent.votes.push({ ...noVote(parent.id), componentId: "plant-a/TK-101", agentId: "agent:plant-a/TK-101", predicted: { levelPct: 51, tempC: 77 } });
    const counter = await buildCounter(deps(new FakeGlue(), pick(65)), parent, [parent]);
    expect(counter?.proposal.to).toBe(65);
  });

  test("the same tag in both plants keeps separate ceilings", async () => {
    const parent = blocked();
    parent.votes.push({ ...noVote(parent.id), componentId: "plant-b/TV-101", agentId: "agent:plant-b/TV-101", predicted: { positionPct: 90 } }, { ...noVote(parent.id), componentId: "plant-a/TV-101", agentId: "agent:plant-a/TV-101", predicted: { positionPct: 88 } });
    const llm = pick(65);
    await buildCounter(deps(new FakeGlue(), llm), parent, [parent]);
    expect(llm.requests[0].user).toContain("plant-a/TV-101.positionPct");
    expect(llm.requests[0].user).toContain("plant-b/TV-101.positionPct");
  });

  test("a value outside the safe candidates is rejected, then the code's pick is labelled", async () => {
    const parent = blocked();
    const llm = pick(84);
    const counter = await buildCounter(deps(new FakeGlue(), llm), parent, [parent]);
    expect(llm.requests).toHaveLength(2);
    expect(counter?.proposal.to).toBe(65);
    expect(counter?.proposal.rationale).toContain("chosen by code");
  });

  test("a fallback pick keeps its vendor label", async () => {
    const parent = blocked();
    const llm = new ScriptedLlm(() => JSON.stringify({ value: 65, rationale: "safe history" }), { fallback: true, model: "gpt-6-luna" });
    const counter = await buildCounter(deps(new FakeGlue(), llm), parent, [parent]);
    expect(counter?.proposal.rationale).toContain("[GPT fallback: Claude CLI unavailable]");
  });

  test("stops at two counters per parent", async () => {
    const root = blocked();
    const first = blocked({ to: 70, from: 50, parentProposalId: root.id });
    const second = blocked({ to: 60, from: 50, parentProposalId: first.id });
    const third = blocked({ to: 58, from: 50, parentProposalId: second.id });
    const all = [root, first, second];
    expect(MAX_COUNTERS_PER_PARENT).toBe(2);
    expect(await buildCounter(deps(new FakeGlue(), pick(55)), second, all)).toBeNull();
    expect(await buildCounter(deps(new FakeGlue(), pick(55)), third, [...all, third])).toBeNull();
  });

  test("a parent is countered once", async () => {
    const parent = blocked();
    const child = makeProposal({ to: 65, parentProposalId: parent.id });
    expect(await buildCounter(deps(new FakeGlue(), pick(65)), parent, [parent, child])).toBeNull();
  });

  test("a forced repeat of a countered target stands as a plain block", async () => {
    const first = blocked();
    const child = makeProposal({ to: 65, parentProposalId: first.id, status: "executed" });
    const repeat = blocked({ from: 65, to: 85 });
    expect(await buildCounter(deps(new FakeGlue(), pick(70)), repeat, [first, child, repeat])).toBeNull();
  });

  test("no safe value between from and to means no counter", async () => {
    const parent = blocked({ from: 72, to: 85 });
    expect(await buildCounter(deps(new FakeGlue(), pick(75)), parent, [parent])).toBeNull();
  });

  test("a proposal that is not blocked is left alone", async () => {
    const parent = blocked({ status: "voting" });
    expect(await buildCounter(deps(new FakeGlue(), pick(65)), parent, [parent])).toBeNull();
  });
});

test("bestCandidate prefers the target closest to what was asked, among those with safe history", () => {
  const c = (value: number, safeRuns: number) => ({ value, safeRuns, peaks: {} });
  expect(bestCandidate([c(55, 4), c(60, 9), c(65, 5), c(70, 1)])?.value).toBe(65);
  expect(bestCandidate([c(55, 1), c(60, 2)])?.value).toBe(60);
  expect(bestCandidate([])).toBeNull();
});

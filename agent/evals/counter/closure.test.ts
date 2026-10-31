// The oracle for the open counter issues. Real agent/counter.ts and agent/vote.ts, FAKE model, no tokens spent.
// Each test fails until its issue is closed. bun test evals/counter/closure.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Proposal, Vote } from "../../../shared/types";
import { buildCounter, MAX_COUNTERS_PER_PARENT } from "../../counter";
import type { Llm, LlmReply, LlmRequest } from "../../llm";
import { RetrievalCache } from "../../retrieval";
import { castVote, thresholdFor } from "../../vote";
import { buildView, makeProposal, type Scenario } from "./fixture";
import { FixtureGlue } from "./glue";

const demo: Scenario = { id: "closure", group: "closure", plantId: "plant-a", from: 50, to: 85, margins: {}, history: "standin", rule: true, overshoot: 4 };

function model(rationale = "this target stays under the valve's limit"): Llm & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    async complete(request): Promise<LlmReply> {
      requests.push(request);
      const value = Number(request.user.match(/^(\d+(?:\.\d+)?) \|/m)?.[1]);
      return { text: JSON.stringify({ value, rationale }), provider: "openai", model: "fake", fallback: false };
    },
  };
}

function vote(proposal: Proposal, tag: string, predicted: Record<string, number>, reason: string): Vote {
  const componentId = `plant-a/${tag}`;
  return { proposalId: proposal.id, componentId, agentId: `agent:${componentId}`, vote: "no", reason, predicted, marginPct: 10, evidenceEventIds: [], evidenceRuleIds: [], similarCount: 5 };
}

const failedVote = (proposal: Proposal, tag: string) => vote(proposal, tag, {}, "malformed prediction");

// The live shape of the failure: LV-101 blocks 85 with evidence, the counter to 65 is refused only because a voter failed.
function afterFailedVoter(tag = "TV-101") {
  const view = buildView(demo);
  const parent = makeProposal(demo, view, 85, null, "test");
  parent.status = "blocked";
  parent.votes = [vote(parent, "LV-101", { positionPct: 89 }, "predicted positionPct 89 is at or past the 81 threshold")];
  const first = makeProposal(demo, view, 65, parent, "test");
  first.status = "blocked";
  first.votes = [failedVote(first, tag)];
  return { view, parent, first, chain: [parent, first] };
}

describe("issue 1: a failed voter must not end the counter chain", () => {
  for (const tag of ["TV-101", "TK-101", "E-101", "LV-101"]) {
    test(`${tag} failing on the first counter still gets a second counter`, async () => {
      const { view, first, chain } = afterFailedVoter(tag);
      const made = await buildCounter({ glue: new FixtureGlue(view), llm: model() }, first, chain);
      expect(made).not.toBeNull();
      expect(made!.proposal.to).toBeGreaterThan(50);
      expect(made!.proposal.to).toBeLessThan(65);
    });
  }

  test("the second counter still respects the cap", async () => {
    const { view, first, chain } = afterFailedVoter();
    const glue = new FixtureGlue(view);
    const made = await buildCounter({ glue, llm: model() }, first, chain);
    expect(made).not.toBeNull();
    const second = makeProposal(demo, view, made!.proposal.to, first, made!.proposal.rationale);
    second.status = "blocked";
    second.votes = [failedVote(second, "TV-101")];
    const llm = model();
    expect(MAX_COUNTERS_PER_PARENT).toBe(2);
    expect(await buildCounter({ glue, llm }, second, [...chain, second])).toBeNull();
    expect(llm.requests.length).toBe(0);
  });

  test("a chain with no real blocker anywhere stops with a reason, not a silent null", async () => {
    const view = buildView(demo);
    const parent = makeProposal(demo, view, 85, null, "test");
    parent.status = "blocked";
    parent.votes = [failedVote(parent, "LV-101")];
    const lines: string[] = [];
    const made = await buildCounter({ glue: new FixtureGlue(view), llm: model(), log: (line) => lines.push(line) }, parent, [parent]);
    expect(made).toBeNull();
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("issue 2: the label must say code picked the target", () => {
  const counter = async () => {
    const view = buildView(demo);
    const parent = makeProposal(demo, view, 85, null, "test");
    parent.status = "blocked";
    parent.votes = [vote(parent, "LV-101", { positionPct: 89 }, "predicted positionPct 89 is at or past the 81 threshold")];
    return (await buildCounter({ glue: new FixtureGlue(view), llm: model() }, parent, [parent]))!;
  };

  test("no field on the result says the model decided", async () => {
    const made = (await counter()) as { decidedBy?: string };
    expect(made.decidedBy ?? "code").not.toContain("openai");
  });

  test("the rationale does not say the model answered, and does say code set the target", async () => {
    const { rationale } = (await counter()).proposal;
    expect(rationale).not.toContain("[answered by");
    expect(rationale).toMatch(/code/i);
  });

  test("the rationale still names the model that wrote the explanation", async () => {
    expect((await counter()).proposal.rationale).toContain("openai fake");
  });

  test("the source header does not claim the model picks the value", () => {
    const source = readFileSync(join(import.meta.dir, "..", "..", "counter.ts"), "utf8");
    expect(source.split("\n")[0]).not.toContain("model picks");
  });

  test("HANDOFF.md does not tell readers a counter rationale means the model answered", () => {
    const handoff = readFileSync(join(import.meta.dir, "..", "..", "HANDOFF.md"), "utf8");
    expect(handoff).not.toContain("the same goes for counter rationales");
  });
});

describe("issue 3: a wider margin must never be less cautious", () => {
  const landing = async (marginPct: number) => {
    const s: Scenario = { ...demo, margins: { "LV-101": marginPct } };
    const view = buildView(s);
    const parent = makeProposal(s, view, 85, null, "test");
    parent.status = "blocked";
    parent.votes = [{ ...vote(parent, "LV-101", { positionPct: 95 }, "predicted positionPct 95 is past the threshold"), marginPct }];
    const made = await buildCounter({ glue: new FixtureGlue(view), llm: model() }, parent, [parent]);
    return made?.proposal.to ?? 0;
  };

  test("the counter never lands higher as LV-101's margin widens", async () => {
    const targets = await Promise.all([5, 10, 15, 20, 25].map(landing));
    for (let i = 1; i < targets.length; i++) expect(targets[i]!).toBeLessThanOrEqual(targets[i - 1]!);
  });

  test("widening LV-101's margin from 10 to 25 lowers the point it votes no at", () => {
    const limit = { min: 10, max: 80, critical: 90 };
    expect(thresholdFor(limit, 25)).toBeLessThan(thresholdFor(limit, 10) - 5);
  });

  test("a voter with a widened margin refuses what CLAUDE.MD says it must", async () => {
    const s: Scenario = { ...demo, to: 75, margins: { "LV-101": 25 } };
    const view = buildView(s);
    const proposal = makeProposal(s, view, 75, null, "test");
    const reply = JSON.stringify({ vote: "yes", reason: "under the limit", predicted: { positionPct: 78 } });
    const llm: Llm = { complete: async () => ({ text: reply, provider: "openai", model: "fake", fallback: false }) };
    const cast = await castVote({ glue: new FixtureGlue(view), llm, cache: new RetrievalCache() }, proposal, "plant-a/LV-101");
    expect(cast.vote).toBe("no"); // 78 is past 90 * (1 - 25/100) = 67.5
  });

  test("the tank's normal 75 C does not lock the plant at a wide margin", async () => {
    const s: Scenario = { ...demo, to: 60, margins: { "TK-101": 15 } };
    const view = buildView(s);
    const proposal = makeProposal(s, view, 60, null, "test");
    const reply = JSON.stringify({ vote: "yes", reason: "dip recovers", predicted: { levelPct: 50, tempC: 74 } });
    const llm: Llm = { complete: async () => ({ text: reply, provider: "openai", model: "fake", fallback: false }) };
    const cast = await castVote({ glue: new FixtureGlue(view), llm, cache: new RetrievalCache() }, proposal, "plant-a/TK-101");
    expect(cast.vote).toBe("yes");
  });
});

// The oracle for the two open counter issues. Real agent/counter.ts, FAKE model, no tokens spent.
// Each test fails until its issue is closed. bun test evals/counter/closure.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Proposal, Vote } from "../../../shared/types";
import { buildCounter, MAX_COUNTERS_PER_PARENT } from "../../counter";
import type { Llm, LlmReply, LlmRequest } from "../../llm";
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

  test("decidedBy does not credit the model", async () => {
    expect((await counter()).decidedBy).not.toContain("openai");
    expect((await counter()).decidedBy).toContain("code");
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

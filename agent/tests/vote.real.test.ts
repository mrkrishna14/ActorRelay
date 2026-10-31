// The listed vote cases, run against real model calls. Nothing here is scripted: a pass means the model plus the code
// enforcement produced these votes. Claude roles run on the labelled GPT fallback while the Claude CLI is logged out.
import { beforeAll, describe, expect, test } from "bun:test";
import type { Proposal } from "../../shared/types";
import { RoutedLlm } from "../llm";
import { RetrievalCache } from "../retrieval";
import { channelForVote } from "../runtime";
import { castVote as castRealVote, type VoteDeps } from "../vote";
import { companyRule, FakeGlue, makeProposal, usingStandInHistory } from "./fake-glue";

const llm = new RoutedLlm();
const deps = (glue: FakeGlue) => ({ glue, llm, cache: new RetrievalCache(), log: () => undefined });

function castVote(d: VoteDeps, proposal: Proposal, componentId: string) {
  (d.glue as FakeGlue).addProposal(proposal);
  return castRealVote(d, proposal, componentId);
}

beforeAll(async () => {
  if (usingStandInHistory) console.warn("history: labelled stand-in, shared/history.json has not landed");
  await llm.probeClaude();
});

describe("plant-a LV-101 on P-100", () => {
  test("votes no on 85 with at least 3 evidence ids and predicted positionPct >= 81", async () => {
    const vote = await castVote(deps(new FakeGlue()), makeProposal({ to: 85 }), "plant-a/LV-101");
    expect(vote.vote).toBe("no");
    expect(vote.evidenceEventIds.length).toBeGreaterThanOrEqual(3);
    expect(vote.predicted.positionPct).toBeGreaterThanOrEqual(81);
    expect(vote.similarCount).toBeGreaterThanOrEqual(3);
    expect(vote.agentId).toBe("agent:plant-a/LV-101");
  });

  test("votes yes on 65 with predicted positionPct 60-72", async () => {
    const vote = await castVote(deps(new FakeGlue()), makeProposal({ to: 65 }), "plant-a/LV-101");
    expect(vote.vote).toBe("yes");
    expect(vote.predicted.positionPct).toBeGreaterThanOrEqual(60);
    expect(vote.predicted.positionPct).toBeLessThanOrEqual(72);
  });
});

test("plant-b TV-101 votes on plant-a P-100 to 85 over the company channel with a predicted headerBarg drop", async () => {
  const glue = new FakeGlue();
  const proposal = makeProposal({ to: 85 });
  const current = (await glue.component("plant-b/TV-101")).metrics.headerBarg;
  const vote = await castVote(deps(glue), proposal, "plant-b/TV-101");
  expect(channelForVote(proposal, "plant-b/TV-101")).toBe("company");
  expect(vote.componentId).toBe("plant-b/TV-101");
  expect(vote.predicted.headerBarg).toBeLessThan(current);
});

describe("plant-b LV-101 with no history near 85", () => {
  const proposal = () => makeProposal({ plantId: "plant-b", to: 85 });

  test("votes no for insufficient history before the company rule exists", async () => {
    const vote = await castVote(deps(new FakeGlue()), proposal(), "plant-b/LV-101");
    expect(vote.vote).toBe("no");
    expect(vote.reason).toContain("insufficient history");
    expect(vote.similarCount).toBeLessThan(3);
    expect(vote.evidenceRuleIds).toEqual([]);
  });

  test("votes no citing the company rule once it exists", async () => {
    const glue = new FakeGlue();
    const rule = companyRule();
    glue.companyRules.push(rule);
    const vote = await castVote(deps(glue), proposal(), "plant-b/LV-101");
    expect(vote.vote).toBe("no");
    expect(vote.evidenceRuleIds).toContain(rule.id);
    expect(vote.reason).toContain(rule.id);
    expect(vote.reason).not.toContain("insufficient history");
  });
});

// Scope: vote.ts, retrieval.ts. Each test states the outcome code should produce; a failure is a finding.
import { describe, expect, test } from "bun:test";
import { component, event, proposal, reply } from "./fixtures";
import { pipeline, TARGET, type LlmFn } from "./harness";

const say = (...replies: string[]): LlmFn => async (_p, attempt) => replies[Math.min(attempt, replies.length - 1)];
const LV = () => component("plant-a/LV-101");
const TK = () => component("plant-a/TK-101");
const TV = "plant-a/TV-101";
const down = (to: number) =>
  proposal(to, { proposerComponentId: TV, proposerAgentId: `agent:${TV}`, metric: "positionPct", from: 50, requiredVoters: ["plant-a/E-101", "plant-a/TK-101"], crossPlant: false });

function lowEvent(id: string, tempC: number) {
  return event(id, 6, 50, {
    componentId: TV,
    metric: "positionPct",
    effects: [{ componentId: "plant-a/TK-101", metric: "tempC", before: 75, after: tempC, ticksToSettle: 5 }, { componentId: "plant-a/TK-101", metric: "levelPct", before: 50, after: 50, ticksToSettle: 5 }],
    incident: null,
  });
}

describe.skipIf(!pipeline)(`attack-vote [${TARGET}]`, () => {
  test("a model no is never turned into a yes by code", async () => {
    const events = [event("e1", 75, 78), event("e2", 75, 78)];
    const { vote } = await pipeline!({ proposal: proposal(75), own: LV(), events, llm: say(reply("no", { positionPct: 70 })) });
    expect(vote?.vote).toBe("no");
  });

  test("two runs near critical: a fast lowball cannot beat what provenNo already decided", async () => {
    const events = [event("e1", 75, 78), event("e2", 75, 78)];
    const { vote } = await pipeline!({ proposal: proposal(75), own: LV(), events, llm: say(reply("yes", { positionPct: 60 })) });
    expect(vote?.vote).toBe("no");
  });

  test("a supported no with a breach prediction is not argued away by the retry", async () => {
    const events = [74, 75, 75, 76, 76].map((after, i) => event(`e${i}`, after, 79));
    const { vote } = await pipeline!({ proposal: proposal(77), own: LV(), events, llm: say(reply("no", { positionPct: 82 }), reply("yes", { positionPct: 79 })) });
    expect(vote?.vote).toBe("no");
  });

  test("evidence below a minimum blocks a lowering, whatever the model predicts", async () => {
    const events = [1, 2, 3, 4, 5].map((i) => lowEvent(`low${i}`, 60));
    const { vote } = await pipeline!({ proposal: down(6), own: TK(), events, llm: say(reply("yes", { levelPct: 50, tempC: 74 })) });
    expect(vote?.vote).toBe("no");
  });

  test("a lowering to just above the minimum with no history is not a yes on priors alone", async () => {
    const { vote } = await pipeline!({ proposal: down(6), own: TK(), events: [], llm: say(reply("yes", { levelPct: 50, tempC: 74 })) });
    expect(vote?.vote).toBe("no");
  });

  test("an incident 0.1 above the target is not dropped from the peak", async () => {
    const events = [event("i", 85, 96), event("s1", 84, 70), event("s2", 84, 70), event("s3", 84, 70), event("s4", 84, 70)];
    const { vote } = await pipeline!({ proposal: proposal(84.9), own: LV(), events, llm: say(reply("yes", { positionPct: 72 })) });
    expect(vote?.vote).toBe("no");
  });
});

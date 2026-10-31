import { describe, expect, test } from "bun:test";
import { agentFlowLinks } from "./agent-flow";
import { createDemoState, DEMO_EPOCH, demoReducer } from "./demo";

describe("agent communication routes", () => {
  test("idle equipment has no fabricated communication", () => {
    const state = createDemoState();
    expect(agentFlowLinks(null, state.components, state.messages, DEMO_EPOCH)).toEqual([]);
  });

  test("a proposal reviews its four local peers and the other plant's steam valve", () => {
    const state = demoReducer(createDemoState(), { type: "propose", plantId: "plant-a", to: 65, now: DEMO_EPOCH });
    const links = agentFlowLinks(state.proposals.at(-1)!, state.components, state.messages, DEMO_EPOCH);
    expect(links).toHaveLength(5);
    expect(links.every((link) => link.from === "plant-a/P-100" && link.active)).toBe(true);
    expect(links.filter((link) => link.channel === "company").map((link) => link.to)).toEqual(["plant-b/TV-101"]);
    expect(links.some((link) => link.to === "plant-b/LV-101")).toBe(false);
  });

  test("recorded refusal reverses the arrow to the proposer and keeps evidence", () => {
    const state = createDemoState();
    const links = agentFlowLinks(state.proposals[0], state.components, state.messages, DEMO_EPOCH);
    const refusal = links.find((link) => link.kind === "no")!;
    expect(refusal.from).toBe("plant-a/LV-101");
    expect(refusal.to).toBe("plant-a/P-100");
    expect(refusal.evidence).toContain("rule-lv-03");
    expect(links.every((link) => !link.active)).toBe(true);
  });

  test("cross-plant review works in both directions and pending requests remain active after six seconds", () => {
    const state = demoReducer(createDemoState(), { type: "propose", plantId: "plant-b", to: 65, now: DEMO_EPOCH });
    const proposal = state.proposals.at(-1)!;
    const recent = agentFlowLinks(proposal, state.components, state.messages, DEMO_EPOCH);
    expect(recent.find((link) => link.channel === "company")?.to).toBe("plant-a/TV-101");
    expect(agentFlowLinks(proposal, state.components, state.messages, DEMO_EPOCH + 6000).every((link) => link.active)).toBe(true);
    expect(agentFlowLinks({ ...proposal, status: "blocked" }, state.components, state.messages, DEMO_EPOCH + 6000).every((link) => !link.active)).toBe(true);
  });

  test("a vote briefly pulses then settles while other pending requests keep animating", () => {
    let state = demoReducer(createDemoState(), { type: "propose", plantId: "plant-a", to: 65, now: DEMO_EPOCH });
    state = demoReducer(state, { type: "tick", now: DEMO_EPOCH + 1800 });
    const proposal = state.proposals.at(-1)!;
    expect(agentFlowLinks(proposal, state.components, state.messages, DEMO_EPOCH + 1800).find((link) => link.kind === "yes")?.active).toBe(true);
    const settled = agentFlowLinks(proposal, state.components, state.messages, DEMO_EPOCH + 9000);
    expect(settled.find((link) => link.kind === "yes")?.active).toBe(false);
    expect(settled.filter((link) => link.kind === "request").every((link) => link.active)).toBe(true);
  });
});


test("temperature and steam-flow proposals route reviews back to their actual proposing agent", () => {
  const state = createDemoState();
  for (const [proposerTag, metric, to] of [["TK-101", "tempC", 76], ["TV-101", "steamKgH", 1800]] as const) {
    const proposal = { ...state.proposals[0], proposerTag, metric, to, status: "voting" as const, votes: [] };
    const links = agentFlowLinks(proposal, state.components, state.messages, DEMO_EPOCH);
    expect(links).toHaveLength(5);
    expect(links.every((link) => link.from === `plant-a/${proposerTag}`)).toBe(true);
    expect(links.some((link) => link.to === "plant-a/P-100")).toBe(true);
    expect(links.some((link) => link.to === `plant-a/${proposerTag}`)).toBe(false);
    expect(links.find((link) => link.channel === "company")?.to).toBe("plant-b/TV-101");
    const voted = { ...proposal, votes: [{ tag: "P-100" as const, plantId: "plant-a" as const, vote: "yes" as const, predicted: 50, reason: "Feed remains stable", evidence: [] }] };
    expect(agentFlowLinks(voted, state.components, [], DEMO_EPOCH).find((link) => link.kind === "yes")?.to).toBe(`plant-a/${proposerTag}`);
  }
});

 test("temperature activity identifies the tank controller and retains the reviewer's actual refusal", async () => {
  const { demoAgentActivities } = await import("./agent-activity");
  const state = createDemoState();
  const proposal = { ...state.proposals[0], proposerTag: "TK-101" as const, metric: "tempC", from: 75, to: 79, status: "voting" as const, votes: [], createdAt: DEMO_EPOCH };
  const activities = demoAgentActivities({ ...state, proposals: [proposal] });
  const proposer = activities.find((activity) => activity.id === "plant-a/TK-101")!;
  expect(proposer.task).toContain("TIC-101");
  expect(proposer.task).toContain("79°C");
  expect(proposer.state).toBe("thinking");
  expect(activities.find((activity) => activity.id === "plant-a/P-100")?.task).toContain("Review");
  const blocked = { ...proposal, status: "blocked" as const, votes: [{ tag: "E-101" as const, plantId: "plant-a" as const, vote: "no" as const, predicted: 1700, reason: "Predicted coil duty exceeds available heating capacity", evidence: ["thermal-capacity-event"] }] };
  const refusal = demoAgentActivities({ ...state, proposals: [blocked] }).find((activity) => activity.id === "plant-a/E-101")!;
  expect(refusal.state).toBe("blocked");
  expect(refusal.summary).toBe(blocked.votes[0].reason);
  expect(refusal.evidence).toEqual(["thermal-capacity-event"]);
});

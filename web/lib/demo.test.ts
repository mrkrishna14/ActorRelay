import { describe, expect, test } from "bun:test";
import { createDemoState, demoReducer, DEMO_EPOCH, DEMO_REVIEW_MS, reviewVotes, type DemoState } from "./demo";
import type { ComponentTag, PlantId } from "./types";

const metric = (state: DemoState, tag: ComponentTag, name: string, plantId: PlantId = "plant-a") =>
  state.components.find((equipment) => equipment.plantId === plantId && equipment.tag === tag)!.metrics[name];
const latest = (state: DemoState) => state.proposals.at(-1)!;
const tick = (state: DemoState, now: number) => demoReducer(state, { type: "tick", now });
const propose = (state: DemoState, to: number, plantId: PlantId = "plant-a", now = DEMO_EPOCH) =>
  demoReducer(state, { type: "propose", plantId, to, now });
const review = (to: number) => tick(propose(createDemoState(), to), DEMO_EPOCH + DEMO_REVIEW_MS);

describe("frontend sample proposal lifecycle", () => {
  test("an unsafe 85% proposal is blocked with evidence and never applies equipment changes", () => {
    const initial = createDemoState();
    const proposed = propose(initial, 85);
    expect(latest(proposed).status).toBe("voting");
    expect(metric(proposed, "P-100", "speedPct")).toBe(50);
    const blocked = tick(proposed, DEMO_EPOCH + DEMO_REVIEW_MS);
    expect(latest(blocked).status).toBe("blocked");
    const objection = latest(blocked).votes.find((vote) => vote.vote === "no");
    expect(objection?.tag).toBe("LV-101");
    expect(objection?.predicted).toBeGreaterThan(81);
    expect(objection?.evidence.length).toBeGreaterThan(0);
    const later = tick(blocked, DEMO_EPOCH + 60_000);
    expect(later.components).toEqual(initial.components);
    expect(later.observation).toBeNull();
    expect(later.evidence).toEqual(initial.evidence);
    expect(latest(initial).id).toBe("p-014");
  });

  test("65% requires unanimous votes, the full veto window, then a distinct observed response", () => {
    const reviewed = review(65);
    const proposal = latest(reviewed);
    expect(proposal.status).toBe("veto_window");
    expect(proposal.votes).toHaveLength(5);
    expect(proposal.votes.every((vote) => vote.vote === "yes")).toBe(true);
    expect(proposal.vetoDeadline).toBe(DEMO_EPOCH + DEMO_REVIEW_MS + 10_000);
    const deadline = proposal.vetoDeadline!;
    const justBefore = tick(reviewed, deadline - 1);
    expect(latest(justBefore).status).toBe("veto_window");
    expect(metric(justBefore, "P-100", "speedPct")).toBe(50);
    const applied = tick(justBefore, deadline);
    expect(latest(applied).status).toBe("executed");
    expect(applied.observation?.proposalId).toBe(proposal.id);
    expect(applied.evidence.some((item) => item.id === `observed-${proposal.id}`)).toBe(false);
    const responding = tick(applied, deadline + 2500);
    expect(metric(responding, "P-100", "speedPct")).toBeCloseTo(57.5);
    expect(responding.observation).not.toBeNull();
    const observed = tick(responding, deadline + 5000);
    expect(metric(observed, "P-100", "speedPct")).toBe(65);
    expect(metric(observed, "LV-101", "positionPct")).toBe(67);
    expect(observed.observation).toBeNull();
    const record = observed.evidence.find((item) => item.id === `observed-${proposal.id}`);
    expect(record?.predicted).toBe(66);
    expect(record?.observed).toBe(67);
    expect(record?.summary).toContain("Frontend demo observation");
    expect(observed.messages.some((item) => item.evidence?.includes(record!.id))).toBe(true);
  });

  test("a veto before the deadline prevents application and observation", () => {
    const reviewed = review(65);
    const proposal = latest(reviewed);
    const vetoed = demoReducer(reviewed, { type: "veto", id: proposal.id, now: proposal.vetoDeadline! - 1 });
    expect(latest(vetoed).status).toBe("vetoed");
    const later = tick(vetoed, proposal.vetoDeadline! + 20_000);
    expect(metric(later, "P-100", "speedPct")).toBe(50);
    expect(metric(later, "LV-101", "positionPct")).toBe(50);
    expect(later.observation).toBeNull();
    expect(later.evidence.some((item) => item.id === `observed-${proposal.id}`)).toBe(false);
  });

  test("a veto at the exact deadline is too late and does not suppress execution", () => {
    const reviewed = review(65);
    const proposal = latest(reviewed);
    const tooLate = demoReducer(reviewed, { type: "veto", id: proposal.id, now: proposal.vetoDeadline! });
    expect(tooLate).toBe(reviewed);
    expect(latest(tick(tooLate, proposal.vetoDeadline!)).status).toBe("executed");
  });

  test("invalid numeric targets do not create proposals or change equipment", () => {
    for (const to of [19, 91, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const initial = createDemoState();
      const rejected = propose(initial, to);
      expect(rejected.proposals).toEqual(initial.proposals);
      expect(rejected.components).toEqual(initial.components);
      expect(rejected.observation).toBeNull();
      expect(rejected.messages.at(-1)?.kind).toBe("system");
      expect(rejected.messages.at(-1)?.text).toContain("between 20% and 90%");
    }
  });

  test("duplicate proposals cannot start during voting, the veto window, or observation", () => {
    const voting = propose(createDemoState(), 65);
    expect(propose(voting, 70).proposals).toHaveLength(voting.proposals.length);
    expect(propose(voting, 70, "plant-b").proposals).toHaveLength(voting.proposals.length);
    const reviewed = tick(voting, DEMO_EPOCH + DEMO_REVIEW_MS);
    expect(propose(reviewed, 70).proposals).toHaveLength(reviewed.proposals.length);
    expect(propose(reviewed, 70, "plant-b").proposals).toHaveLength(reviewed.proposals.length);
    const observing = tick(reviewed, latest(reviewed).vetoDeadline!);
    expect(observing.observation).not.toBeNull();
    expect(propose(observing, 70).proposals).toHaveLength(observing.proposals.length);
    expect(propose(observing, 70, "plant-b").proposals).toHaveLength(observing.proposals.length);
    const observed = tick(observing, latest(reviewed).vetoDeadline! + 5000);
    const nextPlant = propose(observed, 65, "plant-b", observed.now);
    expect(nextPlant.proposals).toHaveLength(observed.proposals.length + 1);
    expect(latest(nextPlant).plantId).toBe("plant-b");
    expect(latest(nextPlant).status).toBe("voting");
  });

  test("both directions require the other plant's TV-101 shared-resource vote", () => {
    for (const plantId of ["plant-a", "plant-b"] as const) {
      const votes = reviewVotes(plantId, 65);
      expect(votes).toHaveLength(5);
      expect(votes.filter((vote) => vote.plantId === plantId)).toHaveLength(4);
      const external = votes.filter((vote) => vote.plantId !== plantId);
      expect(external).toHaveLength(1);
      expect(external[0].tag).toBe("TV-101");
      expect(external[0].vote).toBe("yes");
      expect(external[0].reason).toContain("Cross-plant");
    }
  });

  test("company-channel messages never create a plant setpoint proposal", () => {
    const initial = createDemoState();
    const result = demoReducer(initial, { type: "send", text: "Propose 85%", channel: "company", now: DEMO_EPOCH });
    expect(result.proposals).toEqual(initial.proposals);
    expect(result.components).toEqual(initial.components);
    expect(result.messages.at(-2)?.channel).toBe("company");
    expect(result.messages.at(-2)?.kind).toBe("operator");
    expect(result.messages.at(-1)?.text).toContain("Select a plant");
  });
});

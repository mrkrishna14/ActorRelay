import { describe, expect, test } from "bun:test";
import {
  captionFor,
  crossPlantFeed,
  itLearned,
  latestThread,
  mergedAudit,
  metricLevel,
  outlinesFor,
  plantLearned,
  refusalThreshold,
  ruleSourcePlant,
  simStatus,
  voterState,
  type Plants,
} from "./derive";
import type { AuditEntry, CompanyState, HistoryEvent, LearnedRule, PlantId, PlantState, Proposal, Vote } from "./types";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 31, 13, 0, seconds)).toISOString();

function vote(proposalId: string, componentId: string, overrides: Partial<Vote> = {}): Vote {
  return {
    proposalId,
    componentId,
    agentId: `agent:${componentId}`,
    vote: "yes",
    reason: "ok",
    predicted: { positionPct: 60 },
    marginPct: 10,
    evidenceEventIds: [],
    evidenceRuleIds: [],
    similarCount: 3,
    ...overrides,
  };
}

function proposal(id: string, plantId: PlantId, seconds: number, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id,
    at: at(seconds),
    plantId,
    proposerComponentId: `${plantId}/P-100`,
    proposerAgentId: "operator",
    metric: "speedPct",
    from: 50,
    to: 85,
    rationale: "test",
    requiredVoters: [`${plantId}/LV-101`, `${plantId}/TV-101`],
    votes: [],
    status: "voting",
    vetoDeadline: null,
    parentProposalId: null,
    crossPlant: false,
    ...overrides,
  };
}

function event(id: string, plantId: PlantId, seconds: number, proposalId: string | null): HistoryEvent {
  return {
    id,
    at: at(seconds),
    plantId,
    componentId: `${plantId}/P-100`,
    metric: "speedPct",
    before: 50,
    after: 65,
    upstreamSnapshot: {},
    effects: [],
    incident: null,
    approvedBy: [],
    operator: null,
    proposalId,
  };
}

function plant(id: PlantId, overrides: Partial<PlantState> = {}): PlantState {
  return { id, name: id === "plant-a" ? "Plant A" : "Plant B", components: [], proposals: [], history: [], rules: [], audit: [], tick: 0, connected: true, ...overrides };
}

function companyRule(text: string, overrides: Partial<LearnedRule> = {}): LearnedRule {
  return {
    id: "company-rule:outlet",
    scope: "company",
    model: "outlet-valve-A",
    text,
    condition: { componentId: null, metric: "speedPct", op: ">=", value: 80 },
    consequence: { componentId: null, metric: "positionPct", op: ">=", value: 85, withinTicks: 8 },
    supportEventIds: ["seed-1"],
    timesSeen: 80,
    createdAt: at(0),
    lastSeenAt: at(0),
    ...overrides,
  };
}

function company(rules: LearnedRule[]): CompanyState {
  return { plants: ["plant-a", "plant-b"], sharedResources: [], rules, crossPlantProposals: [], audit: [] };
}

const block = (refId: string, seconds: number): AuditEntry => ({ at: at(seconds), plantId: "plant-a", kind: "block", refId, summary: "blocked", by: "agent" });

describe("It learned", () => {
  const executed = proposal("run", "plant-a", 10, { status: "executed", to: 65 });
  const liveEvent = event("live-1", "plant-a", 20, "run");

  test("shows when a block in the newest thread cites a run executed this session", () => {
    const repeat = proposal("repeat", "plant-a", 30, {
      status: "blocked",
      votes: [vote("repeat", "plant-a/LV-101", { vote: "no", evidenceEventIds: ["live-1", "seed-1"] })],
    });
    const state = plant("plant-a", { proposals: [executed, repeat], history: [event("seed-1", "plant-a", 0, null), liveEvent], audit: [block("repeat", 33)] });
    const caption = itLearned(state);
    expect(caption?.text).toBe("It learned.");
    expect(caption?.evidenceNumber).toBe(1);
    expect(caption?.blockedInMs).toBe(3000);
  });

  test("does not show for a block citing only seeded history", () => {
    const first = proposal("first", "plant-a", 5, { status: "blocked", votes: [vote("first", "plant-a/LV-101", { vote: "no", evidenceEventIds: ["seed-1"] })] });
    expect(itLearned(plant("plant-a", { proposals: [first], history: [event("seed-1", "plant-a", 0, null)] }))).toBeNull();
  });

  test("does not show when the cited event's proposal is not held any more, as after reset", () => {
    const repeat = proposal("repeat", "plant-a", 30, { status: "blocked", votes: [vote("repeat", "plant-a/LV-101", { vote: "no", evidenceEventIds: ["live-1"] })] });
    expect(itLearned(plant("plant-a", { proposals: [repeat], history: [liveEvent] }))).toBeNull();
  });

  test("does not show while voting, even with the evidence already cited", () => {
    const repeat = proposal("repeat", "plant-a", 30, { status: "voting", votes: [vote("repeat", "plant-a/LV-101", { vote: "no", evidenceEventIds: ["live-1"] })] });
    expect(itLearned(plant("plant-a", { proposals: [executed, repeat], history: [liveEvent] }))).toBeNull();
  });

  test("does not show for a yes vote citing the run, and not for a run newer than the proposal", () => {
    const blockedBySomeoneElse = proposal("repeat", "plant-a", 30, {
      status: "blocked",
      votes: [vote("repeat", "plant-a/TV-101", { vote: "yes", evidenceEventIds: ["live-1"] }), vote("repeat", "plant-a/LV-101", { vote: "no" })],
    });
    expect(itLearned(plant("plant-a", { proposals: [executed, blockedBySomeoneElse], history: [liveEvent] }))).toBeNull();

    const earlier = proposal("repeat", "plant-a", 15, { status: "blocked", votes: [vote("repeat", "plant-a/LV-101", { vote: "no", evidenceEventIds: ["live-1"] })] });
    expect(itLearned(plant("plant-a", { proposals: [executed, earlier], history: [liveEvent] }))).toBeNull();
  });

  test("stays while the block's counter-proposal runs, and goes when a new proposal starts", () => {
    const repeat = proposal("repeat", "plant-a", 30, { status: "blocked", votes: [vote("repeat", "plant-a/LV-101", { vote: "no", evidenceEventIds: ["live-1"] })] });
    const counter = proposal("counter", "plant-a", 34, { parentProposalId: "repeat", to: 70 });
    const withCounter = plant("plant-a", { proposals: [executed, repeat, counter], history: [liveEvent] });
    expect(itLearned(withCounter)).not.toBeNull();
    const fresh = proposal("fresh", "plant-a", 50);
    expect(itLearned({ ...withCounter, proposals: [...withCounter.proposals, fresh] })).toBeNull();
  });

  test("reports both block times without claiming the repeat was faster", () => {
    const first = proposal("first", "plant-a", 5, { status: "blocked" });
    const repeat = proposal("repeat", "plant-a", 30, { status: "blocked", votes: [vote("repeat", "plant-a/LV-101", { vote: "no", evidenceEventIds: ["live-1"] })] });
    const caption = itLearned(plant("plant-a", { proposals: [first, executed, repeat], history: [liveEvent], audit: [block("first", 8), block("repeat", 32)] }));
    expect(caption?.firstBlockedInMs).toBe(3000);
    expect(caption?.blockedInMs).toBe(2000);
  });
});

describe("Plant B learned from Plant A", () => {
  const rule = companyRule("P-100 speedPct >= 80 -> LV-101 positionPct >= 85 within 8 ticks, seen 80 times (first learned in plant-a)");
  const blockedOnRule = proposal("b-85", "plant-b", 40, { status: "blocked", votes: [vote("b-85", "plant-b/LV-101", { vote: "no", evidenceRuleIds: [rule.id] })] });

  test("shows when plant-b refuses on a company rule first learned in plant-a", () => {
    const plants: Plants = { "plant-a": plant("plant-a"), "plant-b": plant("plant-b", { proposals: [blockedOnRule] }) };
    const caption = plantLearned("plant-b", plants, company([rule]));
    expect(caption?.text).toBe("Plant B learned from Plant A.");
    expect(captionFor("plant-b", plants, company([rule]))?.kind).toBe("plant-learned");
  });

  test("works with the null component ids company rules carry", () => {
    expect(rule.condition.componentId).toBeNull();
    expect(ruleSourcePlant(rule, {})).toBe("plant-a");
  });

  test("does not show before the block, or for a plant-scoped rule, or for the plant that learned it", () => {
    const voting = { ...blockedOnRule, status: "voting" as const };
    expect(plantLearned("plant-b", { "plant-b": plant("plant-b", { proposals: [voting] }) }, company([rule]))).toBeNull();

    const plantScoped = companyRule(rule.text, { scope: "plant" });
    expect(plantLearned("plant-b", { "plant-b": plant("plant-b", { proposals: [blockedOnRule] }) }, company([plantScoped]))).toBeNull();

    const own = companyRule("same (first learned in plant-b)");
    expect(plantLearned("plant-b", { "plant-b": plant("plant-b", { proposals: [blockedOnRule] }) }, company([own]))).toBeNull();
  });

  test("does not show when the refusal cites no rule, or the rule is unknown to company", () => {
    const noRule = { ...blockedOnRule, votes: [vote("b-85", "plant-b/LV-101", { vote: "no" })] };
    expect(plantLearned("plant-b", { "plant-b": plant("plant-b", { proposals: [noRule] }) }, company([rule]))).toBeNull();
    expect(plantLearned("plant-b", { "plant-b": plant("plant-b", { proposals: [blockedOnRule] }) }, company([]))).toBeNull();
  });

  test("a yes vote citing the rule is not a refusal", () => {
    const yes = { ...blockedOnRule, votes: [vote("b-85", "plant-b/LV-101", { vote: "yes", evidenceRuleIds: [rule.id] }), vote("b-85", "plant-b/TV-101", { vote: "no" })] };
    expect(plantLearned("plant-b", { "plant-b": plant("plant-b", { proposals: [yes] }) }, company([rule]))).toBeNull();
  });

  test("falls back to support events when the text carries no provenance", () => {
    const bare = companyRule("no provenance here");
    const plants: Plants = { "plant-a": plant("plant-a", { history: [event("seed-1", "plant-a", 0, null)] }), "plant-b": plant("plant-b") };
    expect(ruleSourcePlant(bare, plants)).toBe("plant-a");
  });
});

describe("threads and outlines", () => {
  test("nests counters under the blocked parent and follows the newest proposal", () => {
    const parent = proposal("parent", "plant-a", 1, { status: "blocked" });
    const counter = proposal("counter", "plant-a", 2, { parentProposalId: "parent", status: "voting", to: 65 });
    const older = proposal("older", "plant-a", 0, { status: "expired" });
    const thread = latestThread(plant("plant-a", { proposals: [older, counter, parent] }));
    expect(thread?.proposal.id).toBe("parent");
    expect(thread?.children.map((child) => child.proposal.id)).toEqual(["counter"]);
  });

  test("voter words follow the votes and never call a closed proposal voting", () => {
    const open = proposal("p", "plant-a", 1, { votes: [vote("p", "plant-a/LV-101", { vote: "no" })] });
    expect(voterState(open, "plant-a/LV-101")).toBe("no");
    expect(voterState(open, "plant-a/TV-101")).toBe("voting");
    expect(voterState({ ...open, status: "blocked" }, "plant-a/TV-101")).toBe("no vote");
  });

  test("outlines the other plant's voter on the shared header, and clears after execution", () => {
    const crossing = proposal("p", "plant-a", 1, { requiredVoters: ["plant-a/LV-101", "plant-b/TV-101"], crossPlant: true });
    const plants: Plants = { "plant-a": plant("plant-a", { proposals: [crossing] }), "plant-b": plant("plant-b") };
    expect(outlinesFor("plant-b", plants).get("TV-101")?.fromPlant).toBe("plant-a");
    expect(outlinesFor("plant-a", plants).get("LV-101")?.state).toBe("voting");

    const done: Plants = { "plant-a": plant("plant-a", { proposals: [{ ...crossing, status: "executed" }] }), "plant-b": plant("plant-b") };
    expect(outlinesFor("plant-a", done).size).toBe(0);
    expect(outlinesFor("plant-b", done).size).toBe(0);
  });

  test("a blocked proposal keeps the refusing voter pulsing and stops the others", () => {
    const blocked = proposal("p", "plant-a", 1, { status: "blocked", votes: [vote("p", "plant-a/LV-101", { vote: "no" }), vote("p", "plant-a/TV-101")] });
    const outlines = outlinesFor("plant-a", { "plant-a": plant("plant-a", { proposals: [blocked] }) });
    expect(outlines.get("LV-101")?.pulsing).toBe(true);
    expect(outlines.get("TV-101")?.pulsing).toBe(false);
  });
});

describe("limits and small reads", () => {
  test("the refusal threshold matches the LV-101 worked example", () => {
    expect(refusalThreshold({ min: 10, max: 80, critical: 90 }, 10)).toBeCloseTo(81);
  });

  test("metric levels", () => {
    const limit = { min: 10, max: 80, critical: 90 };
    expect(metricLevel(50, limit)).toBe("ok");
    expect(metricLevel(85, limit)).toBe("warning");
    expect(metricLevel(5, limit)).toBe("warning");
    expect(metricLevel(90, limit)).toBe("critical");
  });

  test("merged audit is newest first without duplicates", () => {
    const entry = block("p", 3);
    const plants: Plants = { "plant-a": plant("plant-a", { audit: [block("q", 1), entry] }) };
    const merged = mergedAudit(plants, { ...company([]), audit: [entry] });
    expect(merged.map((item) => item.refId)).toEqual(["p", "q"]);
  });

  test("cross-plant feed resolves ids to proposals, newest first", () => {
    const a = proposal("a", "plant-a", 1, { crossPlant: true });
    const b = proposal("b", "plant-b", 2, { crossPlant: true });
    const plants: Plants = { "plant-a": plant("plant-a", { proposals: [a] }), "plant-b": plant("plant-b", { proposals: [b] }) };
    const feed = crossPlantFeed({ ...company([]), crossPlantProposals: ["a", "b", "gone"] }, plants);
    expect(feed.map((item) => item.id)).toEqual(["b", "a"]);
  });

  test("sim status reads the connection and whether ticks advance", () => {
    expect(simStatus(undefined, undefined, 0).word).toBe("starting");
    expect(simStatus(plant("plant-a", { connected: false }), 0, 0).word).toBe("disconnected");
    expect(simStatus(plant("plant-a"), 0, 9000).word).toBe("stalled");
    expect(simStatus(plant("plant-a"), 8000, 9000).word).toBe("running");
  });
});

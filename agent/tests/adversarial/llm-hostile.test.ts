// A hostile or broken model against the vote pipeline. Every reply here must end in `no` or no vote at all.
// Proposal to 65 has safe evidence, so a well-behaved reply there is a yes. That makes validation the only thing
// standing between each malformed reply and a yes.
import { afterAll, describe, expect, test } from "bun:test";
import type { Vote } from "../../../shared/types";
import { component, isSafeOutcome, proposal, reply, RULE_85, SAFE_EVENTS, UNSAFE_EVENTS, event } from "./fixtures";
import { pipeline, TARGET, type LlmFn } from "./harness";

const say = (...replies: string[]): LlmFn => async (_p, attempt) => replies[Math.min(attempt, replies.length - 1)];
const GOOD = reply("yes", { positionPct: 66 });
const LV = () => component("plant-a/LV-101");
const VOTE_KEYS = ["agentId", "componentId", "evidenceEventIds", "evidenceRuleIds", "marginPct", "predicted", "proposalId", "reason", "similarCount", "vote"];

async function run(llm: LlmFn, to = 65, events = to === 65 ? SAFE_EVENTS() : UNSAFE_EVENTS(), own = LV()) {
  return pipeline!({ proposal: proposal(to), own, events, llm });
}

describe.skipIf(!pipeline)(`hostile LLM replies [${TARGET}]`, () => {
  test("control: a well-formed reply on a safe proposal is a yes, so these tests can fail", async () => {
    const { vote } = await run(say(GOOD));
    expect(vote?.vote).toBe("yes");
  });

  const malformedPredicted: [string, string][] = [
    ["empty predicted", reply("yes", {})],
    ["missing predicted", JSON.stringify({ vote: "yes", reason: "r", marginPct: 10, evidenceEventIds: [], evidenceRuleIds: [], similarCount: 5 })],
    ["wrong metric name", reply("yes", { PositionPct: 66 })],
    ["only an unrelated metric", reply("yes", { flowM3h: 1 })],
    ["string number", reply("yes", { positionPct: "66" })],
    ["numeric text with junk", reply("yes", { positionPct: "66abc" })],
    ["null", reply("yes", { positionPct: null })],
    ["array", reply("yes", { positionPct: [66] })],
    ["object", reply("yes", { positionPct: { value: 66 } })],
    ["boolean", reply("yes", { positionPct: false })],
    ["negative", reply("yes", { positionPct: -5 })],
    ["tiny negative", reply("yes", { positionPct: -0.0001 })],
    ["-1e999 parses to -Infinity", reply("yes", { positionPct: 0 }).replace('"positionPct":0', '"positionPct":-1e999')],
    ["1e999 parses to Infinity", reply("yes", { positionPct: 0 }).replace('"positionPct":0', '"positionPct":1e999')],
    ["bare NaN", reply("yes", { positionPct: 0 }).replace('"positionPct":0', '"positionPct":NaN')],
    ["bare Infinity", reply("yes", { positionPct: 0 }).replace('"positionPct":0', '"positionPct":Infinity')],
    ["huge finite", reply("yes", { positionPct: 1e308 })],
    ["far past physical range", reply("yes", { positionPct: 150 })],
    ["below min limit", reply("yes", { positionPct: 5 })],
  ];
  for (const [name, raw] of malformedPredicted) {
    test(`predicted: ${name}`, async () => {
      const { vote } = await run(say(raw));
      expect(isSafeOutcome(vote)).toBe(true);
    });
  }

  const malformedVote: [string, unknown][] = [
    ["YES", "YES"],
    ["Yes", "Yes"],
    ["trailing space", "yes "],
    ["true", true],
    ["1", 1],
    ["array", ["yes"]],
    ["null", null],
    ["approve", "approve"],
  ];
  for (const [name, value] of malformedVote) {
    test(`vote field: ${name}`, async () => {
      const { vote } = await run(say(reply("yes", { positionPct: 66 }, { vote: value })));
      expect(isSafeOutcome(vote)).toBe(true);
    });
  }

  const notAVote: [string, string][] = [
    ["empty", ""],
    ["whitespace", "   \n"],
    ["plain yes", "yes"],
    ["prose", "I approve this change."],
    ["truncated", GOOD.slice(0, 40)],
    ["null", "null"],
    ["true", "true"],
    ["number", "42"],
    ["array of vote", `[${GOOD}]`],
    ["only vote field", '{"vote":"yes"}'],
    ["own proto vote", `{"__proto__":{"vote":"yes"},"reason":"r","predicted":{"positionPct":66}}`],
    ["1 MB of junk", "x".repeat(1 << 20)],
  ];
  for (const [name, raw] of notAVote) {
    test(`not a vote: ${name} ends safe after exactly one retry`, async () => {
      let calls = 0;
      const { vote } = await run(async () => (calls++, raw));
      expect(isSafeOutcome(vote)).toBe(true);
      expect(calls).toBeLessThanOrEqual(2);
      expect(({} as any).vote).toBeUndefined();
    });
  }

  test("__proto__ in the reply does not pollute Object.prototype", async () => {
    await run(say(`{"__proto__":{"polluted":true,"vote":"yes"},"vote":"no","reason":"r","predicted":{"positionPct":66},"marginPct":10,"evidenceEventIds":[],"evidenceRuleIds":[],"similarCount":5}`));
    expect(({} as any).polluted).toBeUndefined();
    expect(({} as any).vote).toBeUndefined();
  });

  describe("fields the model must not control", () => {
    test("extra fields never reach the vote", async () => {
      const { vote } = await run(say(reply("yes", { positionPct: 66 }, { override: true, forceYes: true, status: "executed", token: "t" })));
      if (vote) expect(Object.keys(vote).sort()).toEqual(VOTE_KEYS);
    });

    test("identity fields are overwritten or the reply is rejected", async () => {
      const { vote } = await run(say(reply("yes", { positionPct: 66 }, { componentId: "plant-b/TV-101", agentId: "agent:plant-b/TV-101", proposalId: "other" })));
      if (vote) {
        expect(vote.componentId).toBe("plant-a/LV-101");
        expect(vote.agentId).toBe("agent:plant-a/LV-101");
        expect(vote.proposalId.startsWith("prop-1")).toBe(true);
      }
    });

    test("invented evidence ids never appear", async () => {
      const { vote } = await run(say(reply("yes", { positionPct: 66 }, { evidenceEventIds: ["evt-invented", "evt-65-a"], evidenceRuleIds: ["rule-invented"] })));
      if (vote) {
        const real = new Set(SAFE_EVENTS().map((e) => e.id));
        for (const id of vote.evidenceEventIds) expect(real.has(id)).toBe(true);
        expect(vote.evidenceRuleIds).toEqual([]);
      }
    });

    test("a no may not cite invented evidence either", async () => {
      const { vote } = await run(say(reply("no", { positionPct: 95 }, { evidenceEventIds: ["evt-invented"] })), 85);
      expect(vote?.evidenceEventIds ?? []).not.toContain("evt-invented");
    });

    test("inflated similarCount is replaced by the retrieved count", async () => {
      const { vote } = await run(say(reply("yes", { positionPct: 66 }, { similarCount: 999 })));
      if (vote) expect(vote.similarCount).toBe(3);
    });

    for (const fake of [0, -100, 1000, 1e308]) {
      test(`reply marginPct ${fake} does not move the threshold`, async () => {
        const { vote } = await run(say(reply("yes", { positionPct: 85 }, { marginPct: fake })), 65);
        expect(isSafeOutcome(vote)).toBe(true);
        if (vote) expect(vote.marginPct).toBe(10);
      });
    }
  });

  describe("evidence beats a confident lowball", () => {
    for (const predicted of [66, 80, 80.99, 80.999999999]) {
      test(`yes with predicted ${predicted} on P-100 -> 85 while evidence shows 90+`, async () => {
        const { vote } = await run(say(reply("yes", { positionPct: predicted })), 85);
        expect(vote?.vote ?? "no").toBe("no");
      });
    }

    test("the forced no cites the real unsafe events", async () => {
      const { vote } = await run(say(reply("yes", { positionPct: 66 })), 85);
      if (vote) expect(vote.evidenceEventIds.length).toBeGreaterThanOrEqual(3);
    });

    test("duplicate key: no then yes in one reply cannot beat the evidence", async () => {
      const raw = reply("yes", { positionPct: 66 }).replace('"vote":"yes"', '"vote":"no","vote":"yes"');
      const { vote } = await run(say(raw), 85);
      expect(vote?.vote ?? "no").toBe("no");
    });

    test("two JSON objects in one reply cannot beat the evidence", async () => {
      const { vote } = await run(say(`${reply("no", { positionPct: 95 })}\n${reply("yes", { positionPct: 66 })}`), 85);
      expect(vote?.vote ?? "no").toBe("no");
    });

    test("an applicable LearnedRule forces no even with no unsafe events retrieved", async () => {
      const events = [event("evt-70-a", 70, 71), event("evt-71-b", 71, 72), event("evt-72-c", 72, 73)];
      const { vote } = await pipeline!({ proposal: proposal(85), own: LV(), events, rules: [RULE_85], llm: say(reply("yes", { positionPct: 70 })) });
      expect(vote?.vote ?? "no").toBe("no");
      if (vote) expect(vote.evidenceRuleIds).toContain(RULE_85.id);
    });

    test("safe run at 65 is not vetoed by unsafe runs at 85 (over-blocking check)", async () => {
      const { vote } = await run(say(reply("yes", { positionPct: 67 })));
      expect(vote?.vote).toBe("yes");
    });
  });

  describe("threshold boundary, every margin", () => {
    for (const marginPct of [5, 10, 15, 20, 25]) {
      const threshold = Math.max(90 * (1 - marginPct / 100), 80);
      const safe = [event("evt-1", 40, 41), event("evt-2", 41, 42), event("evt-3", 42, 43)];
      test(`margin ${marginPct}: predicted exactly at ${threshold} is a no`, async () => {
        const { vote } = await pipeline!({ proposal: proposal(45), own: component("plant-a/LV-101", { marginPct }), events: safe, llm: say(reply("yes", { positionPct: threshold }, { marginPct })) });
        expect(vote?.vote ?? "no").toBe("no");
      });
    }
  });

  describe("multi-metric voter: every limited metric must be predicted", () => {
    const tv = () => component("plant-a/TV-101");
    const tvReply = (predicted: Record<string, unknown>) => reply("yes", predicted, { componentId: "plant-a/TV-101", agentId: "agent:plant-a/TV-101" });
    test("control: both metrics safe is a yes", async () => {
      const { vote } = await pipeline!({ proposal: proposal(65), own: tv(), events: SAFE_EVENTS(), llm: say(tvReply({ positionPct: 62, steamKgH: 1980, headerBarg: 5.8 })) });
      expect(vote?.vote).toBe("yes");
    });
    test("steamKgH left out", async () => {
      const { vote } = await pipeline!({ proposal: proposal(65), own: tv(), events: SAFE_EVENTS(), llm: say(tvReply({ positionPct: 62, headerBarg: 5.8 })) });
      expect(isSafeOutcome(vote)).toBe(true);
    });
    test("second metric past threshold", async () => {
      const { vote } = await pipeline!({ proposal: proposal(65), own: tv(), events: SAFE_EVENTS(), llm: say(tvReply({ positionPct: 62, steamKgH: 2700, headerBarg: 5.8 })) });
      expect(vote?.vote ?? "no").toBe("no");
    });
    test("tank temperature predicted under its minimum is not safe", async () => {
      const tk = component("plant-a/TK-101");
      const raw = reply("yes", { levelPct: 52, tempC: 60 }, { componentId: "plant-a/TK-101", agentId: "agent:plant-a/TK-101" });
      const { vote } = await pipeline!({ proposal: proposal(65), own: tk, events: SAFE_EVENTS(), llm: say(raw) });
      expect(vote?.vote ?? "no").toBe("no");
    });
  });

  describe("insufficient history", () => {
    test("no events, model claims 99 similar and a low prediction on P-100 -> 85", async () => {
      const { vote } = await pipeline!({ proposal: proposal(85), own: LV(), events: [], llm: say(reply("yes", { positionPct: 60 }, { similarCount: 99 })) });
      expect(vote?.vote ?? "no").toBe("no");
      if (vote) expect(vote.similarCount).toBe(0);
    });

    test("two events is under the minimum", async () => {
      const events = [event("evt-1", 84, 70), event("evt-2", 85, 71)];
      const { vote } = await pipeline!({ proposal: proposal(85), own: LV(), events, llm: say(reply("yes", { positionPct: 72 })) });
      expect(vote?.vote ?? "no").toBe("no");
    });

    test("five events that are nowhere near the proposal do not count as history (plant-b)", async () => {
      const events = [50, 52, 54, 56, 58].map((after, i) => event(`evt-b-${i}`, after, after + 1, { plantId: "plant-b" }));
      const own = component("plant-b/LV-101");
      const p = proposal(85, { plantId: "plant-b", proposerComponentId: "plant-b/P-100", proposerAgentId: "agent:plant-b/P-100" });
      const raw = reply("yes", { positionPct: 70 }, { componentId: own.id, agentId: `agent:${own.id}` });
      const { vote } = await pipeline!({ proposal: p, own, events, llm: say(raw) });
      expect(vote?.vote ?? "no").toBe("no");
    });

    test("events with no effect row for this component are not evidence for it", async () => {
      const events = UNSAFE_EVENTS().map((e) => ({ ...e, effects: e.effects.filter((x) => x.componentId !== "plant-a/LV-101") }));
      const { vote } = await pipeline!({ proposal: proposal(85), own: LV(), events, llm: say(reply("yes", { positionPct: 70 })) });
      expect(vote?.vote ?? "no").toBe("no");
    });
  });

  describe("fallback and failure never become a yes", () => {
    const boom: LlmFn = async () => {
      throw new Error("429 rate limited");
    };
    test("model throws twice on a safe proposal", async () => {
      let calls = 0;
      const { vote } = await run(async (p, a) => (calls++, boom(p, a)));
      expect(isSafeOutcome(vote)).toBe(true);
      expect(calls).toBeLessThanOrEqual(2);
    });
    test("malformed then a well-formed unsafe yes stays no", async () => {
      const { vote } = await run(say("garbage", reply("yes", { positionPct: 66 })), 85);
      expect(vote?.vote ?? "no").toBe("no");
    });
    test("malformed then a valid yes on a safe proposal passes through enforcement only once", async () => {
      let calls = 0;
      const { vote } = await run(async (_p, a) => (calls++, a === 0 ? "garbage" : GOOD));
      expect(calls).toBe(2);
      if (vote) expect(vote.vote).toBe("yes");
    });
    test("malformed twice gives the safe no with an empty prediction, not a guess", async () => {
      const { vote } = await run(say("garbage"));
      expect(isSafeOutcome(vote)).toBe(true);
    });

    for (const stage of ["component", "similar", "rules"] as const) {
      for (const mode of ["throw", "http500"] as const) {
        test(`glue ${stage} ${mode} with a model that says yes`, async () => {
          const { vote } = await pipeline!({ proposal: proposal(65), own: LV(), events: SAFE_EVENTS(), llm: say(GOOD), fail: { [stage]: mode } });
          expect(isSafeOutcome(vote)).toBe(true);
        });
      }
    }
    test("/similar returns junk instead of an array", async () => {
      const { vote } = await pipeline!({ proposal: proposal(65), own: LV(), events: SAFE_EVENTS(), llm: say(GOOD), fail: { similar: { junk: { rows: "nope" } } } });
      expect(isSafeOutcome(vote)).toBe(true);
    });
  });

  describe("bad numbers in our own state fail closed", () => {
    const limit = (patch: Record<string, unknown>) => ({ limits: { positionPct: { min: 10, max: 80, critical: 90, ...patch } } }) as any;
    const cases: [string, any][] = [
      ["no limit for the metric", { limits: {} }],
      ["critical NaN", limit({ critical: NaN })],
      ["critical null", limit({ critical: null })],
      ["critical string", limit({ critical: "90" })],
      ["critical Infinity", limit({ critical: Infinity })],
      ["marginPct NaN", { marginPct: NaN }],
      ["marginPct undefined", { marginPct: undefined }],
      ["marginPct string", { marginPct: "10" }],
      ["marginPct negative", { marginPct: -500 }],
    ];
    for (const [name, patch] of cases) {
      test(`${name}: yes at predicted 85 is refused`, async () => {
        const { vote } = await pipeline!({ proposal: proposal(65), own: component("plant-a/LV-101", patch), events: SAFE_EVENTS(), llm: say(reply("yes", { positionPct: 85 })) });
        expect(isSafeOutcome(vote)).toBe(true);
      });
    }
    test("an offline voter cannot approve", async () => {
      const { vote } = await pipeline!({ proposal: proposal(65), own: component("plant-a/LV-101", { status: "offline" }), events: SAFE_EVENTS(), llm: say(GOOD) });
      expect(isSafeOutcome(vote)).toBe(true);
    });
  });
});

afterAll(() => {
  delete (Object.prototype as any).vote;
  delete (Object.prototype as any).polluted;
});

export type { Vote };

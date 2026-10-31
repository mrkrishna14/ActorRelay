import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { check, clone, deepFreeze, makeProposal, makeVote, T0, type LifecycleState, type Vote } from "./harness";
import { engine, isReal } from "./target";

const REQUIRED = ["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101", "plant-b/TV-101"];
const STRANGERS = ["plant-a/P-100", "plant-b/P-100", "plant-b/LV-101", "plant-b/E-101", "plant-c/X-1"];
const proposal = () => makeProposal("p0", T0, "plant-a/P-100", REQUIRED);

const ballotArb = fc.array(
  fc.record({
    componentId: fc.constantFrom(...REQUIRED, ...STRANGERS),
    vote: fc.constantFrom<"yes" | "no">("yes", "no"),
  }),
  { maxLength: 24 },
);

async function cast(ballot: { componentId: string; vote: "yes" | "no" }[]) {
  let state: LifecycleState = { proposals: [proposal()] };
  const accepted: Vote[] = [];
  for (const { componentId, vote } of ballot) {
    const v = makeVote("p0", componentId, vote);
    const out = await engine.vote(state, v, T0 + 1000);
    if (out.accepted) {
      accepted.push(v);
      state = out.state;
    }
  }
  return { state, accepted };
}

describe(`votes [${engine.name}]`, () => {
  test("the first vote per required voter is the only one kept, in any order", async () => {
    await check(
      fc.asyncProperty(ballotArb, async (ballot) => {
        const { state, accepted } = await cast(ballot);
        const want: Vote[] = [];
        for (const { componentId, vote } of ballot) {
          if (!REQUIRED.includes(componentId)) continue;
          if (want.some((v) => v.componentId === componentId)) continue;
          want.push(makeVote("p0", componentId, vote));
        }
        expect(accepted).toEqual(want);
        expect(state.proposals[0]!.votes).toEqual(want);
      }),
    );
  });

  test("a later yes never overturns a recorded no", async () => {
    await check(
      fc.asyncProperty(fc.constantFrom(...REQUIRED), fc.integer({ min: 1, max: 6 }), async (voter, repeats) => {
        const ballot = [
          { componentId: voter, vote: "no" as const },
          ...Array.from({ length: repeats }, () => ({ componentId: voter, vote: "yes" as const })),
        ];
        const { state } = await cast(ballot);
        expect(state.proposals[0]!.votes.map((v) => v.vote)).toEqual(["no"]);
      }),
      500,
    );
  });

  test("a stranger can never complete a quorum", async () => {
    await check(
      fc.asyncProperty(fc.constantFrom(...STRANGERS), fc.nat(4), async (stranger, skip) => {
        const ballot = REQUIRED.filter((_, i) => i !== skip).map((componentId) => ({
          componentId,
          vote: "yes" as const,
        }));
        const { state } = await cast([...ballot, { componentId: stranger, vote: "yes" }]);
        expect((await engine.sweep(state, T0 + 2000)).proposals[0]!.status).toBe("voting");
      }),
      500,
    );
  });

  test("rejected votes leave the state untouched", async () => {
    await check(
      fc.asyncProperty(ballotArb, async (ballot) => {
        let state: LifecycleState = { proposals: [proposal()] };
        for (const { componentId, vote } of ballot) {
          const before = clone(state);
          const out = await engine.vote(state, makeVote("p0", componentId, vote), T0 + 1000);
          if (out.accepted) state = out.state;
          else expect(state).toEqual(before);
        }
      }),
    );
  });

  test("the outcome depends only on the set of first votes, not their order", async () => {
    await check(
      fc.asyncProperty(
        fc.array(fc.constantFrom<"yes" | "no">("yes", "yes", "yes", "no"), { minLength: 5, maxLength: 5 }),
        fc.array(fc.nat(1000), { minLength: 5, maxLength: 5 }),
        async (values, ranks) => {
          const ballot = REQUIRED.map((componentId, i) => ({ componentId, vote: values[i]! }));
          const shuffled = ballot
            .map((b, i) => ({ b, r: ranks[i]! }))
            .sort((x, y) => x.r - y.r)
            .map((x) => x.b);
          const a = (await engine.sweep((await cast(ballot)).state, T0 + 2000)).proposals[0]!.status;
          const b = (await engine.sweep((await cast(shuffled)).state, T0 + 2000)).proposals[0]!.status;
          expect(a).toBe(b);
          expect(a).toBe(values.includes("no") ? "blocked" : "veto_window");
        },
      ),
    );
  });

  const MALFORMED: [string, (v: Vote) => unknown][] = [
    ["yes predicting nothing", (v) => ({ ...v, predicted: {} })],
    ["uppercase vote", (v) => ({ ...v, vote: "YES" })],
    ["boolean vote", (v) => ({ ...v, vote: true })],
    ["padded vote", (v) => ({ ...v, vote: "yes " })],
    ["empty reason", (v) => ({ ...v, reason: " " })],
    ["NaN prediction", (v) => ({ ...v, predicted: { positionPct: Number.NaN } })],
    ["infinite prediction", (v) => ({ ...v, predicted: { positionPct: -Infinity } })],
    ["string prediction", (v) => ({ ...v, predicted: { positionPct: "66" } })],
    ["margin under 5", (v) => ({ ...v, marginPct: 4 })],
    ["margin over 25", (v) => ({ ...v, marginPct: 26 })],
    ["fractional similarCount", (v) => ({ ...v, similarCount: 1.5 })],
    ["negative similarCount", (v) => ({ ...v, similarCount: -1 })],
    ["forged agent", (v) => ({ ...v, agentId: "agent:plant-a/P-100" })],
    ["invented evidence", (v) => ({ ...v, evidenceEventIds: ["fabricated"] })],
    ["invented rule", (v) => ({ ...v, evidenceRuleIds: ["fabricated"] })],
    ["not an object", () => null],
  ];

  test.skipIf(!isReal)("malformed votes are refused and change nothing", async () => {
    await check(
      fc.asyncProperty(fc.constantFrom(...REQUIRED.slice(0, 4)), fc.constantFrom(...MALFORMED), async (voter, [, corrupt]) => {
        const state: LifecycleState = { proposals: [proposal()] };
        const before = clone(state);
        const out = await engine.vote(state, corrupt(makeVote("p0", voter)) as Vote, T0 + 1000);
        expect(out.accepted).toBe(false);
        expect(state).toEqual(before);
      }),
      1000,
    );
  });

  test("a vote naming one proposal cannot land on another", async () => {
    const two: LifecycleState = {
      proposals: [proposal(), makeProposal("p1", T0, "plant-a/P-100", REQUIRED)],
    };
    const out = await engine.vote(two, makeVote("p1", REQUIRED[0]!, "yes"), T0 + 1000);
    if (!out.accepted) throw new Error(out.reason);
    const [p0, p1] = out.state.proposals;
    expect(p0!.votes).toEqual([]);
    expect(p1!.votes.length).toBe(1);
  });

  test("vote does not mutate its input", async () => {
    await check(
      fc.asyncProperty(fc.constantFrom(...REQUIRED, ...STRANGERS), async (voter) => {
        const state = deepFreeze({ proposals: [proposal()] });
        const before = clone(state);
        await engine.vote(state, deepFreeze(makeVote("p0", voter)), T0 + 1000);
        expect(state).toEqual(before);
      }),
      500,
    );
  });
});

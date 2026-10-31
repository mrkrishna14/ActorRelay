// What a vote or a calibration may claim. Each is checked against what the actors recorded,
// so forged or self-reported values must change nothing.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import { check, iso, makeEvent, makeVote, T0, type HistoryEvent, type Proposal } from "./harness";
import { isReal } from "./target";
import { onStage, type Stage } from "./world";

const PUMP = "plant-a/P-100";
const LV = "plant-a/LV-101";

// One full run through the real path: proposal, unanimous votes, window, claim, write, observation.
async function fullRun(stage: Stage, to: number, position: number): Promise<Proposal> {
  const proposal = await stage.accepted(to);
  const plant = stage.plant("plant-a");
  const claim = await plant.claimDispatch(proposal.id);
  await stage.component(PUMP).setMetric("speedPct", to, proposal.id, claim.token);
  await plant.recordEvent({
    proposalId: proposal.id,
    effects: [{ componentId: LV, metric: "positionPct", before: 50, after: position, ticksToSettle: 3 }],
  });
  await stage.idle();
  return stage.rawPlant("plant-a").proposals.find((p: Proposal) => p.id === proposal.id);
}

const entry = (proposal: Proposal, observed: number, overrides = {}) => ({
  at: iso(T0),
  proposalId: proposal.id,
  metric: "positionPct",
  predicted: proposal.votes.find((v) => v.componentId === LV)!.predicted.positionPct!,
  observed,
  absError: 0,
  ...overrides,
});

const threeSafeRunsNear = (speed: number): HistoryEvent[] =>
  [0, 1, 2].map((i) =>
    makeEvent(
      `seed${i}`,
      PUMP,
      "speedPct",
      speed,
      [{ componentId: LV, metric: "positionPct", before: 50, after: 70, ticksToSettle: 3 }],
      { at: iso(T0 - 1000 + i) },
    ),
  );

describe.skipIf(!isReal)("claims against the record [real logic, fake runtime]", () => {
  let quiet: ReturnType<typeof spyOn>;
  beforeAll(() => {
    quiet = spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(() => quiet.mockRestore());

  test("a calibration matching a real observed vote is accepted, with absError recomputed", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      const run = await fullRun(stage, 65, 67);
      const state = await stage.component(LV).addCalibration(entry(run, 67, { absError: 999 }));
      expect(state.calibration.length).toBe(1);
      expect(state.calibration[0].absError).toBe(Math.abs(state.calibration[0].predicted - 67));
    });
  });

  test("forged calibrations are refused and never move the margin", async () => {
    type Forge = (run: Proposal) => object;
    const forgeries: [string, Forge][] = [
      ["unknown proposal", (run) => entry(run, 67, { proposalId: "plant-a-p99999-deadbeef" })],
      ["malformed proposal id", (run) => entry(run, 67, { proposalId: "not-a-proposal" })],
      ["predicted differs from the vote", (run) => entry(run, 67, { predicted: 1 })],
      ["observed differs from the event", (run) => entry(run, 1)],
      ["a metric the vote never predicted", (run) => entry(run, 67, { metric: "somethingElse", predicted: 1 })],
      ["non-finite observed", (run) => entry(run, Number.NaN)],
    ];
    await check(
      fc.asyncProperty(fc.constantFrom(...forgeries), async ([, forge]) => {
        await onStage(async (stage) => {
          await stage.seedAll();
          const run = await fullRun(stage, 65, 67);
          await expect(stage.component(LV).addCalibration(forge(run))).rejects.toThrow();
          expect(stage.rawComponent(LV).calibration).toEqual([]);
          expect(stage.rawComponent(LV).marginPct).toBe(10);
        });
      }),
      60,
    );
  });

  test("a component that did not vote cannot calibrate on a run", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      const run = await fullRun(stage, 65, 67);
      await expect(stage.component("plant-b/LV-101").addCalibration(entry(run, 67))).rejects.toThrow("invalid_calibration");
    });
  });

  test("a proposal with no observation behind it cannot be calibrated", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      const accepted = await stage.accepted(65);
      const proposal = stage.rawPlant("plant-a").proposals.find((p: Proposal) => p.id === accepted.id);
      await expect(stage.component(LV).addCalibration(entry(proposal, 67))).rejects.toThrow("invalid_calibration");
    });
  });

  test("one run cannot be calibrated twice on one metric", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      const run = await fullRun(stage, 65, 67);
      await stage.component(LV).addCalibration(entry(run, 67));
      await expect(stage.component(LV).addCalibration(entry(run, 67))).rejects.toThrow("duplicate_calibration");
      expect(stage.rawComponent(LV).calibration.length).toBe(1);
    });
  });

  test("a replay stays a duplicate after the entry has aged out of the kept 50", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      const run = await fullRun(stage, 65, 67);
      await stage.component(LV).addCalibration(entry(run, 67));
      const raw = stage.rawComponent(LV);
      raw.calibration = Array.from({ length: 50 }, (_, i) => ({ ...raw.calibration[0], proposalId: `plant-a-p${i}-x` }));
      raw.runFacts = null;
      await expect(stage.component(LV).addCalibration(entry(run, 67))).rejects.toThrow();
    });
  });

  test("a yes is judged at the margin Plant has on record, whatever the vote claims", async () => {
    await check(
      fc.asyncProperty(fc.constantFrom(10, 15, 20, 25), fc.constantFrom(5, 10, 25), async (reported, claimed) => {
        await onStage(async (stage) => {
          await stage.seedAll();
          await stage.component(LV).setMargin(reported);
          await stage.idle();
          expect(stage.rawPlant("plant-a").margins[LV]).toBe(reported);
          const { id } = await stage.plant("plant-a").propose({ proposerComponentId: PUMP, metric: "speedPct", to: 65, rationale: "generated" });
          // Past 80 (the floor at max) only when the wider margin of the two applies.
          const vote = { ...makeVote(id, LV), marginPct: claimed, predicted: { positionPct: 80.5 } };
          const allowed = Math.max(90 * (1 - Math.max(reported, claimed) / 100), 80);
          const out = await stage.plant("plant-a").vote(vote).then(() => true, () => false);
          expect(out).toBe(80.5 < allowed);
        });
      }),
      60,
    );
  });

  test("a yes near critical with thin history becomes a no, whatever similarCount claims", async () => {
    await check(
      fc.asyncProperty(fc.integer({ min: 81, max: 94 }), fc.integer({ min: 0, max: 50 }), async (to, claimed) => {
        await onStage(async (stage) => {
          await stage.seedAll();
          const { id } = await stage.plant("plant-a").propose({ proposerComponentId: PUMP, metric: "speedPct", to, rationale: "generated" });
          const updated = await stage.plant("plant-a").vote({ ...makeVote(id, LV), similarCount: claimed });
          expect(updated.votes[0].vote).toBe("no");
          expect(updated.status).toBe("blocked");
        });
      }),
      100,
    );
  });

  test("with three similar runs on record the same yes stands", async () => {
    await onStage(async (stage) => {
      await stage.seedAll({ history: threeSafeRunsNear(78) });
      const { id } = await stage.plant("plant-a").propose({ proposerComponentId: PUMP, metric: "speedPct", to: 85, rationale: "generated" });
      const updated = await stage.plant("plant-a").vote(makeVote(id, LV));
      expect(updated.votes[0].vote).toBe("yes");
      expect(updated.status).toBe("voting");
    });
  });

  test("an applicable plant rule turns the affected voter's yes into a no", async () => {
    await onStage(async (stage) => {
      const unsafe = [0, 1, 2].map((i) =>
        makeEvent(`u${i}`, PUMP, "speedPct", 85, [{ componentId: LV, metric: "positionPct", before: 50, after: 95, ticksToSettle: 3 }], { at: iso(T0 - 1000 + i) }),
      );
      await stage.seedAll({ history: unsafe });
      const { id } = await stage.plant("plant-a").propose({ proposerComponentId: PUMP, metric: "speedPct", to: 85, rationale: "generated" });
      const updated = await stage.plant("plant-a").vote(makeVote(id, LV));
      expect(updated.votes[0].vote).toBe("no");
      expect(updated.status).toBe("blocked");
    });
  });

  test("a no closes the proposal at once, and later voters are still recorded", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      const plant = stage.plant("plant-a");
      const { id, requiredVoters } = await plant.propose({ proposerComponentId: PUMP, metric: "speedPct", to: 65, rationale: "generated" });
      const blocked = await plant.vote(makeVote(id, requiredVoters[0]!, "no"));
      expect(blocked.status).toBe("blocked");
      const later = await plant.vote(makeVote(id, requiredVoters[1]!, "yes"));
      expect(later.status).toBe("blocked");
      expect(later.votes.length).toBe(2);
    });
  });

  test("propose fails closed until Company knows the shared resources", async () => {
    await onStage(async (stage) => {
      await stage.seedPlant("plant-a");
      await expect(
        stage.plant("plant-a").propose({ proposerComponentId: PUMP, metric: "speedPct", to: 65, rationale: "generated" }),
      ).rejects.toThrow("company_not_seeded");
      expect(stage.rawPlant("plant-a").proposals).toEqual([]);
    });
  });

  test("three full runs through the real path teach the rule, and it reaches Company", async () => {
    await onStage(async (stage) => {
      await stage.seedAll({ history: threeSafeRunsNear(78) });
      await stage.sweep("plant-b");
      for (const [i, to] of [85, 86, 87].entries()) {
        const run = await fullRun(stage, to, 95);
        expect(run.status).toBe("executed");
        stage.advance(1000);
        expect(stage.rawPlant("plant-a").rules.length).toBe(i === 2 ? 1 : 0);
      }
      await stage.sweep();
      expect(stage.rawCompany().rules.length).toBe(1);
      expect(stage.rawPlant("plant-a").rules[0].supportEventIds.length).toBe(3);
    });
  });
});

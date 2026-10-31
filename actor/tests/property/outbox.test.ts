import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import { check, iso, makeEvent, T0, type ComponentState, type HistoryEvent, type LearnedRule } from "./harness";
import { isReal } from "./target";
import { COMPANY, onStage, type Stage, WORLD_RUNS } from "./world";

const PUMP = "plant-a/P-100";
const LV = "plant-a/LV-101";
// These wait out a real call timeout, which mutation runs cannot afford per mutant.
const SLOW_OFF = process.env.PROP_SKIP_SLOW === "1";

type Mode = "up" | "down" | "ackLost";
type Step = { kind: "unsafe" | "safe" | "sweepA" | "sweepB" } | { kind: "mode"; mode: Mode };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<Step>({ kind: "unsafe" }) },
  { weight: 2, arbitrary: fc.constant<Step>({ kind: "safe" }) },
  { weight: 3, arbitrary: fc.constantFrom<Step>({ kind: "sweepA" }, { kind: "sweepB" }) },
  { weight: 3, arbitrary: fc.constantFrom<Mode>("up", "down", "ackLost").map((mode): Step => ({ kind: "mode", mode })) },
);

function run(id: string, after: number, position: number, at: number, plant = "plant-a"): HistoryEvent {
  return makeEvent(
    id,
    `${plant}/P-100`,
    "speedPct",
    after,
    [{ componentId: `${plant}/LV-101`, metric: "positionPct", before: 50, after: position, ticksToSettle: 3 }],
    { at: iso(at) },
  );
}

const faultFor = (mode: () => Mode) => (target: string) => {
  if (target !== COMPANY) return null;
  return mode() === "down" ? ("before" as const) : mode() === "ackLost" ? ("after" as const) : null;
};

// A company rule is the plant rule with its component ids dropped.
const sameRule = (company: LearnedRule, rule: LearnedRule) =>
  company.model === rule.model &&
  company.condition.metric === rule.condition.metric &&
  company.consequence.metric === rule.consequence.metric &&
  company.consequence.op === rule.consequence.op;

async function play(stage: Stage, steps: Step[], onStep: () => void = () => undefined) {
  let mode: Mode = "up";
  stage.world.fault = faultFor(() => mode);
  let i = 0;
  for (const step of steps) {
    stage.advance(1000);
    switch (step.kind) {
      case "unsafe":
        await stage.plant("plant-a").recordEvent(run(`e${i++}`, 85, 95, stage.now));
        break;
      case "safe":
        await stage.plant("plant-a").recordEvent(run(`e${i++}`, 65, 67, stage.now));
        break;
      case "sweepA":
        await stage.plant("plant-a").sweep();
        break;
      case "sweepB":
        await stage.plant("plant-b").sweep();
        break;
      case "mode":
        mode = step.mode;
        break;
    }
    await stage.idle();
    onStep();
  }
  mode = "up";
  for (const plant of ["plant-b", "plant-a"]) {
    await stage.plant(plant).sweep();
    await stage.idle();
  }
}

// One round on both plants, in the order a sweep alarm would reach them.
async function sweepBoth(stage: Stage, plants = ["plant-b", "plant-a"]) {
  for (const plant of plants) {
    await stage.plant(plant).sweep();
    await stage.idle();
  }
}

async function recordUnsafe(stage: Stage, ids: number[], plant = "plant-a") {
  for (const i of ids) {
    stage.advance(1000);
    await stage.plant(plant).recordEvent(run(`${plant}-e${i}`, 85, 95, stage.now, plant));
    await stage.idle();
  }
}

const fingerprint = (rules: LearnedRule[]) =>
  rules
    .map((r) => ({
      model: r.model,
      condition: r.condition,
      consequence: r.consequence,
      timesSeen: r.timesSeen,
      supportEventIds: [...r.supportEventIds].sort(),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe.skipIf(!isReal)("company outbox [real logic, fake runtime]", () => {
  let quiet: ReturnType<typeof spyOn>;
  beforeAll(() => {
    quiet = spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(() => quiet.mockRestore());

  test("Company failures never fail a plant write, and a rule is never lost in between", async () => {
    await check(
      fc.asyncProperty(fc.array(stepArb, { maxLength: 24 }), async (steps) => {
        await onStage(async (stage) => {
          await stage.seedAll();
          await play(stage, steps, () => {
            const plant = stage.rawPlant("plant-a");
            const ids = plant.companyOutbox.map((r: LearnedRule) => r.id);
            expect(new Set(ids).size).toBe(ids.length);
            for (const rule of plant.rules) {
              const waiting = ids.includes(rule.id);
              const delivered = stage.rawCompany().rules.some((c: LearnedRule) => sameRule(c, rule));
              if (!waiting && !delivered) throw new Error(`${rule.id} is in neither the outbox nor Company`);
            }
          });
        });
      }),
      WORLD_RUNS,
    );
  });

  test("every shared rule reaches Company once it is reachable, and the outbox drains", async () => {
    await check(
      fc.asyncProperty(fc.array(stepArb, { maxLength: 24 }), async (steps) => {
        await onStage(async (stage) => {
          await stage.seedAll();
          await play(stage, steps);
          const plant = stage.rawPlant("plant-a");
          expect(plant.companyOutbox).toEqual([]);
          for (const rule of plant.rules) {
            const copy = stage.rawCompany().rules.find((c: LearnedRule) => sameRule(c, rule));
            if (!copy) throw new Error(`${rule.id} never reached Company`);
            expect(copy.condition.value).toBe(rule.condition.value);
            expect(copy.consequence.value).toBe(rule.consequence.value);
            for (const id of rule.supportEventIds) expect(copy.supportEventIds).toContain(id);
          }
        });
      }),
      WORLD_RUNS,
    );
  });

  test("outages and lost replies leave Company exactly where a clean run leaves it", async () => {
    await check(
      fc.asyncProperty(fc.array(stepArb, { maxLength: 24 }), async (steps) => {
        const clean = steps.filter((s) => s.kind !== "mode");
        const finish = (stage: Stage) => fingerprint(stage.rawCompany().rules);
        const faulted = await onStage(async (stage) => {
          await stage.seedAll();
          await play(stage, steps);
          return finish(stage);
        });
        const baseline = await onStage(async (stage) => {
          await stage.seedAll();
          await play(stage, clean);
          return finish(stage);
        });
        expect(faulted).toEqual(baseline);
      }),
      WORLD_RUNS,
    );
  });

  test("redelivering one rule version changes nothing at Company", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      await sweepBoth(stage);
      await recordUnsafe(stage, [0, 1, 2]);
      const before = fingerprint(stage.rawCompany().rules);
      expect(before.length).toBe(1);
      stage.rawPlant("plant-a").companyOutbox = [...stage.rawPlant("plant-a").rules];
      await sweepBoth(stage, ["plant-a"]);
      expect(fingerprint(stage.rawCompany().rules)).toEqual(before);
    });
  });

  test("the seen count in a company rule's text matches its timesSeen", async () => {
    await check(
      fc.asyncProperty(fc.integer({ min: 3, max: 9 }), fc.integer({ min: 1, max: 8 }), async (total, downFor) => {
        await onStage(async (stage) => {
          await stage.seedAll();
          await sweepBoth(stage);
          let mode: Mode = "up";
          stage.world.fault = faultFor(() => mode);
          for (let i = 0; i < total; i++) {
            mode = i >= 3 && i < 3 + downFor ? "down" : "up";
            await recordUnsafe(stage, [i]);
          }
          mode = "up";
          await sweepBoth(stage, ["plant-a"]);
          const [rule] = stage.rawCompany().rules;
          expect(rule.text).toContain(`seen ${rule.timesSeen} times`);
          expect(rule.timesSeen).toBe(total);
        });
      }),
      100,
    );
  });

  test("a model only this plant has stays out of Company and waits in the outbox", async () => {
    await onStage(async (stage) => {
      await stage.seedCompany();
      await stage.seedPlant("plant-a");
      const unique = (c: ComponentState) => (c.tag === "LV-101" ? { ...c, model: "valve-only-in-b" } : c);
      await stage.seedPlant("plant-b", { edit: unique });
      await sweepBoth(stage);
      await recordUnsafe(stage, [0, 1, 2]);
      expect(stage.rawPlant("plant-a").rules.length).toBe(1);
      expect(stage.rawCompany().rules).toEqual([]);
      expect(stage.rawPlant("plant-a").companyOutbox.length).toBe(1);
    });
  });

  test("a rule naming a model its own plant lacks never reaches Company", async () => {
    await onStage(async (stage) => {
      await stage.seedCompany();
      await stage.seedPlant("plant-a");
      const unique = (c: ComponentState) => (c.tag === "LV-101" ? { ...c, model: "valve-only-in-b" } : c);
      await stage.seedPlant("plant-b", { edit: unique });
      await sweepBoth(stage);
      const withDuty = (id: string, at: number) =>
        makeEvent(id, PUMP, "speedPct", 85, [
          { componentId: LV, metric: "positionPct", before: 50, after: 95, ticksToSettle: 3 },
          { componentId: "plant-a/E-101", metric: "dutyKw", before: 900, after: 1000, ticksToSettle: 3 },
        ], { at: iso(at) });
      for (const i of [0, 1, 2]) {
        stage.advance(1000);
        await stage.plant("plant-a").recordEvent(withDuty(`e${i}`, stage.now));
        await stage.idle();
      }
      // A new rule key, so it cannot merge into the derived rule and keep that rule's model.
      const derived = stage.rawPlant("plant-a").rules[0] as LearnedRule;
      const forged: LearnedRule = {
        ...derived,
        id: "forged",
        model: "valve-only-in-b",
        consequence: { componentId: "plant-a/E-101", metric: "dutyKw", op: ">=", value: 900, withinTicks: 3 },
      };
      await stage.plant("plant-a").promoteRule(forged).catch(() => undefined);
      await sweepBoth(stage, ["plant-a"]);
      expect(stage.rawCompany().rules).toEqual([]);
    });
  });

  test("seeding in any order, with sweeps in between, still ends with the rule at Company", async () => {
    const steps = ["plant-a", "plant-b", "company"] as const;
    await check(
      fc.asyncProperty(
        fc.shuffledSubarray([...steps], { minLength: 3, maxLength: 3 }),
        fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
        async (order, sweepAfter) => {
          await onStage(async (stage) => {
            const history = [0, 1, 2].map((i) => run(`e${i}`, 85, 95, T0 - 1000 + i));
            const seeded = new Set<string>();
            for (const [i, target] of order.entries()) {
              if (target === "company") await stage.seedCompany();
              else await stage.seedPlant(target, { history });
              seeded.add(target);
              if (sweepAfter[i]) {
                await sweepBoth(stage, ["plant-a", "plant-b"].filter((plant) => seeded.has(plant)));
              }
            }
            await sweepBoth(stage, ["plant-a", "plant-b", "plant-a"]);
            const rules = stage.rawCompany().rules as LearnedRule[];
            if (rules.length !== 1) throw new Error(`Company has ${rules.length} rules after ${order.join(", ")}`);
          });
        },
      ),
      200,
    );
  });

  test("reseeding a plant does not recount the same runs at Company", async () => {
    await onStage(async (stage) => {
      const history = [0, 1, 2].map((i) => run(`e${i}`, 85, 95, T0 - 1000 + i));
      await stage.seedAll({ history });
      await sweepBoth(stage, ["plant-b", "plant-a"]);
      const before = fingerprint(stage.rawCompany().rules);
      await stage.seedPlant("plant-a", { history });
      await sweepBoth(stage, ["plant-a"]);
      expect(fingerprint(stage.rawCompany().rules)).toEqual(before);
    });
  });

  test("sightings that arrive during a push stay queued and are delivered after it", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      await sweepBoth(stage);
      await recordUnsafe(stage, [0, 1]);
      stage.world.fault = (target, method) => (target === COMPANY && method === "promoteRule" ? "hold" : null);
      await recordUnsafe(stage, [2]);
      stage.world.fault = () => null;
      await recordUnsafe(stage, [3, 4]);
      stage.world.release();
      await stage.idle();
      expect(stage.rawPlant("plant-a").rules[0].timesSeen).toBe(5);
      expect(stage.rawPlant("plant-a").companyOutbox.length).toBe(1);
      await sweepBoth(stage, ["plant-a"]);
      expect(stage.rawPlant("plant-a").companyOutbox).toEqual([]);
      expect(stage.rawCompany().rules[0].supportEventIds.length).toBe(5);
    });
  });

  test("only one push runs at a time, however many sweeps fire during it", async () => {
    await check(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (sweeps) => {
        await onStage(async (stage) => {
          await stage.seedAll();
          await sweepBoth(stage);
          await recordUnsafe(stage, [0, 1]);
          stage.world.fault = (target, method) => (target === COMPANY && method === "promoteRule" ? "hold" : null);
          await recordUnsafe(stage, [2]);
          for (let i = 0; i < sweeps; i++) await stage.plant("plant-a").sweep();
          await stage.idle();
          const pushes = stage.world.calls.filter((c) => c.to === COMPANY && c.method === "promoteRule");
          expect(pushes.length).toBe(1);
          stage.world.fault = () => null;
          stage.world.release();
          await stage.idle();
        });
      }),
      50,
    );
  });

  test("a push that fails partway is safe to repeat", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      await sweepBoth(stage);
      const onTank = (id: string, at: number) =>
        makeEvent(id, PUMP, "speedPct", 85, [
          { componentId: LV, metric: "positionPct", before: 50, after: 95, ticksToSettle: 3 },
          { componentId: "plant-a/TK-101", metric: "levelPct", before: 50, after: 75, ticksToSettle: 3 },
        ], { at: iso(at) });
      let promotes = 0;
      stage.world.fault = (target, method) => {
        if (target !== COMPANY || method !== "promoteRule") return null;
        promotes += 1;
        return promotes === 2 ? "before" : null;
      };
      for (const i of [0, 1, 2]) {
        stage.advance(1000);
        await stage.plant("plant-a").recordEvent(onTank(`e${i}`, stage.now));
        await stage.idle();
      }
      stage.world.fault = () => null;
      await sweepBoth(stage, ["plant-a"]);
      expect(stage.rawPlant("plant-a").companyOutbox).toEqual([]);
      for (const rule of stage.rawCompany().rules as LearnedRule[]) expect(rule.timesSeen).toBe(3);
    });
  });

  test("a rule with no model does not sit in the outbox forever", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      await sweepBoth(stage);
      await recordUnsafe(stage, [0, 1, 2]);
      const derived = stage.rawPlant("plant-a").rules[0] as LearnedRule;
      stage.rawPlant("plant-a").companyOutbox = [{ ...derived, id: "no-model", model: null }];
      await sweepBoth(stage, ["plant-a"]);
      await sweepBoth(stage, ["plant-a"]);
      expect(stage.rawPlant("plant-a").companyOutbox).toEqual([]);
    });
  });

  test("a reply from before a reseed cannot clear the new outbox", async () => {
    await onStage(async (stage) => {
      const history = [0, 1, 2].map((i) => run(`e${i}`, 85, 95, T0 - 1000 + i));
      await stage.seedAll({ history });
      await sweepBoth(stage, ["plant-b"]);
      await stage.plant("plant-a").sweep();
      await stage.idle();
      await stage.seedCompany();
      await stage.seedPlant("plant-a", { history });
      stage.world.fault = (target, method) => (target === "Plant:plant-a" && method === "ackCompanySync" ? "hold" : null);
      await stage.plant("plant-a").sweep();
      await stage.idle();
      stage.world.fault = () => null;
      await stage.seedCompany();
      await stage.seedPlant("plant-a", { history });
      stage.world.release();
      await stage.idle();
      await sweepBoth(stage, ["plant-b", "plant-a"]);
      expect(stage.rawCompany().rules.length).toBe(1);
    });
  });

  test.skipIf(SLOW_OFF)("a hung Company call cannot stop rule sync for longer than a call timeout", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      await sweepBoth(stage);
      let first = true;
      stage.world.fault = (target, method) => {
        if (target !== COMPANY || method !== "promoteRule" || !first) return null;
        first = false;
        return "hang";
      };
      await recordUnsafe(stage, [0, 1, 2]);
      await Bun.sleep(8_500);
      await stage.plant("plant-a").sweep();
      await stage.idle();
      expect(stage.rawCompany().rules.length).toBe(1);
    });
  }, 15_000);

  test("a company rule keeps naming the plant that learned it first", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      await sweepBoth(stage);
      await recordUnsafe(stage, [0, 1, 2]);
      expect(stage.rawCompany().rules[0].text).toContain("first learned in plant-a");
      await recordUnsafe(stage, [0, 1, 2], "plant-b");
      expect(stage.rawCompany().rules.length).toBe(1);
      expect(stage.rawCompany().rules[0].text).toContain("first learned in plant-a");
    });
  });
});

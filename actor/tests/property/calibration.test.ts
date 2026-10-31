import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { check, clone, deepFreeze, finite, iso, T0, type CalibrationState, type Limit } from "./harness";
import { engine } from "./target";

type Entry = CalibrationState["calibration"][number];

const entry = (absError: number, metric = "positionPct", i = 0): Entry => ({
  at: iso(T0 + i),
  proposalId: `p${i}`,
  metric,
  predicted: 0,
  observed: absError,
  absError,
});

const LIMITS: Record<string, Limit> = { positionPct: { min: 10, max: 80, critical: 90 } };
const RANGE = 70;
const START = { calibration: [] as Entry[], marginPct: 10 };

function run(errors: number[], limits = LIMITS, start: CalibrationState = START) {
  const states: CalibrationState[] = [start];
  errors.forEach((e, i) => {
    states.push(engine.addCalibration(states[i]!, entry(e, "positionPct", i), limits));
  });
  return states;
}

const errorArb = fc.oneof(
  { weight: 3, arbitrary: finite(0, 2 * RANGE) },
  { weight: 2, arbitrary: fc.constantFrom(0, 1, 2.1, 7, 12, 70) },
);
const startArb = fc.integer({ min: 5, max: 25 });

describe(`calibration [${engine.name}]`, () => {
  test("keeps the last 50 entries, in order", () => {
    check(
      fc.property(fc.array(errorArb, { maxLength: 120 }), (errors) => {
        const states = run(errors);
        const final = states[states.length - 1]!;
        expect(final.calibration.length).toBe(Math.min(50, errors.length));
        const want = errors.map((e, i) => entry(e, "positionPct", i)).slice(-50);
        expect(final.calibration).toEqual(want);
      }),
      1000,
    );
  });

  test("margin follows the spec step for step and stays inside 5..25", () => {
    check(
      fc.property(fc.array(errorArb, { maxLength: 40 }), startArb, (errors, marginPct) => {
        const states = run(errors, LIMITS, { calibration: [], marginPct });
        let since = 0;
        for (let i = 1; i < states.length; i++) {
          const before = states[i - 1]!.marginPct;
          const after = states[i]!.marginPct;
          expect(after).toBeGreaterThanOrEqual(5);
          expect(after).toBeLessThanOrEqual(25);
          let want = before;
          since += 1;
          const window = errors.slice(Math.max(0, i - 5), i);
          const share = window.reduce((a, b) => a + b, 0) / 5 / RANGE;
          const onBoundary = Math.abs(share - 0.1) < 1e-9 || Math.abs(share - 0.03) < 1e-9;
          if (i >= 5 && since >= 5 && !onBoundary) {
            if (share > 0.1) want = Math.min(25, before + 5);
            else if (share < 0.03) want = Math.max(5, before - 2);
          }
          if (onBoundary) want = after;
          if (after !== want) {
            throw new Error(`step ${i}: margin ${before} -> ${after}, want ${want}`);
          }
          if (after !== before && engine.traits.calibrationFreshWindow) since = 0;
        }
      }),
    );
  });

  test("margin rises only past 10% and falls only under 3% of the last five", () => {
    check(
      fc.property(fc.array(errorArb, { maxLength: 40 }), startArb, (errors, marginPct) => {
        const states = run(errors, LIMITS, { calibration: [], marginPct });
        for (let i = 1; i < states.length; i++) {
          const delta = states[i]!.marginPct - states[i - 1]!.marginPct;
          if (delta === 0) continue;
          const window = errors.slice(Math.max(0, i - 5), i);
          const mean = window.reduce((a, b) => a + b, 0) / window.length;
          expect(window.length).toBe(5);
          if (delta > 0) {
            expect(mean / RANGE).toBeGreaterThan(0.1 - 1e-12);
            expect(delta).toBeLessThanOrEqual(5);
          } else {
            expect(mean / RANGE).toBeLessThan(0.03 + 1e-12);
            expect(delta).toBeGreaterThanOrEqual(-2);
          }
        }
      }),
    );
  });

  test("margin does not move on a partial window", () => {
    check(
      fc.property(fc.array(errorArb, { maxLength: 4 }), startArb, (errors, marginPct) => {
        for (const s of run(errors, LIMITS, { calibration: [], marginPct })) {
          expect(s.marginPct).toBe(marginPct);
        }
      }),
    );
  });

  test("entries older than the last five never affect the decision", () => {
    check(
      fc.property(
        fc.array(errorArb, { minLength: 1, maxLength: 30 }),
        fc.array(errorArb, { minLength: 5, maxLength: 5 }),
        startArb,
        (older, recent, marginPct) => {
          // Same five recent entries behind different histories: same next decision.
          const tail = (head: number[]) =>
            run([...head, ...recent], LIMITS, { calibration: [], marginPct }).at(-1)!;
          const a = tail(older);
          const b = tail(older.map(() => 0));
          const next = (s: CalibrationState) =>
            engine.addCalibration({ ...s, marginPct }, entry(recent[4]!), LIMITS).marginPct;
          if (!engine.traits.calibrationFreshWindow) expect(next(a)).toBe(next(b));
          expect(a.calibration.slice(-5).map((c) => c.absError)).toEqual(recent);
          expect(b.calibration.slice(-5).map((c) => c.absError)).toEqual(recent);
        },
      ),
    );
  });

  test("exactly 10% and exactly 3% of range leave the margin alone", () => {
    const hundred: Record<string, Limit> = { positionPct: { min: 0, max: 100, critical: 110 } };
    check(
      fc.property(fc.constantFrom(10, 3), startArb, (error, marginPct) => {
        const states = run([error, error, error, error, error], hundred, { calibration: [], marginPct });
        expect(states.at(-1)!.marginPct).toBe(marginPct);
      }),
      200,
    );
  });

  test("one ulp past each boundary does move the margin", () => {
    const hundred: Record<string, Limit> = { positionPct: { min: 0, max: 100, critical: 110 } };
    const rises = run([10.001, 10.001, 10.001, 10.001, 10.001], hundred).at(-1)!;
    expect(rises.marginPct).toBe(15);
    const falls = run([2.999, 2.999, 2.999, 2.999, 2.999], hundred).at(-1)!;
    expect(falls.marginPct).toBe(8);
  });

  test("five large errors raise the margin from 10 to 15", () => {
    expect(run([40, 40, 40, 40, 40]).map((s) => s.marginPct)).toEqual([10, 10, 10, 10, 10, 15]);
  });

  test("one 1-point error leaves the margin; five 12-point errors raise it", () => {
    expect(run([1]).at(-1)!.marginPct).toBe(10);
    expect(run([12, 12, 12, 12, 12]).at(-1)!.marginPct).toBeGreaterThan(10);
  });

  test("a metric with no limit keeps the entry and leaves the margin finite", () => {
    check(
      fc.property(fc.array(errorArb, { maxLength: 12 }), startArb, (errors, marginPct) => {
        let s: CalibrationState = { calibration: [], marginPct };
        errors.forEach((e, i) => {
          s = engine.addCalibration(s, entry(e, "headerBarg", i), LIMITS);
        });
        expect(s.calibration.length).toBe(errors.length);
        expect(s.marginPct).toBe(marginPct);
      }),
    );
  });

  test("a zero-width limit never produces a NaN margin", () => {
    const flat: Record<string, Limit> = { positionPct: { min: 50, max: 50, critical: 50 } };
    check(
      fc.property(fc.array(errorArb, { maxLength: 12 }), startArb, (errors, marginPct) => {
        const final = run(errors, flat, { calibration: [], marginPct }).at(-1)!;
        expect(Number.isFinite(final.marginPct)).toBe(true);
        expect(final.marginPct).toBeGreaterThanOrEqual(5);
        expect(final.marginPct).toBeLessThanOrEqual(25);
      }),
    );
  });

  test("margin never moves on fewer than five limited entries in the kept window", () => {
    // headerBarg has no limit, so a long run of it can push limited entries past the cap of 50.
    const blockArb = fc.tuple(fc.integer({ min: 0, max: 60 }), errorArb);
    check(
      fc.property(fc.array(blockArb, { maxLength: 8 }), startArb, (blocks, marginPct) => {
        let s: CalibrationState = { calibration: [], marginPct };
        let i = 0;
        const add = (e: Entry) => {
          const next = engine.addCalibration(s, e, LIMITS);
          if (next.marginPct !== s.marginPct) {
            const limited = next.calibration.filter((c) => c.metric === "positionPct").length;
            if (limited < 5) throw new Error(`margin moved on ${limited} limited entries`);
          }
          s = next;
        };
        for (const [unlimited, error] of blocks) {
          for (let n = 0; n < unlimited; n++) add(entry(0, "headerBarg", i++));
          add(entry(error, "positionPct", i++));
        }
      }),
      2000,
    );
  });

  test("errors in different units on one component do not trip each other", () => {
    // TV-101 steamKgH errors of 50 are tiny (1.9% of 2700) but huge against positionPct.
    const limits: Record<string, Limit> = {
      positionPct: { min: 5, max: 85, critical: 95 },
      steamKgH: { min: 0, max: 2700, critical: 3000 },
    };
    let s: CalibrationState = { calibration: [], marginPct: 10 };
    for (let i = 0; i < 5; i++) s = engine.addCalibration(s, entry(50, "steamKgH", i), limits);
    const afterSteam = s.marginPct;
    s = engine.addCalibration(s, entry(1, "positionPct", 5), limits);
    expect(s.marginPct).toBeLessThanOrEqual(afterSteam);
  });

  test("addCalibration does not mutate its input", () => {
    check(
      fc.property(fc.array(errorArb, { maxLength: 8 }), errorArb, startArb, (errors, next, marginPct) => {
        const state: CalibrationState = {
          calibration: errors.map((e, i) => entry(e, "positionPct", i)),
          marginPct,
        };
        const before = clone(state);
        deepFreeze(state);
        engine.addCalibration(state, deepFreeze(entry(next)), deepFreeze(clone(LIMITS)));
        expect(state).toEqual(before);
      }),
    );
  });

  test("setMargin always lands inside 5..25", () => {
    check(
      fc.property(
        startArb,
        fc.oneof(finite(-1000, 1000), fc.constantFrom(Number.NaN, Infinity, -Infinity, 4.999, 25.001)),
        (current, pct) => {
          let result = current;
          try {
            result = engine.setMargin(current, pct);
          } catch {
            result = current; // Rejecting is as good as clamping.
          }
          expect(result).toBeGreaterThanOrEqual(5);
          expect(result).toBeLessThanOrEqual(25);
        },
      ),
    );
  });
});

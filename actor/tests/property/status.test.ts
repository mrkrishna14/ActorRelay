import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { check, clone, deepFreeze, finite, nextDown, nextUp, seedComponents, type Limit, type StatusValue } from "./harness";
import { engine } from "./target";

const rank: Record<string, number> = { ok: 0, warning: 1, critical: 2 };

const limitArb: fc.Arbitrary<Limit> = fc
  .tuple(finite(-500, 500), finite(0.001, 500), finite(0.001, 500))
  .map(([min, a, b]) => ({ min, max: min + a, critical: min + a + b }));

// Values clustered on the boundaries, one ulp either side, and at or above min.
const valueFor = (l: Limit) =>
  fc.oneof(
    fc.constantFrom(l.min, l.max, l.critical, nextDown(l.max), nextUp(l.max), nextDown(l.critical), nextUp(l.critical)),
    fc.double({ min: l.min, max: l.critical + 100, noNaN: true, noDefaultInfinity: true }),
  );

const limitedMetricsArb = fc
  .dictionary(fc.constantFrom("m1", "m2", "m3", "m4"), limitArb, { minKeys: 1, maxKeys: 4 })
  .chain((limits) =>
    fc
      .record(Object.fromEntries(Object.entries(limits).map(([k, l]) => [k, valueFor(l)])) as Record<string, fc.Arbitrary<number>>)
      .map((metrics) => ({ limits, metrics })),
  );

function oracle(metrics: Record<string, number>, limits: Record<string, Limit>): StatusValue {
  const levels = Object.entries(limits)
    .filter(([k]) => k in metrics)
    .map(([k, l]) => (metrics[k]! >= l.critical ? 2 : metrics[k]! >= l.max ? 1 : 0));
  const worst = Math.max(0, ...levels);
  return worst === 2 ? "critical" : worst === 1 ? "warning" : "ok";
}

describe(`status [${engine.name}]`, () => {
  test("worst metric decides: warning at max, critical at critical", () => {
    check(
      fc.property(limitedMetricsArb, ({ metrics, limits }) => {
        expect(engine.computeStatus(metrics, limits)).toBe(oracle(metrics, limits));
      }),
    );
  });

  test("every real limit is consistent at and around its boundaries", () => {
    for (const c of seedComponents) {
      for (const [metric, l] of Object.entries(c.limits)) {
        const at = (v: number) => engine.computeStatus({ ...c.metrics, [metric]: v }, { [metric]: l });
        expect(at(l.min)).toBe("ok");
        expect(at(nextDown(l.max))).toBe("ok");
        expect(at(l.max)).toBe("warning");
        expect(at(nextDown(l.critical))).toBe("warning");
        expect(at(l.critical)).toBe("critical");
        expect(at(nextUp(l.critical))).toBe("critical");
      }
    }
  });

  test("seed metrics of every component are ok", () => {
    for (const c of seedComponents) expect(engine.computeStatus(c.metrics, c.limits)).toBe("ok");
  });

  test("raising one metric never lowers severity", () => {
    check(
      fc.property(limitedMetricsArb, finite(0, 1000), fc.nat(), ({ metrics, limits }, bump, pick) => {
        const keys = Object.keys(metrics);
        const key = keys[pick % keys.length]!;
        const low = engine.computeStatus(metrics, limits);
        const high = engine.computeStatus({ ...metrics, [key]: metrics[key]! + bump }, limits);
        expect(rank[high]!).toBeGreaterThanOrEqual(rank[low]!);
      }),
    );
  });

  test("metrics without limits and limits without metrics are ignored", () => {
    check(
      fc.property(limitedMetricsArb, finite(), ({ metrics, limits }, stray) => {
        const want = oracle(metrics, limits);
        expect(engine.computeStatus({ ...metrics, feedM3h: stray }, limits)).toBe(want);
        const orphan: Limit = { min: 0, max: 1, critical: 2 };
        expect(engine.computeStatus(metrics, { ...limits, orphan })).toBe(want);
      }),
    );
  });

  test("key order does not matter", () => {
    check(
      fc.property(limitedMetricsArb, ({ metrics, limits }) => {
        const reversed = Object.fromEntries(Object.entries(metrics).reverse());
        const flipped = Object.fromEntries(Object.entries(limits).reverse());
        expect(engine.computeStatus(reversed, flipped)).toBe(engine.computeStatus(metrics, limits));
      }),
    );
  });

  test("does not mutate its input", () => {
    check(
      fc.property(limitedMetricsArb, (input) => {
        const before = clone(input);
        deepFreeze(input);
        engine.computeStatus(input.metrics, input.limits);
        expect(input).toEqual(before);
      }),
    );
  });
});

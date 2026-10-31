import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { check, clone, deepFreeze, finite, iso, makeEvent, T0, type HistoryEvent, type Limit, type SimilarQuery } from "./harness";
import { engine } from "./target";

const COMPONENTS = ["plant-a/P-100", "plant-a/TV-101", "plant-b/P-100"];
const METRICS = ["speedPct", "positionPct"];
const KEYS = ["a", "b", "c", "d"];

// Rounded to plant resolution: a subnormal spread is not a reading any instrument gives.
const reading = (min: number, max: number) => finite(min, max).map((v) => Math.round(v * 1000) / 1000);
const snapshot = fc.dictionary(fc.constantFrom(...KEYS), reading(-100, 200), { maxKeys: 4 });
// Few distinct values, so zero spreads, ties and shared keys come up constantly.
const value = fc.oneof(reading(0, 120), fc.constantFrom(0, 50, 80, 85, 100));

// Array order is chronological, as recordEvent appends it. proposalId marks a live event.
const eventsArb = fc
  .array(
    fc.record({
      componentId: fc.constantFrom(...COMPONENTS),
      metric: fc.constantFrom(...METRICS),
      after: value,
      upstreamSnapshot: snapshot,
      live: fc.boolean(),
    }),
    { maxLength: 30 },
  )
  .map((rows) =>
    rows.map((r, i) =>
      makeEvent(`e${i}`, r.componentId, r.metric, r.after, [], {
        at: iso(T0 + i * 1000),
        upstreamSnapshot: r.upstreamSnapshot,
        proposalId: r.live ? `plant-a-p${i}` : null,
      }),
    ),
  );

const limitArb = fc.constantFrom<Limit | undefined>(
  undefined,
  { min: 20, max: 90, critical: 95 },
  { min: 10, max: 80, critical: 90 },
  { min: 50, max: 50, critical: 50 },
);

const queryArb: fc.Arbitrary<SimilarQuery> = fc.record({
  history: eventsArb,
  componentId: fc.constantFrom(...COMPONENTS),
  metric: fc.constantFrom(...METRICS),
  to: value,
  upstreamSnapshot: snapshot,
  k: fc.integer({ min: 1, max: 12 }),
  limit: limitArb,
});

const matching = (q: SimilarQuery) =>
  q.history.filter((e) => e.componentId === q.componentId && e.metric === q.metric);

// Independent statement of the formula in TASK1.MD; ranges come from the target's definition.
function oracleDistance(q: SimilarQuery, e: HistoryEvent): number {
  const { metricRange, keyRange } = engine.similarRanges(q);
  const first = metricRange > 0 ? Math.abs(e.after - q.to) / metricRange : 0;
  const keys = Object.keys(q.upstreamSnapshot).filter((key) => key in e.upstreamSnapshot);
  if (keys.length === 0) return first;
  let sum = 0;
  for (const key of keys) {
    const range = keyRange(key);
    sum += range > 0 ? Math.abs(e.upstreamSnapshot[key]! - q.upstreamSnapshot[key]!) / range : 0;
  }
  return first + 0.5 * (sum / keys.length);
}

// What the target should rank: `head` is pinned first, `rest` sort by distance.
function plan(q: SimilarQuery) {
  const pool = matching(q);
  const live = engine.traits.similarLive;
  if (!live) return { head: null, rest: pool };
  const head = pool.filter((e) => e.proposalId !== null).at(-1) ?? null;
  const { metricRange } = engine.similarRanges(q);
  const rest = pool.filter((e) => {
    if (e === head) return false;
    return metricRange === 0 || Math.abs(e.after - q.to) / metricRange <= live.dropBeyond;
  });
  return { head, rest };
}

function expectedCount(q: SimilarQuery, k = q.k!) {
  const { head, rest } = plan(q);
  return Math.min(k, rest.length + (head ? 1 : 0));
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * (1 + Math.abs(a) + Math.abs(b));

describe(`similar [${engine.name}]`, () => {
  test("returns min(k, matches) events", () => {
    check(
      fc.property(queryArb, (q) => {
        expect(engine.similar(q).length).toBe(expectedCount(q));
      }),
    );
  });

  test("defaults to k = 5", () => {
    check(
      fc.property(queryArb, (q) => {
        const { k: _k, ...rest } = q;
        expect(engine.similar(rest).length).toBe(expectedCount(q, 5));
      }),
    );
  });

  test("filters on componentId and metric", () => {
    check(
      fc.property(queryArb, (q) => {
        for (const e of engine.similar(q)) {
          expect(e.componentId).toBe(q.componentId);
          expect(e.metric).toBe(q.metric);
        }
      }),
    );
  });

  test("returns the k smallest distances under the exact formula, nearest first", () => {
    check(
      fc.property(queryArb, (q) => {
        const { head, rest } = plan(q);
        const result = engine.similar(q);
        if (head && q.k! > 0) expect(result[0]!.id).toBe(head.id);
        const got = (head ? result.slice(1) : result).map((e) => oracleDistance(q, e));
        const want = rest
          .map((e) => oracleDistance(q, e))
          .sort((a, b) => a - b)
          .slice(0, head ? Math.max(0, q.k! - 1) : q.k);
        expect(got.length).toBe(want.length);
        got.forEach((d, i) => {
          expect(Number.isFinite(d)).toBe(true);
          if (!close(d, want[i]!)) {
            throw new Error(`rank ${i}: distance ${d}, oracle ${want[i]}`);
          }
        });
      }),
    );
  });

  test("is deterministic, including under reordered history", () => {
    check(
      fc.property(queryArb, fc.infiniteStream(fc.double({ min: 0, max: 1, noNaN: true })), (raw, stream) => {
        // Live events keep their chronological order; only seed events can arrive shuffled.
        const q = engine.traits.similarLive
          ? { ...raw, history: raw.history.map((e) => ({ ...e, proposalId: null })) }
          : raw;
        expect(engine.similar(q)).toEqual(engine.similar(q));
        const noise = [...stream.take(q.history.length)];
        const shuffled = q.history
          .map((e, i) => ({ e, r: noise[i]! }))
          .sort((a, b) => a.r - b.r)
          .map((x) => x.e);
        const a = engine.similar(q).map((e) => oracleDistance(q, e));
        const b = engine.similar({ ...q, history: shuffled }).map((e) => oracleDistance({ ...q, history: shuffled }, e));
        a.forEach((d, i) => {
          if (!close(d, b[i]!)) throw new Error(`rank ${i} changed under reorder: ${d} vs ${b[i]}`);
        });
      }),
    );
  });

  test("never mutates history or the query snapshot", () => {
    check(
      fc.property(queryArb, (q) => {
        const before = clone(q);
        deepFreeze(q);
        engine.similar(q);
        expect(q).toEqual(before);
      }),
    );
  });

  test("returned events are distinct events from history", () => {
    check(
      fc.property(queryArb, (q) => {
        const got = engine.similar(q);
        expect(new Set(got.map((e) => e.id)).size).toBe(got.length);
        for (const e of got) expect(q.history.some((h) => h.id === e.id)).toBe(true);
      }),
    );
  });

  test("handles zero ranges and snapshots that share no keys", () => {
    check(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        value,
        value,
        fc.integer({ min: 1, max: 8 }),
        (n, after, to, k) => {
          const history = Array.from({ length: n }, (_, i) =>
            makeEvent(`e${i}`, "plant-a/P-100", "speedPct", after, [], {
              upstreamSnapshot: i % 2 ? { a: 1 } : {},
            }),
          );
          const q = {
            history,
            componentId: "plant-a/P-100",
            metric: "speedPct",
            to,
            upstreamSnapshot: { a: 1, z: 9 },
            k,
          };
          const got = engine.similar(q);
          expect(got.length).toBe(expectedCount(q));
          for (const e of got) expect(Number.isFinite(oracleDistance(q, e))).toBe(true);
        },
      ),
    );
  });

  test("a snapshot key on only one side has no effect on the distance", () => {
    check(
      fc.property(queryArb, finite(-100, 200), (q, extra) => {
        const withExtra = {
          ...q,
          history: q.history.map((e) => ({
            ...e,
            upstreamSnapshot: { ...e.upstreamSnapshot, onlyEvent: extra },
          })),
        };
        expect(engine.similar(withExtra).map((e) => e.id)).toEqual(engine.similar(q).map((e) => e.id));
      }),
    );
  });

  test("the newest live event leads even when it is the furthest", () => {
    if (!engine.traits.similarLive) return;
    const history = [
      makeEvent("seed", "plant-a/P-100", "speedPct", 85),
      makeEvent("old-live", "plant-a/P-100", "speedPct", 85, [], { proposalId: "plant-a-p1", at: iso(T0) }),
      makeEvent("new-live", "plant-a/P-100", "speedPct", 65, [], { proposalId: "plant-a-p2", at: iso(T0 + 1000) }),
    ];
    const q = { history, componentId: "plant-a/P-100", metric: "speedPct", to: 85, upstreamSnapshot: {} };
    expect(engine.similar(q)[0]!.id).toBe("new-live");
    expect(engine.similar({ ...q, k: 1 }).map((e) => e.id)).toEqual(["new-live"]);
  });

  test("seed events far from the target stay out, so thin history reads as thin", () => {
    const live = engine.traits.similarLive;
    if (!live) return;
    const history = [
      makeEvent("near", "plant-b/P-100", "speedPct", 50),
      makeEvent("anchor", "plant-b/P-100", "speedPct", 100),
    ];
    const q = { history, componentId: "plant-b/P-100", metric: "speedPct", to: 100, upstreamSnapshot: {} };
    expect(engine.similar(q).map((e) => e.id)).toEqual(["anchor"]);
  });

  const empty = {
    history: [],
    componentId: "plant-a/P-100",
    metric: "speedPct",
    to: 85,
    upstreamSnapshot: {},
  };

  test("empty history returns nothing", () => {
    expect(engine.similar(empty)).toEqual([]);
  });

  test("k = 0 returns nothing", () => {
    const history = [makeEvent("e0", "plant-a/P-100", "speedPct", 85)];
    expect(engine.similar({ ...empty, history, k: 0 })).toEqual([]);
  });

  test("the demo query ranks the 85 runs ahead of the 65 runs", () => {
    const history = [
      makeEvent("safe", "plant-a/P-100", "speedPct", 65),
      makeEvent("bad1", "plant-a/P-100", "speedPct", 85),
      makeEvent("bad2", "plant-a/P-100", "speedPct", 86),
      makeEvent("other", "plant-a/P-100", "feedM3h", 85),
    ];
    const got = engine.similar({
      history,
      componentId: "plant-a/P-100",
      metric: "speedPct",
      to: 85,
      upstreamSnapshot: {},
      k: 2,
    });
    expect(got.map((e) => e.id)).toEqual(["bad1", "bad2"]);
  });
});

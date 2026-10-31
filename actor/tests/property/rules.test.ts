import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  check,
  clone,
  iso,
  makeEvent,
  plantComponents,
  T0,
  type ComponentState,
  type HistoryEvent,
  type LearnedRule,
  type RuleContext,
} from "./harness";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { engine, isReal } from "./target";

const PUMP = "plant-a/P-100";
const LV = "plant-a/LV-101";
const TK = "plant-a/TK-101";
const CTX: RuleContext = {
  components: plantComponents("plant-a"),
  otherPlantComponents: plantComponents("plant-b"),
};

const unsafe = (id: string, after = 85, position = 95) =>
  makeEvent(id, PUMP, "speedPct", after, [
    { componentId: LV, metric: "positionPct", before: 50, after: position, ticksToSettle: 3 },
  ]);
const safe = (id: string, after = 65) =>
  makeEvent(id, PUMP, "speedPct", after, [
    { componentId: LV, metric: "positionPct", before: 50, after: 67, ticksToSettle: 3 },
  ]);

// Replays recordEvent one event at a time, as the actor does after each execution.
async function record(events: HistoryEvent[], ctx: RuleContext = CTX) {
  let history: HistoryEvent[] = [];
  let rules: LearnedRule[] = [];
  let company: LearnedRule[] = [];
  const trace: { rules: LearnedRule[]; company: LearnedRule[] }[] = [];
  for (const [i, raw] of events.entries()) {
    const nowMs = T0 + i * 1000;
    const event = { ...raw, at: iso(nowMs) };
    const result = await engine.promoteAfterEvent(history, rules, company, event, ctx, nowMs);
    history = [...history, event];
    rules = result.planted;
    company = result.company;
    trace.push({ rules, company });
  }
  return { history, rules, company, trace };
}

const eventArb = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("unsafe" as const), after: fc.double({ min: 80, max: 100, noNaN: true }), position: fc.double({ min: 85, max: 100, noNaN: true }) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("safe" as const), after: fc.double({ min: 40, max: 75, noNaN: true }), position: fc.double({ min: 40, max: 79, noNaN: true }) }) },
  // The run that matters most: high `after`, yet nothing crossed. Must never count.
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("safeHigh" as const), after: fc.double({ min: 80, max: 100, noNaN: true }), position: fc.double({ min: 40, max: 79, noNaN: true }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("otherMetric" as const), after: fc.double({ min: 80, max: 100, noNaN: true }), position: fc.double({ min: 85, max: 100, noNaN: true }) }) },
);

function build(rows: { kind: string; after: number; position: number }[]) {
  return rows.map((r, i) => {
    const effects = [{ componentId: LV, metric: "positionPct", before: 50, after: r.position, ticksToSettle: 3 }];
    return makeEvent(`e${i}`, PUMP, r.kind === "otherMetric" ? "feedM3h" : "speedPct", r.after, effects);
  });
}

const crossed = (e: HistoryEvent) =>
  e.effects.some((x) => x.componentId === LV && x.metric === "positionPct" && x.after >= 80);

// Whether a rule is due for this metric once these events are on record.
function ruleDue(events: HistoryEvent[], metric: string): boolean {
  const pool = events.filter((e) => e.metric === metric);
  const unsafeRuns = pool.filter(crossed);
  if (unsafeRuns.length < 3) return false;
  if (!engine.traits.ruleThresholdScan) return true;
  const stop = Math.max(...unsafeRuns.map((e) => e.after));
  const start = Math.floor(Math.min(...unsafeRuns.map((e) => e.after)) / 5) * 5;
  for (let t = start; t <= stop; t += 5) {
    const atOrPast = pool.filter((e) => e.after >= t);
    if (atOrPast.length >= 3 && atOrPast.every(crossed)) return true;
  }
  return false;
}

describe(`rule promotion [${engine.name}]`, () => {
  test("fires on the third matching event and not before", async () => {
    const { trace } = await record([unsafe("e0"), unsafe("e1"), unsafe("e2")]);
    expect(trace[0]!.rules.length).toBe(0);
    expect(trace[1]!.rules.length).toBe(0);
    expect(trace[2]!.rules.length).toBe(1);
    expect(trace[2]!.rules[0]!.timesSeen).toBe(3);
    expect([...trace[2]!.rules[0]!.supportEventIds].sort()).toEqual(["e0", "e1", "e2"]);
  });

  test("dedupes on the fourth, keeping id and createdAt and bumping timesSeen", async () => {
    const { trace } = await record([unsafe("e0"), unsafe("e1"), unsafe("e2"), unsafe("e3")]);
    const [third, fourth] = [trace[2]!.rules, trace[3]!.rules];
    expect(fourth.length).toBe(1);
    expect(fourth[0]!.id).toBe(third[0]!.id);
    expect(fourth[0]!.createdAt).toBe(third[0]!.createdAt);
    expect(fourth[0]!.timesSeen).toBe(4);
    expect(fourth[0]!.supportEventIds.length).toBe(4);
    expect(Date.parse(fourth[0]!.lastSeenAt)).toBeGreaterThan(Date.parse(third[0]!.lastSeenAt));
  });

  test("replaying the same event does not count twice", async () => {
    const { history, rules, company } = await record([unsafe("e0"), unsafe("e1")]);
    const again = await engine.promoteAfterEvent(history, rules, company, history[1]!, CTX, T0 + 9000);
    expect(again.planted.length).toBe(0);
  });

  test("random mixes: every rule is backed by real, distinct, unsafe events", async () => {
    await check(
      fc.asyncProperty(fc.array(eventArb, { maxLength: 14 }), async (rows) => {
        const events = build(rows);
        const { rules, history, trace } = await record(events);
        for (const rule of rules) {
          const ids = rule.supportEventIds;
          expect(new Set(ids).size).toBe(ids.length);
          expect(ids.length).toBeGreaterThanOrEqual(3);
          expect(rule.timesSeen).toBeGreaterThanOrEqual(3);
          for (const id of ids) {
            const event = history.find((e) => e.id === id);
            if (!event) throw new Error(`rule cites unknown event ${id}`);
            if (!crossed(event)) throw new Error(`rule cites safe event ${id}, after=${event.after}`);
            if (event.metric !== rule.condition.metric) throw new Error(`rule cites other metric ${id}`);
            expect(event.after).toBeGreaterThanOrEqual(rule.condition.value);
          }
        }
        // As soon as the record supports a rule for a metric, the rule must exist.
        for (const metric of ["speedPct", "feedM3h"]) {
          const ruled = (t: { rules: LearnedRule[] }) => t.rules.some((r) => r.condition.metric === metric);
          trace.forEach((t, i) => {
            const due = ruleDue(events.slice(0, i + 1), metric);
            if (due && !ruled(t)) throw new Error(`no ${metric} rule after event ${i}`);
            if (ruled(t) && !trace.slice(0, i + 1).some((_, j) => ruleDue(events.slice(0, j + 1), metric))) {
              throw new Error(`${metric} rule at event ${i} with no supporting record`);
            }
          });
        }
      }),
    );
  });

  test("two unsafe runs plus any number of safe runs never make a rule", async () => {
    await check(
      fc.asyncProperty(
        fc.array(fc.double({ min: 40, max: 100, noNaN: true }), { maxLength: 12 }),
        fc.nat(100),
        async (afters, slot) => {
          const safes = afters.map((after, i) => safe(`s${i}`, after));
          const at = slot % (safes.length + 1);
          const events = [...safes.slice(0, at), unsafe("u0"), ...safes.slice(at), unsafe("u1")];
          expect((await record(events)).rules.length).toBe(0);
        },
      ),
    );
  });

  test("a safe run alone never counts, however many there are", async () => {
    await check(
      fc.asyncProperty(fc.array(fc.double({ min: 0, max: 79.9, noNaN: true }), { minLength: 3, maxLength: 12 }), async (positions) => {
        const events = positions.map((position, i) =>
          makeEvent(`s${i}`, PUMP, "speedPct", 85, [
            { componentId: LV, metric: "positionPct", before: 50, after: position, ticksToSettle: 3 },
          ]),
        );
        const { rules, company } = await record(events);
        // A position at or under LV-101's min (10) is a real low-side crossing, not a safe run.
        const highSide = rules.filter((r) => r.consequence.op === ">=");
        expect(highSide.length).toBe(0);
        expect(company.filter((r) => r.consequence.op === ">=").length).toBe(0);
      }),
    );
  });

  test("effects on different components do not pool into one rule", async () => {
    const onTank = (id: string) =>
      makeEvent(id, PUMP, "speedPct", 85, [
        { componentId: TK, metric: "levelPct", before: 50, after: 75, ticksToSettle: 3 },
      ]);
    expect((await record([unsafe("e0"), unsafe("e1"), onTank("e2")])).rules.length).toBe(0);
  });

  test("events on another component or metric do not pool either", async () => {
    const fromCoil = makeEvent("c0", "plant-a/E-101", "dutyKw", 1500, [
      { componentId: LV, metric: "positionPct", before: 50, after: 95, ticksToSettle: 3 },
    ]);
    expect((await record([unsafe("e0"), unsafe("e1"), fromCoil])).rules.length).toBe(0);
  });

  test("recording order does not matter: same events, same supported rule", async () => {
    await check(
      fc.asyncProperty(
        fc.array(eventArb, { minLength: 3, maxLength: 10 }),
        fc.array(fc.nat(1000), { minLength: 10, maxLength: 10 }),
        async (rows, ranks) => {
          const events = build(rows);
          const shuffled = events
            .map((e, i) => ({ e, r: ranks[i]! }))
            .sort((a, b) => a.r - b.r)
            .map((x) => x.e);
          const ids = (rules: LearnedRule[]) => rules.flatMap((r) => r.supportEventIds).sort();
          expect(ids((await record(events)).rules)).toEqual(ids((await record(shuffled)).rules));
        },
      ),
      2000,
    );
  });

  test("promotes to the company only when the model exists in both plants", async () => {
    await check(
      fc.asyncProperty(fc.boolean(), fc.boolean(), async (lvShared, pumpShared) => {
        const other = clone(plantComponents("plant-b")).map((c: ComponentState) => {
          if (c.tag === "LV-101" && !lvShared) return { ...c, model: "something-else" };
          if (c.tag === "P-100" && !pumpShared) return { ...c, model: "something-else" };
          return c;
        });
        const ctx = { ...CTX, otherPlantComponents: other };
        const { rules, company } = await record([unsafe("e0"), unsafe("e1"), unsafe("e2")], ctx);
        expect(rules.length).toBe(1);
        expect(company.length).toBe(lvShared ? 1 : 0);
        for (const rule of company) {
          expect(rule.scope).toBe("company");
          expect(rule.model).toBeTruthy();
        }
      }),
      100,
    );
  });

  test("a contradicted rule and a never-made rule agree: order of a safe run is irrelevant", async () => {
    const before = await record([unsafe("e0"), unsafe("e1"), unsafe("e2"), safe("s0", 90)]);
    const after = await record([safe("s0", 90), unsafe("e0"), unsafe("e1"), unsafe("e2")]);
    expect(before.rules.length).toBe(after.rules.length);
  });

  test("company rules from different changed components stay separate", async () => {
    const run = (id: string, componentId: string, after: number) =>
      makeEvent(id, componentId, "positionPct", after, [
        { componentId: TK, metric: "levelPct", before: 50, after: 75, ticksToSettle: 3 },
      ]);
    const events = [
      run("v0", LV, 85), run("v1", LV, 85), run("v2", LV, 85),
      run("s0", "plant-a/TV-101", 60), run("s1", "plant-a/TV-101", 60), run("s2", "plant-a/TV-101", 60),
    ];
    const { rules, company } = await record(events);
    expect(rules.length).toBe(2);
    expect(company.length).toBe(2);
  });

  const STAND_IN = join(import.meta.dir, "../fixtures-gen/history.json");

  test.skipIf(!isReal || !existsSync(STAND_IN))("stand-in history yields the demo rule and the demo retrieval", async () => {
    const history: HistoryEvent[] = JSON.parse(readFileSync(STAND_IN, "utf8"));
    const plantA = history.filter((e) => e.plantId === "plant-a");
    const { rules, history: recorded } = await record(plantA.map((e) => ({ ...e, proposalId: null })));
    const demo = rules.find(
      (r) => r.condition.componentId === PUMP && r.consequence.componentId === LV && r.consequence.op === ">=",
    );
    if (!demo) throw new Error(`no P-100 -> LV-101 rule; rules: ${rules.map((r) => r.text).join("; ")}`);
    expect(demo.condition.value).toBeLessThanOrEqual(85);
    expect(demo.consequence.value).toBeGreaterThanOrEqual(80);
    expect(demo.timesSeen).toBeGreaterThanOrEqual(3);
    const similar = engine.similar({
      history: recorded,
      componentId: PUMP,
      metric: "speedPct",
      to: 85,
      upstreamSnapshot: {},
      limit: { min: 20, max: 90, critical: 95 },
    });
    expect(similar.length).toBe(5);
    for (const event of similar) {
      expect(event.after).toBeGreaterThanOrEqual(74.5);
      const row = event.effects.find((x) => x.componentId === LV && x.metric === "positionPct")!;
      if (event.after >= 80) expect(row.after).toBeGreaterThanOrEqual(80);
    }
  }, 60_000);

  test("company dedupes and bumps timesSeen", async () => {
    const { company } = await record([unsafe("e0"), unsafe("e1"), unsafe("e2"), unsafe("e3")]);
    expect(company.length).toBe(1);
    expect(company[0]!.timesSeen).toBeGreaterThanOrEqual(4);
  });

  test("a company rule names no plant-specific component, so plant-b can apply it", async () => {
    const { company } = await record([unsafe("e0"), unsafe("e1"), unsafe("e2")]);
    expect(company.length).toBe(1);
    const rule = company[0]!;
    for (const id of [rule.condition.componentId, rule.consequence.componentId]) {
      if (id !== null) expect(id.startsWith("plant-a/")).toBe(false);
    }
  });

  const submitted = (supportEventIds: string[], overrides: Partial<LearnedRule> = {}): LearnedRule => ({
    id: "agent-rule",
    scope: "plant",
    model: "outlet-valve-A",
    text: "pump >= 80 -> valve >= 85",
    condition: { componentId: PUMP, metric: "speedPct", op: ">=", value: 80 },
    consequence: { componentId: LV, metric: "positionPct", op: ">=", value: 85, withinTicks: 3 },
    supportEventIds,
    timesSeen: Math.max(3, supportEventIds.length),
    createdAt: iso(T0),
    lastSeenAt: iso(T0),
    ...overrides,
  });
  const HISTORY = [unsafe("e0"), unsafe("e1"), unsafe("e2"), safe("s0", 85), safe("s1", 85), safe("s2", 65)];

  test("an agent-submitted rule with three real unsafe events is accepted", async () => {
    expect(await engine.submitRule(submitted(["e0", "e1", "e2"]), HISTORY, CTX)).toBe(true);
  });

  test("an agent-submitted rule needs three distinct real ids", async () => {
    expect(await engine.submitRule(submitted(["e0", "e1"]), HISTORY, CTX)).toBe(false);
    expect(await engine.submitRule(submitted([]), HISTORY, CTX)).toBe(false);
    expect(await engine.submitRule(submitted(["e0", "e1", "fabricated"]), HISTORY, CTX)).toBe(false);
    expect(await engine.submitRule(submitted(["e0", "e0", "e0"]), HISTORY, CTX)).toBe(false);
  });

  test("a safe run is never accepted as support for an unsafe rule", async () => {
    await check(
      fc.asyncProperty(
        fc.subarray(["s0", "s1", "s2"], { minLength: 1 }),
        async (safeIds) => {
          const ids = [...safeIds, "e0", "e1", "e2"].slice(0, 3);
          expect(await engine.submitRule(submitted(ids), HISTORY, CTX)).toBe(false);
        },
      ),
      50,
    );
  });

  test("three safe runs alone are never accepted as support", async () => {
    expect(await engine.submitRule(submitted(["s0", "s1", "s2"]), HISTORY, CTX)).toBe(false);
  });

  test("a rule whose condition no support event meets is refused", async () => {
    const lowThreshold = submitted(["e0", "e1", "e2"], {
      condition: { componentId: PUMP, metric: "speedPct", op: ">=", value: 95 },
    });
    expect(await engine.submitRule(lowThreshold, HISTORY, CTX)).toBe(false);
  });

  test("Company refuses a rule for a model only one plant has", async () => {
    const onlyHere = clone(CTX);
    onlyHere.otherPlantComponents = onlyHere.otherPlantComponents.map((c) =>
      c.tag === "LV-101" ? { ...c, model: "something-else" } : c,
    );
    const rule = submitted(["e0", "e1", "e2"], {
      scope: "company",
      condition: { componentId: null, metric: "speedPct", op: ">=", value: 80 },
      consequence: { componentId: null, metric: "positionPct", op: ">=", value: 85, withinTicks: 3 },
    });
    expect(await engine.submitCompanyRule(rule, CTX)).toBe(true);
    expect(await engine.submitCompanyRule(rule, onlyHere)).toBe(false);
  });
});

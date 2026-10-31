// The real seed (shared/plants.json and shared/history.json) through the real actor classes.
// The demo stands on these facts, so a regenerated history gets checked as soon as it lands.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, type HistoryEvent, type LearnedRule } from "./harness";
import { isReal } from "./target";
import { onStage, type Stage } from "./world";

const SEED = join(import.meta.dir, "../../../shared/history.json");
const history: HistoryEvent[] = existsSync(SEED) ? JSON.parse(readFileSync(SEED, "utf8")) : [];

const PUMP = (plant: string) => `${plant}/P-100`;
const LV = (plant: string) => `${plant}/LV-101`;

const lvAfter = (event: HistoryEvent, plant: string) =>
  event.effects.find((e) => e.componentId === LV(plant) && e.metric === "positionPct")?.after;

const demoRule = (rules: LearnedRule[]) =>
  rules.find((r) => r.condition.metric === "speedPct" && r.consequence.metric === "positionPct" && r.consequence.op === ">=");

async function seeded(stage: Stage) {
  await stage.seedAll({ history });
  for (const plant of ["plant-a", "plant-b", "plant-a"]) {
    await stage.plant(plant).sweep();
    await stage.idle();
  }
  return stage;
}

const similar = (stage: Stage, plant: string, to: number) => stage.plant(plant).similar(PUMP(plant), "speedPct", to, {}, 5);

describe.skipIf(!isReal || history.length === 0)("real seed [real logic, fake runtime]", () => {
  let quiet: ReturnType<typeof spyOn>;
  beforeAll(() => {
    quiet = spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(() => quiet.mockRestore());

  test("every seeded event loads, and each plant keeps only its own", async () => {
    await onStage(async (stage) => {
      await seeded(stage);
      for (const plant of ["plant-a", "plant-b"]) {
        const kept = stage.rawPlant(plant).history as HistoryEvent[];
        expect(kept.length).toBe(history.filter((e) => e.plantId === plant).length);
        expect(kept.every((e) => e.plantId === plant)).toBe(true);
      }
      expect(new Set(history.map((e) => e.id)).size).toBe(history.length);
    });
  });

  test("plant-a learns P-100 -> LV-101 from real unsafe runs only", async () => {
    await onStage(async (stage) => {
      await seeded(stage);
      const rule = demoRule(stage.rawPlant("plant-a").rules);
      if (!rule) throw new Error("plant-a has no P-100 -> LV-101 rule");
      expect(rule.condition.componentId).toBe(PUMP("plant-a"));
      expect(rule.consequence.componentId).toBe(LV("plant-a"));
      expect(rule.model).toBe("outlet-valve-A");
      expect(rule.condition.value).toBeLessThanOrEqual(85);
      expect(rule.supportEventIds.length).toBeGreaterThanOrEqual(3);
      for (const id of rule.supportEventIds) {
        const event = history.find((e) => e.id === id)!;
        expect(event.after).toBeGreaterThanOrEqual(rule.condition.value);
        expect(lvAfter(event, "plant-a")!).toBeGreaterThanOrEqual(rule.consequence.value);
        expect(lvAfter(event, "plant-a")!).toBeGreaterThanOrEqual(80);
      }
    });
  });

  test("the rule covers 85, so a repeat of the demo's bad proposal falls under it", async () => {
    await onStage(async (stage) => {
      await seeded(stage);
      const rule = demoRule(stage.rawPlant("plant-a").rules)!;
      expect(85).toBeGreaterThanOrEqual(rule.condition.value);
      expect(65).toBeLessThan(rule.condition.value);
    });
  });

  test("plant-b has no rule of its own, so the demo's claim that it learned from plant-a holds", async () => {
    await onStage(async (stage) => {
      await seeded(stage);
      expect(demoRule(stage.rawPlant("plant-b").rules)).toBeUndefined();
      const crossed = history.filter((e) => e.plantId === "plant-b" && lvAfter(e, "plant-b")! >= 80);
      expect(crossed.length).toBe(0);
    });
  });

  test("the rule reaches Company and plant-b can read it, naming plant-a", async () => {
    await onStage(async (stage) => {
      await seeded(stage);
      const rules: LearnedRule[] = await stage.plant("plant-b").rulesFor(LV("plant-b"), "outlet-valve-A");
      const rule = rules.find((r) => r.scope === "company" && r.consequence.metric === "positionPct");
      if (!rule) throw new Error("plant-b cannot see the company rule");
      expect(rule.text).toContain("first learned in plant-a");
      expect(rule.condition.componentId).toBeNull();
      expect(rule.consequence.componentId).toBeNull();
    });
  });

  test("plant-a retrieves its unsafe runs for 85, all showing LV-101 past its limit", async () => {
    await onStage(async (stage) => {
      await seeded(stage);
      const events: HistoryEvent[] = await similar(stage, "plant-a", 85);
      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(events.filter((e) => lvAfter(e, "plant-a")! >= 85).length).toBeGreaterThanOrEqual(3);
    });
  });

  test("plant-a retrieves safe runs for 65, none near LV-101's threshold", async () => {
    await onStage(async (stage) => {
      await seeded(stage);
      const events: HistoryEvent[] = await similar(stage, "plant-a", 65);
      expect(events.length).toBeGreaterThanOrEqual(3);
      for (const event of events) expect(lvAfter(event, "plant-a")!).toBeLessThan(81);
    });
  });

  test("plant-b has too little history near 85 to count as evidence", async () => {
    await onStage(async (stage) => {
      await seeded(stage);
      const events: HistoryEvent[] = await similar(stage, "plant-b", 85);
      expect(events.length).toBeLessThan(3);
    });
  });

  test("retrieval for any legal target stays within its relevance band and its own plant", async () => {
    await onStage(async (stage) => {
      await seeded(stage);
      await check(
        fc.asyncProperty(fc.constantFrom("plant-a", "plant-b"), fc.double({ min: 20, max: 94.9, noNaN: true }), async (plant, to) => {
          const events: HistoryEvent[] = await similar(stage, plant, to);
          expect(events.length).toBeLessThanOrEqual(5);
          for (const event of events) {
            expect(event.plantId).toBe(plant);
            expect(Math.abs(event.after - to) / 70).toBeLessThanOrEqual(0.15 + 1e-9);
          }
          // An empty query snapshot leaves the after gap as the whole distance, so order is exact.
          const gaps = events.map((e) => Math.abs(e.after - to));
          for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]!);
        }),
        500,
      );
    });
  });
});

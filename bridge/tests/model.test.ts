// Fast checks on the model itself, no server. Compares steady states and transients with CLAUDE.MD.
// Run: bun test bridge/tests/model.test.ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { historyEventSchema } from "../../agent/schemas";
import { PARAMS, SteamUnit, headerBarg, steamDemandKgH, steamFlowKgH, summarizeEffects, type Params } from "../tank_model";

const HOURS = 360;

function runTo(speed: number, hours = 8, params: Params = PARAMS) {
  const unit = new SteamUnit(params);
  const plant = unit.plants["plant-a"];
  plant.speedPct = speed;
  let peakLv = 0;
  let lowT = Infinity;
  for (let n = 0; n < hours * HOURS; n++) {
    unit.scan();
    peakLv = Math.max(peakLv, plant.valveLv * 100);
    lowT = Math.min(lowT, plant.T);
  }
  return { unit, plant, peakLv, lowT };
}

test("design point sits still", () => {
  const unit = new SteamUnit();
  const plant = unit.plants["plant-a"];
  const start = plant.metrics();
  expect(start["TK-101"]).toEqual({ levelPct: 50, tempC: 75 });
  expect(start["TV-101"].steamKgH).toBeCloseTo(1533, 0);
  expect(start["E-101"].dutyKw).toBeCloseTo(898.5, 0);
  expect(start["LV-101"].positionPct).toBeCloseTo(50, 0);
  for (let n = 0; n < 8 * HOURS; n++) unit.scan();
  expect(plant.T).toBeCloseTo(75, 6);
  expect(plant.h).toBeCloseTo(2, 6);
  expect(plant.metrics()["TV-101"].steamKgH).toBeCloseTo(1533, 0);
});

test.each([
  [65, 64.9, 1980, 1160],
  [85, 84.9, 2570, 1510],
])("steady state at speed %d matches CLAUDE.MD", (speed, lv, steam, duty) => {
  const m = runTo(speed).plant.metrics();
  expect(Math.abs(m["LV-101"].positionPct - lv)).toBeLessThan(0.1);
  expect(Math.abs(m["TV-101"].steamKgH - steam)).toBeLessThan(10);
  expect(Math.abs(m["E-101"].dutyKw - duty)).toBeLessThan(10);
  expect(m["TK-101"].tempC).toBeCloseTo(75, 2);
  expect(m["TK-101"].levelPct).toBeCloseTo(50, 2);
});

test("at speed 100 steam stops at the 3000 kg/h controller range", () => {
  const m = runTo(100, 12).plant.metrics();
  expect(steamDemandKgH(PARAMS, 100, 25, 20)).toBeCloseTo(3020, -1);
  expect(m["TV-101"].steamKgH).toBeCloseTo(3000, 0);
  expect(m["TK-101"].tempC).toBeCloseTo(74.67, 1);
  expect(Math.abs(m["LV-101"].positionPct - 99.9)).toBeLessThan(0.2);
});

test("transients stay in the CLAUDE.MD ranges", () => {
  const to65 = runTo(65, 3);
  expect(75 - to65.lowT).toBeGreaterThan(1.7);
  expect(75 - to65.lowT).toBeLessThan(2.3);
  const to85 = runTo(85, 3);
  expect(to85.peakLv - 85).toBeGreaterThan(2.9);
  expect(to85.peakLv - 85).toBeLessThan(5);
  expect(75 - to85.lowT).toBeGreaterThan(3.8);
  expect(75 - to85.lowT).toBeLessThan(4.6);
  const to26m3h = runTo(26 / 0.3, 3);
  expect(to26m3h.peakLv).toBeGreaterThan(87);
  expect(to26m3h.peakLv).toBeLessThan(90.1);
});

test("at 33 m3/h LV-101 sticks at 100 and the level climbs to about 2.39 m in an hour", () => {
  const { plant } = runTo(110, 1);
  expect(plant.valveLv).toBe(1);
  expect(plant.h).toBeGreaterThan(2.37);
  expect(plant.h).toBeLessThan(2.4);
});

test("the temperature loop swing at high feed is the FIC-201 scan, and FT-201 damping removes it", () => {
  const swing = (ft201DampingS: number) => {
    const params = { ...PARAMS, ft201DampingS };
    const { unit, plant } = runTo(100, 4, params);
    let low = Infinity;
    let high = -Infinity;
    for (let n = 0; n < HOURS; n++) {
      unit.scan();
      low = Math.min(low, plant.T);
      high = Math.max(high, plant.T);
    }
    return high - low;
  };
  expect(swing(0)).toBeGreaterThan(1);
  expect(swing(PARAMS.ft201DampingS)).toBeLessThan(0.01);
});

test("lower header pressure means a wider TV-101 for the same steam", () => {
  const at6 = new SteamUnit();
  const flow = steamFlowKgH(PARAMS, 0.6, 5.5);
  expect(flow).toBeLessThan(steamFlowKgH(PARAMS, 0.6, 6));
  expect(headerBarg(PARAMS, 3066)).toBe(6);
  expect(headerBarg(PARAMS, 100000)).toBe(4.5);
  expect(headerBarg(PARAMS, 0)).toBe(6.5);
  const plantB = at6.plants["plant-b"];
  at6.plants["plant-a"].speedPct = 85;
  const start = plantB.valveTv;
  for (let n = 0; n < 4 * HOURS; n++) at6.scan();
  expect(plantB.valveTv).toBeGreaterThan(start);
  expect(plantB.steamKgH).toBeCloseTo(1533, 0);
  const drop = 6 - plantB.headerBarg;
  expect(drop).toBeGreaterThan(0.3);
  expect(drop).toBeLessThan(0.6);
});

test("effect rows: LV-101 reports the peak, the rest report tick 5", () => {
  const samples = [{ "plant-a/TK-101": { levelPct: 50, tempC: 75 }, "plant-a/LV-101": { positionPct: 50 }, "plant-a/E-101": { dutyKw: 900 }, "plant-a/TV-101": { positionPct: 50, steamKgH: 1533, headerBarg: 6 } }];
  for (const lv of [60, 70, 72, 71, 70]) samples.push({ ...samples[0], "plant-a/LV-101": { positionPct: lv } });
  const rows = summarizeEffects("plant-a", samples);
  const row = rows.find((r) => r.componentId === "plant-a/LV-101");
  expect(row).toMatchObject({ before: 50, after: 72, ticksToSettle: 3 });
  expect(rows.length).toBe(7);
});

test("every event in shared/history.json passes the zod HistoryEvent schema", () => {
  const events = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "shared", "history.json"), "utf8"));
  expect(events.length).toBe(300);
  for (const event of events) historyEventSchema.parse(event);
});

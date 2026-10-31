// The TASK2.MD test list, run against a real live_sim process in real time: 1 tick = 1 wall second. Takes about 2.5 min.
// Glue is the FAKE in harness.ts, so these prove the bridge side of /mirror and /observed, not the integration.
// Run: bun test bridge/tests/live.test.ts --timeout 200000
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { routeSchemas } from "../../actor/tests/contract/lib/glue-spec";
import { Bridge, FakeGlue } from "./harness";

const PORT = Number(process.env.TEST_BRIDGE_PORT ?? 7319);
const GLUE_PORT = PORT + 10;
const glue = new FakeGlue(GLUE_PORT);
const bridge = new Bridge(PORT, GLUE_PORT);
const measured: Record<string, unknown> = {};

const EXPECTED: Record<string, string[]> = {
  "P-100": ["feedM3h", "speedPct"],
  "TK-101": ["levelPct", "tempC"],
  "LV-101": ["positionPct"],
  "E-101": ["dutyKw"],
  "TV-101": ["headerBarg", "positionPct", "steamKgH"],
};
const IDS = ["plant-a", "plant-b"].flatMap((plant) => Object.keys(EXPECTED).map((tag) => `${plant}/${tag}`));

beforeAll(async () => {
  await bridge.start();
});

afterAll(() => {
  console.log(`MEASURED ${JSON.stringify(measured, null, 1)}`);
  bridge.stop();
  glue.stop();
});

test("reader: full metrics for all 10 components every tick for 60 s, and every tick pushed to /mirror", async () => {
  await bridge.reset();
  await Bun.sleep(1100);
  glue.clear();
  const series = await bridge.record(60);
  const ticks = series.map((s) => s.tick);
  expect(ticks.length).toBe(61);
  for (let n = 1; n < ticks.length; n++) expect(ticks[n]).toBe(ticks[n - 1] + 1);
  for (const { metrics } of series) {
    expect(Object.keys(metrics).sort()).toEqual([...IDS].sort());
    for (const id of IDS) {
      expect(Object.keys(metrics[id]).sort()).toEqual(EXPECTED[id.split("/")[1]]);
      for (const value of Object.values(metrics[id])) expect(Number.isFinite(value)).toBe(true);
    }
  }
  await Bun.sleep(300);
  const mirrors = glue.of("/mirror");
  const gaps: Record<string, number> = {};
  for (const id of IDS) {
    const pushes = mirrors.filter((m) => m.body.componentId === id);
    expect(pushes.length).toBeGreaterThanOrEqual(60);
    let worst = 0;
    for (let n = 1; n < pushes.length; n++) worst = Math.max(worst, pushes[n].at - pushes[n - 1].at);
    gaps[id] = Math.round(worst);
    expect(worst).toBeLessThan(2000);
    for (const push of pushes) expect(routeSchemas["/mirror"].safeParse(push.body).success).toBe(true);
  }
  const health = await bridge.health();
  measured.reader = { ticks: ticks.length - 1, mirrorPushes: mirrors.length, worstGapMsByComponent: Math.max(...Object.values(gaps)), late: health.stats.lateTicks, dropped: health.stats.droppedTicks, skipped: health.stats.mirrorSkippedBusy, mirrorFailed: health.stats.mirrorFailed };
}, 90000);

test("P-100 to 65: LV-101 settles 60-72 within 5 ticks; temperature measured against the 1 C band", async () => {
  await bridge.reset();
  const write = await bridge.setpoint("plant-a/P-100", "speedPct", 65, "test-65");
  expect(write.status).toBe(200);
  expect(write.body.applied).toBe(65);
  const series = (await bridge.record(12)).filter((s) => s.tick > write.body.tick);
  const lv = series.map((s) => s.metrics["plant-a/LV-101"].positionPct);
  const temp = series.map((s) => s.metrics["plant-a/TK-101"].tempC);
  expect(lv[4]).toBeGreaterThanOrEqual(60);
  expect(lv[4]).toBeLessThanOrEqual(72);
  for (const value of lv.slice(1)) expect(value).toBeLessThanOrEqual(72);
  const back = temp.findIndex((value, n) => n >= temp.indexOf(Math.min(...temp)) && Math.abs(value - 75) <= 1) + 1;
  measured.step65 = { lvByTick: lv, tempByTick: temp, tempAtTick5: temp[4], tempWithin1CAtTick: back };
  expect(back).toBeGreaterThan(0);

  const observed = glue.observed("test-65");
  expect(observed.length).toBe(1);
  expect(routeSchemas["/observed"].safeParse(observed[0].body).success).toBe(true);
  const rows = observed[0].body.effects;
  expect(rows.filter((r: any) => r.componentId.startsWith("plant-a/")).length).toBe(7);
  const row = rows.find((r: any) => r.componentId === "plant-a/LV-101");
  expect(row.after).toBeGreaterThanOrEqual(Math.max(...lv.slice(0, 5)) - 0.01);
  measured.step65.observed = rows;
}, 30000);

test("live LV-101 after a step to 65 lands on the seeded history", async () => {
  const history = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "shared", "history.json"), "utf8"));
  const seeded = history.filter((e: any) => e.plantId === "plant-a" && e.before === 50 && e.after === 65).map((e: any) => e.effects.find((r: any) => r.componentId === "plant-a/LV-101").after);
  const live = glue.observed("test-65")[0].body.effects.find((r: any) => r.componentId === "plant-a/LV-101").after;
  expect(seeded.length).toBeGreaterThanOrEqual(3);
  for (const value of seeded) expect(Math.abs(value - live)).toBeLessThan(0.5);
  measured.historyParity = { live, seeded };
});

test("P-100 to 85: LV-101 at or above 85 within 3 ticks", async () => {
  await bridge.reset();
  const write = await bridge.setpoint("plant-a/P-100", "speedPct", 85, "test-85");
  const series = (await bridge.record(6)).filter((s) => s.tick > write.body.tick);
  const lv = series.map((s) => s.metrics["plant-a/LV-101"].positionPct);
  measured.step85 = { lvByTick: lv, tempByTick: series.map((s) => s.metrics["plant-a/TK-101"].tempC) };
  expect(lv[2]).toBeGreaterThanOrEqual(85);
}, 20000);

test("P-100 to 100: LV-101 reaches 100 and the level climbs while it opens", async () => {
  await bridge.reset();
  const write = await bridge.setpoint("plant-a/P-100", "speedPct", 100, "test-100");
  const series = (await bridge.record(8)).filter((s) => s.tick > write.body.tick);
  const lv = series.map((s) => s.metrics["plant-a/LV-101"].positionPct);
  const level = series.map((s) => s.metrics["plant-a/TK-101"].levelPct);
  const atFull = lv.findIndex((value) => value >= 99.99);
  measured.step100 = { lvByTick: lv, levelByTick: level, lvAt100FromTick: atFull + 1, levelPeakTick: level.indexOf(Math.max(...level)) + 1, levelRisingWhileLvAt100: atFull > 0 && level[atFull] > level[atFull - 1] };
  expect(atFull).toBeGreaterThanOrEqual(0);
  expect(Math.max(...level)).toBeGreaterThan(52);
  expect(level[0]).toBeGreaterThan(50);
}, 20000);

test("plant-a at 85 lowers plant-b's header and opens plant-b's TV-101", async () => {
  await bridge.reset();
  await Bun.sleep(1200);
  const before = await bridge.snapshot();
  await bridge.setpoint("plant-a/P-100", "speedPct", 85, "test-cross");
  const series = await bridge.record(8);
  const after = series[series.length - 1].metrics;
  const headerBefore = before.metrics["plant-b/TV-101"].headerBarg;
  const headerAfter = after["plant-b/TV-101"].headerBarg;
  const tvBefore = before.metrics["plant-b/TV-101"].positionPct;
  const tvAfter = after["plant-b/TV-101"].positionPct;
  measured.crossPlant = { headerBefore, headerAfter, drop: Number((headerBefore - headerAfter).toFixed(3)), tvBefore, tvAfter, plantBSteamAfter: after["plant-b/TV-101"].steamKgH, plantBTempAfter: after["plant-b/TK-101"].tempC };
  expect(headerAfter).toBeLessThan(headerBefore);
  expect(tvAfter).toBeGreaterThan(tvBefore);
  const crossRows = glue.observed("test-cross")[0].body.effects.filter((r: any) => r.componentId.startsWith("plant-b/"));
  expect(crossRows.some((r: any) => r.metric === "headerBarg")).toBe(true);
}, 20000);

test("reset returns both plants to the design steady state and cancels pending observations", async () => {
  await bridge.setpoint("plant-b/P-100", "speedPct", 70, "test-cancel");
  const reset = await bridge.reset();
  expect(reset.snapshot["plant-a/P-100"]).toEqual({ speedPct: 50, feedM3h: 15 });
  expect(reset.snapshot["plant-a/TK-101"].tempC).toBe(75);
  expect(reset.snapshot["plant-a/TK-101"].levelPct).toBe(50);
  expect(reset.snapshot["plant-b/TV-101"].headerBarg).toBeCloseTo(6, 2);
  expect(reset.snapshot["plant-b/TV-101"].steamKgH).toBeCloseTo(1533, -1);
  await Bun.sleep(6500);
  expect(glue.observed("test-cancel").length).toBe(0);
}, 15000);

test("a retried setpoint does not move the plant twice or start a second observation", async () => {
  await bridge.reset();
  const first = await bridge.setpoint("plant-b/P-100", "speedPct", 60, "test-dup");
  const second = await bridge.setpoint("plant-b/P-100", "speedPct", 60, "test-dup");
  const conflict = await bridge.setpoint("plant-b/P-100", "speedPct", 61, "test-dup");
  expect(first.body.duplicate).toBe(false);
  expect(second.status).toBe(200);
  expect(second.body.duplicate).toBe(true);
  expect(conflict.status).toBe(409);
  await Bun.sleep(6500);
  expect(glue.observed("test-dup").length).toBe(1);
}, 15000);

test("/observed is retried after a glue 500", async () => {
  await bridge.reset();
  glue.observedStatus = [500];
  await bridge.setpoint("plant-b/P-100", "speedPct", 55, "test-retry");
  await Bun.sleep(7500);
  expect(glue.observed("test-retry").length).toBe(2);
}, 15000);

test("a glue that stops answering /mirror does not stall the plant", async () => {
  const before = await bridge.health();
  glue.mirrorDelayMs = 2000;
  await Bun.sleep(4300);
  const after = await bridge.health();
  glue.mirrorDelayMs = 0;
  await Bun.sleep(2200);
  expect(after.tick - before.tick).toBeGreaterThanOrEqual(4);
  expect(after.stats.droppedTicks).toBe(before.stats.droppedTicks);
  const failed = after.stats.mirrorFailed - before.stats.mirrorFailed;
  const skipped = after.stats.mirrorSkippedBusy - before.stats.mirrorSkippedBusy;
  measured.slowGlue = { ticks: after.tick - before.tick, failed, skippedBatches: skipped };
  expect(failed + 10 * skipped).toBeGreaterThanOrEqual(30);
  const recovered = (await bridge.health()).stats.mirrorPushed;
  await Bun.sleep(1500);
  expect((await bridge.health()).stats.mirrorPushed).toBeGreaterThan(recovered);
}, 15000);

test("bad writes are refused", async () => {
  const raw = (body: string, headers: Record<string, string>) => fetch(`${bridge.url}/setpoint`, { method: "POST", headers, body });
  const json = { "content-type": "application/json" };
  expect((await bridge.setpoint("plant-a/P-100", "speedPct", 101, "bad-1")).status).toBe(400);
  expect((await bridge.setpoint("plant-a/LV-101", "positionPct", 50, "bad-2")).status).toBe(400);
  expect((await bridge.setpoint("plant-c/P-100", "speedPct", 50, "bad-3")).status).toBe(400);
  expect((await raw(JSON.stringify({ componentId: "plant-a/P-100", metric: "speedPct", value: 60 }), json)).status).toBe(400);
  expect((await raw(JSON.stringify({ componentId: "plant-a/P-100", metric: "speedPct", value: "60", proposalId: "bad-4" }), json)).status).toBe(400);
  expect((await raw("{", json)).status).toBe(400);
  expect((await raw("{}", { "content-type": "text/plain" })).status).toBe(415);
  expect((await raw("{}", { ...json, origin: "https://example.com" })).status).toBe(403);
  expect((await fetch(`${bridge.url}/reset`, { method: "POST", headers: { origin: "https://example.com" } })).status).toBe(403);
  expect((await fetch(`${bridge.url}/snapshot?plantId=plant-c`)).status).toBe(400);
  expect((await bridge.snapshot("plant-a")).metrics["plant-a/P-100"].speedPct).toBe(50);
});

// Checks the expected-outcome functions against the published plant numbers. Run: node --test agent/evals/vote/oracle.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { dutyAt, expectedVote, headerAt, lvPeak, lvSteady, plantSeed, stepEffects, steamAt, tempDip, tempRise, thresholdFor, voterTruth } from "./plant.mjs";
import { generate } from "./scenarios.mjs";

const near = (actual, want, tol) => assert.ok(Math.abs(actual - want) <= tol, `${actual} not within ${tol} of ${want}`);
const seeded = (tag) => plantSeed.plants[0].components.find((c) => c.tag === tag);

test("CLAUDE.MD steady values", () => {
  near(lvSteady(65), 64.9, 0.01);
  near(lvSteady(85), 84.9, 0.01);
  near(lvSteady(100), 99.9, 0.01);
  near(steamAt(65), 1980, 5);
  near(steamAt(85), 2570, 5);
  near(steamAt(50), 1533, 0.01);
  assert.equal(steamAt(100), 3000);
  near(dutyAt(65), 1160, 2);
  near(dutyAt(85), 1510, 2);
  near(dutyAt(50), 898.5, 0.01);
});

test("CLAUDE.MD transients and TASK2.MD header drop", () => {
  near(tempDip(15), 2, 0.01);
  near(tempDip(35), 4, 0.01);
  near(lvPeak(50, 85) - 85, 4, 0.5);
  const drop = 6 - headerAt(steamAt(85), steamAt(50));
  assert.ok(drop >= 0.3 && drop <= 0.6, `header drop ${drop}`);
  assert.equal(lvPeak(90, 60), lvSteady(60));
});

test("temperature rises on a downward step, as the simulated history shows", () => {
  near(75 + tempRise(13.8), 76.5, 0.2);
  near(75 + tempRise(26), 78.05, 0.1);
  assert.equal(tempRise(-10), 0);
  const fx = stepEffects({ from: 70, to: 45, otherSpeed: 50 });
  near(voterTruth({ tag: "TK-101", otherSpeed: 50, fx }).tempC.ceil, 77.9, 0.1);
});

test("thresholds floor at limit.max", () => {
  const { tempC } = seeded("TK-101").limits;
  const { positionPct } = seeded("LV-101").limits;
  assert.equal(thresholdFor(tempC, 10), 80);
  assert.equal(thresholdFor(tempC, 25), 80);
  near(thresholdFor(positionPct, 10), 81, 1e-9);
  assert.equal(thresholdFor(positionPct, 25), 80);
});

test("demo verdicts", () => {
  const verdict = (tag, from, to, similar) => {
    const component = { ...seeded(tag), marginPct: 10 };
    const fx = stepEffects({ from, to, otherSpeed: 50 });
    return expectedVote(component, voterTruth({ tag, otherSpeed: 50, fx }), similar).vote;
  };
  assert.equal(verdict("LV-101", 50, 85, 5), "no");
  for (const tag of ["TK-101", "LV-101", "E-101", "TV-101"]) assert.equal(verdict(tag, 50, 65, 5), "yes");
  assert.equal(verdict("LV-101", 50, 85, 0), "no");
});

test("LV-101 threshold matches the CLAUDE.MD worked example", () => {
  assert.equal(seeded("LV-101").limits.positionPct.critical * 0.9, 81);
});

test("generator is deterministic and every voter appears", () => {
  const a = generate({ proposals: 300, seed: 5 });
  const b = generate({ proposals: 300, seed: 5 });
  assert.deepEqual(a.map((s) => s.expected.vote), b.map((s) => s.expected.vote));
  assert.deepEqual([...new Set(a.map((s) => s.component.tag))].sort(), ["E-101", "LV-101", "P-100", "TK-101", "TV-101"]);
  assert.ok(new Set(a.map((s) => s.similarCount)).has(0));
  assert.ok(a.some((s) => s.crossPlant));
});

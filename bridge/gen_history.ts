// Generates shared/history.json by stepping the same model the live plant runs: every number in an event comes from a
// real 5-tick model run. Only the provenance is invented: operators, approvers and dates. Same seed, same bytes.
//
// Run: bun run bridge/gen_history.ts
// Check: node actor/tests/fixtures-gen/validate-history.mjs shared/history.json
//
// INCIDENT TEXT. Derived from each run's own rows, so it never claims more than the run showed. LV-101's row is the
// furthest it travelled, and only a row at 100 says saturated, which takes about 97 % speed from the design point. The
// model has no LAH-101 alarm, so the alarm clause needs the level row to reach TK-101's limit, and no run here does.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HistoryEvent, PlantId } from "../shared/types";
import { OBSERVE_TICKS, PARAMS, SteamUnit, summarizeEffects, upstreamSnapshot, type Snapshot } from "./tank_model";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "history.json");
const SEED = 20261031;
const PLANT_A_TOTAL = 180;
const PLANT_B_TOTAL = 120;
const WINDOW_START = Date.UTC(2024, 1, 5);
const WINDOW_END = Date.UTC(2026, 9, 20);
const MINUTE = 60_000;

// Limits from shared/plants.json.
const LV_LIMIT_PCT = 80;
const LV_CRITICAL_PCT = 90;
const LEVEL_LIMIT_PCT = 70;

// Fictional people on a fictional plant.
const OPERATORS = ["T. Okonkwo-Hale", "R. Sandoval", "L. Bergstrom", "P. Ivanova", "S. Marchetti", "Y. Takeda", "N. Abernathy", "V. Duarte"];
const SHIFT_LEADS = ["W. Kowalczyk", "I. Rahmani", "O. Fitzgerald", "E. Lund"];

// [before, after] of P-100 speedPct, each run once with the other plant at design and feed at 25 C.
// similar() returns the 5 nearest `after`, so these placements decide what the demo retrieves:
// - Keep the band around 85 thin (84, 86), so that with the three runs at 88, 3 of the 5 nearest are past LV-101 critical.
//   The other band runs sit at 81.5, the highest speed where a step from 40 still takes LV-101 past 85.
// - The 65 row is the demo's counter-proposal: plenty of clean runs at exactly the target.
// - 30->70 and 35->71 are real runs with overshoot past 72.9 %, so 70 is not offered as a safe counter.
const PLANT_A_ANCHORS: [number, number][] = [
  [50, 84], [50, 86], [40, 81.5], [41, 81.5],
  [50, 88], [50, 88], [50, 88], [50, 89], [65, 88.5], [65, 89], [65, 89], [50, 90], [65, 90], [65, 91], [60, 92], [50, 94],
  [50, 96], [65, 96], [50, 97], [60, 98], [50, 100], [65, 100],
  [50, 65], [50, 65], [50, 65], [50, 65], [50, 64], [50, 66], [50, 63], [50, 67], [48, 65], [52, 66], [50, 62],
  [30, 70], [35, 71], [33, 69.5],
  [84, 70], [88, 72], [86, 68], [90, 75], [82, 62], [85, 66],
];

const PLANT_B_ANCHORS: [number, number][] = [
  [50, 65], [50, 65], [50, 65], [50, 62], [50, 68], [50, 60], [55, 70], [50, 72], [45, 74], [60, 74],
];

// [low, high, weight] of the background `after` draw. Plant-a stops under 80 so nothing crowds the band around 85.
// Plant-b stops at 74: outside the relevance band of a proposal at 85, so its insufficient-history path can fire.
const PLANT_A_BANDS = [[25, 39, 0.12], [40, 59, 0.38], [60, 70, 0.32], [71, 79, 0.18]] as const;
const PLANT_B_BANDS = [[25, 39, 0.12], [40, 65, 0.68], [66, 74, 0.2]] as const;

const MAX_STEP_UP = 42;
const MAX_STEP_DOWN = 20;
const MIN_TEMP_AT_WINDOW_END = 70.2;

type Spec = { key: string; plantId: PlantId; before: number; after: number; otherSpeed: number; feedTempC: number; anchor: boolean };

function rngFor(key: string): () => number {
  let state = SEED;
  for (let i = 0; i < key.length; i++) state = Math.imul(state ^ key.charCodeAt(i), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, list: readonly T[]) => list[Math.floor(rng() * list.length)];
const between = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

function drawBand(rng: () => number, bands: readonly (readonly [number, number, number])[]): number {
  let roll = rng();
  for (const [lo, hi, weight] of bands) {
    roll -= weight;
    if (roll <= 0) return between(rng, lo, hi);
  }
  const [lo, hi] = bands[bands.length - 1];
  return between(rng, lo, hi);
}

/** A real run: start on the steady state, change P-100, sample at each of the next 5 ticks. */
function modelRun(spec: Spec): { samples: Snapshot[] } {
  const other: PlantId = spec.plantId === "plant-a" ? "plant-b" : "plant-a";
  const unit = new SteamUnit(PARAMS, {
    [spec.plantId]: { speedPct: spec.before, feedTempC: spec.feedTempC },
    [other]: { speedPct: spec.otherSpeed },
  });
  const samples: Snapshot[] = [unit.snapshot()];
  unit.plants[spec.plantId].speedPct = spec.after;
  for (let n = 0; n < OBSERVE_TICKS; n++) {
    unit.tick();
    samples.push(unit.snapshot());
  }
  return { samples };
}

/** Says only what this run's own rows show. */
function incidentFor(effects: HistoryEvent["effects"]): string | null {
  const after = (tag: string, metric: string) => {
    const row = effects.find((item) => item.componentId.endsWith(`/${tag}`) && item.metric === metric);
    if (!row) throw new Error(`no ${tag} ${metric} row`);
    return row.after;
  };
  const position = after("LV-101", "positionPct");
  const level = after("TK-101", "levelPct");
  const claims: string[] = [];
  if (position >= 100) claims.push("LV-101 saturated at 100%, no control headroom");
  else if (position >= LV_CRITICAL_PCT) claims.push(`LV-101 reached ${position.toFixed(1)}%, past its ${LV_LIMIT_PCT}% limit, no control headroom`);
  else if (position >= LV_LIMIT_PCT) claims.push(`LV-101 reached ${position.toFixed(1)}%, past its ${LV_LIMIT_PCT}% limit`);
  if (level >= LEVEL_LIMIT_PCT) claims.push(`TK-101 reached ${level.toFixed(1)}%, high-level alarm LAH-101`);
  return claims.length ? claims.join("; ") : null;
}

function buildEvent(spec: Spec): Omit<HistoryEvent, "id"> {
  const rng = rngFor(`${spec.key}:provenance`);
  const { samples } = modelRun(spec);
  const effects = summarizeEffects(spec.plantId, samples);

  const operator = spec.anchor || rng() > 0.08 ? pick(rng, OPERATORS) : null;
  const approvedBy = operator === null ? [] : [pick(rng, SHIFT_LEADS)];
  if (operator !== null && spec.after >= 80) {
    const second = pick(rng, SHIFT_LEADS);
    if (!approvedBy.includes(second)) approvedBy.push(second);
  }

  return {
    at: new Date(WINDOW_START + Math.floor((rng() * (WINDOW_END - WINDOW_START)) / MINUTE) * MINUTE).toISOString(),
    plantId: spec.plantId,
    componentId: `${spec.plantId}/P-100`,
    metric: "speedPct",
    before: spec.before,
    after: spec.after,
    upstreamSnapshot: upstreamSnapshot(spec.plantId, samples[0], spec.feedTempC),
    effects,
    incident: incidentFor(effects),
    approvedBy,
    operator,
    proposalId: null,
  };
}

function anchorSpecs(plantId: PlantId, anchors: [number, number][]): Spec[] {
  return anchors.map(([before, after], n) => {
    const key = `${plantId}:anchor:${n}`;
    const rng = rngFor(`${key}:feed`);
    return { key, plantId, before, after, otherSpeed: 50, feedTempC: Number((25 + (rng() * 2 - 1) * 0.2).toFixed(2)), anchor: true };
  });
}

/** The tick-5 temperature has to stay inside the limits the rest of the demo reads, so an over-long step is redrawn. */
function acceptable(spec: Spec): boolean {
  const { samples } = modelRun(spec);
  return samples[OBSERVE_TICKS][`${spec.plantId}/TK-101`].tempC >= MIN_TEMP_AT_WINDOW_END;
}

function backgroundSpecs(plantId: PlantId, count: number, bands: readonly (readonly [number, number, number])[], maxBefore: number, maxOther: number): Spec[] {
  const specs: Spec[] = [];
  for (let n = 0; n < count; n++) {
    const key = `${plantId}:background:${n}`;
    const rng = rngFor(`${key}:draw`);
    for (;;) {
      const after = drawBand(rng, bands);
      const before = between(rng, 30, maxBefore);
      const step = after - before;
      if (Math.abs(step) < 3 || step > MAX_STEP_UP || -step > MAX_STEP_DOWN) continue;
      const spec = { key, plantId, before, after, otherSpeed: between(rng, 35, maxOther), feedTempC: Number((25 + (rng() * 2 - 1) * 4).toFixed(2)), anchor: false };
      if (acceptable(spec)) {
        specs.push(spec);
        break;
      }
    }
  }
  return specs;
}

function buildPlant(tag: string, specs: Spec[]): HistoryEvent[] {
  return specs
    .map((spec) => ({ key: spec.key, event: buildEvent(spec) }))
    .sort((x, y) => x.event.at.localeCompare(y.event.at) || x.key.localeCompare(y.key))
    .map(({ event }, n) => ({ id: `hist-${tag}-${String(n + 1).padStart(4, "0")}`, ...event }));
}

const events = [
  ...buildPlant("a", [...anchorSpecs("plant-a", PLANT_A_ANCHORS), ...backgroundSpecs("plant-a", PLANT_A_TOTAL - PLANT_A_ANCHORS.length, PLANT_A_BANDS, 78, 75)]),
  ...buildPlant("b", [...anchorSpecs("plant-b", PLANT_B_ANCHORS), ...backgroundSpecs("plant-b", PLANT_B_TOTAL - PLANT_B_ANCHORS.length, PLANT_B_BANDS, 74, 85)]),
];

writeFileSync(OUT, `[\n${events.map((event) => JSON.stringify(event)).join(",\n")}\n]\n`);
console.log(`wrote ${events.length} model-generated events to ${OUT}`);

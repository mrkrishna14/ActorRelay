// STAND-IN seed history for tests. shared/history.json is Person 2's and comes from stepping the
// plant model; this file comes from the linear fit in TASK2.MD and the physics summary in CLAUDE.MD.
// Run: node actor/tests/fixtures-gen/gen-history.mjs   Same seed, same bytes. See README.md.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEED = 20261031;
const ID_PREFIX = "standin";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "history.json");
const PLANT_A_TOTAL = 180;
const PLANT_B_TOTAL = 120;
const WINDOW_START = Date.UTC(2024, 0, 8);
const WINDOW_END = Date.UTC(2026, 9, 24);

const INCIDENT_SATURATED = "LV-101 saturated at 100%, TK-101 high-level alarm LAH-101";
const INCIDENT_HEADROOM = "LV-101 no control headroom";

const OPERATORS = ["A. Varga", "B. Osei", "C. Lindqvist", "D. Ferreira", "E. Nakashima", "G. Haddad", "H. Castellan", "J. Whitlow"];
const SHIFT_LEADS = ["F. Brandvold", "K. Adeyemi-Ross", "M. Tanaguchi", "R. Ostrowicz"];

// [before, after] of P-100 speedPct. Everything near a demo proposal is placed by hand: similar()
// returns the 5 nearest `after`, so the 80-87 band stays thin around 85 or it pushes the incidents
// out of the top 5. Keep at most two band events inside 82-87.
const PLANT_A_ANCHORS = [
  // 80-87 band, supports the rule P-100 >= 80 -> LV-101 >= 85.
  [50, 84], [50, 86], [40, 80], [35, 80], [45, 81], [38, 81],
  // Incidents. 88-90 are what the demo cites from the design point and from 65; 96+ truly saturate.
  [50, 88], [50, 88], [50, 89], [65, 88], [65, 88], [65, 89], [50, 90], [65, 90], [65, 91], [60, 92], [50, 94],
  [50, 96], [65, 96], [50, 97], [60, 98], [50, 100], [65, 100],
  // Neighbours of the 65 counter-proposal.
  [50, 65], [50, 65], [50, 65], [50, 64], [50, 66], [50, 63], [50, 67], [48, 65], [52, 66], [50, 62],
  // Coming back down after a high-rate campaign.
  [84, 70], [88, 72], [86, 68], [90, 75], [82, 62], [85, 66],
];

const PLANT_B_ANCHORS = [
  [50, 65], [50, 65], [50, 65], [50, 62], [50, 68], [50, 60], [55, 70], [50, 72], [45, 74], [60, 74],
];

// [low, high, weight] of the background `after` draw. Plant-b stops at 74: LV-101 stays under 80, and
// to=85 falls outside the actor's relevance band (+/-10.5), which is what lets insufficient history fire.
const PLANT_A_BANDS = [[25, 39, 0.12], [40, 59, 0.38], [60, 70, 0.32], [71, 79, 0.18]];
const PLANT_B_BANDS = [[25, 39, 0.12], [40, 65, 0.68], [66, 74, 0.2]];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round = (x, places) => Number(x.toFixed(places));

function rngFor(key) {
  let state = SEED;
  for (const ch of key) state = Math.imul(state ^ ch.charCodeAt(0), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const jitter = (rng, spread) => (rng() * 2 - 1) * spread;
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const between = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

function drawBand(rng, bands) {
  let roll = rng();
  for (const [lo, hi, weight] of bands) {
    roll -= weight;
    if (roll <= 0) return between(rng, lo, hi);
  }
  const [lo, hi] = bands[bands.length - 1];
  return between(rng, lo, hi);
}

const heatFactor = (feedTempC) => (75 - feedTempC) / 50;

// TASK2.MD coefficients at the design feed temperature, scaled by the energy balance so that
// feedTempC moves steam and duty. The steam controller range caps flow at 3000 kg/h.
const steamKgH = (speed, feedTempC) => Math.min(3000, 29.7 * speed * heatFactor(feedTempC) + 48);
const dutyKw = (steam) => 17.43 * ((steam - 48) / 29.7) + 27;
// 3.6 points per bar is derived from the fit (see README.md), not given in TASK2.MD.
const steamValvePct = (steam, header) => 0.36 * ((steam - 48) / 29.7) + 32.5 + 3.6 * (6 - header);
const headerBarg = (steam, otherSteam) => clamp(6 - 0.0005 * (steam + otherSteam - 3066), 4.5, 6.5);

// Highest LV-101 position in the 5-tick window. Overshoot scales with the step so that 50 -> 65
// lands on 66.7 and 50 -> 85 on 89, the two numbers in the demo script.
function outletValvePeak(before, after, rng) {
  if (after > 95) return 100;
  const step = after - before;
  let peak = after + jitter(rng, 0.3);
  if (step > 0) {
    const overshoot = 0.115 * step;
    peak = after + (after >= 80 ? clamp(overshoot, 3, 5) : Math.min(overshoot, 5)) + jitter(rng, 0.4);
  }
  if (after >= 80 && after <= 87) peak = clamp(peak, 85, 91);
  if (after >= 60 && after <= 70) peak = clamp(peak, 60, 73);
  return Math.min(100, peak);
}

// Share of the temperature change still present at tick 5 (0.05 x step, from TASK2.MD).
const residualTempC = (step) => 75 - 0.05 * step;

function levelAfterPct(after, step, rng) {
  if (after > 95) return 55 + jitter(rng, 0.3); // LV-101 is pinned, level climbs 1 %/tick.
  return 50 + (after >= 88 ? 0.05 : 0.02) * step + jitter(rng, 0.2);
}

function incidentFor(after, lvPeak) {
  if (after >= 88) return INCIDENT_SATURATED;
  if (after >= 80 && lvPeak >= 88) return INCIDENT_HEADROOM;
  return null;
}

function buildEvent(plantId, spec) {
  const { key, before, after, otherSpeed, feedTempC } = spec;
  const rng = rngFor(key);
  const step = after - before;

  const steamBefore = steamKgH(before, feedTempC);
  const steamAfter = steamKgH(after, feedTempC);
  const otherSteam = steamKgH(otherSpeed, 25);
  const headerBefore = headerBarg(steamBefore, otherSteam);
  const headerAfter = headerBarg(steamAfter, otherSteam);
  const lvPeak = outletValvePeak(before, after, rng);

  const row = (tag, metric, from, to, places, ticksToSettle) => ({
    componentId: `${plantId}/${tag}`,
    metric,
    before: round(from, places),
    after: round(to, places),
    ticksToSettle,
  });

  const operator = spec.anchor || rng() > 0.08 ? pick(rng, OPERATORS) : null;
  const approvedBy = operator === null ? [] : [pick(rng, SHIFT_LEADS)];
  if (operator !== null && after >= 80) {
    const second = pick(rng, SHIFT_LEADS);
    if (!approvedBy.includes(second)) approvedBy.push(second);
  }

  return {
    at: new Date(WINDOW_START + Math.floor(rng() * (WINDOW_END - WINDOW_START) / 60000) * 60000).toISOString(),
    plantId,
    componentId: `${plantId}/P-100`,
    metric: "speedPct",
    before,
    after,
    upstreamSnapshot: {
      feedM3h: round(0.3 * before, 2),
      headerBarg: round(headerBefore, 2),
      feedTempC: round(feedTempC, 1),
    },
    effects: [
      row("TK-101", "levelPct", 50 + jitter(rng, 0.2), levelAfterPct(after, step, rng), 1, after > 95 ? 5 : between(rng, 3, 5)),
      row("TK-101", "tempC", 75 + jitter(rng, 0.1), residualTempC(step) + jitter(rng, 0.1), 2, between(rng, 4, 5)),
      row("LV-101", "positionPct", before + jitter(rng, 0.2), lvPeak, 1, after >= 80 ? between(rng, 2, 3) : between(rng, 2, 4)),
      row("E-101", "dutyKw", dutyKw(steamBefore) + jitter(rng, 3), dutyKw(steamAfter) + jitter(rng, 3), 1, between(rng, 2, 4)),
      row("TV-101", "positionPct", steamValvePct(steamBefore, headerBefore) + jitter(rng, 0.2), steamValvePct(steamAfter, headerAfter) + jitter(rng, 0.2), 1, between(rng, 2, 4)),
      row("TV-101", "steamKgH", Math.min(3000, steamBefore + jitter(rng, 4)), Math.min(3000, steamAfter + jitter(rng, 4)), 1, between(rng, 2, 4)),
      row("TV-101", "headerBarg", headerBefore, headerAfter, 2, between(rng, 1, 3)),
    ],
    incident: incidentFor(after, lvPeak),
    approvedBy,
    operator,
    proposalId: null,
  };
}

function anchorSpecs(plantId, anchors) {
  return anchors.map(([before, after], n) => {
    const key = `${plantId}:anchor:${n}`;
    return { key, before, after, otherSpeed: 50, feedTempC: 25 + jitter(rngFor(`${key}:feed`), 0.2), anchor: true };
  });
}

function backgroundSpecs(plantId, count, bands, maxBefore, maxOther) {
  const specs = [];
  for (let n = 0; n < count; n++) {
    const key = `${plantId}:background:${n}`;
    const rng = rngFor(`${key}:draw`);
    let after, before;
    do {
      after = drawBand(rng, bands);
      before = between(rng, 30, maxBefore);
    } while (Math.abs(after - before) < 3 || before - after > 25);
    const otherSpeed = between(rng, 35, maxOther);
    specs.push({ key, before, after, otherSpeed, feedTempC: 25 + jitter(rng, 4), anchor: false });
  }
  return specs;
}

function buildPlant(plantId, tag, specs) {
  return specs
    .map((spec) => ({ key: spec.key, event: buildEvent(plantId, spec) }))
    .sort((x, y) => x.event.at.localeCompare(y.event.at) || x.key.localeCompare(y.key))
    .map(({ event }, n) => ({ id: `${ID_PREFIX}-${tag}-${String(n + 1).padStart(4, "0")}`, ...event }));
}

const events = [
  ...buildPlant("plant-a", "a", [
    ...anchorSpecs("plant-a", PLANT_A_ANCHORS),
    ...backgroundSpecs("plant-a", PLANT_A_TOTAL - PLANT_A_ANCHORS.length, PLANT_A_BANDS, 78, 75),
  ]),
  ...buildPlant("plant-b", "b", [
    ...anchorSpecs("plant-b", PLANT_B_ANCHORS),
    ...backgroundSpecs("plant-b", PLANT_B_TOTAL - PLANT_B_ANCHORS.length, PLANT_B_BANDS, 74, 85),
  ]),
];

writeFileSync(OUT, `[\n${events.map((e) => JSON.stringify(e)).join(",\n")}\n]\n`);
console.log(`wrote ${events.length} stand-in events to ${OUT}`);

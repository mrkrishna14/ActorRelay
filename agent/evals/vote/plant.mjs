// Deterministic plant truth for the vote evals. No model output ever reaches this file.
// Coefficients: CLAUDE.MD physics summary, TASK2.MD fallback fit and header equation, shared/plants.json limits.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const plantSeed = JSON.parse(readFileSync(join(root, "shared", "plants.json"), "utf8"));
export const physicsSummary = readFileSync(join(root, "CLAUDE.MD"), "utf8").match(/### Physics summary[^\n]*\n([^\n]+)/)[1];

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const round = (x, d = 1) => Number(x.toFixed(d));

export const steamAt = (s) => Math.min(3000, 29.7 * s + 48);
export const dutyAt = (s) => 17.43 * Math.min(s, (3000 - 48) / 29.7) + 27;
export const lvSteady = (s) => Math.min(100, s - 0.1);
export const overshoot = (up) => clamp(0.12 * up, 0, 5);
export const lvPeak = (from, to) => (to > from ? Math.min(100, lvSteady(to) + overshoot(to - from)) : lvSteady(to));
export const tempDip = (up) => (up <= 0 ? 0 : up <= 15 ? (up * 2) / 15 : 2 + (up - 15) * 0.1);
// Not in the physics summary: less cold feed overshoots the setpoint. Slope fitted to 100 simulated downward steps.
export const tempRise = (down) => Math.max(0, down) * 0.116;
export const levelAfter = (s) => (s > 95 ? 55 : 50);
export const headerAt = (steamA, steamB) => clamp(6 - 0.0005 * (steamA + steamB - 3066), 4.5, 6.5);
export const tvPosition = (s, header) => 0.36 * s + 32.5 + 2.2 * (6 - header);

// Live metrics of one plant holding pump speed s against the other plant at otherSpeed.
export function steadyMetrics(s, otherSpeed = 50) {
  const header = headerAt(steamAt(s), steamAt(otherSpeed));
  return {
    "P-100": { speedPct: round(s), feedM3h: round(0.3 * s, 2) },
    "TK-101": { levelPct: 50, tempC: 75 },
    "LV-101": { positionPct: round(lvSteady(s)) },
    "E-101": { dutyKw: round(dutyAt(s)) },
    "TV-101": { positionPct: round(tvPosition(s, header)), steamKgH: round(steamAt(s)), headerBarg: round(header, 2) },
  };
}

// Value reported 5 ticks after a pump step, per tag and metric. bias shifts a metric to model equipment
// that drifted from the physics summary, which only retrieved history can reveal.
export function stepEffects({ from, to, otherSpeed = 50, bias = {} }) {
  const up = Math.max(0, to - from);
  const header = headerAt(steamAt(to), steamAt(otherSpeed));
  const fx = {
    "TK-101": { levelPct: levelAfter(to), tempC: 75 - tempDip(up) + tempRise(from - to) },
    "LV-101": { positionPct: lvPeak(from, to) },
    "E-101": { dutyKw: dutyAt(to) },
    "TV-101": { positionPct: tvPosition(to, header), steamKgH: steamAt(to), headerBarg: header },
  };
  for (const [key, delta] of Object.entries(bias)) {
    const [tag, metric] = key.split(".");
    fx[tag][metric] += delta;
  }
  return fx;
}

// Tank temperature setpoint change at constant pump speed: steam and duty scale with the temperature rise of the feed.
export function setpointEffects({ speed, to, otherSpeed = 50 }) {
  const scale = (to - 25) / 50;
  const steam = Math.min(3000, steamAt(speed) * scale);
  const header = headerAt(steam, steamAt(otherSpeed));
  return {
    "P-100": { speedPct: speed },
    "TK-101": { levelPct: 50, tempC: to },
    "LV-101": { positionPct: lvSteady(speed) },
    "E-101": { dutyKw: dutyAt(speed) * scale },
    "TV-101": { positionPct: tvPosition((steam - 48) / 29.7, header), steamKgH: steam, headerBarg: header },
  };
}

// What a voter's own metrics do. point scores prediction error, [lo, hi] is the accepted band,
// ceil is the value compared to the ceiling rules (tank temperature settles back at its setpoint).
export function voterTruth({ tag, crossPlant, otherSpeed, fx }) {
  if (crossPlant) {
    const header = fx["TV-101"].headerBarg;
    return {
      positionPct: band(tvPosition(otherSpeed, header)),
      steamKgH: band(steamAt(otherSpeed)),
      headerBarg: band(header),
    };
  }
  const own = fx[tag];
  const out = Object.fromEntries(Object.entries(own).map(([m, v]) => [m, band(v)]));
  if (tag === "TK-101") out.tempC = { point: own.tempC, lo: Math.min(own.tempC, 75), hi: Math.max(own.tempC, 75), ceil: Math.max(own.tempC, 75) };
  return out;
}

const band = (v) => ({ point: v, lo: v, hi: v, ceil: v });

const TOLERANCE = { positionPct: 2, steamKgH: 60, dutyKw: 40, levelPct: 2, tempC: 1, speedPct: 1 };

// A learned rule binds a voter when this change meets its condition and its consequence reaches the voter's threshold.
function ruleBinds(rule, proposal, component) {
  const { condition, consequence } = rule;
  if (condition.metric !== proposal.metric || proposal.to < condition.value) return false;
  const limit = component.limits[consequence.metric];
  if (!limit || consequence.value < limit.critical * (1 - component.marginPct / 100)) return false;
  if (consequence.componentId) return consequence.componentId === component.id;
  return rule.model === component.model;
}

// TASK1.MD step 6 and the CLAUDE.MD learning rule applied to the true values instead of a model's prediction.
export function expectedVote(component, truth, similarCount, { changeNearCritical = false, rules = [], proposal = null } = {}) {
  const margin = component.marginPct;
  const reasons = [];
  let borderline = false;
  if (similarCount < 3 && changeNearCritical) reasons.push({ rule: "thin", metric: proposal.metric, value: proposal.to, limit: null, unchanged: false });
  for (const rule of rules) {
    if (ruleBinds(rule, proposal, component)) reasons.push({ rule: "learned", metric: rule.consequence.metric, value: rule.consequence.value, limit: null, unchanged: false });
  }
  for (const [metric, limit] of Object.entries(component.limits)) {
    const t = truth[metric];
    if (!t) continue;
    const threshold = limit.critical * (1 - margin / 100);
    const thin = limit.critical * 0.85;
    const before = component.metrics[metric];
    const unchanged = t.ceil <= before;
    if (t.ceil >= threshold) reasons.push({ rule: "threshold", metric, value: t.ceil, limit: threshold, unchanged });
    if (similarCount < 3 && t.ceil >= thin) reasons.push({ rule: "thin", metric, value: t.ceil, limit: thin, unchanged });
    const tol = TOLERANCE[metric];
    if (Math.abs(t.ceil - threshold) <= tol || (similarCount < 3 && Math.abs(t.ceil - thin) <= tol)) borderline = true;
  }
  const moved = reasons.filter((r) => !r.unchanged);
  const category = !reasons.length
    ? "safe"
    : moved.some((r) => r.rule === "threshold")
      ? "physical"
      : moved.some((r) => r.rule === "learned")
        ? "rule"
        : moved.length
          ? "thin"
          : "static";
  return { vote: reasons.length ? "no" : "yes", category, reasons, borderline };
}

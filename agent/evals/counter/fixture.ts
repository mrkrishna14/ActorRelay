// Scenario fixture for the counter-proposal eval: plant state, generated history, physics truth.
// Physics uses the fitted coefficients from TASK2.MD (fallback section) and the CLAUDE.MD summary.
// History defaults to shared/history.json, the file the glue seeds from. Other shapes exist to test the shape itself.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rankSimilar } from "../../../actor/src/logic/similar";
import type { ComponentState, HistoryEvent, LearnedRule, PlantId, Proposal } from "../../../shared/types";
import { thresholdFor } from "../../vote";

const ROOT = join(import.meta.dir, "..", "..", "..");
const plantsJson = JSON.parse(readFileSync(join(ROOT, "shared", "plants.json"), "utf8"));

export const PHYSICS_SUMMARY = (() => {
  const text = readFileSync(join(ROOT, "CLAUDE.MD"), "utf8");
  const match = text.match(/### Physics summary[^\n]*\n([^\n]+)/);
  if (!match) throw new Error("physics summary paragraph not found in CLAUDE.MD");
  return match[1]!.trim();
})();

export type HistoryShape =
  | "real" // shared/history.json, generated from the tank model
  | "standin" // actor/tests/fixtures-gen/history.json, the earlier fitted stand-in
  | "seed" // the TASK2 hard requirements: incidents >=88, no headroom 80-87, safe 60-70, low 40-58
  | "dense" // seed plus safe runs at 72-78, so "use all the headroom" has evidence behind it
  | "gap" // incidents and low runs only, nothing between 58 and 80
  | "sparse" // two events only
  | "empty"
  | "no_high"; // plant-b shape: zero events >=80, several 40-65

export type Scenario = {
  id: string;
  group: string;
  plantId: PlantId;
  from: number;
  to: number;
  margins: Record<string, number>; // tag -> marginPct, "other/TV-101" for the cross-plant voter
  limits?: Record<string, Record<string, { min?: number; max?: number; critical?: number }>>; // tag -> metric -> override
  history: HistoryShape;
  rule: boolean;
  overshoot: number; // LV-101 transient points above steady state
  fault?: { voter: string; round: number }; // this voter's model calls throw; round 0 is the parent, 1 the first counter
};

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const round1 = (x: number) => Math.round(x * 10) / 10;

export function componentsFor(plantId: PlantId): ComponentState[] {
  const plant = plantsJson.plants.find((p: { id: string }) => p.id === plantId);
  return clone(plant.components);
}

export function truthAt(speed: number, overshoot: number): Record<string, Record<string, number>> {
  return {
    "P-100": { speedPct: speed },
    "LV-101": { positionPct: Math.min(100, speed + overshoot) },
    "TK-101": { levelPct: speed > 95 ? 50 + (speed - 95) * 3 : 50, tempC: 75 },
    "E-101": { dutyKw: 17.43 * speed + 27 },
    "TV-101": { positionPct: 0.36 * speed + 32.5, steamKgH: 29.7 * speed + 48 },
  };
}

export function faultVoterId(s: Scenario): string | null {
  if (!s.fault) return null;
  const other: PlantId = s.plantId === "plant-a" ? "plant-b" : "plant-a";
  return s.fault.voter.startsWith("other/") ? `${other}/${s.fault.voter.slice(6)}` : `${s.plantId}/${s.fault.voter}`;
}

export function thresholdOf(c: ComponentState, metric: string): number | null {
  const limit = c.limits[metric];
  return limit ? thresholdFor(limit, c.marginPct) : null;
}

export type Plantview = {
  proposer: ComponentState;
  voters: ComponentState[];
  history: HistoryEvent[];
  rules: LearnedRule[];
};

function applyOverrides(c: ComponentState, tag: string, s: Scenario, otherPlant: boolean) {
  const key = otherPlant ? `other/${tag}` : tag;
  c.marginPct = s.margins[key] ?? 10;
  for (const [metric, override] of Object.entries(s.limits?.[key] ?? {})) {
    c.limits[metric] = { ...c.limits[metric]!, ...override };
  }
}

export function buildView(s: Scenario): Plantview {
  const own = componentsFor(s.plantId);
  own.forEach((c) => applyOverrides(c, c.tag, s, false));
  const proposer = own.find((c) => c.tag === "P-100")!;
  proposer.metrics.speedPct = s.from;
  proposer.metrics.feedM3h = 0.3 * s.from;

  const steady = truthAt(s.from, 0);
  for (const c of own) Object.assign(c.metrics, steady[c.tag] ?? {});

  const otherId: PlantId = s.plantId === "plant-a" ? "plant-b" : "plant-a";
  const otherTv = componentsFor(otherId).find((c) => c.tag === "TV-101")!;
  applyOverrides(otherTv, "TV-101", s, true);

  const voters = [...own.filter((c) => c.tag !== "P-100"), otherTv];
  return { proposer, voters, history: makeHistory(s), rules: s.rule ? [makeRule(s)] : [] };
}

export function safeCeiling(s: Scenario): number | null {
  // Highest speed strictly between from and to where physics clears every voter and the proposer.
  const view = buildView(s);
  const lo = Math.min(s.from, s.to);
  const hi = Math.max(s.from, s.to);
  let best: number | null = null;
  for (let v = lo + 0.5; v < hi; v += 0.5) {
    if (clearsAll(v, s, view)) best = v;
  }
  return best;
}

export function clearsAll(value: number, s: Scenario, view: Plantview): boolean {
  const truth = truthAt(value, s.overshoot);
  const fromTruth = truthAt(s.from, 0);
  for (const voter of view.voters) {
    const tracked = voter.plantId === s.plantId ? truth[voter.tag] : fromTruth[voter.tag];
    for (const metric of Object.keys(voter.limits)) {
      const threshold = thresholdOf(voter, metric)!;
      if ((tracked?.[metric] ?? -Infinity) >= threshold) return false;
    }
  }
  const own = thresholdOf(view.proposer, "speedPct");
  return own === null || value < own;
}

function makeRule(s: Scenario): LearnedRule {
  const shared = s.plantId === "plant-b"; // Company rules carry null componentIds and match on model.
  return {
    id: "rule-p100-80-lv101-85",
    scope: shared ? "company" : "plant",
    model: "outlet-valve-A",
    text: "P-100 speedPct >= 80 -> LV-101 positionPct >= 85 within 3 ticks, seen 4 times",
    condition: { componentId: shared ? null : `${s.plantId}/P-100`, metric: "speedPct", op: ">=", value: 80 },
    consequence: { componentId: shared ? null : `${s.plantId}/LV-101`, metric: "positionPct", op: ">=", value: 85, withinTicks: 3 },
    supportEventIds: ["evt-0", "evt-1", "evt-2", "evt-3"],
    timesSeen: 4,
    createdAt: "2026-10-30T12:00:00.000Z",
    lastSeenAt: "2026-10-31T12:00:00.000Z",
  };
}

const seeded = (...path: string[]): HistoryEvent[] => JSON.parse(readFileSync(join(ROOT, ...path), "utf8"));
const FILES = { real: seeded("shared", "history.json"), standin: seeded("actor", "tests", "fixtures-gen", "history.json") };

const SPEEDS: Record<Exclude<HistoryShape, keyof typeof FILES>, number[]> = {
  seed: [88, 92, 95, 100, 80, 82, 84, 85, 87, 60, 62, 64, 65, 66, 68, 70, 40, 45, 50, 55, 58],
  dense: [88, 92, 95, 100, 80, 82, 84, 85, 87, 60, 62, 64, 65, 66, 68, 70, 72, 74, 75, 76, 78, 40, 45, 50, 55, 58],
  gap: [88, 92, 95, 100, 80, 82, 84, 85, 87, 40, 45, 50, 55, 58],
  sparse: [64, 88],
  empty: [],
  no_high: [40, 45, 48, 50, 52, 55, 58, 60, 62, 65],
};

export function makeHistory(s: Scenario): HistoryEvent[] {
  if (s.history === "real" || s.history === "standin") return FILES[s.history].filter((e) => e.plantId === s.plantId);
  return SPEEDS[s.history].map((after, i) => {
    const before = after >= 55 ? 50 : 40;
    const peak = truthAt(after, s.overshoot);
    const base = truthAt(before, 0);
    const c = (tag: string) => `${s.plantId}/${tag}`;
    const dip = (after - before) * 0.11;
    const level = after >= 88 ? 76 : 50;
    return {
      id: `evt-${i}`,
      at: new Date(Date.UTC(2025, i % 12, 1 + (i % 27), 8)).toISOString(),
      plantId: s.plantId,
      componentId: c("P-100"),
      metric: "speedPct",
      before,
      after,
      upstreamSnapshot: { feedM3h: 0.3 * before, headerBarg: 6, feedTempC: 25 },
      effects: [
        { componentId: c("LV-101"), metric: "positionPct", before: base["LV-101"]!.positionPct!, after: round1(peak["LV-101"]!.positionPct!), ticksToSettle: 3 },
        { componentId: c("TK-101"), metric: "levelPct", before: 50, after: level, ticksToSettle: 5 },
        { componentId: c("TK-101"), metric: "tempC", before: 75, after: round1(75 - dip), ticksToSettle: 5 },
        { componentId: c("E-101"), metric: "dutyKw", before: round1(base["E-101"]!.dutyKw!), after: round1(peak["E-101"]!.dutyKw!), ticksToSettle: 4 },
        { componentId: c("TV-101"), metric: "steamKgH", before: round1(base["TV-101"]!.steamKgH!), after: round1(peak["TV-101"]!.steamKgH!), ticksToSettle: 4 },
        { componentId: c("TV-101"), metric: "positionPct", before: round1(base["TV-101"]!.positionPct!), after: round1(peak["TV-101"]!.positionPct!), ticksToSettle: 4 },
      ],
      incident: after >= 88 ? "LV-101 saturated at 100%, TK-101 high-level alarm LAH-101" : after >= 80 ? "LV-101 no control headroom" : null,
      approvedBy: [],
      operator: "fictional-operator",
      proposalId: null,
    };
  });
}

// The real ranking from the actor, seeded history only: nothing here has executed yet.
export function similar(view: Plantview, to: number, k = 5, upstreamSnapshot: Record<string, number> = {}): HistoryEvent[] {
  return rankSimilar({ history: view.history, componentId: view.proposer.id, metric: "speedPct", to, upstreamSnapshot, k, limit: view.proposer.limits.speedPct, liveEventIds: [] });
}

let proposalSeq = 0;
export function makeProposal(s: Scenario, view: Plantview, to: number, parent: Proposal | null, rationale: string): Proposal {
  return {
    id: `p-${s.id}-${++proposalSeq}`,
    at: new Date(0).toISOString(),
    plantId: s.plantId,
    proposerComponentId: view.proposer.id,
    proposerAgentId: `agent:${view.proposer.id}`,
    metric: "speedPct",
    from: s.from,
    to,
    rationale,
    requiredVoters: view.voters.map((v) => v.id),
    votes: [],
    status: "voting",
    vetoDeadline: null,
    parentProposalId: parent?.id ?? null,
    crossPlant: true,
  };
}

const m = (over: Record<string, number> = {}) => over;
const base = { plantId: "plant-a" as PlantId, rule: true, overshoot: 4, history: "real" as HistoryShape, margins: m() };

export function buildScenarios(scale: number): Scenario[] {
  const out: Scenario[] = [];
  const add = (group: string, spec: Partial<Scenario> & { from: number; to: number }, reps: number) => {
    for (let i = 0; i < Math.max(1, Math.round(reps * scale)); i++) {
      out.push({ ...base, ...spec, group, id: `${group}-${out.length}` });
    }
  };

  // The demo step, exactly as scripted, many times: distribution of the landing value.
  add("demo", { from: 50, to: 85 }, 40);
  add("demo_minimal_seed", { from: 50, to: 85, history: "seed" }, 15);
  add("demo_standin", { from: 50, to: 85, history: "standin" }, 10);

  // Varied targets.
  for (const from of [40, 50, 60]) for (const to of [80, 85, 90, 95, 100]) add("targets", { from, to }, 2);

  // Varied LV-101 margin, the ceiling moves from 81 to 63.
  for (const lv of [5, 15, 20, 25]) add("margins", { from: 50, to: 85, margins: m({ "LV-101": lv }) }, 5);

  // Which voter blocks: steam, coil, both, and the tightest of several.
  add("blocker_steam", { from: 50, to: 80, margins: m({ "LV-101": 5, "TV-101": 25 }) }, 5);
  add("blocker_coil", { from: 50, to: 80, margins: m({ "LV-101": 5, "E-101": 25 }) }, 5);
  add("blocker_multi", { from: 50, to: 85, margins: m({ "LV-101": 20, "TV-101": 25, "E-101": 25 }) }, 5);

  // History shapes.
  for (const history of ["gap", "sparse", "empty"] as const) add(`history_${history}`, { from: 50, to: 85, history, rule: history !== "empty" }, 5);
  add("plant_b", { plantId: "plant-b", from: 50, to: 85, rule: false }, 5);
  add("plant_b_rule", { plantId: "plant-b", from: 50, to: 85, rule: true }, 5);

  // Not hard-coded: move the limits and the safe ceiling must drag the counter with it.
  add("moved_low", { from: 30, to: 60, limits: { "LV-101": { positionPct: { critical: 60, max: 54 } } } }, 4);
  add("moved_mid", { from: 40, to: 70, limits: { "LV-101": { positionPct: { critical: 70, max: 62 } } } }, 4);
  add("moved_high", { from: 70, to: 95, limits: { "LV-101": { positionPct: { critical: 100, max: 90 } }, "P-100": { speedPct: { critical: 110, max: 100 } } } }, 4);
  add("moved_overshoot", { from: 50, to: 85, overshoot: 12, history: "dense" }, 4);

  // One voter fails on the first counter, each voter in turn. A failed voter must not end the chain.
  for (const voter of ["TK-101", "LV-101", "E-101", "TV-101", "other/TV-101"]) {
    add(`fault_${voter.replace("/", "_")}`, { from: 50, to: 85, fault: { voter, round: 1 } }, 4);
  }
  // LV-101 fails on the parent: the block then rests on whoever else voted no.
  add("fault_parent_LV-101", { from: 50, to: 85, fault: { voter: "LV-101", round: 0 } }, 4);

  // Nothing between from and to can pass. Correct: stop cleanly, no loop, no third counter.
  add("infeasible_tk_margin", { from: 50, to: 85, margins: m({ "TK-101": 15 }) }, 4);
  add("infeasible_from_unsafe", { from: 70, to: 85, margins: m({ "LV-101": 25 }) }, 4);
  return out;
}

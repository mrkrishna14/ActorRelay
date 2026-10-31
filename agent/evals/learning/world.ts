// In-memory stand-in for glue and the actors. State here is FAKE; every LLM call the harness makes is real.
// Effect sizes come from the CLAUDE.MD physics summary. Ids, timing and settled offsets are randomised per run
// so a passing sequence cannot be the result of a memorised id.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CalibrationEntry,
  ComponentId,
  ComponentState,
  HistoryEvent,
  LearnedRule,
  PlantId,
  Proposal,
  Vote,
} from "../../../shared/types.ts";
import { applyCalibration } from "../../../actor/src/logic/component.ts";
import { deriveRules, mergeCompanyRule, mergeDerivedRules, mergeSubmittedRule, toCompanyRule } from "../../../actor/src/logic/rules.ts";
import { rankSimilar } from "../../../actor/src/logic/similar.ts";
import { crossPlantEffects, OBSERVE_TICKS, PARAMS, SteamUnit, summarizeEffects, type Snapshot } from "../../../bridge/tank_model.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const interp = (pts: [number, number][], x: number) => {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return pts[pts.length - 1][1];
};

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

// Shared header drop against the other plant held at 50 %, from the fixture coefficients in actor/tests/e2e.
const header = (speed: number) => round(Math.min(6.5, Math.max(4.5, 6.0 - 0.0005 * (29.7 * speed + 48 + 29.7 * 50 + 48 - 3066))), 2);

const STEAM: [number, number][] = [[50, 1533], [65, 1980], [85, 2570], [100, 3020]];
const DUTY: [number, number][] = [[50, 898.5], [65, 1160], [85, 1510], [100, 1780]];
const DIP: [number, number][] = [[50, 0], [65, 2], [85, 4], [100, 5]];

// Observed values five ticks after a step, per the physics summary: valve position tracks pump speed,
// plus what is left of the +3 to +5 overshoot.
export function observe(plantId: PlantId, speed: number, before: number, r: () => number, residualRange: [number, number] = [0, 3]) {
  const c = (tag: string) => `${plantId}/${tag}` as ComponentId;
  const residual = residualRange[0] + r() * (residualRange[1] - residualRange[0]);
  const lv = Math.min(100, speed + residual);
  const level = speed < 93 ? 50 + (r() - 0.5) * 2 : 50 + (speed - 92) * 4;
  const steam = interp(STEAM, speed) + (r() - 0.5) * 40;
  const duty = interp(DUTY, speed) + (r() - 0.5) * 20;
  const temp = 75 - interp(DIP, speed) * (0.8 + r() * 0.4);
  const tv = 50.5 + ((steam - 1533) / 1467) * 45;
  const e = (componentId: ComponentId, metric: string, b: number, a: number, ticksToSettle: number) => ({
    componentId, metric, before: b, after: round(a), ticksToSettle,
  });
  return [
    e(c("LV-101"), "positionPct", before, lv, 3),
    e(c("TK-101"), "levelPct", 50, level, 4),
    e(c("TK-101"), "tempC", 75, temp, 4),
    e(c("E-101"), "dutyKw", interp(DUTY, before), duty, 3),
    e(c("TV-101"), "positionPct", 50.5, tv, 3),
    e(c("TV-101"), "steamKgH", interp(STEAM, before), steam, 3),
    e(c("TV-101"), "headerBarg", header(before), header(speed), 3),
  ];
}

const SATURATED = "LV-101 saturated at 100%, TK-101 high-level alarm LAH-101";
const NO_HEADROOM = "LV-101 no control headroom";

// TASK2.MD hard requirements: plant-a has saturation incidents at 88-100, headroom events at 80-87, safe runs at 60-70.
// plant-b has zero events at or above 80. plantBReach sets how close its history comes to 85.
const SPEEDS: Record<PlantId, [number, [number, number], string | null][]> = {
  "plant-a": [
    ...[88, 90, 92, 94, 96, 98, 100].map((s): [number, [number, number], string | null] => [s, [3, 5], SATURATED]),
    ...[80, 81, 83, 85, 86, 87].map((s): [number, [number, number], string | null] => [s, [4, 5], s >= 85 ? NO_HEADROOM : null]),
    ...[40, 45, 55, 58, 60, 62, 64, 65, 66, 68, 70, 72, 75, 78].map((s): [number, [number, number], string | null] => [s, [0, 3], null]),
  ],
  "plant-b": [40, 45, 50, 55, 60, 62, 64, 65].map((s): [number, [number, number], string | null] => [s, [0, 3], null]),
};
const PLANT_B_NEAR = [68, 70, 72, 74, 75, 76, 78];

export type PlantsFile = { company: { plants: PlantId[]; sharedResources: { id: string; name: string; components: string[] }[] }; plants: { id: PlantId; name: string; components: ComponentState[] }[] };

// shared/history.json when it exists, else the ar-fixtures stand-in, else the generated fixture below.
const HISTORY_FILES = [["shared/history.json", "shared-history"], ["actor/tests/fixtures-gen/history.json", "stand-in"]] as const;
let seedCache: { events: HistoryEvent[]; source: string } | null | undefined;
function seedFile() {
  if (seedCache !== undefined) return seedCache;
  seedCache = null;
  const override = process.env.LEARNING_HISTORY;
  const files = override ? ([[override, "person2"]] as const) : HISTORY_FILES;
  for (const [path, source] of files) {
    const full = override ? path : join(ROOT, ...path.split("/"));
    if (!existsSync(full)) continue;
    const raw = JSON.parse(readFileSync(full, "utf8"));
    seedCache = { events: Array.isArray(raw) ? raw : (raw.events ?? raw.history ?? []), source };
    break;
  }
  return seedCache;
}

function settledCopy(e: HistoryEvent, r: () => number): HistoryEvent {
  return {
    ...e,
    effects: e.effects.map((f) => (f.componentId.endsWith("LV-101") && f.metric === "positionPct" ? { ...f, after: round(Math.min(100, e.after + r() * 0.8)) } : f)),
  };
}

export class World {
  plants: PlantsFile = JSON.parse(readFileSync(join(ROOT, "shared", "plants.json"), "utf8"));
  components = new Map<ComponentId, ComponentState>();
  history: Record<PlantId, HistoryEvent[]> = { "plant-a": [], "plant-b": [] };
  plantRules: Record<PlantId, LearnedRule[]> = { "plant-a": [], "plant-b": [] };
  companyRules: LearnedRule[] = [];
  proposals: Proposal[] = [];
  calibration = new Map<ComponentId, CalibrationEntry[]>();
  sinceAdjustment = new Map<ComponentId, number>();
  clock: number;
  seq = 0;
  r: () => number;
  source: string = "fixture";

  // shape "settled" rewrites LV-101 rows to the steady value, as if history recorded 5 ticks after the overshoot decayed.
  constructor(public seed: number, public plantBReach: 65 | 78 = 65, historyMode: "auto" | "fixture" = "auto", public shape: "as-is" | "settled" = "as-is", public plantModel = false) {
    this.r = rng(seed);
    this.clock = Date.parse("2026-10-31T17:00:00Z");
    for (const p of this.plants.plants) for (const c of p.components) this.components.set(c.id, structuredClone(c));
    const seeded = historyMode === "auto" ? seedFile() : null;
    if (seeded) {
      for (const e of seeded.events) this.history[e.plantId].push(shape === "settled" ? settledCopy(e, this.r) : e);
      this.source = seeded.source;
    } else {
      this.seedHistory();
    }
  }

  id(prefix: string) {
    const tag = Math.floor(this.r() * 0xfffff).toString(16).padStart(5, "0");
    return `${prefix}-${tag}-${++this.seq}`;
  }

  private seedHistory() {
    for (const plantId of ["plant-a", "plant-b"] as PlantId[]) {
      const grid = [...SPEEDS[plantId]];
      if (plantId === "plant-b" && this.plantBReach === 78) grid.push(...PLANT_B_NEAR.map((s): [number, [number, number], string | null] => [s, [0, 3], null]));
      grid.forEach(([speed, residual, incident], i) => {
        const effects = observe(plantId, speed, 50, this.r, residual);
        this.history[plantId].push({
          id: this.id(`evt-${plantId.slice(-1)}`),
          at: new Date(Date.parse("2024-02-01T06:00:00Z") + this.r() * 8.0e10).toISOString(),
          plantId,
          componentId: `${plantId}/P-100`,
          metric: "speedPct",
          before: 50,
          after: speed,
          upstreamSnapshot: { feedM3h: 15, headerBarg: 6, feedTempC: 25 },
          effects,
          incident,
          approvedBy: [],
          operator: "history",
          proposalId: null,
        });
      });
    }
  }

  // Real actor logic over in-memory history.
  similar(q: { componentId: ComponentId; metric: string; to: number; upstreamSnapshot: Record<string, number>; k?: number }) {
    const plantId = q.componentId.split("/")[0] as PlantId;
    return rankSimilar({
      history: this.history[plantId],
      componentId: q.componentId,
      metric: q.metric,
      to: q.to,
      upstreamSnapshot: q.upstreamSnapshot,
      k: q.k ?? 5,
      limit: this.components.get(q.componentId)!.limits[q.metric],
      liveEventIds: this.history[plantId].filter((e) => e.proposalId).map((e) => e.id),
    });
  }

  // Newest event that this system executed on a proposal. Not in the frozen glue surface; learn.ts's cache has it.
  newestExecution(componentId: ComponentId, metric: string) {
    const plantId = componentId.split("/")[0] as PlantId;
    return this.history[plantId]
      .filter((e) => e.componentId === componentId && e.metric === metric && e.proposalId)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
  }

  // Plant scope for this plant, company scope for all plants. vote.ts applies ruleApplies on top.
  rulesFor(componentId: ComponentId) {
    const comp = this.components.get(componentId)!;
    return [...this.plantRules[comp.plantId], ...this.companyRules.filter((r) => r.model === comp.model)];
  }

  // Rule ingest as the actors do it: plant merge, then company merge when the model exists in the other plant.
  promote(rule: LearnedRule, plantId: PlantId) {
    const now = new Date(this.clock).toISOString();
    const merged = mergeSubmittedRule(this.plantRules[plantId], rule, now);
    this.plantRules[plantId] = merged.rules;
    this.toCompany(merged.rule, plantId, now);
    return merged.rule;
  }

  private toCompany(rule: LearnedRule, plantId: PlantId, now: string) {
    const other = plantId === "plant-a" ? "plant-b" : "plant-a";
    const exists = [...this.components.values()].some((c) => c.plantId === other && c.model === rule.model);
    if (exists) this.companyRules = mergeCompanyRule(this.companyRules, toCompanyRule(rule, plantId), now).rules;
  }

  // What recordEvent does after a run lands: re-derive and merge plant rules, promote what changed.
  deriveAfterRecord(plantId: PlantId) {
    const now = new Date(this.clock).toISOString();
    const topology = Object.fromEntries(this.components);
    const derived = deriveRules(this.history[plantId], topology, now);
    const merged = mergeDerivedRules(this.plantRules[plantId], derived);
    this.plantRules[plantId] = merged.rules;
    for (const rule of merged.changed) this.toCompany(rule, plantId, now);
  }

  addCalibration(id: ComponentId, entry: CalibrationEntry) {
    const c = this.components.get(id)!;
    const outcome = applyCalibration({ calibration: this.calibration.get(id) ?? [], entry, limits: c.limits, marginPct: c.marginPct, sinceAdjustment: this.sinceAdjustment.get(id) ?? 0 });
    this.calibration.set(id, outcome.calibration);
    this.sinceAdjustment.set(id, outcome.sinceAdjustment);
    c.marginPct = outcome.marginPct;
  }

  proposal(plantId: PlantId, to: number, from: number, rationale: string, parent: string | null = null): Proposal {
    const proposer = `${plantId}/P-100`;
    const other = plantId === "plant-a" ? "plant-b" : "plant-a";
    const requiredVoters = ["TK-101", "LV-101", "E-101", "TV-101"].map((t) => `${plantId}/${t}`).concat(`${other}/TV-101`);
    const p: Proposal = {
      id: `${plantId}-${this.id("p")}`,
      at: new Date(this.clock).toISOString(),
      plantId,
      proposerComponentId: proposer,
      proposerAgentId: `agent:${proposer}`,
      metric: "speedPct",
      from,
      to,
      rationale,
      requiredVoters,
      votes: [],
      status: "voting",
      vetoDeadline: null,
      parentProposalId: parent,
      crossPlant: true,
    };
    this.proposals.push(p);
    return p;
  }

  // Steps the real tank model the way live_sim does: both plants at steady state, then OBSERVE_TICKS after the write.
  // Feed temperature varies per run, so calibration is not scored against one fixed answer.
  private simulated(p: Proposal) {
    const other = p.plantId === "plant-a" ? "plant-b" : "plant-a";
    const feedTempC = PARAMS.feedTempC + (this.r() - 0.5) * 4;
    const speedOf = (id: PlantId) => this.components.get(`${id}/P-100`)!.metrics.speedPct;
    const unit = new SteamUnit(PARAMS, { [p.plantId]: { speedPct: p.from, feedTempC }, [other]: { speedPct: speedOf(other), feedTempC } });
    const samples: Snapshot[] = [unit.snapshot()];
    unit.plants[p.plantId].speedPct = p.to;
    for (let tick = 0; tick < OBSERVE_TICKS; tick++) {
      unit.tick();
      samples.push(unit.snapshot());
    }
    return [...summarizeEffects(p.plantId, samples), ...crossPlantEffects(other, samples)];
  }

  // Without the model, TASK2 says live runs land near history: a nearby seeded run's rows plus small sensor noise.
  private observed(p: Proposal) {
    if (this.plantModel) return this.simulated(p);
    const pool = this.history[p.plantId].filter((e) => !e.proposalId && e.componentId === p.proposerComponentId && Math.abs(e.after - p.to) <= 1);
    if (this.source === "fixture" || pool.length === 0) return observe(p.plantId, p.to, p.from, this.r);
    const base = pool[Math.floor(this.r() * pool.length)];
    const jitter = (x: number) => round(x * (1 + (this.r() - 0.5) * 0.01), 2);
    return base.effects.map((f) => ({ ...f, after: jitter(f.after) }));
  }

  // Applies an approved proposal. Observed values are generated here, never read from a vote.
  execute(p: Proposal, votes: Vote[]) {
    this.clock += 40_000;
    const effects = this.observed(p);
    const lv = effects.find((f) => f.componentId.endsWith("LV-101"))!.after;
    const event: HistoryEvent = {
      id: this.id(`evt-${p.plantId.slice(-1)}`),
      at: new Date(this.clock).toISOString(),
      plantId: p.plantId,
      componentId: p.proposerComponentId,
      metric: p.metric,
      before: p.from,
      after: p.to,
      upstreamSnapshot: { feedM3h: 0.3 * p.from, headerBarg: 6, feedTempC: 25 },
      effects,
      incident: lv >= 90 ? SATURATED : null,
      approvedBy: votes.filter((v) => v.vote === "yes").map((v) => v.agentId),
      operator: "operator-1",
      proposalId: p.id,
    };
    this.history[p.plantId].push(event);
    for (const eff of effects) {
      const c = this.components.get(eff.componentId)!;
      c.metrics[eff.metric] = eff.after;
    }
    this.components.get(p.proposerComponentId)!.metrics[p.metric] = p.to;
    this.components.get(p.proposerComponentId)!.metrics.feedM3h = 0.3 * p.to;
    const twin = this.components.get(`${p.plantId === "plant-a" ? "plant-b" : "plant-a"}/TV-101`)!;
    twin.metrics.headerBarg = effects.find((f) => f.metric === "headerBarg")!.after;
    p.status = "executed";
    this.deriveAfterRecord(p.plantId);
    return event;
  }

  rule(id: string) {
    return [...this.plantRules["plant-a"], ...this.plantRules["plant-b"], ...this.companyRules].find((r) => r.id === id) ?? null;
  }

  event(id: string) {
    return [...this.history["plant-a"], ...this.history["plant-b"]].find((e) => e.id === id) ?? null;
  }
}

// TK-101 heated stirred hold tank, written for ActorRelay from the Model notes and Physics summary in CLAUDE.MD.
// Two states (level h, temperature T), three PI loops, an equal-percentage steam valve and RK4 at 1 s substeps
// under a 10 s controller scan. See NOTICE.md for the model design this follows.
//
// Scan order: read signals, step every PI controller (the TIC-101 master writes the FIC-201 setpoint), then integrate
// 10 s with the valve outputs held. Nothing here keeps wall-clock time; live_sim.ts decides when a scan runs.
import type { HistoryEvent, PlantId } from "../shared/types";

export const SCAN_SECONDS = 10;
export const SUBSTEP_SECONDS = 1;
export const SCANS_PER_TICK = 18;
export const TICK_SIM_SECONDS = SCANS_PER_TICK * SCAN_SECONDS;
export const OBSERVE_TICKS = 5;
export const PLANT_IDS: PlantId[] = ["plant-a", "plant-b"];

export const TAGS = ["P-100", "TK-101", "LV-101", "E-101", "TV-101"] as const;
export type Tag = (typeof TAGS)[number];

// CLAUDE.MD gives the design point, tuning and steady states but not the vessel constants, so the first block below
// is derived from those numbers. The derivation is in HANDOFF.md.
export const PARAMS = {
  tankHeightM: 4.0,
  tankAreaM2: 3.2, // fitted: LV-101 overshoot of +3 points at 85 %, temperature dips, about 2.39 m after an hour at 33 m3/h
  rhoCpKjM3K: 4183, // duty slope 17.43 kW per speed point at a 50 C rise
  lossKwPerK: 0.491, // duty intercept 27 kW at 55 C above ambient
  steamLatentKjKg: 2110, // 1533 kg/h <-> 898.5 kW
  lvCapacity: (30 / 3600) / (0.999 * Math.SQRT2), // LV-101 at 99.9 % passes 30 m3/h at 2.0 m (m^2.5/s at full travel)
  tvMaxKgH: 10000, // TV-101 fully open at 6 barg
  tvRangeability: 44, // equal-percentage: TV-101 at 50.5 % passes 1533 kg/h at 6 barg
  atmosphereBar: 1.013,

  // Stated tuning.
  tempSpC: 75,
  tempKc: 0.045, // output fraction per degC, output scaled onto the FIC-201 setpoint range
  tempTiS: 900,
  steamRangeKgH: 3000,
  steamKc: 0.00015, // valve fraction per kg/h
  steamTiS: 60,
  levelSpM: 2.0,
  levelKc: 2.0, // valve fraction per metre
  levelTiS: 600,

  // Damping on the FT-201 signal into FIC-201. Without it the 10 s scan makes that loop unstable above about 1630 kg/h:
  // steam follows the valve instantly, so the loop gain is steamKc * flow * ln(rangeability) and the limit is 0.92.
  // Set to 0 to see the swing; 10 s is the smallest stable value tried at 100 % speed. It filters the controller's
  // input only, so it adds no plant state and moves no steady state.
  ft201DampingS: 20,

  // Design point.
  feedM3hPerSpeedPct: 0.3,
  designSpeedPct: 50,
  feedTempC: 25,
  ambientC: 20,
  headerDesignBarg: 6.0,
  headerSlopeBargPerKgH: 0.0005,
  headerDesignSteamKgH: 3066, // two plants at design
  headerMinBarg: 4.5,
  headerMaxBarg: 6.5,
} as const;

export type Params = { [K in keyof typeof PARAMS]: number };

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export type Signals = {
  "LI-101": number; // level, m
  "TI-101": number; // temperature, degC
  "FI-101": number; // feed, m3/h
  "FI-102": number; // outlet, m3/h
  "FI-201": number; // steam, kg/h
  "PI-201": number; // steam header, barg
  "CALC-DUTY": number; // coil duty, kW
};

export type Conditions = { speedPct: number; feedTempC: number; ambientC: number; headerBarg: number };

/** Velocity-form PI. Clamping the output is the anti-windup: there is no separate integral to wind up. */
export class PiController {
  sp: number;
  output: number;
  private lastError = 0;

  constructor(
    sp: number,
    output: number,
    private readonly gain: { kc: number; tiS: number; opensOnHighPv: boolean; min: number; max: number },
  ) {
    this.sp = sp;
    this.output = output;
  }

  step(pv: number, dtS: number): number {
    const error = this.gain.opensOnHighPv ? pv - this.sp : this.sp - pv;
    const delta = this.gain.kc * (error - this.lastError + (dtS / this.gain.tiS) * error);
    this.output = clamp(this.output + delta, this.gain.min, this.gain.max);
    this.lastError = error;
    return this.output;
  }
}

/** TV-101: equal-percentage trim, and flow proportional to absolute header pressure because the valve runs choked. */
export function steamFlowKgH(p: Params, valve: number, headerBarg: number): number {
  if (valve <= 0) return 0; // Equal-percentage trim bottoms out at max/rangeability; a shut valve still passes nothing.
  const pressure = (headerBarg + p.atmosphereBar) / (p.headerDesignBarg + p.atmosphereBar);
  return p.tvMaxKgH * p.tvRangeability ** (valve - 1) * pressure;
}

function valveForSteam(p: Params, steamKgH: number, headerBarg: number): number {
  const pressure = (headerBarg + p.atmosphereBar) / (p.headerDesignBarg + p.atmosphereBar);
  return clamp(1 + Math.log(steamKgH / (p.tvMaxKgH * pressure)) / Math.log(p.tvRangeability), 0, 1);
}

/** Steam needed to hold the temperature setpoint, from the energy balance. */
export function steamDemandKgH(p: Params, speedPct: number, feedTempC: number, ambientC: number): number {
  const feed = (p.feedM3hPerSpeedPct * speedPct) / 3600;
  const dutyKw = p.rhoCpKjM3K * feed * (p.tempSpC - feedTempC) + p.lossKwPerK * (p.tempSpC - ambientC);
  return (dutyKw * 3600) / p.steamLatentKjKg;
}

export function headerBarg(p: Params, totalSteamKgH: number): number {
  return clamp(p.headerDesignBarg - p.headerSlopeBargPerKgH * (totalSteamKgH - p.headerDesignSteamKgH), p.headerMinBarg, p.headerMaxBarg);
}

export class TankPlant {
  h: number;
  T: number;
  speedPct: number;
  feedTempC: number;
  ambientC: number;
  headerBarg: number;
  valveLv: number;
  valveTv: number;
  dampedSteamKgH: number;
  readonly lic: PiController;
  readonly tic: PiController;
  readonly fic: PiController;

  /** Starts on the steady state for these conditions: valve outputs solved for the level and temperature setpoints. */
  constructor(
    readonly p: Params,
    conditions: Conditions,
  ) {
    const { speedPct, feedTempC, ambientC } = conditions;
    this.speedPct = speedPct;
    this.feedTempC = feedTempC;
    this.ambientC = ambientC;
    this.headerBarg = conditions.headerBarg;
    this.h = p.levelSpM;
    this.T = p.tempSpC;
    const feed = (p.feedM3hPerSpeedPct * speedPct) / 3600;
    this.valveLv = clamp(feed / (p.lvCapacity * Math.sqrt(this.h)), 0, 1);
    const steam = Math.min(steamDemandKgH(p, speedPct, feedTempC, ambientC), p.steamRangeKgH);
    this.valveTv = valveForSteam(p, steam, this.headerBarg);
    this.dampedSteamKgH = steam;
    this.lic = new PiController(p.levelSpM, this.valveLv, { kc: p.levelKc, tiS: p.levelTiS, opensOnHighPv: true, min: 0, max: 1 });
    this.tic = new PiController(p.tempSpC, steam / p.steamRangeKgH, { kc: p.tempKc, tiS: p.tempTiS, opensOnHighPv: false, min: 0, max: 1 });
    this.fic = new PiController(steam, this.valveTv, { kc: p.steamKc, tiS: p.steamTiS, opensOnHighPv: false, min: 0, max: 1 });
  }

  get feedM3h(): number {
    return this.p.feedM3hPerSpeedPct * this.speedPct;
  }

  get steamKgH(): number {
    return steamFlowKgH(this.p, this.valveTv, this.headerBarg);
  }

  signals(): Signals {
    const steam = this.steamKgH;
    return {
      "LI-101": this.h,
      "TI-101": this.T,
      "FI-101": this.feedM3h,
      "FI-102": this.p.lvCapacity * this.valveLv * Math.sqrt(this.h) * 3600,
      "FI-201": steam,
      "PI-201": this.headerBarg,
      "CALC-DUTY": (steam * this.p.steamLatentKjKg) / 3600,
    };
  }

  /** One controller scan: PI loops first, then 10 s of RK4 with the valve outputs held. */
  scan(): void {
    const { p } = this;
    const signals = this.signals();
    const steam = signals["FI-201"];
    const decay = p.ft201DampingS > 0 ? Math.exp(-SCAN_SECONDS / p.ft201DampingS) : 0;
    this.dampedSteamKgH = decay * this.dampedSteamKgH + (1 - decay) * steam;
    this.fic.sp = this.tic.step(signals["TI-101"], SCAN_SECONDS) * p.steamRangeKgH;
    this.valveTv = this.fic.step(this.dampedSteamKgH, SCAN_SECONDS);
    this.valveLv = this.lic.step(signals["LI-101"], SCAN_SECONDS);
    this.integrate(SCAN_SECONDS);
  }

  private derivatives(h: number, T: number, dutyKw: number): [number, number] {
    const { p } = this;
    const feed = this.feedM3h / 3600;
    const outlet = p.lvCapacity * this.valveLv * Math.sqrt(Math.max(h, 0));
    const volume = Math.max(p.tankAreaM2 * h, 1e-3);
    const net = (dutyKw - p.lossKwPerK * (T - this.ambientC)) / p.rhoCpKjM3K;
    return [(feed - outlet) / p.tankAreaM2, (feed * (this.feedTempC - T) + net) / volume];
  }

  private integrate(seconds: number): void {
    const dt = SUBSTEP_SECONDS;
    const dutyKw = (this.steamKgH * this.p.steamLatentKjKg) / 3600;
    for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
      const { h, T } = this;
      const k1 = this.derivatives(h, T, dutyKw);
      const k2 = this.derivatives(h + (dt / 2) * k1[0], T + (dt / 2) * k1[1], dutyKw);
      const k3 = this.derivatives(h + (dt / 2) * k2[0], T + (dt / 2) * k2[1], dutyKw);
      const k4 = this.derivatives(h + dt * k3[0], T + dt * k3[1], dutyKw);
      this.h = clamp(h + (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]), 0, this.p.tankHeightM);
      this.T = T + (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    }
  }

  /** Metrics per component, exactly the TASK2 mapping. Keys are bare tags. */
  metrics(): Record<Tag, Record<string, number>> {
    const s = this.signals();
    return {
      "P-100": { speedPct: this.speedPct, feedM3h: s["FI-101"] },
      "TK-101": { levelPct: (s["LI-101"] / this.p.tankHeightM) * 100, tempC: s["TI-101"] },
      "LV-101": { positionPct: this.valveLv * 100 },
      "E-101": { dutyKw: s["CALC-DUTY"] },
      "TV-101": { positionPct: this.valveTv * 100, steamKgH: s["FI-201"], headerBarg: s["PI-201"] },
    };
  }
}

export type PlantConditions = { speedPct: number; feedTempC: number };

/** Both plants on the shared steam header. Header pressure is recomputed from the two steam flows before every scan. */
export class SteamUnit {
  readonly plants: Record<PlantId, TankPlant>;

  constructor(
    readonly p: Params = PARAMS,
    start: Partial<Record<PlantId, Partial<PlantConditions>>> = {},
  ) {
    const conditions = (id: PlantId): PlantConditions => ({ speedPct: start[id]?.speedPct ?? p.designSpeedPct, feedTempC: start[id]?.feedTempC ?? p.feedTempC });
    const a = conditions("plant-a");
    const b = conditions("plant-b");
    const steam = (c: PlantConditions) => Math.min(steamDemandKgH(p, c.speedPct, c.feedTempC, p.ambientC), p.steamRangeKgH);
    const header = headerBarg(p, steam(a) + steam(b));
    this.plants = {
      "plant-a": new TankPlant(p, { ...a, ambientC: p.ambientC, headerBarg: header }),
      "plant-b": new TankPlant(p, { ...b, ambientC: p.ambientC, headerBarg: header }),
    };
  }

  scan(): void {
    const header = headerBarg(this.p, this.plants["plant-a"].steamKgH + this.plants["plant-b"].steamKgH);
    for (const id of PLANT_IDS) {
      this.plants[id].headerBarg = header;
      this.plants[id].scan();
    }
  }

  tick(): void {
    for (let n = 0; n < SCANS_PER_TICK; n++) this.scan();
  }

  snapshot(): Snapshot {
    const out: Snapshot = {};
    for (const id of PLANT_IDS) {
      for (const [tag, metrics] of Object.entries(this.plants[id].metrics())) out[`${id}/${tag}`] = metrics;
    }
    return out;
  }
}

export type Snapshot = Record<string, Record<string, number>>;
export type Effect = HistoryEvent["effects"][number];

/** The rows an observation reports for the plant that changed, with rounding and the smallest change worth calling a move. */
export const EFFECT_ROWS: { tag: Tag; metric: string; places: number; floor: number }[] = [
  { tag: "TK-101", metric: "levelPct", places: 2, floor: 0.1 },
  { tag: "TK-101", metric: "tempC", places: 2, floor: 0.1 },
  { tag: "LV-101", metric: "positionPct", places: 2, floor: 0.25 },
  { tag: "E-101", metric: "dutyKw", places: 1, floor: 5 },
  { tag: "TV-101", metric: "positionPct", places: 2, floor: 0.25 },
  { tag: "TV-101", metric: "steamKgH", places: 1, floor: 10 },
  { tag: "TV-101", metric: "headerBarg", places: 3, floor: 0.01 },
];

const round = (x: number, places: number) => Number(x.toFixed(places));

/**
 * Turns samples [before, tick 1, ..., tick N] into effect rows.
 * - `after` is the value at the last tick, except LV-101 positionPct, which reports the furthest point reached in the
 *   direction of travel: its overshoot is what the agents reason about, and it has often passed by tick 5.
 * - `ticksToSettle` is the first tick from which the metric stays within 5 % of the move (or the row's floor) of `after`,
 *   so a metric still moving at the last tick reports N. For LV-101, where `after` is a peak it leaves again, it is the
 *   first tick inside that band.
 */
export function summarizeEffects(plantId: PlantId, samples: Snapshot[]): Effect[] {
  const [first, ...ticks] = samples;
  return EFFECT_ROWS.map(({ tag, metric, places, floor }) => {
    const componentId = `${plantId}/${tag}`;
    const before = first[componentId][metric];
    const series = ticks.map((s) => s[componentId][metric]);
    const last = series[series.length - 1];
    const isPeakRow = tag === "LV-101";
    const after = isPeakRow ? (last >= before ? Math.max(...series) : Math.min(...series)) : last;
    const band = Math.max(0.05 * Math.abs(after - before), floor);
    const inBand = series.map((value) => Math.abs(value - after) <= band);
    const ticksToSettle = isPeakRow ? inBand.indexOf(true) + 1 : Math.min(inBand.lastIndexOf(false) + 2, series.length);
    return { componentId, metric, before: round(before, places), after: round(after, places), ticksToSettle };
  });
}

/** Rows for the other plant's TV-101, the one thing it shares with the changed plant, only where something actually moved. */
export function crossPlantEffects(otherPlantId: PlantId, samples: Snapshot[]): Effect[] {
  const floors = new Map(EFFECT_ROWS.filter((r) => r.tag === "TV-101").map((r) => [r.metric, r.floor]));
  return summarizeEffects(otherPlantId, samples).filter((row) => {
    if (!row.componentId.endsWith("/TV-101")) return false;
    return Math.abs(row.after - row.before) >= (floors.get(row.metric) ?? Infinity);
  });
}

export function upstreamSnapshot(plantId: PlantId, snapshot: Snapshot, feedTempC: number): Record<string, number> {
  return {
    feedM3h: round(snapshot[`${plantId}/P-100`].feedM3h, 2),
    headerBarg: round(snapshot[`${plantId}/TV-101`].headerBarg, 3),
    feedTempC: round(feedTempC, 2),
  };
}

/**
 * Fallback plant simulator (Bun, no dependencies).
 *
 * Same HTTP surface and JSON shapes as bridge/live_sim.py, backed by a linear
 * approximation fitted to the tank model's steady states. Every response
 * carries the header "X-Sim-Mode: fallback" so clients can tell which
 * simulator answered.
 *
 *   bun bridge/fallback.ts             -> 127.0.0.1:7300, 1 tick per second
 *   PORT=7399 bun bridge/fallback.ts   -> other port (SIM_PORT also accepted)
 *   SIM_FAST=1 bun bridge/fallback.ts  -> 10 ticks per second
 */
type Metrics = Record<string, number>;
type Snapshot = Record<string, Metrics>;
type Plant = {
  speedPct: number; // commanded pump speed (instant, as in live_sim)
  lagSpeed: number; // first-order lagged speed driving steam, duty, TV-101
  lvPct: number;
  levelPct: number;
  levelSp: number;
  tempC: number;
  tempSp: number;
  overshoot: number;
};
type Effect = { componentId: string; metric: string; before: number; after: number; ticksToSettle: number };
type Observation = { proposalId: string; effects: Effect[] };
type SetpointResult = { proposalId: string; componentId: string; metric: string; value: number; accepted: true; tick: number };

const PLANT_IDS = ["plant-a", "plant-b"] as const;
const TAGS = ["P-100", "TK-101", "LV-101", "E-101", "TV-101"];
// Same command/observation ranges as live_sim MINMAX.
const MINMAX: Record<string, [number, number]> = {
  "P-100/speedPct": [20, 100],
  "TK-101/levelPct": [20, 70],
  "TK-101/tempC": [70, 80],
  "LV-101/positionPct": [0, 100],
  "E-101/dutyKw": [0, 2000],
  "TV-101/positionPct": [0, 100],
  "TV-101/steamKgH": [0, 5000],
  "TV-101/headerBarg": [0, 10],
};
const ALPHA = 0.7; // first-order lag: ~90% of a step within 2 ticks
const BASE_STEAM = 3066; // both plants at 50% speed

const plants = new Map<string, Plant>();
const results = new Map<string, SetpointResult>();
const observations = new Map<string, Observation>();
let observers: { proposalId: string; before: Snapshot; remaining: number; startTick: number }[] = [];
let tick = 0;
let header = 6;
let glueDown = false;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const steamOf = (speed: number) => 29.7 * speed + 48;

function newPlant(): Plant {
  return { speedPct: 50, lagSpeed: 50, lvPct: 50, levelPct: 50, levelSp: 50, tempC: 75, tempSp: 75, overshoot: 0 };
}
function resetAll() {
  for (const id of PLANT_IDS) plants.set(id, newPlant());
  header = 6;
}

function componentMetrics(id: string): Snapshot {
  const p = plants.get(id)!;
  const tv = clamp(0.36 * p.lagSpeed + 32.5 + (6 - header) * 4, 0, 100);
  return {
    [`${id}/P-100`]: { speedPct: p.speedPct, feedM3h: p.speedPct * 0.3 },
    [`${id}/TK-101`]: { levelPct: p.levelPct, tempC: p.tempC },
    [`${id}/LV-101`]: { positionPct: p.lvPct },
    [`${id}/E-101`]: { dutyKw: 17.43 * p.lagSpeed + 27 },
    [`${id}/TV-101`]: { positionPct: tv, steamKgH: steamOf(p.lagSpeed), headerBarg: header },
  };
}
function snapshot(plantId?: string): Snapshot {
  const ids = plantId ? [plantId] : [...PLANT_IDS];
  return Object.assign({}, ...ids.map(componentMetrics));
}

// Best-effort pushes to glue, kept off the tick path (like live_sim's worker thread).
const glueQueue: [string, unknown][] = [];
let glueBusy = false;
function push(path: string, payload: unknown) {
  glueQueue.push([path, payload]);
  if (!glueBusy) void drainGlue();
}
async function drainGlue() {
  glueBusy = true;
  const base = (Bun.env.GLUE_URL || "http://127.0.0.1:7200").replace(/\/$/, "");
  while (glueQueue.length) {
    const [path, payload] = glueQueue.shift()!;
    try {
      await fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(150),
      });
      glueDown = false;
    } catch (e) {
      if (!glueDown) console.log(`glue unavailable (${path}): ${e}`);
      glueDown = true;
    }
  }
  glueBusy = false;
}
function mirror(snap: Snapshot) {
  const stamp = new Date().toISOString();
  for (const [componentId, metrics] of Object.entries(snap)) push("/mirror", { componentId, metrics, lastTick: stamp });
}

function step(): Snapshot {
  for (const p of plants.values()) {
    p.lagSpeed += ALPHA * (p.speedPct - p.lagSpeed);
    if (p.speedPct >= 95) {
      p.lvPct = 100; // outlet valve saturated
      p.levelPct = Math.min(100, p.levelPct + 1); // level rises 1 %/tick
    } else {
      const target = clamp(p.speedPct + 4 * p.overshoot, 0, 100);
      p.lvPct = clamp(p.lvPct + ALPHA * (target - p.lvPct), 0, 100);
      p.levelPct += ALPHA * (p.levelSp - p.levelPct);
    }
    p.overshoot *= 0.5;
    p.tempC += ALPHA * (p.tempSp - p.tempC); // dip recovers
  }
  const total = PLANT_IDS.reduce((s, id) => s + steamOf(plants.get(id)!.lagSpeed), 0);
  header = clamp(6 - 0.0005 * (total - BASE_STEAM), 4.5, 6.5);
  tick += 1;
  const snap = snapshot();
  mirror(snap);
  for (const ob of [...observers]) {
    ob.remaining -= 1;
    if (ob.remaining !== 0) continue;
    const effects: Effect[] = [];
    for (const [cid, ms] of Object.entries(snap)) {
      for (const [metric, val] of Object.entries(ms)) {
        const old = ob.before[cid]?.[metric];
        if (old !== undefined && Math.abs(val - old) > 1e-5)
          effects.push({ componentId: cid, metric, before: old, after: val, ticksToSettle: tick - ob.startTick });
      }
    }
    const observation = { proposalId: ob.proposalId, effects };
    observations.set(ob.proposalId, observation);
    push("/observed", observation);
    observers = observers.filter((o) => o !== ob);
  }
  return snap;
}

class BadRequest extends Error {}
function command(cid: string, metric: string, value: unknown, pid: string): SetpointResult {
  const prior = results.get(pid);
  if (prior) return prior; // idempotent on proposalId
  const parts = String(cid).split("/");
  if (parts.length !== 2 || !plants.has(parts[0]) || !TAGS.includes(parts[1])) throw new BadRequest("unknown componentId");
  const [plantId, tag] = parts;
  const range = MINMAX[`${tag}/${metric}`];
  if (!range) throw new BadRequest("unknown component metric");
  const [lo, hi] = range;
  if (typeof value !== "number" || !Number.isFinite(value) || value < lo || value > hi)
    throw new BadRequest(`value must be in [${lo}, ${hi}]`);
  const before = snapshot();
  const p = plants.get(plantId)!;
  if (tag === "P-100") {
    const delta = value - p.speedPct;
    p.speedPct = value;
    p.overshoot = delta > 0 ? 1 : 0;
    p.tempC -= 0.05 * Math.abs(delta); // feed step dips temperature, then recovers
  } else if (tag === "TK-101" && metric === "tempC") p.tempSp = value;
  else if (tag === "TK-101" && metric === "levelPct") p.levelSp = value;
  else throw new BadRequest("metric is observable and cannot be commanded");
  const result: SetpointResult = { proposalId: pid, componentId: cid, metric, value, accepted: true, tick };
  results.set(pid, result);
  observers.push({ proposalId: pid, before, remaining: 5, startTick: tick });
  console.log("setpoint", JSON.stringify(result));
  return result;
}

function send(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "X-Sim-Mode": "fallback" },
  });
}

resetAll();
const port = Number(Bun.env.PORT || Bun.env.SIM_PORT || 7300);
const fast = ["1", "true", "yes"].includes((Bun.env.SIM_FAST || "0").toLowerCase());

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET") {
      if (url.pathname === "/health") return send(200, { ok: true, tick });
      if (url.pathname === "/observed") {
        const pid = url.searchParams.get("proposalId");
        if (!pid) return send(400, { error: "proposalId required" });
        const obs = observations.get(pid);
        if (obs) return send(200, obs);
        if (results.has(pid)) return send(202, { proposalId: pid, pending: true });
        return send(404, { error: "unknown proposalId" });
      }
      if (url.pathname === "/snapshot") {
        const p = url.searchParams.get("plantId");
        if (p !== null && !plants.has(p)) return send(400, { error: "unknown plantId" });
        return send(200, snapshot(p ?? undefined));
      }
      return send(404, { error: "not found" });
    }
    if (req.method === "POST") {
      let data: any = {};
      try {
        const raw = await req.text();
        data = raw ? JSON.parse(raw) : {};
      } catch {
        return send(400, { error: "invalid JSON" });
      }
      if (url.pathname === "/setpoint") {
        try {
          if (data === null || typeof data !== "object") throw new BadRequest("missing componentId");
          for (const f of ["componentId", "metric", "value", "proposalId"]) if (!(f in data)) throw new BadRequest(`missing ${f}`);
          if (typeof data.proposalId !== "string" || !data.proposalId) throw new BadRequest("proposalId required");
          return send(200, command(data.componentId, data.metric, data.value, data.proposalId));
        } catch (e) {
          if (e instanceof BadRequest) return send(400, { error: e.message });
          throw e;
        }
      }
      if (url.pathname === "/reset") {
        resetAll();
        tick = 0;
        results.clear();
        observations.clear();
        observers = [];
        const snap = snapshot();
        mirror(snap);
        return send(200, { reset: true, snapshot: snap });
      }
    }
    return send(404, { error: "not found" });
  },
});

setInterval(step, fast ? 100 : 1000);
console.log(`fallback sim (X-Sim-Mode: fallback) listening on ${server.hostname}:${server.port}`);

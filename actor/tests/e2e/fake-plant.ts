#!/usr/bin/env bun
// TEST FAKE, NOT THE SIMULATOR. Used only by actor/tests/e2e to drive the real actors and agents.
// Implements the HTTP surface in TASK2.MD with the fitted linear coefficients listed there for the
// fallback. Every response carries `x-actorrelay-fake: plant`, and the e2e table labels any step that
// depends on this file. It does not model the shared header's effect on TV-101 position.
import plants from "../../../shared/plants.json";

const PORT = Number(process.env.FAKE_PLANT_PORT ?? 7310);
const GLUE = (process.env.FAKE_GLUE_URL ?? "http://127.0.0.1:7210").replace(/\/$/, "");
const TICK_MS = Number(process.env.FAKE_PLANT_TICK_MS ?? 1000);
const OBSERVE_TICKS = 5;
const LAG_TICKS = 2;
const ALPHA = 1 - Math.exp(-1 / LAG_TICKS);
const MOVED_EPSILON = 1e-6;
const SETTLE_BAND_PCT = 1;

type PlantId = "plant-a" | "plant-b";
type Metrics = Record<string, Record<string, number>>;
type Write = { seq: number; at: string; componentId: string; metric: string; value: number; proposalId: string };
type Observer = { proposalId: string; plantId: PlantId; startTick: number; before: Metrics; samples: Metrics[] };
type Sim = { speed: number; lagged: number; stepTick: number | null; stepDelta: number; levelPct: number };

const PLANT_IDS = plants.plants.map((p) => p.id) as PlantId[];
const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

function designSim(): Sim {
  return { speed: 50, lagged: 50, stepTick: null, stepDelta: 0, levelPct: 50 };
}

let tick = 0;
let sims: Record<PlantId, Sim> = { "plant-a": designSim(), "plant-b": designSim() };
let writes: Write[] = [];
let observers: Observer[] = [];
let mirrorOk = 0;
let mirrorFail = 0;
let observedSent: { at: string; proposalId: string; effects: unknown[]; status: number }[] = [];
let holdObserved = false;

// Rises to 1 on the tick after a step, then decays, so LV-101 overshoots by about 4 points early on.
function pulse(sim: Sim): number {
  if (sim.stepTick === null) return 0;
  const t = tick - sim.stepTick;
  return t < 1 ? 0 : Math.exp(-(t - 1) / LAG_TICKS);
}

function steam(sim: Sim): number {
  return 29.7 * sim.lagged + 48;
}

function headerBarg(): number {
  const total = steam(sims["plant-a"]) + steam(sims["plant-b"]);
  return Math.min(6.5, Math.max(4.5, 6.0 - 0.0005 * (total - 3066)));
}

function snapshot(plantId: PlantId): Metrics {
  const sim = sims[plantId];
  const p = pulse(sim);
  return {
    [`${plantId}/P-100`]: { speedPct: round(sim.speed), feedM3h: round(0.3 * sim.speed) },
    [`${plantId}/TK-101`]: { levelPct: round(sim.levelPct), tempC: round(75 - 0.05 * Math.abs(sim.stepDelta) * p) },
    [`${plantId}/LV-101`]: { positionPct: round(Math.min(100, sim.lagged + 4 * p)) },
    [`${plantId}/E-101`]: { dutyKw: round(17.43 * sim.lagged + 27) },
    [`${plantId}/TV-101`]: {
      positionPct: round(0.36 * sim.lagged + 32.5),
      steamKgH: round(steam(sim)),
      headerBarg: round(headerBarg()),
    },
  };
}

function allMetrics(): Metrics {
  return Object.assign({}, ...PLANT_IDS.map(snapshot));
}

// A voter in either plant may need its own metric back for calibration, so the observer reports both.
function buildEffects(obs: Observer) {
  const effects: { componentId: string; metric: string; before: number; after: number; ticksToSettle: number }[] = [];
  const last = obs.samples[obs.samples.length - 1]!;
  for (const [componentId, metrics] of Object.entries(obs.before)) {
    for (const [metric, before] of Object.entries(metrics)) {
      const series = obs.samples.map((s) => s[componentId]![metric]!);
      const moved = series.some((v) => Math.abs(v - before) > MOVED_EPSILON);
      if (!moved) continue;
      const after = last[componentId]![metric]!;
      const band = Math.max(Math.abs(after) * (SETTLE_BAND_PCT / 100), 1e-3);
      let settle = series.length;
      for (let i = series.length - 1; i >= 0 && Math.abs(series[i]! - after) <= band; i--) settle = i + 1;
      effects.push({ componentId, metric, before, after, ticksToSettle: settle });
    }
  }
  return effects;
}

async function post(path: string, body: unknown): Promise<number> {
  const res = await fetch(`${GLUE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actorrelay-fake": "plant" },
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

// A slow tick never overlaps the next one, the same rule as glue's poller, so a busy actor sees no backlog.
let mirroring = false;
async function pushMirrors() {
  if (mirroring) return;
  mirroring = true;
  const entries = Object.entries(allMetrics());
  await Promise.all(
    entries.map(async ([componentId, metrics]) => {
      try {
        const status = await post("/mirror", { componentId, metrics });
        if (status < 300) mirrorOk++;
        else mirrorFail++;
      } catch {
        mirrorFail++;
      }
    }),
  );
  mirroring = false;
}

async function finishObserver(obs: Observer) {
  const effects = buildEffects(obs);
  if (holdObserved) return;
  try {
    const status = await post("/observed", { proposalId: obs.proposalId, effects });
    observedSent.push({ at: new Date().toISOString(), proposalId: obs.proposalId, effects, status });
  } catch {
    observedSent.push({ at: new Date().toISOString(), proposalId: obs.proposalId, effects, status: 0 });
  }
}

function stepOnce() {
  tick++;
  for (const id of PLANT_IDS) {
    const sim = sims[id];
    sim.lagged += ALPHA * (sim.speed - sim.lagged);
    if (sim.speed > 95) sim.levelPct += 1;
  }
  const now = allMetrics();
  for (const obs of [...observers]) {
    obs.samples.push(now);
    if (obs.samples.length >= OBSERVE_TICKS) {
      observers = observers.filter((o) => o !== obs);
      void finishObserver(obs);
    }
  }
  void pushMirrors();
}

const timer = setInterval(stepOnce, TICK_MS);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-actorrelay-fake": "plant" },
  });
}

async function handleSetpoint(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const { componentId, metric, value, proposalId } = body ?? {};
  if (typeof componentId !== "string" || typeof metric !== "string" || typeof value !== "number" || typeof proposalId !== "string" || !proposalId) {
    return json({ error: "componentId, metric, value and proposalId are required" }, 400);
  }
  const plantId = componentId.split("/")[0] as PlantId;
  if (!PLANT_IDS.includes(plantId) || !componentId.endsWith("/P-100") || metric !== "speedPct") {
    return json({ error: "this fake accepts only P-100.speedPct" }, 400);
  }
  if (!Number.isFinite(value) || value < 0 || value > 100) return json({ error: "value out of range" }, 400);

  const sim = sims[plantId];
  const before = allMetrics();
  const delta = value - sim.speed;
  sim.speed = value;
  sim.stepTick = tick;
  sim.stepDelta = delta;
  const write: Write = { seq: writes.length + 1, at: new Date().toISOString(), componentId, metric, value, proposalId };
  writes.push(write);
  observers.push({ proposalId, plantId, startTick: tick, before, samples: [] });
  return json({ applied: value, componentId, metric, proposalId, seq: write.seq });
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/snapshot") {
      const plantId = url.searchParams.get("plantId") as PlantId;
      if (!PLANT_IDS.includes(plantId)) return json({ error: "unknown plantId" }, 400);
      return json(snapshot(plantId));
    }
    if (req.method === "POST" && url.pathname === "/setpoint") return handleSetpoint(req);
    if (req.method === "POST" && url.pathname === "/reset") {
      sims = { "plant-a": designSim(), "plant-b": designSim() };
      observers = [];
      return json({ ok: true, tick });
    }
    // Test-only controls and evidence, never part of the TASK2.MD surface.
    if (req.method === "GET" && url.pathname === "/__fake/info") return json({ fake: "plant", tick, tickMs: TICK_MS, mirrorOk, mirrorFail });
    if (req.method === "GET" && url.pathname === "/__fake/writes") return json(writes);
    if (req.method === "GET" && url.pathname === "/__fake/observed") return json(observedSent);
    if (req.method === "POST" && url.pathname === "/__fake/hold-observed") {
      holdObserved = (await req.json()).hold === true;
      return json({ holdObserved });
    }
    if (req.method === "POST" && url.pathname === "/__fake/clear-log") {
      writes = [];
      observedSent = [];
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  },
});

console.log(`[fake-plant] TEST FAKE on http://127.0.0.1:${server.port}, tick ${TICK_MS} ms, pushing to ${GLUE}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    clearInterval(timer);
    server.stop(true);
    process.exit(0);
  });
}

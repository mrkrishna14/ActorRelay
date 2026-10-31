// The live plant: two TK-101 units on one steam header, stepped in real time and served on 127.0.0.1:7300.
// 1 tick = 1 wall second = 18 controller scans = 180 simulated seconds.
//
// Run: bun run bridge/live_sim.ts
// Env: BRIDGE_PORT (7300), BRIDGE_HOST (127.0.0.1), GLUE_URL (http://127.0.0.1:7200), BRIDGE_TICK_MS (1000),
//      BRIDGE_PUSH_MIRROR (1; 0 leaves glue to poll /snapshot).
import type { PlantId } from "../shared/types";
import { OBSERVE_TICKS, PARAMS, PLANT_IDS, SCANS_PER_TICK, SCAN_SECONDS, SteamUnit, crossPlantEffects, summarizeEffects, type Effect, type Snapshot } from "./tank_model";

const PORT = Number(process.env.BRIDGE_PORT ?? 7300);
const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1";
const GLUE_URL = (process.env.GLUE_URL ?? "http://127.0.0.1:7200").replace(/\/+$/, "");
const TICK_MS = Number(process.env.BRIDGE_TICK_MS ?? 1000);
const PUSH_MIRROR = process.env.BRIDGE_PUSH_MIRROR !== "0";

const MAX_CATCH_UP_TICKS = 5;
const MIRROR_TIMEOUT_MS = 900;
const OBSERVED_RETRY_MS = [0, 1000, 2000, 4000];
const WRITE_LOG_SIZE = 200;

/** Decimals per metric on the wire. Observers keep full precision and round when they summarize. */
const PLACES: Record<string, number> = { speedPct: 2, feedM3h: 2, levelPct: 3, tempC: 3, positionPct: 2, dutyKw: 1, steamKgH: 1, headerBarg: 3 };

type WriteResult = { ok: true; componentId: string; metric: string; value: number; applied: number; before: number; tick: number; proposalId: string; duplicate: boolean };
type Observer = { proposalId: string; plantId: PlantId; samples: Snapshot[] };

let unit = new SteamUnit();
let tick = 0;
let observers: Observer[] = [];
let writes = new Map<string, WriteResult>();
const writeLog: (WriteResult & { at: string })[] = [];
const stats = {
  mirrorPushed: 0, mirrorFailed: 0, mirrorSkippedBusy: 0, mirrorLastError: null as string | null,
  observedDelivered: 0, observedFailed: 0, observedLastError: null as string | null,
  lateTicks: 0, droppedTicks: 0,
};
let mirrorInFlight = 0;
let glueReachable: boolean | null = null;

const log = (line: string) => console.log(`${new Date().toISOString()} [tick ${tick}] ${line}`);

function publicSnapshot(snapshot: Snapshot): Snapshot {
  const out: Snapshot = {};
  for (const [componentId, metrics] of Object.entries(snapshot)) {
    out[componentId] = Object.fromEntries(Object.entries(metrics).map(([metric, value]) => [metric, Number(value.toFixed(PLACES[metric] ?? 3))]));
  }
  return out;
}

function noteGlue(reachable: boolean, detail: string) {
  if (reachable === glueReachable) return;
  glueReachable = reachable;
  log(reachable ? `glue reachable at ${GLUE_URL}` : `glue unreachable at ${GLUE_URL}: ${detail}`);
}

async function pushOne(componentId: string, metrics: Record<string, number>) {
  try {
    const response = await fetch(`${GLUE_URL}/mirror`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ componentId, metrics }),
      signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
    });
    if (response.ok) {
      stats.mirrorPushed++;
      noteGlue(true, "");
    } else {
      stats.mirrorFailed++;
      stats.mirrorLastError = `HTTP ${response.status} for ${componentId}`;
      noteGlue(true, "");
    }
    await response.body?.cancel();
  } catch (error) {
    stats.mirrorFailed++;
    stats.mirrorLastError = error instanceof Error ? error.message : String(error);
    noteGlue(false, stats.mirrorLastError);
  } finally {
    mirrorInFlight--;
  }
}

function pushMirror(snapshot: Snapshot) {
  if (!PUSH_MIRROR) return;
  if (mirrorInFlight > 0) {
    stats.mirrorSkippedBusy++;
    return;
  }
  const entries = Object.entries(publicSnapshot(snapshot));
  mirrorInFlight = entries.length;
  for (const [componentId, metrics] of entries) void pushOne(componentId, metrics);
}

async function deliverObserved(proposalId: string, effects: Effect[]) {
  const body = JSON.stringify({ proposalId, effects });
  for (const wait of OBSERVED_RETRY_MS) {
    if (wait) await Bun.sleep(wait);
    try {
      const response = await fetch(`${GLUE_URL}/observed`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(3000) });
      const text = await response.text();
      if (response.ok) {
        stats.observedDelivered++;
        log(`observed ${proposalId}: ${effects.length} effects delivered`);
        return;
      }
      stats.observedLastError = `HTTP ${response.status}: ${text.slice(0, 200)}`;
      if (response.status < 500) break; // Glue refused it; repeating the same body will not change that.
    } catch (error) {
      stats.observedLastError = error instanceof Error ? error.message : String(error);
    }
  }
  stats.observedFailed++;
  log(`observed ${proposalId} NOT delivered: ${stats.observedLastError}`);
}

function finishObserver(observer: Observer) {
  const other = PLANT_IDS.find((id) => id !== observer.plantId) as PlantId;
  const effects = [...summarizeEffects(observer.plantId, observer.samples), ...crossPlantEffects(other, observer.samples)];
  void deliverObserved(observer.proposalId, effects);
}

function runTick() {
  unit.tick();
  tick++;
  const snapshot = unit.snapshot();
  observers = observers.filter((observer) => {
    observer.samples.push(snapshot);
    if (observer.samples.length <= OBSERVE_TICKS) return true;
    finishObserver(observer);
    return false;
  });
  pushMirror(snapshot);
}

let nextAt = performance.now() + TICK_MS;
function loop() {
  const now = performance.now();
  let ran = 0;
  while (now >= nextAt && ran < MAX_CATCH_UP_TICKS) {
    runTick();
    nextAt += TICK_MS;
    ran++;
  }
  if (ran > 1) stats.lateTicks += ran - 1;
  if (now >= nextAt) {
    const missed = Math.floor((now - nextAt) / TICK_MS) + 1;
    stats.droppedTicks += missed;
    log(`event loop stalled, dropped ${missed} ticks`);
    nextAt += missed * TICK_MS;
  }
  setTimeout(loop, Math.max(0, nextAt - performance.now()));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const refuse = (status: number, error: string) => json({ ok: false, error }, status);

function plantOf(componentId: string): { plantId: PlantId; tag: string } | null {
  const [plantId, tag, extra] = componentId.split("/");
  if (extra !== undefined || !PLANT_IDS.includes(plantId as PlantId) || !tag) return null;
  return { plantId: plantId as PlantId, tag };
}

/** The writes the bridge accepts. Everything else is refused, because the only legal target is a controller input. */
function applyWrite(plantId: PlantId, tag: string, metric: string, value: number): { before: number } | string {
  const plant = unit.plants[plantId];
  if (tag === "P-100" && metric === "speedPct") {
    if (value < 0 || value > 100) return "speedPct must be within 0..100";
    const before = plant.speedPct;
    plant.speedPct = value;
    return { before };
  }
  if (tag === "TK-101" && metric === "levelPct") {
    if (value < 5 || value > 95) return "levelPct setpoint must be within 5..95";
    const before = (plant.lic.sp / PARAMS.tankHeightM) * 100;
    plant.lic.sp = (value / 100) * PARAMS.tankHeightM;
    return { before };
  }
  if (tag === "TK-101" && metric === "tempC") {
    if (value < 30 || value > 95) return "tempC setpoint must be within 30..95";
    const before = plant.tic.sp;
    plant.tic.sp = value;
    return { before };
  }
  return `${tag}.${metric} is not writable; accepted: P-100.speedPct, TK-101.levelPct, TK-101.tempC`;
}

async function handleSetpoint(request: Request): Promise<Response> {
  if (!request.headers.get("content-type")?.includes("application/json")) return refuse(415, "content-type must be application/json");
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return refuse(400, "body must be JSON");
  }
  const { componentId, metric, value, proposalId } = body ?? {};
  if (typeof componentId !== "string" || typeof metric !== "string" || typeof proposalId !== "string" || proposalId.length === 0) {
    return refuse(400, "componentId, metric and proposalId are required strings");
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return refuse(400, "value must be a finite number");
  const target = plantOf(componentId);
  if (!target) return refuse(400, `unknown component ${componentId}`);

  // A retried dispatch must not move the plant twice or start a second observation.
  const earlier = writes.get(proposalId);
  if (earlier) {
    if (earlier.componentId !== componentId || earlier.metric !== metric || earlier.value !== value) return refuse(409, `${proposalId} already wrote ${earlier.componentId}.${earlier.metric}=${earlier.value}`);
    log(`duplicate setpoint ${proposalId} ignored`);
    return json({ ...earlier, duplicate: true });
  }

  const samples: Snapshot[] = [unit.snapshot()];
  const outcome = applyWrite(target.plantId, target.tag, metric, value);
  if (typeof outcome === "string") return refuse(400, outcome);

  const result: WriteResult = { ok: true, componentId, metric, value, applied: value, before: outcome.before, tick, proposalId, duplicate: false };
  writes.set(proposalId, result);
  writeLog.push({ ...result, at: new Date().toISOString() });
  writeLog.splice(0, Math.max(0, writeLog.length - WRITE_LOG_SIZE));
  observers.push({ proposalId, plantId: target.plantId, samples });
  log(`setpoint ${componentId}.${metric} ${outcome.before} -> ${value} (${proposalId})`);
  return json(result);
}

function handleReset(): Response {
  unit = new SteamUnit();
  observers = [];
  writes = new Map();
  log("reset: both plants at the design steady state");
  const snapshot = unit.snapshot();
  pushMirror(snapshot);
  return json({ ok: true, tick, snapshot: publicSnapshot(snapshot) });
}

function handleSnapshot(url: URL): Response {
  const plantId = url.searchParams.get("plantId");
  if (plantId !== null && !PLANT_IDS.includes(plantId as PlantId)) return refuse(400, `unknown plantId ${plantId}`);
  const all = publicSnapshot(unit.snapshot());
  const body = plantId ? Object.fromEntries(Object.entries(all).filter(([id]) => id.startsWith(`${plantId}/`))) : all;
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "x-bridge-tick": String(tick) } });
}

function handleHealth(): Response {
  const a = unit.plants["plant-a"];
  return json({
    ok: true,
    label: "simulated plant",
    tick,
    tickMs: TICK_MS,
    scansPerTick: SCANS_PER_TICK,
    simSecondsPerTick: SCANS_PER_TICK * SCAN_SECONDS,
    headerBarg: Number(a.headerBarg.toFixed(3)),
    speedPct: Object.fromEntries(PLANT_IDS.map((id) => [id, unit.plants[id].speedPct])),
    observersPending: observers.length,
    glueUrl: GLUE_URL,
    glueReachable,
    pushMirror: PUSH_MIRROR,
    stats,
  });
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    // Only glue calls this service. A browser page must not be able to move the plant through a cross-site POST.
    if (request.method === "POST" && request.headers.has("origin")) return refuse(403, "browser origins are refused; go through glue");
    if (route === "GET /snapshot") return handleSnapshot(url);
    if (route === "POST /setpoint") return handleSetpoint(request);
    if (route === "POST /reset") return handleReset();
    if (route === "GET /health") return handleHealth();
    if (route === "GET /writes") return json(writeLog);
    return refuse(404, `no route ${route}`);
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal}: stopping`);
    server.stop(true);
    process.exit(0);
  });
}

log(`live sim on http://${HOST}:${server.port}, 1 tick = ${TICK_MS} ms = ${SCANS_PER_TICK} scans = ${SCANS_PER_TICK * SCAN_SECONDS} simulated s, glue ${GLUE_URL}, mirror push ${PUSH_MIRROR ? "on" : "off"}`);
setTimeout(loop, TICK_MS);

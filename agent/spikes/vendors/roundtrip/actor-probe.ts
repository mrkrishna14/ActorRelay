// Times real actor calls with no agents running, to separate an actor's base cost from mailbox queueing.
// Runs against the private Terse on 7130. Usage: RT_LABEL=probe bun run roundtrip/actor-probe.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TERSE = process.env.RT_TERSE ?? "http://127.0.0.1:7130";
const LABEL = process.env.RT_LABEL ?? "probe";
const MIRROR_MS = Number(process.env.RT_MIRROR_MS ?? 0);
const runDir = join(import.meta.dir, "..", "..");
const resultDir = process.env.RT_RESULTS ?? join(runDir, "results");
mkdirSync(resultDir, { recursive: true });

const seed = JSON.parse(readFileSync(join(runDir, "shared", "plants.json"), "utf8"));
const realHistory = join(runDir, "shared", "history.json");
const history = JSON.parse(readFileSync(existsSync(realHistory) ? realHistory : join(runDir, "shared", "history.standin.json"), "utf8")) as { plantId: string }[];
const components = seed.plants.flatMap((p: any) => p.components) as any[];
const actorId = (id: string) => id.replace("/", ".");

async function invoke(actor: string, id: string, method: string, args: unknown[] = []): Promise<any> {
  const requestId = crypto.randomUUID();
  const response = await fetch(`${TERSE}/v1/projects/local/actors/${actor}/${encodeURIComponent(id)}/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "x-request-id": requestId },
    body: JSON.stringify({ requestId, method, args }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${actor}.${method} http ${response.status}: ${text.slice(0, 200)}`);
  const reply = JSON.parse(text);
  const outcome = reply.outcome ?? reply;
  if (outcome.type !== "completed") throw new Error(`${actor}.${method} ${outcome.type}: ${outcome.code ?? outcome.reason} ${outcome.message ?? ""}`);
  return outcome.result;
}

const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]) : null;
};
const row = (name: string, values: number[], extra: Record<string, unknown> = {}) => ({ name, n: values.length, p50: pct(values, 50), p95: pct(values, 95), max: pct(values, 100), ...extra });
const timed = async (fn: () => Promise<unknown>) => {
  const at = performance.now();
  await fn();
  return performance.now() - at;
};

async function serial(name: string, fn: () => Promise<unknown>, n = 12) {
  const values: number[] = [];
  for (let i = 0; i < n; i++) values.push(await timed(fn));
  const result = row(name, values);
  console.log(JSON.stringify(result));
  return result;
}

async function burst(name: string, fn: () => Promise<unknown>, width = 10, rounds = 4) {
  const values: number[] = [];
  const walls: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const at = performance.now();
    values.push(...(await Promise.all(Array.from({ length: width }, () => timed(fn)))));
    walls.push(performance.now() - at);
  }
  const result = row(`${name} x${width}`, values, { wallP50: pct(walls, 50) });
  console.log(JSON.stringify(result));
  return result;
}

await invoke("Company", "company", "loadSeed", [{ ...seed.company, rules: [], crossPlantProposals: [], audit: [] }]);
for (const plant of seed.plants) await invoke("Plant", plant.id, "loadSeed", [plant, history.filter((e) => e.plantId === plant.id)]);
await Promise.all(components.map((c) => invoke("Component", actorId(c.id), "loadSeed", [{ ...c, lastTick: new Date().toISOString() }])));

const mirror = MIRROR_MS
  ? setInterval(() => {
      for (const c of components) invoke("Component", actorId(c.id), "mirror", [c.metrics]).catch(() => undefined);
    }, MIRROR_MS)
  : null;

const state = await invoke("Plant", "plant-a", "getState");
const sizes = { plantStateBytes: JSON.stringify(state).length, historyEvents: state.history.length, rules: state.rules.length, load: readFileSync("/proc/loadavg", "utf8").split(" ")[0] };
console.log(JSON.stringify(sizes));

const similarArgs = ["plant-a/P-100", "speedPct", 85, { feedM3h: 15 }, 5];
const results = [
  await serial("Component.getState", () => invoke("Component", "plant-a.LV-101", "getState")),
  await serial("Company.getState", () => invoke("Company", "company", "getState")),
  await serial("Plant.getState", () => invoke("Plant", "plant-a", "getState")),
  await serial("Plant.similar", () => invoke("Plant", "plant-a", "similar", similarArgs)),
  await serial("Plant.rulesFor", () => invoke("Plant", "plant-a", "rulesFor", ["plant-a/LV-101", "outlet-valve-A"])),
  await serial("Plant.setConnected", () => invoke("Plant", "plant-a", "setConnected", [true])),
  await serial("Component.mirror", () => invoke("Component", "plant-a.LV-101", "mirror", [{ positionPct: 50 }])),
  await serial("Component.setMargin", () => invoke("Component", "plant-a.LV-101", "setMargin", [10])),
];

const noVote = (proposalId: string) => ({
  proposalId,
  componentId: "plant-a/LV-101",
  agentId: "agent:plant-a/LV-101",
  vote: "no",
  reason: "probe refusal",
  predicted: { positionPct: 95 },
  marginPct: 10,
  evidenceEventIds: [],
  evidenceRuleIds: [],
  similarCount: 5,
});
const proposeMs: number[] = [];
const voteMs: number[] = [];
for (let i = 0; i < 8; i++) {
  let proposal: any;
  proposeMs.push(await timed(async () => (proposal = await invoke("Plant", "plant-a", "propose", [{ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 85, rationale: "probe" }]))));
  voteMs.push(await timed(() => invoke("Plant", "plant-a", "vote", [noVote(proposal.id)])));
}
results.push(row("Plant.propose", proposeMs), row("Plant.vote", voteMs));
console.log(JSON.stringify(results.slice(-2)));

results.push(await burst("Component.getState", () => invoke("Component", "plant-a.LV-101", "getState")));
results.push(await burst("Plant.rulesFor", () => invoke("Plant", "plant-a", "rulesFor", ["plant-a/LV-101", "outlet-valve-A"])));
results.push(await burst("Plant.similar", () => invoke("Plant", "plant-a", "similar", similarArgs)));
results.push(await burst("Plant.getState", () => invoke("Plant", "plant-a", "getState"), 5, 3));

// A vote that arrives behind the reads one proposal generates.
const queued: number[] = [];
for (let i = 0; i < 5; i++) {
  const proposal = await invoke("Plant", "plant-a", "propose", [{ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 85, rationale: "probe" }]);
  const reads = Array.from({ length: 10 }, () => invoke("Plant", "plant-a", "rulesFor", ["plant-a/LV-101", "outlet-valve-A"]));
  queued.push(await timed(() => invoke("Plant", "plant-a", "vote", [noVote(proposal.id)])));
  await Promise.all(reads);
}
results.push(row("Plant.vote behind 10 rulesFor", queued));
console.log(JSON.stringify(results.at(-1)));

if (mirror) clearInterval(mirror);
writeFileSync(join(resultDir, `rt-probe-${LABEL}.json`), JSON.stringify({ label: LABEL, at: new Date().toISOString(), mirrorMs: MIRROR_MS, sizes, results }, null, 1));
console.log("[probe] done");
process.exit(0);

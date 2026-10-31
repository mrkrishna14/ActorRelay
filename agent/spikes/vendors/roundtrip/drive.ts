// Full proposal round trip on the real stack: real glue, simulator, agents, Relay, Terse and OpenAI, all private to this
// spike. This script only plays the operator (POST /propose) and the dashboard (GET /state on both plants at 1 Hz).
import { AgentRelay } from "@agent-relay/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LABEL = process.env.RT_LABEL ?? "real";
const REPEATS = Number(process.env.RT_REPEATS ?? 10);
const TEN_ROUNDS = Number(process.env.RT_TEN ?? 3);
const RELAY_URL = process.env.RELAY_URL ?? "http://127.0.0.1:8797";
const TERSE = process.env.RT_TERSE ?? "http://127.0.0.1:7130";
const GLUE_PORT = process.env.RT_GLUE_PORT ?? "7230";
const BRIDGE_PORT = process.env.RT_BRIDGE_PORT ?? "7330";
const HEALTH_PORT = process.env.RT_HEALTH_PORT ?? "7231";
const POLL_MS = Number(process.env.RT_POLL_MS ?? 1000);
const GLUE = `http://127.0.0.1:${GLUE_PORT}`;
const runDir = join(import.meta.dir, "..", "..");
const resultDir = process.env.RT_RESULTS ?? join(runDir, "results");
const preload = join(import.meta.dir, "timing-preload.ts");
const timingAgents = join(runDir, `timing-agents-${LABEL}.jsonl`);
const timingGlue = join(runDir, `timing-glue-${LABEL}.jsonl`);
mkdirSync(resultDir, { recursive: true });
for (const file of [timingAgents, timingGlue, join(runDir, "system-token.json"), join(runDir, "agent-tokens.json")]) rmSync(file, { force: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const loadavg = () => readFileSync("/proc/loadavg", "utf8").split(" ")[0];
const children: ChildProcess[] = [];
const logs: Record<string, string[]> = { bridge: [], glue: [], agents: [] };

function start(name: string, args: string[], cwd: string, env: Record<string, string>) {
  const { OPENAI_API_KEY, ...rest } = process.env;
  const child = spawn("bun", args, { cwd, env: { ...rest, ...(name === "agents" ? { OPENAI_API_KEY } : {}), ...env } as never, stdio: ["ignore", "pipe", "pipe"] });
  const keep = (chunk: Buffer) => {
    logs[name].push(String(chunk));
    if (logs[name].length > 400) logs[name].shift();
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("exit", (code, signal) => console.log(`[rt] ${name} exited code=${code} signal=${signal}`));
  children.push(child);
}

function stop(code: number): never {
  for (const child of children) child.kill("SIGKILL");
  process.exit(code);
}

async function request(path: string, body?: unknown, timeoutMs = 30_000) {
  const response = await fetch(GLUE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

type Tracked = {
  id: string;
  plantId: string;
  label: string;
  from: number;
  to: number;
  t0: number;
  respondedAt: number;
  requiredVoters: string[];
  status?: string;
  blockedAt?: number;
  blockedBy?: string;
  seenAt?: number;
  votes?: { componentId: string; vote: string; prefix: string }[];
  allVotesSeenAt?: number;
  load: string;
};

const latest: Record<string, any> = {};
const statePolls: number[] = [];
const tracked = new Map<string, Tracked>();
let polling = true;

function observe(plantId: string, plant: any) {
  latest[plantId] = plant;
  const now = Date.now();
  for (const record of tracked.values()) {
    if (record.plantId !== plantId) continue;
    const current = plant.proposals.find((p: any) => p.id === record.id);
    if (!current) continue;
    if (current.status !== "voting" && !record.seenAt) {
      record.status = current.status;
      record.seenAt = now;
      const blocked = plant.audit.find((a: any) => a.kind === "block" && a.refId === record.id);
      if (blocked) {
        record.blockedAt = Date.parse(blocked.at);
        record.blockedBy = blocked.by;
      }
    }
    if (current.votes.length === record.requiredVoters.length && !record.allVotesSeenAt) {
      record.allVotesSeenAt = now;
      record.votes = current.votes.map((v: any) => ({ componentId: v.componentId, vote: v.vote, prefix: /^\[[^\]]*\]/.exec(v.reason)?.[0] ?? "" }));
    }
  }
}

async function dashboard(plantId: string) {
  while (polling) {
    const at = Date.now();
    await request(`/state?plantId=${plantId}`, undefined, 10_000).then(
      (state) => {
        statePolls.push(Date.now() - at);
        observe(plantId, state.plant);
      },
      () => undefined,
    );
    await sleep(Math.max(0, POLL_MS - (Date.now() - at)));
  }
}

async function propose(plantId: string, to: number, label: string) {
  const load = loadavg();
  const t0 = Date.now();
  const { proposal } = await request("/propose", { plantId, proposerComponentId: `${plantId}/P-100`, metric: "speedPct", to, rationale: "Operator asked for more throughput." });
  const record: Tracked = { id: proposal.id, plantId, label, from: proposal.from, to, t0, respondedAt: Date.now(), requiredVoters: proposal.requiredVoters, load };
  tracked.set(record.id, record);
  return record;
}

async function until(check: () => boolean, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

const settled = (r: Tracked) => until(() => Boolean(r.seenAt), 30_000);
const voted = (r: Tracked, ms = 12_000) => until(() => Boolean(r.allVotesSeenAt), ms);
const show = (r: Tracked) => `${r.label} ${r.from}->${r.to} ${r.status} block=${r.blockedAt ? r.blockedAt - r.t0 : "n/a"}ms seen=${r.seenAt ? r.seenAt - r.t0 : "n/a"}ms by ${r.blockedBy} load=${r.load} votes=${(r.votes ?? []).map((v) => `${v.componentId.split("/")[1]}:${v.vote}`).join(",")}`;

const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] : null;
};
const line = (name: string, values: number[]) => ({ name, n: values.length, p50: pct(values, 50), p95: pct(values, 95), max: values.length ? Math.max(...values) : null });
const readLines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        })
    : [];

function breakdown(records: Tracked[], voter: string, agents: any[], glue: any[]) {
  const encoded = encodeURIComponent(voter);
  const rows = records.flatMap((r) => {
    const proposeCall = glue.find((t) => t.kind === "actor" && t.method === "propose" && t.result === r.id);
    const publish = glue.filter((t) => t.kind === "relay" && t.type === "proposal" && t.ref === r.id);
    const post = agents.find((t) => t.kind === "relay" && t.type === "vote" && t.proposalId === r.id && t.componentId === voter);
    const plantVote = glue.find((t) => t.kind === "actor" && t.method === "vote" && t.proposalId === r.id && t.componentId === voter);
    if (!post || !plantVote || !r.blockedAt || !proposeCall) return [];
    const reads = agents.filter((t) => t.kind === "glue" && t.at >= proposeCall.at && t.at < post.at);
    const own = reads.filter((t) => t.path.includes(encoded) || t.query?.includes(`componentId=${encoded}`));
    const ownRules = own.find((t) => t.path === "/rules");
    const proposerRules = reads.filter((t) => t.path === "/rules" && t.query?.includes(encodeURIComponent(`${r.plantId}/P-100`))).sort((a, b) => Math.abs(a.at - (ownRules?.at ?? 0)) - Math.abs(b.at - (ownRules?.at ?? 0)))[0];
    const shared = ["/state", "/similar"].flatMap((path) => reads.filter((t) => t.path === path).slice(0, 1));
    const context = [...own, ...(proposerRules ? [proposerRules] : []), ...shared];
    const firstRead = Math.min(...context.map((t) => t.at));
    const contextDone = Math.max(...context.map((t) => t.at + t.ms));
    return [
      {
        id: r.id,
        total: r.blockedAt - r.t0,
        toPropose: proposeCall.at - r.t0,
        propose: proposeCall.ms,
        publish: publish.length ? Math.max(...publish.map((t) => t.at + t.ms)) - (proposeCall.at + proposeCall.ms) : null,
        deliver: firstRead - (proposeCall.at + proposeCall.ms),
        context: contextDone - firstRead,
        decide: post.at - contextDone,
        post: post.ms,
        fanOut: plantVote.at - (post.at + post.ms),
        plantVote: plantVote.ms,
        sweepWait: r.blockedAt - (plantVote.at + plantVote.ms),
        seenLag: r.seenAt ? r.seenAt - r.blockedAt : null,
        load: r.load,
      },
    ];
  });
  const keys = ["total", "toPropose", "propose", "publish", "deliver", "context", "decide", "post", "fanOut", "plantVote", "sweepWait", "seenLag"] as const;
  return { rows, stages: keys.map((k) => line(k, rows.map((row) => row[k]).filter((n): n is number => typeof n === "number"))) };
}

const admin = await AgentRelay.createWorkspace({ name: `rt-${LABEL}-${Date.now().toString(36)}`, baseUrl: RELAY_URL });
const workspaceKey = admin.workspaceKey as string;
const shared = { RELAY_URL, RELAY_BASE_URL: RELAY_URL, RELAY_WORKSPACE_KEY: workspaceKey, RT_GLUE_PORT: GLUE_PORT, RT_TERSE_PORT: new URL(TERSE).port };

start("bridge", ["run", "bridge/live_sim.ts"], runDir, { BRIDGE_PORT, GLUE_URL: GLUE });
start("glue", ["run", "--preload", preload, "server.ts"], join(runDir, "glue"), {
  ...shared,
  GLUE_PORT,
  TERSE_URL: TERSE,
  BRIDGE_URL: `http://127.0.0.1:${BRIDGE_PORT}`,
  RELAY_SYSTEM_TOKEN_FILE: join(runDir, "system-token.json"),
  GLUE_REPO_ROOT: runDir,
  TIMING_FILE: timingGlue,
});

try {
  const glueStart = Date.now();
  let health: any = null;
  while (Date.now() - glueStart < 90_000) {
    health = await request("/health", undefined, 3_000).catch(() => null);
    if (health?.services?.relay) break;
    await sleep(500);
  }
  if (!health?.services?.relay) throw new Error(`glue not ready: ${JSON.stringify(health)} ${logs.glue.join("").slice(-500)}`);
  console.log(`[rt] glue ready after ${Date.now() - glueStart} ms`);

  for (let attempt = 1; ; attempt++) {
    try {
      const reset = await request("/reset", {}, 60_000);
      console.log(`[rt] reset ok seed=${JSON.stringify(reset.seed)}`);
      break;
    } catch (error) {
      if (attempt >= 5) throw error;
      console.log(`[rt] reset retry ${attempt}: ${String(error).slice(0, 180)}`);
      await sleep(3_000);
    }
  }

  start("agents", ["run", "--preload", "./roundtrip/timing-preload.ts", "spawn.ts"], join(runDir, "agent"), {
    ...shared,
    GLUE_URL: GLUE,
    RELAY_TOKENS_FILE: join(runDir, "agent-tokens.json"),
    AGENT_HEALTH_PORT: HEALTH_PORT,
    TIMING_FILE: timingAgents,
  });
  const agentStart = Date.now();
  await until(() => logs.agents.join("").includes("ready:"), 120_000);
  if (!logs.agents.join("").includes("ready:")) throw new Error(`agents not ready: ${logs.agents.join("").slice(-600)}`);
  console.log(`[rt] agents ready after ${Date.now() - agentStart} ms`);

  void dashboard("plant-a");
  void dashboard("plant-b");
  await sleep(2_500);

  const first = await propose("plant-a", 85, "first");
  await settled(first);
  await voted(first, 20_000);
  console.log(`[rt] ${show(first)}`);

  await until(() => latest["plant-a"]?.proposals.some((p: any) => p.parentProposalId === first.id), 45_000);
  const counter = latest["plant-a"]?.proposals.find((p: any) => p.parentProposalId === first.id);
  if (!counter) throw new Error(`no counter arrived: ${logs.agents.join("").slice(-500)}`);
  const safe: Tracked = { id: counter.id, plantId: "plant-a", label: "counter", from: counter.from, to: counter.to, t0: Date.parse(counter.at), respondedAt: Date.parse(counter.at), requiredVoters: counter.requiredVoters, load: loadavg() };
  tracked.set(safe.id, safe);
  const ran = await until(() => latest["plant-a"]?.history.some((e: any) => e.proposalId === counter.id), 70_000);
  console.log(`[rt] ${show(safe)} executed=${ran}`);
  if (!ran) throw new Error(`counter did not execute: ${JSON.stringify(latest["plant-a"]?.proposals.find((p: any) => p.id === counter.id)).slice(0, 400)}`);
  await sleep(3_000);

  // A refused or timed-out /propose is a result, so it is counted and the run carries on.
  const failures: { label: string; at: number; ms: number; error: string }[] = [];
  const attempt = async (plantId: string, label: string) => {
    const at = Date.now();
    try {
      return await propose(plantId, 85, label);
    } catch (error) {
      failures.push({ label, at, ms: Date.now() - at, error: String(error).slice(0, 200) });
      console.log(`[rt] ${label} propose failed after ${Date.now() - at} ms: ${String(error).slice(0, 140)}`);
      return null;
    }
  };

  const repeats: Tracked[] = [];
  for (let i = 0; i < REPEATS; i++) {
    await sleep(500 + Math.random() * 2_500);
    const record = await attempt("plant-a", `repeat-${i}`);
    if (!record) continue;
    await settled(record);
    await voted(record);
    repeats.push(record);
    console.log(`[rt] ${show(record)}`);
  }

  const tens: Tracked[][] = [];
  for (let i = 0; i < TEN_ROUNDS; i++) {
    await sleep(500 + Math.random() * 2_500);
    const pair = (await Promise.all([attempt("plant-a", `ten-a-${i}`), attempt("plant-b", `ten-b-${i}`)])).filter((r): r is Tracked => r !== null);
    await Promise.all(pair.map(settled));
    await Promise.all(pair.map((r) => voted(r)));
    if (pair.length === 2) tens.push(pair);
    pair.forEach((r) => console.log(`[rt] ${show(r)}`));
  }

  polling = false;
  await sleep(600);
  const agents = readLines(timingAgents);
  const glue = readLines(timingGlue);
  const by = <T,>(rows: T[], key: (row: T) => string) => rows.reduce<Record<string, T[]>>((groups, row) => ((groups[key(row)] ??= []).push(row), groups), {});
  const actorSummary = Object.entries(by(glue.filter((t) => t.kind === "actor"), (t) => `${t.actor}.${t.method}`)).map(([name, rows]) => line(name, rows.map((t) => t.ms)));
  const readSummary = Object.entries(by(agents.filter((t) => t.kind === "glue"), (t) => t.path.split("/").slice(0, 2).join("/"))).map(([name, rows]) => line(name, rows.map((t) => t.ms)));
  const totals = repeats.filter((r) => r.blockedAt).map((r) => r.blockedAt! - r.t0);
  const report = {
    label: LABEL,
    at: new Date().toISOString(),
    stack: "real glue, simulator, agents, Relay, Terse, OpenAI; private ports; driver plays operator and dashboard only",
    env: { model: process.env.AGENT_OPENAI_MODEL ?? "agent default", effort: process.env.AGENT_OPENAI_EFFORT ?? "agent default", pollMs: POLL_MS, agentPatch: process.env.AGENT_PATCH ?? null, actorPatch: process.env.ACTOR_PATCH_LABEL ?? null, gluePatch: process.env.GLUE_PATCH ?? null },
    repeat: {
      runs: repeats.length,
      blocked: repeats.filter((r) => r.status === "blocked").length,
      under5s: totals.filter((n) => n < 5000).length,
      total: line("propose to blocked", totals),
      seen: line("propose to dashboard saw it", repeats.filter((r) => r.seenAt).map((r) => r.seenAt! - r.t0)),
      prefixes: repeats.map((r) => r.votes?.find((v) => v.componentId === "plant-a/LV-101")?.prefix ?? "none"),
      lv101: breakdown(repeats, "plant-a/LV-101", agents, glue),
    },
    ten: {
      rounds: tens.length,
      aBlock: line("plant-a propose to blocked", tens.flatMap(([a]) => (a.blockedAt ? [a.blockedAt - a.t0] : []))),
      bBlock: line("plant-b propose to blocked", tens.flatMap(([, b]) => (b.blockedAt ? [b.blockedAt - b.t0] : []))),
      tenVotes: line("first propose to tenth vote seen", tens.flatMap((pair) => (pair.every((r) => r.allVotesSeenAt) ? [Math.max(...pair.map((r) => r.allVotesSeenAt!)) - Math.min(...pair.map((r) => r.t0))] : []))),
      statuses: tens.flat().map((r) => `${r.plantId}:${r.status}`),
      lv101a: breakdown(tens.map(([a]) => a), "plant-a/LV-101", agents, glue).stages,
    },
    setup: { first: show(first), counter: show(safe) },
    failures,
    actorCommit: process.env.RT_ACTOR_COMMIT ?? null,
    actorCalls: actorSummary,
    agentReads: readSummary,
    openai: line("openai ok", agents.filter((t) => t.kind === "openai" && t.status === 200).map((t) => t.ms)),
    openaiStatuses: Object.entries(by(agents.filter((t) => t.kind === "openai"), (t) => String(t.status ?? "error"))).map(([k, v]) => `${k}:${v.length}`),
    relayVotePost: line("agent relay vote post", agents.filter((t) => t.kind === "relay" && t.type === "vote").map((t) => t.ms)),
    relayProposalPost: line("glue relay proposal post", glue.filter((t) => t.kind === "relay" && t.type === "proposal").map((t) => t.ms)),
    dashboardState: line("GET /state at 1 Hz", statePolls),
    glueErrors: logs.glue.join("").split("\n").filter((l) => /fail|refus|error|unavail/i.test(l)).slice(-8).map((l) => l.slice(0, 200)),
    agentErrors: logs.agents.join("").split("\n").filter((l) => /fail|refus|error|rejected/i.test(l)).slice(-8).map((l) => l.slice(0, 200)),
    proposals: [...tracked.values()],
  };
  writeFileSync(join(resultDir, `rt-${LABEL}.json`), JSON.stringify(report, null, 1));
  const { proposals: _proposals, ...printed } = report;
  console.log(`[rt] SUMMARY ${JSON.stringify({ ...printed, repeat: { ...report.repeat, lv101: report.repeat.lv101.stages } })}`);
  stop(0);
} catch (error) {
  console.error("[rt] FAILED", error);
  console.error("[rt] glue log", logs.glue.join("").slice(-1200));
  console.error("[rt] agents log", logs.agents.join("").slice(-1200));
  stop(1);
}

// Full proposal round trip: real agent/ code (spawn.ts), real Relay, real Terse actors, real OpenAI.
// FAKE: this file stands in for glue and the simulator. It uses shared/history.json, or the labelled stand-in if absent.
import { AgentRelay } from "@agent-relay/sdk";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANNELS, encodeEnvelope, SYSTEM_NAME } from "../wire";

const TERSE = process.env.RT_TERSE ?? "http://127.0.0.1:7130";
const RELAY_URL = process.env.RELAY_URL ?? "http://127.0.0.1:8797";
const GLUE_PORT = Number(process.env.RT_GLUE_PORT ?? 7230);
const HEALTH_PORT = Number(process.env.RT_HEALTH_PORT ?? 7231);
const LABEL = process.env.RT_LABEL ?? "baseline";
const REPEATS = Number(process.env.RT_REPEATS ?? 12);
const TEN_ROUNDS = Number(process.env.RT_TEN ?? 6);
const MIRROR_MS = Number(process.env.RT_MIRROR_MS ?? 1000);
const POLL_MS = Number(process.env.RT_POLL_MS ?? 1000);
const runDir = join(import.meta.dir, "..", "..");
const resultDir = process.env.RT_RESULTS ?? join(runDir, "results");
const timingFile = join(runDir, `timing-${LABEL}.jsonl`);
mkdirSync(resultDir, { recursive: true });
rmSync(timingFile, { force: true });

const seed = JSON.parse(readFileSync(join(runDir, "shared", "plants.json"), "utf8"));
const realHistory = join(runDir, "shared", "history.json");
const historyFile = process.env.RT_HISTORY ?? (existsSync(realHistory) ? realHistory : join(runDir, "shared", "history.standin.json"));
const history = JSON.parse(readFileSync(historyFile, "utf8")) as { plantId: string }[];
const components = seed.plants.flatMap((p: any) => p.components) as any[];
const actorId = (id: string) => id.replace("/", ".");
const plantOfId = (id: string) => id.split("/")[0];
const plantOfProposal = (id: string) => /^(plant-[a-z0-9]+)-p\d+-/.exec(id)?.[1] ?? "plant-a";

type ActorCall = { actor: string; method: string; at: number; ms: number; ok: boolean };
const actorCalls: ActorCall[] = [];
const glueCalls: { route: string; component: string | null; at: number; ms: number; status: number }[] = [];

async function invoke(actor: string, id: string, method: string, args: unknown[] = [], timeoutMs = 20_000): Promise<any> {
  const requestId = crypto.randomUUID();
  const at = Date.now();
  let ok = false;
  try {
    const response = await fetch(`${TERSE}/v1/projects/local/actors/${actor}/${encodeURIComponent(id)}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-request-id": requestId },
      body: JSON.stringify({ requestId, method, args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${actor}.${method} http ${response.status}: ${text.slice(0, 240)}`);
    const reply = JSON.parse(text);
    const outcome = reply.outcome ?? reply;
    if (outcome.type !== "completed") throw new Error(`${actor}.${method} ${outcome.type}: ${outcome.code ?? outcome.reason} ${outcome.message ?? ""}`);
    ok = true;
    return outcome.result;
  } finally {
    actorCalls.push({ actor, method, at, ms: Date.now() - at, ok });
  }
}

async function reset() {
  await invoke("Company", "company", "loadSeed", [{ ...seed.company, rules: [], crossPlantProposals: [], audit: [] }]);
  for (const plant of seed.plants) await invoke("Plant", plant.id, "loadSeed", [plant, history.filter((e) => e.plantId === plant.id)]);
  await Promise.all(components.map((c) => invoke("Component", actorId(c.id), "loadSeed", [{ ...c, lastTick: new Date().toISOString() }])));
}

type VoteRecord = { vote: string; prefix: string; seenAt: number; plantDoneAt?: number; plantError?: string };
type Tracked = {
  id: string;
  plantId: string;
  to: number;
  from: number;
  label: string;
  t0: number;
  proposedAt: number;
  publishedAt: number;
  requiredVoters: string[];
  votes: Record<string, VoteRecord>;
  status?: string;
  blockedAt?: number;
  statusSeenAt?: number;
  firstNoAt?: number;
  firstNoFrom?: string;
  allVotesAt?: number;
  load?: string;
};

const tracked = new Map<string, Tracked>();
const seenVotes = new Set<string>();
const counters: { parentProposalId: string; proposal: any; at: number }[] = [];
const executed: { proposalId: string; event: any; at: number }[] = [];
let system: Awaited<ReturnType<AgentRelay["workspace"]["register"]>>;
const channelsOf = (proposal: { plantId: string; crossPlant: boolean }) => (proposal.crossPlant ? [proposal.plantId, "company"] : [proposal.plantId]);

async function publish(type: "proposal" | "executed", message: any, channels: string[]) {
  await Promise.all(channels.map((channel) => system.sendMessage({ to: `#${channel}`, text: encodeEnvelope({ type, ...message }) })));
}

async function propose(plantId: string, to: number, label: string, parentProposalId?: string, rationale = "Operator asked for more throughput.") {
  const t0 = Date.now();
  const proposal = await invoke("Plant", plantId, "propose", [{ proposerComponentId: `${plantId}/P-100`, metric: "speedPct", to, rationale, ...(parentProposalId ? { parentProposalId } : {}) }]);
  const proposedAt = Date.now();
  const record: Tracked = { id: proposal.id, plantId, to, from: proposal.from, label, t0, proposedAt, publishedAt: 0, requiredVoters: proposal.requiredVoters, votes: {} };
  tracked.set(proposal.id, record);
  await publish("proposal", { proposal }, channelsOf(proposal));
  record.publishedAt = Date.now();
  return record;
}

function onVote(vote: any) {
  const key = `${vote.proposalId}|${vote.componentId}`;
  if (seenVotes.has(key)) return;
  seenVotes.add(key);
  const seenAt = Date.now();
  const record = tracked.get(vote.proposalId);
  const prefix = /^\[[^\]]*\]/.exec(vote.reason)?.[0] ?? "";
  const row: VoteRecord = { vote: vote.vote, prefix, seenAt };
  if (record) {
    record.votes[vote.componentId] = row;
    if (vote.vote === "no" && !record.firstNoAt) {
      record.firstNoAt = seenAt;
      record.firstNoFrom = vote.componentId;
    }
    if (Object.keys(record.votes).length === record.requiredVoters.length) record.allVotesAt = seenAt;
  }
  invoke("Plant", plantOfProposal(vote.proposalId), "vote", [vote]).then(
    () => (row.plantDoneAt = Date.now()),
    (error) => {
      row.plantDoneAt = Date.now();
      row.plantError = String(error).slice(0, 200);
    },
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads through the Plant mailbox at the rate a dashboard might. The block time itself comes from the audit entry. */
async function settle(record: Tracked, timeoutMs = 35_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(POLL_MS);
    const state = await invoke("Plant", record.plantId, "getState").catch(() => null);
    const current = state?.proposals.find((p: any) => p.id === record.id);
    if (!current || current.status === "voting") continue;
    record.status = current.status;
    record.statusSeenAt = Date.now();
    const blocked = state.audit.find((a: any) => a.kind === "block" && a.refId === record.id);
    if (blocked) record.blockedAt = Date.parse(blocked.at);
    return record;
  }
  record.status = "timeout";
  return record;
}

async function allVotes(record: Tracked, timeoutMs = 25_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !record.allVotesAt) await sleep(100);
}

const pendingObserve = new Map<string, () => void>();

async function onExecuteCallback(proposalId: string) {
  const plantId = plantOfProposal(proposalId);
  await invoke("Plant", plantId, "execute", [proposalId]);
  const claim = await invoke("Plant", plantId, "claimDispatch", [proposalId]);
  if (!claim?.dispatch) return;
  await invoke("Component", actorId(claim.componentId), "setMetric", [claim.metric, claim.value, proposalId, claim.token]);
  const to = claim.value as number;
  const id = (tag: string) => `${plantId}/${tag}`;
  const event = await invoke("Plant", plantId, "recordEvent", [
    {
      proposalId,
      effects: [
        { componentId: id("LV-101"), metric: "positionPct", before: 50, after: to + 2, ticksToSettle: 4 },
        { componentId: id("TK-101"), metric: "levelPct", before: 50, after: 50.2, ticksToSettle: 3 },
        { componentId: id("TK-101"), metric: "tempC", before: 75, after: 74.6, ticksToSettle: 4 },
        { componentId: id("E-101"), metric: "dutyKw", before: 898, after: 1160, ticksToSettle: 3 },
        { componentId: id("TV-101"), metric: "positionPct", before: 50.5, after: 56, ticksToSettle: 3 },
        { componentId: id("TV-101"), metric: "steamKgH", before: 1533, after: 1980, ticksToSettle: 3 },
        { componentId: id("TV-101"), metric: "headerBarg", before: 6, after: 5.78, ticksToSettle: 3 },
      ],
    },
  ]);
  await publish("executed", { proposalId, event }, [plantId, "company"]);
  executed.push({ proposalId, event, at: Date.now() });
  pendingObserve.get(proposalId)?.();
}

const handlers: Record<string, (url: URL, body: any) => Promise<unknown>> = {
  "GET /component": async (url) => invoke("Component", actorId(decodeURIComponent(url.pathname.slice("/component/".length))), "getState"),
  "GET /similar": async (url) => {
    const q = url.searchParams;
    const snapshot = q.get("upstreamSnapshot");
    const componentId = q.get("componentId") ?? "";
    return invoke("Plant", plantOfId(componentId), "similar", [componentId, q.get("metric"), Number(q.get("to")), snapshot ? JSON.parse(snapshot) : {}, Number(q.get("k") ?? 5)]);
  },
  "GET /rules": async (url) => {
    const componentId = url.searchParams.get("componentId") ?? "";
    const model = url.searchParams.get("model") ?? undefined;
    return invoke("Plant", plantOfId(componentId), "rulesFor", model === "*" ? [] : [componentId, model]);
  },
  "GET /state": async (url) => ({ plant: await invoke("Plant", url.searchParams.get("plantId") ?? "plant-a", "getState") }),
  "POST /vote": async (_url, body) => {
    onVote(body.vote);
    return { ok: true };
  },
  "POST /counter": async (_url, body) => {
    counters.push({ ...body, at: Date.now() });
    return { ok: true };
  },
  "POST /calibration": async (_url, body) => invoke("Component", actorId(body.componentId), "addCalibration", [body.entry]).then(() => ({ ok: true })),
  "POST /rule": async (_url, body) => {
    const home = body.rule.condition?.componentId ? plantOfId(body.rule.condition.componentId) : "plant-a";
    return invoke("Plant", home, "promoteRule", [body.rule]).then(() => ({ ok: true }));
  },
  "POST /tick": async () => ({ ok: true }),
  "POST /execute-callback": async (_url, body) => {
    onExecuteCallback(body.proposalId).catch((error) => console.error("execute failed", error));
    return { ok: true };
  },
};

Bun.serve({
  port: GLUE_PORT,
  hostname: "127.0.0.1",
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    const name = `${request.method} /${url.pathname.split("/")[1]}`;
    const handler = handlers[name];
    if (!handler) return Response.json({ error: "unknown route" }, { status: 404 });
    const at = Date.now();
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : undefined;
    const component = name === "GET /component" ? decodeURIComponent(url.pathname.slice("/component/".length)) : url.searchParams.get("componentId");
    let status = 200;
    try {
      return Response.json((await handler(url, body)) ?? { ok: true });
    } catch (error) {
      status = 500;
      return Response.json({ error: String(error).slice(0, 300) }, { status });
    } finally {
      if (name !== "POST /tick") glueCalls.push({ route: name, component, at, ms: Date.now() - at, status });
    }
  },
});

const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] : null;
};
const line = (name: string, values: number[]) => ({ name, n: values.length, p50: pct(values, 50), p95: pct(values, 95), max: values.length ? Math.max(...values) : null });

function breakdown(records: Tracked[], blocker: string, timing: any[]) {
  const posts = timing.filter((t) => t.kind === "relay" && t.type === "vote");
  const rows = records.flatMap((r) => {
    const v = r.votes[blocker];
    const post = posts.find((p) => p.proposalId === r.id && p.componentId === blocker);
    if (!v || !post || !r.blockedAt) return [];
    // Only this voter's reads: its own /component and /rules, the proposer /rules beside it, and the shared reads once.
    const inWindow = glueCalls.filter((g) => g.at >= r.proposedAt && g.at < post.at);
    const mine = inWindow.filter((g) => g.component === blocker);
    const ownRules = mine.find((g) => g.route === "GET /rules");
    const proposerRules = inWindow
      .filter((g) => g.route === "GET /rules" && g.component === `${r.plantId}/P-100`)
      .sort((a, b) => Math.abs(a.at - (ownRules?.at ?? 0)) - Math.abs(b.at - (ownRules?.at ?? 0)))[0];
    const shared = ["GET /state", "GET /similar"].flatMap((route) => inWindow.filter((g) => g.route === route).slice(0, 1));
    const own = [...mine, ...(proposerRules ? [proposerRules] : []), ...shared];
    const firstGlue = own.length ? Math.min(...own.map((g) => g.at)) : null;
    const contextDone = own.length ? Math.max(...own.map((g) => g.at + g.ms)) : null;
    return [
      {
        id: r.id,
        total: r.blockedAt - r.t0,
        propose: r.proposedAt - r.t0,
        publish: r.publishedAt - r.proposedAt,
        deliver: firstGlue === null ? null : firstGlue - r.proposedAt,
        context: firstGlue === null || contextDone === null ? null : contextDone - firstGlue,
        decide: contextDone === null ? null : post.at - contextDone,
        post: post.ms,
        fanOut: v.seenAt - (post.at + post.ms),
        plantVote: v.plantDoneAt ? v.plantDoneAt - v.seenAt : null,
        sweepWait: v.plantDoneAt ? r.blockedAt - v.plantDoneAt : null,
        prefix: v.prefix,
        load: r.load,
      },
    ];
  });
  const keys = ["total", "propose", "publish", "deliver", "context", "decide", "post", "fanOut", "plantVote", "sweepWait"] as const;
  return { rows, stages: keys.map((k) => line(k, rows.map((row) => row[k]).filter((n): n is number => typeof n === "number"))) };
}

// Relay system participant.
const admin = await AgentRelay.createWorkspace({ name: `rt-${LABEL}-${Date.now().toString(36)}`, baseUrl: RELAY_URL });
const workspaceKey = admin.workspaceKey as string;
const relay = new AgentRelay({ workspaceKey, baseUrl: RELAY_URL });
system = await relay.workspace.register({ name: SYSTEM_NAME, type: "agent" });
for (const channel of CHANNELS) {
  await system.channels.create({ name: channel, topic: `ActorRelay ${channel}` }).catch(() => undefined);
  await system.channels.join(channel);
}
relay.addListener("message.created", ({ message, envelope }: any) => {
  if (!envelope.from?.name?.startsWith("agent:")) return;
  try {
    const body = JSON.parse(message.text);
    if (body.type === "vote") onVote(body.payload.vote);
    if (body.type === "counter") counters.push({ ...body.payload, at: Date.now() });
  } catch {
    // Not one of ours.
  }
});

console.log(`[rt] seeding real actors, history ${historyFile}: ${history.length} events`);
for (let attempt = 1; ; attempt++) {
  try {
    await reset();
    break;
  } catch (error) {
    if (attempt >= 4) throw error;
    console.log(`[rt] reset retry ${attempt}: ${String(error).slice(0, 160)}`);
    await sleep(3_000);
  }
}

const mirror = setInterval(() => {
  for (const c of components) invoke("Component", actorId(c.id), "mirror", [c.metrics]).catch(() => undefined);
}, MIRROR_MS);

const tokens = join(runDir, `tokens-${LABEL}.json`);
rmSync(tokens, { force: true });
const agents = spawn("bun", ["run", "--preload", "./roundtrip/timing-preload.ts", "spawn.ts"], {
  cwd: join(runDir, "agent"),
  env: {
    ...process.env,
    GLUE_URL: `http://127.0.0.1:${GLUE_PORT}`,
    RELAY_URL,
    RELAY_WORKSPACE_KEY: workspaceKey,
    RELAY_TOKENS_FILE: tokens,
    AGENT_HEALTH_PORT: String(HEALTH_PORT),
    TIMING_FILE: timingFile,
    RT_GLUE_PORT: String(GLUE_PORT),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let ready = false;
const agentLog: string[] = [];
const onAgentOutput = (chunk: Buffer) => {
  const text = String(chunk);
  agentLog.push(text);
  if (text.includes("ready:")) ready = true;
};
agents.stdout.on("data", onAgentOutput);
agents.stderr.on("data", onAgentOutput);

const started = Date.now();
while (!ready) {
  if (Date.now() - started > 240_000) throw new Error(`agents not ready: ${agentLog.join("").slice(-600)}`);
  await sleep(100);
}
console.log(`[rt] agents ready after ${Date.now() - started} ms`);

const loadavg = () => readFileSync("/proc/loadavg", "utf8").split(" ")[0];
const pass = (r: Tracked) => `${r.label} ${r.from}->${r.to} ${r.status} total=${r.blockedAt ? r.blockedAt - r.t0 : "n/a"}ms firstNo=${r.firstNoAt ? r.firstNoAt - r.t0 : "n/a"}ms by ${r.firstNoFrom} votes=${Object.keys(r.votes).length}/${r.requiredVoters.length} all=${r.allVotesAt ? r.allVotesAt - r.t0 : "n/a"}ms`;

// Setup: a first block, the counter it produces, its execution, so a real live event exists to repeat against.
const first = await propose("plant-a", 85, "first");
first.load = loadavg();
await settle(first);
await allVotes(first);
console.log(`[rt] ${pass(first)}`);

const counterDeadline = Date.now() + 40_000;
while (!counters.length && Date.now() < counterDeadline) await sleep(100);
console.log(`[rt] counter ${counters.length ? `to ${counters[0].proposal.to} after ${counters[0].at - (first.statusSeenAt ?? first.t0)} ms` : "never arrived"}`);
const counterTo = counters.length ? counters[0].proposal.to : 65;
const safe = await propose("plant-a", counterTo, "counter", first.id, counters[0]?.proposal.rationale ?? "Counter from harness.");
safe.load = loadavg();
await new Promise<void>((resolve) => {
  pendingObserve.set(safe.id, resolve);
  setTimeout(resolve, 45_000);
});
await settle(safe, 5_000);
await allVotes(safe, 1_000);
console.log(`[rt] ${pass(safe)} executed=${executed.length}`);
await sleep(3_000);

const repeats: Tracked[] = [];
for (let i = 0; i < REPEATS; i++) {
  await sleep(500 + Math.random() * 2_500);
  const record = await propose("plant-a", 85, `repeat-${i}`);
  record.load = loadavg();
  await settle(record);
  await allVotes(record, 12_000);
  repeats.push(record);
  console.log(`[rt] ${pass(record)} load=${record.load}`);
}

const tens: Tracked[][] = [];
for (let i = 0; i < TEN_ROUNDS; i++) {
  await sleep(500 + Math.random() * 2_500);
  const pair = await Promise.all([propose("plant-a", 85, `ten-a-${i}`), propose("plant-b", 85, `ten-b-${i}`)]);
  pair.forEach((r) => (r.load = loadavg()));
  await Promise.all(pair.map((r) => settle(r)));
  await Promise.all(pair.map((r) => allVotes(r, 15_000)));
  tens.push(pair);
  pair.forEach((r) => console.log(`[rt] ${pass(r)}`));
}

clearInterval(mirror);
await sleep(1_000);
agents.kill();

const timing = existsSync(timingFile)
  ? readFileSync(timingFile, "utf8")
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
const openai = timing.filter((t) => t.kind === "openai");
const relayVotes = timing.filter((t) => t.kind === "relay" && t.type === "vote");
const by = <T,>(rows: T[], key: (row: T) => string) => rows.reduce<Record<string, T[]>>((groups, row) => ((groups[key(row)] ??= []).push(row), groups), {});
const glueSummary = Object.entries(by(glueCalls, (g) => g.route)).map(([route, rows]) => line(route, rows.map((g) => g.ms)));
const actorSummary = Object.entries(by(actorCalls, (a) => `${a.actor}.${a.method}`)).map(([name, rows]) => line(name, rows.map((a) => a.ms)));
const repeatTotals = repeats.filter((r) => r.blockedAt).map((r) => r.blockedAt! - r.t0);
const report = {
  label: LABEL,
  at: new Date().toISOString(),
  history: historyFile,
  historyEvents: history.length,
  env: { model: process.env.AGENT_OPENAI_MODEL ?? "default gpt-6-luna", effort: process.env.AGENT_OPENAI_EFFORT ?? "default none", mirrorMs: MIRROR_MS },
  repeat: {
    runs: repeats.length,
    blocked: repeats.filter((r) => r.status === "blocked").length,
    under5s: repeatTotals.filter((n) => n < 5000).length,
    total: line("propose to blocked", repeatTotals),
    firstNo: line("propose to first no at system", repeats.filter((r) => r.firstNoAt).map((r) => r.firstNoAt! - r.t0)),
    allVotes: line("propose to all votes", repeats.filter((r) => r.allVotesAt).map((r) => r.allVotesAt! - r.t0)),
    lv101: breakdown(repeats, "plant-a/LV-101", timing),
  },
  ten: {
    rounds: tens.length,
    aBlock: line("plant-a propose to blocked", tens.flatMap(([a]) => (a.blockedAt ? [a.blockedAt - a.t0] : []))),
    bBlock: line("plant-b propose to blocked", tens.flatMap(([, b]) => (b.blockedAt ? [b.blockedAt - b.t0] : []))),
    tenVotes: line("first propose to tenth vote", tens.flatMap((pair) => (pair.every((r) => r.allVotesAt) ? [Math.max(...pair.map((r) => r.allVotesAt!)) - Math.min(...pair.map((r) => r.t0))] : []))),
    statuses: tens.flat().map((r) => r.status),
    lv101a: breakdown(tens.map(([a]) => a), "plant-a/LV-101", timing).stages,
  },
  setup: { first: pass(first), counter: pass(safe), executed: executed.length },
  glueRoutes: glueSummary,
  actorCalls: actorSummary,
  openai: line("openai call", openai.filter((t) => t.status === 200).map((t) => t.ms)),
  openaiStatuses: Object.entries(by(openai, (t) => String(t.status ?? t.error))).map(([k, v]) => `${k}:${v.length}`),
  relayVotePost: line("relay vote post", relayVotes.map((t) => t.ms)),
  voteProblems: [...tracked.values()].flatMap((r) => Object.entries(r.votes).flatMap(([id, v]) => (v.plantError ? [`${id}: ${v.plantError}`] : []))).slice(0, 6),
  proposals: [...tracked.values()].map((r) => ({ ...r })),
};
writeFileSync(join(resultDir, `rt-${LABEL}.json`), JSON.stringify(report, null, 1));
console.log(`[rt] SUMMARY ${JSON.stringify({ repeat: { ...report.repeat, lv101: report.repeat.lv101.stages }, ten: report.ten, setup: report.setup, openai: report.openai, openaiStatuses: report.openaiStatuses, relayVotePost: report.relayVotePost, voteProblems: report.voteProblems })}`);
console.log(`[rt] GLUE ${JSON.stringify(glueSummary)}`);
console.log(`[rt] ACTOR ${JSON.stringify(actorSummary)}`);
process.exit(0);

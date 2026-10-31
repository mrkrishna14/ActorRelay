// Proof over a real Relay server: real agents, real model calls, and glue's real RelayBridge code. Only glue's HTTP
// surface and the actors behind it are fake. Run inside WSL after run-wsl.sh has installed once:
//   bun run agent/tests/live-relay-proof.ts
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Vote } from "../../shared/types";
import { FakeGlue, makeProposal, safeExecution } from "./fake-glue";

const GLUE_PORT = Number(process.env.PROOF_GLUE_PORT ?? 7213);
const HEALTH_PORT = Number(process.env.PROOF_HEALTH_PORT ?? 7214);
const RELAY_URL = process.env.RELAY_URL ?? "http://127.0.0.1:8787";
const repo = join(import.meta.dir, "..", "..");
const runDir = process.env.AGENT_RUN_DIR ?? join(homedir(), ".actorrelay", "agent-run");
const glue = new FakeGlue();
const timings: Record<string, number> = {};

// glue/ has no node_modules on the Linux filesystem, so its real bridge runs beside the agents' copy of the SDK.
const glueDir = join(runDir, "glue");
const glueSource = process.env.PROOF_GLUE_SRC ?? join(repo, "glue");
mkdirSync(glueDir, { recursive: true });
for (const file of ["relay.ts", "actors.ts", "journal.ts", "schemas.ts"]) copyFileSync(join(glueSource, file), join(glueDir, file));
if (!existsSync(join(glueDir, "node_modules"))) symlinkSync(join(runDir, "agent", "node_modules"), join(glueDir, "node_modules"));
const { RelayBridge } = await import(join(glueDir, "relay.ts"));
const { Journal } = await import(join(glueDir, "journal.ts"));
const { AgentRelay } = await import(join(runDir, "agent", "node_modules", "@agent-relay", "sdk", "dist", "index.js"));

Bun.serve({
  port: GLUE_PORT,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith("/component/")) return Response.json(await glue.component(decodeURIComponent(path.slice(11))));
    if (path === "/similar") {
      const q = url.searchParams;
      const snapshot = q.get("upstreamSnapshot");
      return Response.json(await glue.similar({ componentId: q.get("componentId") ?? "", metric: q.get("metric") ?? "", to: Number(q.get("to")), k: Number(q.get("k")), upstreamSnapshot: snapshot ? JSON.parse(snapshot) : undefined }));
    }
    if (path === "/rules") return Response.json(await glue.rules());
    if (path === "/state") return Response.json({ plant: await glue.plant(url.searchParams.get("plantId") as "plant-a") });
    const body = (await request.json()) as Record<string, never>;
    if (path === "/calibration") await glue.calibration(body.componentId, body.entry);
    else if (path === "/rule") await glue.rule(body.rule);
    else return Response.json({ error: "unknown" }, { status: 404 });
    return Response.json({ ok: true });
  },
});

// Own workspace, so a proof never touches a demo.
const workspace = await AgentRelay.createWorkspace({ name: `proof-${Date.now().toString(36)}`, baseUrl: RELAY_URL });
process.env.RELAY_WORKSPACE_KEY = workspace.workspaceKey;
process.env.RELAY_BASE_URL = RELAY_URL;
delete process.env.RELAY_AGENT_TOKEN;
const dispatched: string[] = [];
let lastPublish = Date.now();
const since = () => `+${Date.now() - lastPublish}ms`;
const bridge = new RelayBridge(async (path: string, body: never, sender: string) => {
  dispatched.push(`${path} from ${sender}`);
  console.log(`[glue ${since()}] ${path} from ${sender}`);
  const b = body as Record<string, never>;
  if (path === "/vote") await glue.vote(b.vote);
  else if (path === "/counter") await glue.counter(b.parentProposalId, b.proposal);
  return { ok: true };
}, new Journal(":memory:"));
await bridge.start();

const agentScript = join(import.meta.dir, "..", "run-wsl.sh");
const tokens = join(mkdtempSync(join(tmpdir(), "proof-")), "tokens.json");
const child = spawn("bash", [agentScript], {
  env: { ...process.env, GLUE_URL: `http://127.0.0.1:${GLUE_PORT}`, AGENT_HEALTH_PORT: String(HEALTH_PORT), RELAY_TOKENS_FILE: tokens },
  stdio: ["ignore", "pipe", "inherit"],
});
let ready = false;
child.stdout.on("data", (d) => {
  const text = String(d);
  process.stdout.write(`[agents ${since()}] ${text}`);
  if (text.includes("ready:")) ready = true;
});

async function until(check: () => boolean, ms: number, label: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out: ${label}`);
}

async function publish(type: string, payload: unknown, channels: string[]) {
  lastPublish = Date.now();
  await bridge.publish(type, payload, channels);
  console.log(`[publish returned ${since()}]`);
}

const votesOn = (id: string): Vote[] => glue.votes.filter((v) => v.proposalId === id);
const show = (v: Vote) => `${v.componentId} ${v.vote} ${JSON.stringify(v.predicted)} similar=${v.similarCount} evidence=${v.evidenceEventIds.length} :: ${v.reason.slice(0, 160)}`;

async function run(proposal: ReturnType<typeof makeProposal>, label: string) {
  glue.addProposal(proposal);
  const started = Date.now();
  await publish("proposal", { proposal }, [proposal.plantId, "company"]);
  await until(() => votesOn(proposal.id).some((v) => v.vote === "no") || votesOn(proposal.id).length === proposal.requiredVoters.length, 25_000, `${label} first no or all votes`);
  timings[`${label} first decisive vote ms`] = Date.now() - started;
  await until(() => votesOn(proposal.id).length === proposal.requiredVoters.length, 25_000, `${label} all votes`);
  timings[`${label} all votes ms`] = Date.now() - started;
  console.log(`\n== ${label}`);
  votesOn(proposal.id).forEach((v) => console.log(show(v)));
  proposal.votes = votesOn(proposal.id);
}

try {
  await until(() => ready, 240_000, "agents ready");
  const health = await (await fetch(`http://127.0.0.1:${HEALTH_PORT}/health`)).json();
  console.log("agent health", JSON.stringify(health), "relay bridge", JSON.stringify(bridge.status));

  const bad = makeProposal({ to: 85 });
  await run(bad, "50->85");
  if (!bad.votes.some((v) => v.componentId === "plant-a/LV-101" && v.vote === "no")) throw new Error("LV-101 did not block 85");
  const blockedAt = Date.now();
  bad.status = "blocked";
  await until(() => glue.counters.length === 1, 25_000, "counter over relay");
  timings["counter after block ms"] = Date.now() - blockedAt;
  const counter = glue.counters[0];
  console.log("\ncounter", JSON.stringify(counter));

  const safe = makeProposal({ to: counter.proposal.to, parentProposalId: bad.id });
  await run(safe, `counter 50->${counter.proposal.to}`);
  const noes = safe.votes.filter((v) => v.vote === "no");
  if (noes.length) throw new Error(`counter refused by ${noes.map((v) => v.componentId)}`);

  safe.status = "executed";
  const event = safeExecution(safe.id);
  glue.history.push(event);
  await publish("executed", { proposalId: safe.id, event }, ["plant-a", "company"]);
  await until(() => new Set(glue.calibrations.map((c) => c.componentId)).size === safe.requiredVoters.length, 15_000, "calibration for all voters");
  console.log("\ncalibrated", glue.calibrations.map((c) => `${c.componentId}.${c.entry.metric} ${c.entry.predicted}/${c.entry.observed}`).join("; "));

  const repeat = makeProposal({ from: 65, to: 85 });
  await run(repeat, "repeat 65->85");
  const lv = repeat.votes.find((v) => v.componentId === "plant-a/LV-101");
  if (lv?.vote !== "no" || lv.evidenceEventIds[0] !== event.id) throw new Error(`repeat evidence wrong: ${lv?.evidenceEventIds}`);
  repeat.status = "blocked";

  const plantB = makeProposal({ plantId: "plant-b", to: 85 });
  await run(plantB, "plant-b 50->85");
  const lvB = plantB.votes.find((v) => v.componentId === "plant-b/LV-101");
  console.log("\nrules", JSON.stringify(glue.rulesPosted.map((r) => r.text)));
  if (lvB?.vote !== "no") throw new Error("plant-b LV-101 did not block");
  console.log("\nglue bridge dispatched", new Set(dispatched.map((d) => d.split(" ")[0])).size, "route kinds,", dispatched.length, "messages; senders", [...new Set(dispatched.map((d) => d.split(" from ")[1]))].length);
  console.log("TIMINGS", JSON.stringify(timings, null, 1));
  console.log("PROOF PASS");
} catch (error) {
  console.error("PROOF FAIL", error);
  process.exitCode = 1;
} finally {
  child.kill();
  process.exit();
}

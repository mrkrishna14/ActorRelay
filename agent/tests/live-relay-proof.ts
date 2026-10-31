// Proof over a real Relay server: real agents, real model calls, fake glue over HTTP. Run inside WSL with
//   bun run agent/tests/live-relay-proof.ts
// It is a script, not a test, because it needs Relay on RELAY_URL. Actors and the simulator are fake here.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Vote } from "../../shared/types";
import { FakeGlue, makeProposal, safeExecution } from "./fake-glue";

const GLUE_PORT = Number(process.env.PROOF_GLUE_PORT ?? 7213);
const SYSTEM_PORT = Number(process.env.PROOF_SYSTEM_PORT ?? 7214);
const glue = new FakeGlue();
const timings: Record<string, number> = {};

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
    if (path === "/vote") await glue.vote(body.vote);
    else if (path === "/counter") await glue.counter(body.parentProposalId, body.proposal);
    else if (path === "/calibration") await glue.calibration(body.componentId, body.entry);
    else if (path === "/rule") await glue.rule(body.rule);
    else return Response.json({ error: "unknown" }, { status: 404 });
    return Response.json({ ok: true });
  },
});

const agentScript = join(import.meta.dir, "..", "run-wsl.sh");
const tokens = join(mkdtempSync(join(tmpdir(), "proof-")), "tokens.json");
const child = spawn("bash", [agentScript], {
  env: { ...process.env, GLUE_URL: `http://127.0.0.1:${GLUE_PORT}`, SYSTEM_PORT: String(SYSTEM_PORT), RELAY_TOKENS_FILE: tokens },
  stdio: ["ignore", "pipe", "inherit"],
});
let ready = false;
child.stdout.on("data", (d) => {
  const text = String(d);
  process.stdout.write(`[agents] ${text}`);
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
  const response = await fetch(`http://127.0.0.1:${SYSTEM_PORT}/publish`, { method: "POST", body: JSON.stringify({ type, payload, channels }) });
  if (!response.ok) throw new Error(`publish ${response.status}: ${await response.text()}`);
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
  const health = await (await fetch(`http://127.0.0.1:${SYSTEM_PORT}/health`)).json();
  console.log("system health", JSON.stringify(health));

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
  console.log("\nTIMINGS", JSON.stringify(timings, null, 1));
  console.log("PROOF PASS");
} catch (error) {
  console.error("PROOF FAIL", error);
  process.exitCode = 1;
} finally {
  child.kill();
  process.exit();
}

#!/usr/bin/env bun
// Runs the end-to-end proof and prints the table.
//   bun run run.ts [--phase=attacks,demo]
// E2E_ACTORS=shim runs the real actor classes on terse-shim.ts. E2E_ACTORS=terse reaches a real server at
//   E2E_TERSE_URL (default http://127.0.0.1:7110).
// E2E_AGENTS=runtime runs the real AgentRuntime in this process, with Relay replaced by a direct call.
//   E2E_AGENTS=relay expects `agent/spawn.ts` running against this fake glue and publishes to E2E_PUBLISH_URL.
//   E2E_AGENTS=none skips the demo walk.
// Ports: FAKE_GLUE_PORT (7210), FAKE_PLANT_PORT (7310). Whatever is not real is named in every affected row.
import { plugin } from "bun";
import { join } from "node:path";
import { httpBus, localBus, terseActors } from "./bind.ts";
import { startFakeGlue } from "./fake-glue.ts";
import type { ActorPorts, Bus } from "./ports.ts";
import { Gap, REAL, renderTable, summarize, writeRun, type Row, type Stack } from "./report.ts";
import { walkDemo, type Ctx } from "./scenario.ts";
import { runAttacks } from "./attacks.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const phases = (process.argv.find((a) => a.startsWith("--phase="))?.slice(8) ?? "attacks,demo").split(",");
const actorMode = process.env.E2E_ACTORS ?? "shim";
const agentMode = process.env.E2E_AGENTS ?? "runtime";
const terseUrl = process.env.E2E_TERSE_URL ?? "http://127.0.0.1:7110";
const gluePort = Number(process.env.FAKE_GLUE_PORT ?? 7210);
const plantPort = Number(process.env.FAKE_PLANT_PORT ?? 7310);
const plantUrl = `http://127.0.0.1:${plantPort}`;
const glueUrl = `http://127.0.0.1:${gluePort}`;
const publishUrl = process.env.E2E_PUBLISH_URL;
const takes = Number(process.env.E2E_TAKES ?? 1);

process.env.GLUE_URL = glueUrl;
process.env.DURABLE_ACTORS_CONTROL_PLANE_URL = terseUrl;

async function bindActors(): Promise<ActorPorts> {
  if (actorMode === "terse") return terseActors(terseUrl);
  const shim = await import("./terse-shim.ts");
  await plugin({
    name: "terse-sdk-shim",
    setup(build) {
      build.module("terse-sdk/actor", () => ({ loader: "object", exports: { Actor: shim.Actor, Persisted: shim.Persisted, Emittable: shim.Emittable, Ephemeral: shim.Ephemeral, Compute: shim.Compute } }));
    },
  });
  const { Component, Plant, Company } = (await import("../../src/actor.ts")) as any;
  return {
    label: "real actor classes on the in-process shim, not Terse",
    isReal: false,
    component: (id) => Component.get(id.replaceAll("/", ".")),
    plant: (id) => Plant.get(id),
    company: () => Company.get("company"),
  };
}

// The real agent code, with Relay replaced by a direct call. The table says relay=in-process.
async function bindRuntime(): Promise<{ bus: Bus; stop: () => void }> {
  const [{ AgentRuntime }, { HttpGlue }, { RoutedLlm }] = await Promise.all([import("../../../agent/runtime.ts"), import("../../../agent/glue.ts"), import("../../../agent/llm.ts")]);
  const seed = await Bun.file(join(repoRoot, "shared", "plants.json")).json();
  const owned: string[] = seed.plants.flatMap((p: { components: { id: string }[] }) => p.components.map((c) => c.id));
  const llm = new RoutedLlm();
  await llm.probeClaude();
  const post = async (message: any, _channel: string, from: string) => {
    const [path, body] = message.type === "vote" ? ["/vote", { vote: message.vote }] : ["/counter", { parentProposalId: message.parentProposalId, proposal: message.proposal }];
    const res = await fetch(glueUrl + path, { method: "POST", headers: { "content-type": "application/json", "x-agent-id": from }, body: JSON.stringify(body) });
    if (!res.ok) console.warn(`[agent post] ${path} from ${from} -> ${res.status}: ${(await res.text()).slice(0, 240)}`);
  };
  const runtime = new AgentRuntime({ glue: new HttpGlue(glueUrl), llm, post, owned, log: (line: string) => console.log(`[agent] ${line.slice(0, 200)}`) });
  const bus = localBus(async (type, payload) => {
    runtime.onMessage({ type, ...payload });
  });
  return { bus, stop: () => undefined };
}

const stack: Stack = {
  actors: actorMode === "terse" ? REAL : "in-process-shim",
  agents: agentMode === "none" ? "none" : REAL,
  llm: agentMode === "none" ? "none" : process.env.E2E_LLM_LABEL ?? "real-openai (claude roles on labelled GPT fallback)",
  relay: agentMode === "relay" ? REAL : agentMode === "none" ? "none" : "in-process",
  glue: "FAKE",
  plant: "FAKE",
};

const rows: Row[] = [];
const printRow = (r: Row) => console.log(`[${r.outcome.toUpperCase()}] ${r.id} ${r.title}: ${r.detail}`);

async function waitForPlant() {
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`${plantUrl}/__fake/info`).then((r) => r.ok, () => false);
    if (up) return;
    await Bun.sleep(100);
  }
  throw new Error("fake plant did not start");
}

// The first call to a real actor pays for a host process, so this waits rather than failing the first row.
async function warmActors(actors: ActorPorts) {
  const started = Date.now();
  let last: unknown;
  while (Date.now() - started < 120_000) {
    try {
      await actors.company().getState();
      console.log(`[harness] first actor call answered after ${Date.now() - started} ms`);
      return;
    } catch (e) {
      last = e;
      console.log(`[harness] actor not answering after ${Date.now() - started} ms: ${String(e).slice(0, 160)}`);
    }
  }
  throw new Gap(`actors are not reachable (${actors.label}): ${last}`);
}

async function main() {
  const actors = await bindActors();
  const plantProc = Bun.spawn(["bun", "run", join(import.meta.dir, "fake-plant.ts")], {
    env: { ...process.env, FAKE_PLANT_PORT: String(plantPort), FAKE_GLUE_URL: glueUrl },
    stdout: "inherit",
    stderr: "inherit",
  });
  const agentBus: { current?: Bus } = {};
  const bus: Bus = {
    label: agentMode,
    isReal: agentMode === "relay",
    publish: (type, payload, channels) => agentBus.current?.publish(type, payload, channels) ?? Promise.resolve(),
  };
  const glue = startFakeGlue({ port: gluePort, repoRoot, plantUrl, actors, bus });
  const ctx: Ctx = { actors, stack, glueUrl: glue.url, plantUrl, rows, onRow: printRow };
  try {
    await waitForPlant();
    await warmActors(actors);
    if (phases.includes("attacks")) await runAttacks(ctx);
    if (phases.includes("demo")) {
      if (agentMode === "none") {
        rows.push({ id: "E0", title: "Demo walk", strict: true, layers: ["agents"], outcome: "gap", detail: "E2E_AGENTS=none", ms: 0 });
      } else {
        if (agentMode === "relay") {
          if (!publishUrl) throw new Gap("E2E_AGENTS=relay needs E2E_PUBLISH_URL");
          agentBus.current = httpBus(publishUrl, true, `agent/system.ts at ${publishUrl}`);
        } else {
          agentBus.current = (await bindRuntime()).bus;
        }
        // Rehearsals reset between takes while the agent process keeps running, so a take must not depend on a fresh process.
        for (let take = 1; take <= takes; take++) {
          ctx.take = take;
          await walkDemo(ctx);
        }
      }
    }
  } catch (e) {
    rows.push({ id: "H0", title: "Harness", strict: false, layers: ["actors"], outcome: e instanceof Gap ? "gap" : "fail", detail: String(e), ms: 0 });
  } finally {
    glue.stop();
    plantProc.kill();
  }
  writeRun(join(import.meta.dir, `last-run-${actorMode}-${agentMode}.md`), `ActorRelay e2e run (actors ${actorMode}, agents ${agentMode})`, rows, stack);
  console.log(`\n${renderTable(rows, stack)}\n`);
  const s = summarize(rows, stack);
  console.log(`Stack: ${JSON.stringify(stack)}`);
  console.log(`Totals: ${s.pass} PASS, ${s.passOnFake} PASS on fake or stand-in, ${s.fail} FAIL, ${s.gap} GAP`);
  process.exit(s.fail > 0 ? 1 : s.gap > 0 ? 2 : 0);
}

await main();

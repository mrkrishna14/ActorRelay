// Runner. Scenarios run one at a time on the real runtime, each on its own data dir.
//   bun run run.ts --project <dir> [--only c1,c2a] [--runId name]
import { cpSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runScenario, type RunConfig, type Scenario, type ScenarioResult } from "./lib/scenario";
import { probeScenarios } from "./scenarios/probe";
import * as restart from "./scenarios/restart";
import * as execute from "./scenarios/execute";
import * as learning from "./scenarios/learning";
import * as deadlock from "./scenarios/deadlock";

const flag = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const all: Scenario[] = [
  restart.killHostOnly,
  restart.alarmRearm,
  restart.silentTicks,
  restart.silentAfterHostKill,
  restart.votingRestart,
  restart.votingExpiredDown,
  restart.vetoRestartBeforeDeadline,
  restart.vetoDownPastDeadline,
  restart.vetoReopened,
  restart.vetoThenKill,
  execute.killBeforeClaim,
  execute.killAtSetpointRuntime,
  execute.killAtSetpointGroup,
  execute.glueDiesAfterClaim,
  execute.ackLostPrompt,
  execute.ackLostLate,
  execute.dispatchFailure,
  learning.ackedEventThenKill,
  learning.killMidPromotion,
  learning.ackStream,
  deadlock.tickHang,
  deadlock.tickSlow,
  deadlock.tickError,
  deadlock.tickDown,
  deadlock.executeHang,
  deadlock.executeDownThenBack,
  deadlock.executeDownForever,
  deadlock.reentrantTick,
  deadlock.killDuringHang,
  deadlock.companyFrozen,
  restart.crashLoop,
  execute.randomKillAroundDeadline,
  learning.randomKillRecordEvent,
];

const suite = flag("suite") ?? "actors";
const rootDir = join(homedir(), "ar-chaos");
const runId = flag("runId") ?? new Date().toISOString().replace(/[:.]/g, "-");
const port = Number(flag("port") ?? 7140);
const gluePort = Number(flag("gluePort") ?? 7240);
const config: RunConfig = {
  runId,
  rootDir,
  projectDir: flag("project") ?? join(rootDir, "snapshot", "actor"),
  port,
  gluePort,
  target: flag("target") ?? "real Terse dev server, fake glue and bridge",
  env: { DURABLE_ACTORS_CONTROL_PLANE_URL: `http://127.0.0.1:${port}` },
};

const only = flag("only")?.split(",");
const pool = suite === "probe" ? probeScenarios : all;
const selected = only ? pool.filter((scenario) => only.some((prefix) => scenario.id.startsWith(prefix))) : pool;
if (selected.length === 0) throw new Error(`no scenarios match ${only}`);

mkdirSync(join(rootDir, "results", runId), { recursive: true });
const results: ScenarioResult[] = [];
for (const scenario of selected) results.push(await runScenario(config, scenario));

console.log("\n=== SUMMARY");
for (const result of results) {
  const failed = result.checks.filter((check) => !check.pass).map((check) => check.name);
  console.log(`${result.status.toUpperCase().padEnd(5)} ${result.id}${failed.length ? `  failed: ${failed.join("; ")}` : ""}${result.error ? `  error: ${result.error.split("\n")[0]}` : ""}`);
}

const evidence = join(import.meta.dir, "results", runId);
mkdirSync(evidence, { recursive: true });
cpSync(join(rootDir, "results", runId), evidence, { recursive: true });
console.log(`results: ${evidence}`);
process.exit(results.every((result) => result.status === "pass") ? 0 : 1);

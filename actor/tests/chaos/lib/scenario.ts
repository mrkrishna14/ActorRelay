// Scenario bookkeeping. A check records only what was observed; there is no way to mark one as passed by reasoning.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ActorClient } from "./client";
import { FakeGlue } from "./fakeGlue";
import { DevServer, type KillMode, type KillRecord } from "./server";

export type Check = { name: string; pass: boolean; detail?: string };
export type RestartTiming = {
  label: string;
  kill: KillRecord;
  downMs: number;
  healthzMs: number;
  firstCallMs?: number;
  firstTickMs?: number;
};

export type ScenarioResult = {
  id: string;
  title: string;
  target: string;
  startedAt: string;
  durationMs: number;
  status: "pass" | "fail" | "error" | "blocked";
  checks: Check[];
  restarts: RestartTiming[];
  metrics: Record<string, number>;
  notes: string[];
  error?: string;
};

export type RunConfig = {
  runId: string;
  rootDir: string;
  projectDir: string;
  port: number;
  gluePort: number;
  target: string;
  env?: Record<string, string>;
  command?: string[];
};

export class Ctx {
  checks: Check[] = [];
  restarts: RestartTiming[] = [];
  metrics: Record<string, number> = {};
  notes: string[] = [];
  server: DevServer;
  glue: FakeGlue;
  client: ActorClient;

  constructor(
    readonly config: RunConfig,
    readonly scenarioId: string,
  ) {
    const dataDir = join(config.rootDir, "data", config.runId, scenarioId);
    rmSync(dataDir, { recursive: true, force: true });
    this.glue = new FakeGlue(config.gluePort);
    this.server = new DevServer({
      projectDir: config.projectDir,
      dataDir,
      port: config.port,
      logFile: join(config.rootDir, "logs", config.runId, `${scenarioId}.log`),
      command: config.command,
      env: { GLUE_URL: this.glue.url, ...config.env },
    });
    this.client = new ActorClient(this.server.url);
  }

  check(name: string, pass: boolean, detail?: unknown): boolean {
    const text = detail === undefined ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail);
    this.checks.push({ name, pass, detail: text?.slice(0, 1500) });
    console.log(`  ${pass ? "PASS" : "FAIL"} ${name}${text ? `  ${text.slice(0, 300)}` : ""}`);
    return pass;
  }

  equal(name: string, actual: unknown, expected: unknown): boolean {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    return this.check(name, a === e, a === e ? a : `got ${a}, expected ${e}`);
  }

  note(text: string): void {
    this.notes.push(text);
    console.log(`  NOTE ${text}`);
  }

  metric(name: string, value: number): void {
    this.metrics[name] = Math.round(value * 10) / 10;
    console.log(`  METRIC ${name}=${this.metrics[name]}`);
  }

  /** kill -9, stay down for `downMs`, restart on the same data dir, and time each stage from the kill. */
  async crash(label: string, mode: KillMode = "runtime", downMs = 0): Promise<RestartTiming> {
    const kill = await this.server.kill9(mode);
    if (kill.survivors.length > 0) this.note(`${label}: ${kill.survivors.length} process(es) outlived the runtime by 10s`);
    if (downMs > 0) await Bun.sleep(downMs);
    const { readyMs } = await this.server.start();
    const timing: RestartTiming = { label, kill, downMs, healthzMs: Date.now() - kill.atEpochMs };
    timing.healthzMs = Math.round(timing.healthzMs);
    this.metrics[`${label}.restartReadyMs`] = Math.round(readyMs);
    this.restarts.push(timing);
    console.log(`  CRASH ${label}: ${mode} kill, port closed ${kill.portClosedMs.toFixed(0)}ms, healthy again ${timing.healthzMs}ms after kill`);
    return timing;
  }
}

export type Scenario = {
  id: string;
  title: string;
  run: (ctx: Ctx) => Promise<void>;
};

export async function runScenario(config: RunConfig, scenario: Scenario): Promise<ScenarioResult> {
  console.log(`\n=== ${scenario.id}: ${scenario.title}`);
  const ctx = new Ctx(config, scenario.id);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let error: string | undefined;
  ctx.glue.start();
  try {
    const first = await ctx.server.start();
    ctx.metric("firstStartMs", first.readyMs);
    await scenario.run(ctx);
  } catch (caught: any) {
    error = String(caught?.stack ?? caught);
    console.log(`  ERROR ${error}`);
  }
  await ctx.server.stop().catch(() => {});
  await ctx.glue.stop().catch(() => {});
  const failed = ctx.checks.some((check) => !check.pass);
  const result: ScenarioResult = {
    id: scenario.id,
    title: scenario.title,
    target: config.target,
    startedAt,
    durationMs: Math.round(performance.now() - started),
    status: error ? "error" : failed ? "fail" : ctx.checks.length ? "pass" : "error",
    checks: ctx.checks,
    restarts: ctx.restarts,
    metrics: ctx.metrics,
    notes: ctx.notes,
    error,
  };
  const dir = join(config.rootDir, "results", config.runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${scenario.id}.json`), JSON.stringify(result, null, 2));
  console.log(`=== ${scenario.id}: ${result.status.toUpperCase()} (${ctx.checks.filter((c) => c.pass).length}/${ctx.checks.length} checks, ${result.durationMs}ms)`);
  return result;
}

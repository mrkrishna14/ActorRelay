// Lifecycle of a real local Terse server for crash testing.
// Every run gets its own port and data dir, so ar-actors' server on 7100 is never touched.
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

export type KillMode = "runtime" | "group";

export type ServerOptions = {
  projectDir: string;
  dataDir: string;
  port: number;
  logFile: string;
  env?: Record<string, string>;
  command?: string[];
};

export type KillRecord = {
  mode: KillMode;
  atEpochMs: number;
  runtimePid: number;
  groupBefore: number[];
  portClosedMs: number;
  hostsGoneMs: number | null;
  survivors: number[];
};

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until<T>(fn: () => T | Promise<T>, timeoutMs: number, stepMs = 25): Promise<T | undefined> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (performance.now() >= deadline) return undefined;
    await sleep(stepMs);
  }
}

function procStat(pid: number): { state: string; ppid: number; pgrp: number } | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], ppid: Number(fields[1]), pgrp: Number(fields[2]) };
  } catch {
    return null;
  }
}

export function groupMembers(pgid: number): number[] {
  const members: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = procStat(Number(entry));
    if (stat && stat.pgrp === pgid && stat.state !== "Z") members.push(Number(entry));
  }
  return members;
}

/** The runtime stamps each host's identity into DURABLE_ACTORS_ACTOR, so a host can be found without guessing. */
export function hostPid(pgid: number, actorName: string, actorId: string): number | null {
  for (const pid of groupMembers(pgid)) {
    try {
      const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      const identity = environ.find((entry) => entry.startsWith("DURABLE_ACTORS_ACTOR="));
      if (!identity) continue;
      const text = identity.slice("DURABLE_ACTORS_ACTOR=".length);
      if (text.includes(`"${actorName}"`) && text.includes(`"${actorId}"`)) return pid;
    } catch {}
  }
  return null;
}

export function listenerPid(port: number): number | null {
  const proc = Bun.spawnSync(["ss", "-ltnpH", `sport = :${port}`]);
  const match = /pid=(\d+)/.exec(proc.stdout.toString());
  return match ? Number(match[1]) : null;
}

export function portListening(port: number): boolean {
  const proc = Bun.spawnSync(["ss", "-ltnH", `sport = :${port}`]);
  return proc.stdout.toString().trim().length > 0;
}

async function healthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

export class DevServer {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  pgid = 0;
  starts = 0;

  constructor(readonly options: ServerOptions) {
    if (options.port === 7100) throw new Error("port 7100 belongs to ar-actors; chaos runs must use their own port");
  }

  get url(): string {
    return `http://127.0.0.1:${this.options.port}`;
  }

  // The runtime rebuilds the whole bundle on every start, which takes minutes on a loaded machine.
  async start(timeoutMs = 300_000): Promise<{ readyMs: number }> {
    const { projectDir, dataDir, port, logFile, env, command } = this.options;
    if (this.proc) throw new Error("server already running");
    // A previous server can take a few seconds to die on a loaded machine.
    if (!(await until(() => !portListening(port), 20_000, 100))) throw new Error(`port ${port} is already in use; refusing to start`);
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(dirname(logFile), { recursive: true });
    const log = openSync(logFile, "a");
    const argv = command ?? [`${homedir()}/terse-probe/node_modules/.bin/terse`, "actor", "dev", "--port", String(port)];
    const started = performance.now();
    // setsid gives the server its own process group, so "group" kills cannot reach the harness.
    this.proc = Bun.spawn(["setsid", ...argv], {
      cwd: projectDir,
      env: { ...process.env, DURABLE_ACTORS_DATA_DIR: dataDir, TERSE_ACTOR_PORT: String(port), ...env },
      stdin: "ignore",
      stdout: log,
      stderr: log,
    });
    this.pgid = this.proc.pid;
    this.starts += 1;
    const ready = await until(() => healthy(port), timeoutMs, 20);
    if (!ready) throw new Error(`server not healthy on ${port} after ${timeoutMs}ms; see ${logFile}`);
    return { readyMs: performance.now() - started };
  }

  /** SIGKILL. "runtime" kills only the process holding the port, which is the literal kill -9 of the dev server;
   *  actor hosts then see their parent-lifetime pipe close. "group" also kills them in the same instant, like power loss. */
  async kill9(mode: KillMode = "runtime"): Promise<KillRecord> {
    if (!this.proc) throw new Error("server not running");
    const { port } = this.options;
    const runtimePid = listenerPid(port);
    if (runtimePid == null) throw new Error(`nothing listening on ${port}`);
    const groupBefore = groupMembers(this.pgid);
    if (!groupBefore.includes(runtimePid)) throw new Error(`listener ${runtimePid} is not in group ${this.pgid}`);
    const atEpochMs = Date.now();
    const started = performance.now();
    if (mode === "group") process.kill(-this.pgid, "SIGKILL");
    else process.kill(runtimePid, "SIGKILL");
    await until(() => !portListening(port), 10_000, 5);
    const portClosedMs = performance.now() - started;
    const gone = await until(() => groupMembers(this.pgid).length === 0, 10_000, 10);
    const hostsGoneMs = gone ? performance.now() - started : null;
    const survivors = groupMembers(this.pgid);
    // Hosts that outlive the runtime by 10s are a finding, and must not leak into the next scenario.
    if (survivors.length > 0) {
      try {
        process.kill(-this.pgid, "SIGKILL");
      } catch {}
      await until(() => groupMembers(this.pgid).length === 0, 5_000, 10);
    }
    await this.proc.exited;
    this.proc = null;
    return { mode, atEpochMs, runtimePid, groupBefore, portClosedMs, hostsGoneMs, survivors };
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      process.kill(-this.pgid, "SIGKILL");
    } catch {}
    await until(() => groupMembers(this.pgid).length === 0, 5_000, 10);
    await this.proc.exited;
    this.proc = null;
  }
}

export function fileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

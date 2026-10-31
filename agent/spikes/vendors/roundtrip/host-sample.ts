// Samples CPU use of each actor host and the Terse runtime once a second, to tell a busy Plant from a blocked one.
// Usage: HOST_SAMPLE_FILE=file bun run roundtrip/host-sample.ts
import { appendFileSync, readdirSync, readFileSync } from "node:fs";

const file = process.env.HOST_SAMPLE_FILE;
if (!file) throw new Error("HOST_SAMPLE_FILE is not set");
const tersePort = process.env.RT_TERSE_PORT ?? "7130";
const TICKS_PER_SECOND = 100;

type Host = { pid: number; name: string };

function cpuTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(fields[11]) + Number(fields[12]);
  } catch {
    return null;
  }
}

function findHosts(): Host[] {
  const hosts: Host[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const environ = readFileSync(`/proc/${entry}/environ`, "utf8").split("\0");
      const plane = environ.find((v) => v.startsWith("DURABLE_ACTORS_CONTROL_PLANE_URL="));
      if (!plane?.includes(`:${tersePort}`)) continue;
      const actor = environ.find((v) => v.startsWith("DURABLE_ACTORS_ACTOR="))?.split("=").slice(1).join("=");
      const cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8").replaceAll("\0", " ");
      if (actor) hosts.push({ pid: Number(entry), name: actor.slice(0, 40) });
      else if (cmd.includes("durable-actors dev")) hosts.push({ pid: Number(entry), name: "runtime" });
    } catch {
      // A process can exit between readdir and read.
    }
  }
  return hosts;
}

let hosts = findHosts();
let last = new Map<number, number>();
let rounds = 0;
setInterval(() => {
  if (++rounds % 5 === 0) hosts = findHosts();
  const sample: Record<string, number> = {};
  const next = new Map<number, number>();
  for (const { pid, name } of hosts) {
    const ticks = cpuTicks(pid);
    if (ticks === null) continue;
    next.set(pid, ticks);
    const before = last.get(pid);
    if (before !== undefined) sample[name] = Math.round(((ticks - before) / TICKS_PER_SECOND) * 100) / 100;
  }
  last = next;
  appendFileSync(file, `${JSON.stringify({ at: Date.now(), load: readFileSync("/proc/loadavg", "utf8").split(" ")[0], cores: sample })}\n`);
}, 1000);

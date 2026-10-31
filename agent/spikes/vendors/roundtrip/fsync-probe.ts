// Times a small durable write on each filesystem, the same operation a SQLite commit waits for.
import { closeSync, fsyncSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const pct = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil((p / 100) * values.length) - 1)];
const block = Buffer.alloc(4096, 1);
for (const dir of [join(homedir(), "ar-vendors", "fsync-probe"), "/dev/shm/ar-vendors-fsync"]) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "probe.bin");
  const fd = openSync(file, "w");
  const times: number[] = [];
  for (let i = 0; i < 60; i++) {
    const at = performance.now();
    writeSync(fd, block);
    fsyncSync(fd);
    times.push(performance.now() - at);
  }
  closeSync(fd);
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ dir, n: times.length, p50: Number(pct(times, 50).toFixed(1)), p95: Number(pct(times, 95).toFixed(1)), max: Number(Math.max(...times).toFixed(1)) }));
}

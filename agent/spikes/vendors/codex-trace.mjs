#!/usr/bin/env node
// Prints when each codex exec JSONL event arrives, to show where its latency goes.
// Usage: node codex-trace.mjs [model] [effort]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVoters } from "./vote-prompt.mjs";

const [model = "gpt-6-luna", effort = "none"] = process.argv.slice(2);
const root = join(import.meta.dirname, "..", "..", "..");
const key = readFileSync(join(root, ".env"), "utf8").split(/\r?\n/).find((l) => l.startsWith("OPENAI_API_KEY=")).slice(15).trim();
const bin = join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
const scratch = mkdtempSync(join(tmpdir(), "ar-codex-trace-"));
mkdirSync(join(scratch, "home"));
const voter = buildVoters(`prop-trace-${Date.now()}`)[2];
const started = performance.now();
const stamp = (label) => console.log(`${String(Math.round(performance.now() - started)).padStart(6)}ms ${label}`);
const child = spawn(bin, ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules", "-m", model, "-c", `model_reasoning_effort="${effort}"`, "-C", scratch, "-"], {
  env: { ...process.env, CODEX_API_KEY: key, CODEX_HOME: join(scratch, "home"), RUST_LOG: "warn" },
  cwd: scratch,
  windowsHide: true,
});
let buffer = "";
child.stdout.on("data", (d) => {
  buffer += d;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop();
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      const usage = e.usage ? ` input=${e.usage.input_tokens} cached=${e.usage.cached_input_tokens} output=${e.usage.output_tokens}` : "";
      stamp(`${e.type}${e.item?.type ? `:${e.item.type}` : ""}${usage}`);
    } catch {
      stamp(`text ${line.slice(0, 100)}`);
    }
  }
});
child.stderr.on("data", (d) => stamp(`stderr ${String(d).replaceAll(key, "<key>").slice(0, 220).trim()}`));
child.on("close", (code) => stamp(`exit ${code}`));
child.stdin.end(`${voter.system}\n\n${voter.user}`);

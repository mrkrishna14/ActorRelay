#!/usr/bin/env node
// Ask an OpenAI model from the command line, so any agent or teammate can use the credits.
// Usage: node scripts/gpt.mjs [--model id] [--effort none|low|medium|high] [--runs n] "prompt"
// The prompt can also be piped in. --runs sends n parallel calls, for second opinions.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const line = readFileSync(join(root, ".env"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("OPENAI_API_KEY="));
  if (!line) throw new Error("OPENAI_API_KEY is not set and is not in .env");
  return line.slice("OPENAI_API_KEY=".length).trim();
}

function parseArgs(argv) {
  const opts = { model: "gpt-6.1-sol", effort: "medium", runs: 1, prompt: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") opts.model = argv[++i];
    else if (argv[i] === "--effort") opts.effort = argv[++i];
    else if (argv[i] === "--runs") opts.runs = Number(argv[++i]);
    else opts.prompt.push(argv[i]);
  }
  return opts;
}

async function ask(key, { model, effort }, input) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input, reasoning: { effort } }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${body.error?.message}`);
  const text = body.output.flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join("");
  return { text, tokens: body.usage?.total_tokens ?? 0 };
}

const opts = parseArgs(process.argv.slice(2));
const input = opts.prompt.join(" ") || readFileSync(0, "utf8");
const key = loadKey();
const replies = await Promise.all(Array.from({ length: opts.runs }, () => ask(key, opts, input)));

replies.forEach((r, i) => {
  if (opts.runs > 1) console.log(`--- run ${i + 1}`);
  console.log(r.text);
});
console.error(`[${opts.model}] ${replies.reduce((sum, r) => sum + r.tokens, 0)} tokens`);

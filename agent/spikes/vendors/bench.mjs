#!/usr/bin/env node
// Measures vote latency, success and JSON validity for one vendor path.
// Usage: node bench.mjs --path oa-luna-none [--concurrency 10] [--rounds 3] [--timeout 60000] [--tag win]
// Paths: oa-luna-none oa-nano oa-sol-low codex-luna-none codex-nano claude-haiku claude-sonnet
//        claude-haiku-plain claude-sonnet-plain claude-haiku-warm claude-sonnet-warm
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVoters, checkVerdict, checkVote } from "./vote-prompt.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

function parseArgs(argv) {
  const o = { path: "", concurrency: 10, rounds: 3, timeout: 60000, tag: platform() === "win32" ? "win" : "wsl", claudeBin: "", inheritEnv: false, warmDelay: 8000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--path") o.path = argv[++i];
    else if (a === "--concurrency") o.concurrency = Number(argv[++i]);
    else if (a === "--rounds") o.rounds = Number(argv[++i]);
    else if (a === "--timeout") o.timeout = Number(argv[++i]);
    else if (a === "--tag") o.tag = argv[++i];
    else if (a === "--claude-bin") o.claudeBin = argv[++i];
    else if (a === "--inherit-env") o.inheritEnv = true;
    else if (a === "--warm-delay") o.warmDelay = Number(argv[++i]);
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));

function openaiKey() {
  const line = readFileSync(join(root, ".env"), "utf8").split(/\r?\n/).find((l) => l.startsWith("OPENAI_API_KEY="));
  if (!line) throw new Error("OPENAI_API_KEY is not in .env");
  return line.slice("OPENAI_API_KEY=".length).trim();
}

const npmRoot = process.env.APPDATA ? join(process.env.APPDATA, "npm") : "/mnt/c/Users/zubai/AppData/Roaming/npm";
const claudeBin = opts.claudeBin || (platform() === "win32" ? join(npmRoot, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe") : "claude");

function findCodexBin() {
  const pkg = join(npmRoot, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc");
  for (const sub of [join("codex", "codex.exe"), join("bin", "codex.exe"), "codex.exe"]) if (existsSync(join(pkg, sub))) return join(pkg, sub);
  return join(npmRoot, "codex.cmd");
}

// Removes the parent Claude Code session's variables, so a child behaves like a fresh shell.
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  if (!opts.inheritEnv) {
    for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC_BASE_URL$|BAGGAGE$|AI_AGENT$)/.test(k)) delete env[k];
  }
  return { ...env, ...extra };
}

const scratch = mkdtempSync(join(tmpdir(), "ar-vendors-"));
const OPENAI = {
  "oa-luna-none": { model: "gpt-6-luna", effort: "none" },
  "oa-nano": { model: "gpt-5.4-nano" },
  "oa-sol-low": { model: "gpt-6.1-sol", effort: "low" },
  "oa-terra-low": { model: "gpt-6.1-terra", effort: "low" },
  "oa-53codex-low": { model: "gpt-5.3-codex", effort: "low" },
  "oa-luna-priority": { model: "gpt-6-luna", effort: "none", tier: "priority" },
  "oa-nano-priority": { model: "gpt-5.4-nano", tier: "priority" },
};
const CODEX = {
  "codex-luna-none": { model: "gpt-6-luna", effort: "none" },
  "codex-nano": { model: "gpt-5.4-nano" },
  "codex-luna-early": { model: "gpt-6-luna", effort: "none", early: true },
  "codex-luna-early-noschema": { model: "gpt-6-luna", effort: "none", early: true, noSchema: true },
  "codex-sol-low-early": { model: "gpt-6.1-sol", effort: "low", early: true },
  "codex-53-low-early": { model: "gpt-5.3-codex", effort: "low", early: true },
  "codex-terra-low-early": { model: "gpt-6.1-terra", effort: "low", early: true },
  "codex-luna-priority": { model: "gpt-6-luna", effort: "none", early: true, tier: "priority" },
};
const CLAUDE = {
  "claude-haiku": { model: "haiku", schema: true },
  "claude-sonnet": { model: "sonnet", schema: true },
  "claude-haiku-plain": { model: "haiku", schema: false },
  "claude-sonnet-plain": { model: "sonnet", schema: false },
  "claude-haiku-warm": { model: "haiku", schema: false, warm: true },
  "claude-sonnet-warm": { model: "sonnet", schema: false, warm: true },
};

let key = "";
async function callOpenAI(cfg, voter) {
  key ||= openaiKey();
  const started = performance.now();
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      instructions: voter.system,
      input: voter.user,
      store: false,
      ...(cfg.tier ? { service_tier: cfg.tier } : {}),
      ...(cfg.effort ? { reasoning: { effort: cfg.effort } } : {}),
      text: { format: { type: "json_schema", name: "vote", strict: true, schema: voter.schema } },
    }),
    signal: AbortSignal.timeout(opts.timeout),
  });
  const body = await res.json().catch(() => ({}));
  const ms = performance.now() - started;
  const limits = {
    limitRequests: res.headers.get("x-ratelimit-limit-requests"),
    limitTokens: res.headers.get("x-ratelimit-limit-tokens"),
    remainingRequests: res.headers.get("x-ratelimit-remaining-requests"),
    remainingTokens: res.headers.get("x-ratelimit-remaining-tokens"),
    retryAfter: res.headers.get("retry-after"),
  };
  if (!res.ok) return { ms, ok: false, status: res.status, error: body.error?.message?.slice(0, 200), limits };
  const text = (body.output ?? []).flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join("");
  return { ms, ok: true, status: res.status, text, model: body.model, tokens: body.usage?.total_tokens, cached: body.usage?.input_tokens_details?.cached_tokens, limits };
}

// doneWhen lets a caller take the answer as soon as it is on stdout, without waiting for process exit.
function runCli(bin, args, { stdin, env, cwd, timeout, doneWhen }) {
  return new Promise((resolve) => {
    const started = performance.now();
    const shell = bin.endsWith(".cmd");
    const child = spawn(bin, args, { env, cwd, shell, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.stdout.on("data", (d) => {
      stdout += d;
      if (doneWhen?.(stdout)) {
        clearTimeout(timer);
        resolve({ ms: performance.now() - started, code: 0, stdout, stderr, timedOut });
        child.kill();
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ms: performance.now() - started, code: -1, stdout, stderr: String(e), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ms: performance.now() - started, code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

function parseCodex(stdout) {
  let text = "";
  let usage = null;
  let error = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "item.completed" && e.item?.type === "agent_message") text = e.item.text;
    if (e.type === "turn.completed") usage = e.usage;
    if (e.type === "turn.failed" || e.type === "error") error = e.error?.message ?? e.message;
  }
  return { text, usage, error };
}

async function callCodex(cfg, voter) {
  const schemaFile = join(scratch, `schema-${voter.tag}.json`);
  writeFileSync(schemaFile, JSON.stringify(voter.schema));
  const home = join(scratch, "codex-home");
  mkdirSync(home, { recursive: true });
  const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules", "-m", cfg.model];
  if (cfg.effort) args.push("-c", `model_reasoning_effort="${cfg.effort}"`);
  if (cfg.tier) args.push("-c", `service_tier="${cfg.tier}"`);
  if (!cfg.noSchema) args.push("--output-schema", schemaFile);
  args.push("-C", scratch, "-");
  const r = await runCli(findCodexBin(), args, {
    stdin: `${voter.system}\n\n${voter.user}`,
    env: { ...cleanEnv(), CODEX_API_KEY: (key ||= openaiKey()), CODEX_HOME: home },
    cwd: scratch,
    timeout: opts.timeout,
    doneWhen: cfg.early ? (out) => /"type":"turn\.(completed|failed)"/.test(out) : undefined,
  });
  const p = parseCodex(r.stdout);
  return { ms: r.ms, ok: r.code === 0 && !!p.text, status: r.code, text: p.text, error: p.error ?? (r.timedOut ? "timeout" : r.code !== 0 ? r.stderr.slice(0, 300) : undefined), tokens: p.usage ? p.usage.input_tokens + p.usage.output_tokens : undefined, cached: p.usage?.cached_input_tokens, model: cfg.model };
}

function claudeArgs(cfg, voter, { stream }) {
  const args = ["-p", "--model", cfg.model, "--effort", "low", "--output-format", "stream-json", "--verbose", "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--system-prompt", voter.system];
  if (cfg.schema) args.push("--json-schema", JSON.stringify(voter.schema));
  if (stream) args.push("--input-format", "stream-json");
  return args;
}

function parseClaude(stdout) {
  let result = null;
  const rate = [];
  let model = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "result") result = e;
    if (e.type === "rate_limit_event") rate.push(e.rate_limit_info ?? e);
    if (e.type === "assistant" && e.message?.model) model = e.message.model;
  }
  return { result, rate, model };
}

async function callClaude(cfg, voter) {
  const r = await runCli(claudeBin, claudeArgs(cfg, voter, { stream: false }), { stdin: voter.user, env: cleanEnv(), cwd: scratch, timeout: opts.timeout });
  const p = parseClaude(r.stdout);
  const res = p.result;
  const text = res?.structured_output ? JSON.stringify(res.structured_output) : res?.result;
  const models = res?.modelUsage ? Object.keys(res.modelUsage) : [];
  return {
    ms: r.ms,
    ok: r.code === 0 && !!res && !res.is_error && !!text,
    status: r.code,
    text,
    error: res?.is_error ? String(res.result ?? res.subtype).slice(0, 300) : r.timedOut ? "timeout" : r.code !== 0 ? (r.stderr || r.stdout).slice(0, 300) : undefined,
    apiMs: res?.duration_api_ms,
    costUsd: res?.total_cost_usd,
    model: p.model ?? models[0],
    models,
    rate: p.rate.at(-1),
  };
}

// A warm voter: the process has already started and waits on stdin; it serves one vote and exits.
function startWarm(cfg, voter) {
  const started = performance.now();
  const child = spawn(claudeBin, claudeArgs(cfg, voter, { stream: true }), { env: cleanEnv(), cwd: scratch, windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.on("error", () => {});
  return {
    ask() {
      return new Promise((resolve) => {
        const t0 = performance.now();
        const timer = setTimeout(() => {
          child.kill();
          finish("timeout");
        }, opts.timeout);
        const finish = (error) => {
          clearTimeout(timer);
          const p = parseClaude(stdout);
          const res = p.result;
          child.kill();
          resolve({ ms: performance.now() - t0, ok: !!res && !res.is_error && !!res.result, status: 0, text: res?.result, error: error ?? (res?.is_error ? String(res.result).slice(0, 300) : stderr.slice(0, 300) || undefined), apiMs: res?.duration_api_ms, costUsd: res?.total_cost_usd, model: p.model, rate: p.rate.at(-1), spawnedMsAgo: t0 - started });
        };
        const onData = () => {
          if (/"type":"result"/.test(stdout)) {
            child.stdout.off("data", onData);
            finish();
          }
        };
        child.stdout.on("data", onData);
        child.on("close", () => finish());
        child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: voter.user }] } })}\n`);
      });
    },
  };
}

function stripFence(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function grade(reply, voter) {
  const out = { voter: voter.id, ...reply };
  delete out.text;
  out.jsonValid = false;
  out.jsonValidStrict = false;
  out.contractErrors = [];
  if (reply.ok && reply.text) {
    try {
      const v = JSON.parse(reply.text);
      out.jsonValidStrict = true;
      out.jsonValid = true;
      out.contractErrors = checkVote(v, voter);
      out.verdictOk = checkVerdict(v, voter);
      out.predicted = v.predicted;
      out.vote = v.vote;
    } catch {
      try {
        const v = JSON.parse(stripFence(reply.text));
        out.jsonValid = true;
        out.contractErrors = checkVote(v, voter);
        out.verdictOk = checkVerdict(v, voter);
        out.vote = v.vote;
      } catch {
        out.sample = reply.text.slice(0, 160);
      }
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

const round0 = (n) => (n == null ? null : Math.round(n));

async function runRound(index) {
  const voters = [];
  while (voters.length < opts.concurrency) voters.push(...buildVoters(`prop-${Date.now().toString(36)}-${index}-${voters.length}`));
  const batch = voters.slice(0, opts.concurrency);
  const started = performance.now();
  let replies;
  if (OPENAI[opts.path]) replies = await Promise.all(batch.map((v) => callOpenAI(OPENAI[opts.path], v).catch((e) => ({ ms: performance.now() - started, ok: false, status: -1, error: String(e).slice(0, 200) }))));
  else if (CODEX[opts.path]) replies = await Promise.all(batch.map((v) => callCodex(CODEX[opts.path], v)));
  else if (CLAUDE[opts.path]?.warm) {
    const warm = batch.map((v) => startWarm(CLAUDE[opts.path], v));
    await sleep(opts.warmDelay);
    const t0 = performance.now();
    replies = await Promise.all(warm.map((w) => w.ask()));
    return { calls: replies.map((r, i) => grade(r, batch[i])), wallMs: performance.now() - t0 };
  } else if (CLAUDE[opts.path]) replies = await Promise.all(batch.map((v) => callClaude(CLAUDE[opts.path], v)));
  else throw new Error(`unknown path ${opts.path}`);
  return { calls: replies.map((r, i) => grade(r, batch[i])), wallMs: performance.now() - started };
}

const rounds = [];
for (let i = 0; i < opts.rounds; i++) rounds.push(await runRound(i));

const calls = rounds.flatMap((r) => r.calls);
const good = calls.filter((c) => c.ok);
const latencies = good.map((c) => c.ms).sort((a, b) => a - b);
const lv = calls.filter((c) => c.verdictOk !== undefined && c.verdictOk !== null);
const lim = calls.map((c) => c.limits).filter(Boolean);
const summary = {
  path: opts.path,
  tag: opts.tag,
  concurrency: opts.concurrency,
  rounds: opts.rounds,
  calls: calls.length,
  success: good.length,
  jsonStrict: calls.filter((c) => c.jsonValidStrict).length,
  jsonAfterFenceStrip: calls.filter((c) => c.jsonValid).length,
  contractClean: calls.filter((c) => c.jsonValid && c.contractErrors.length === 0).length,
  p50: round0(pct(latencies, 50)),
  p95: round0(pct(latencies, 95)),
  max: round0(latencies.at(-1)),
  roundWallMs: rounds.map((r) => round0(r.wallMs)),
  over20s: calls.filter((c) => c.ms > 20000).length,
  over5s: calls.filter((c) => c.ms > 5000).length,
  lvVerdictOk: `${lv.filter((c) => c.verdictOk).length}/${lv.length}`,
  apiP50: round0(pct(good.map((c) => c.apiMs).filter((n) => n != null).sort((a, b) => a - b), 50)),
  statuses: Object.entries(calls.reduce((m, c) => ((m[c.status] = (m[c.status] ?? 0) + 1), m), {})).map(([k, n]) => `${k}:${n}`).join(" "),
  errors: [...new Set(calls.map((c) => c.error).filter(Boolean))].slice(0, 4),
  contractErrors: [...new Set(calls.flatMap((c) => c.contractErrors))].slice(0, 6),
  models: [...new Set(calls.map((c) => c.model).filter(Boolean))],
  costUsd: calls.reduce((s, c) => s + (c.costUsd ?? 0), 0) || undefined,
  rateLast: calls.map((c) => c.rate).filter(Boolean).at(-1),
  openaiLimits: lim.length ? { limitRequests: lim[0].limitRequests, limitTokens: lim[0].limitTokens, minRemainingRequests: Math.min(...lim.map((l) => Number(l.remainingRequests ?? Infinity))), minRemainingTokens: Math.min(...lim.map((l) => Number(l.remainingTokens ?? Infinity))), retryAfter: lim.map((l) => l.retryAfter).filter(Boolean).slice(0, 3) } : undefined,
  samples: calls.filter((c) => c.sample).map((c) => c.sample).slice(0, 2),
  at: new Date().toISOString(),
};

const outDir = join(here, "results");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${opts.tag}-${opts.path}-c${opts.concurrency}.json`), JSON.stringify({ summary, calls }, null, 1));
console.log(JSON.stringify(summary));

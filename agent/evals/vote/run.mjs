#!/usr/bin/env node
// Runs generated vote scenarios through candidate models and prompts, appending one JSON line per vote.
// Usage: node agent/evals/vote/run.mjs --tag first --proposals 200 --seed 1 --models gpt-6-luna:none,gpt-6.1-sol:low --prompts baseline --concurrency 40
// A model named "oracle" is a fake that returns the true values, used only to check the harness.
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./scenarios.mjs";
import { PROMPTS, voteFormat } from "./prompts.mjs";
import { runVote, score } from "./pipeline.mjs";
import { asker, pool } from "./llm.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = { tag: "run", proposals: 100, seed: 1, models: "oracle", prompts: "baseline", concurrency: 40 };
  for (let i = 0; i < argv.length; i += 2) o[argv[i].slice(2)] = argv[i + 1];
  o.proposals = Number(o.proposals); o.seed = Number(o.seed); o.concurrency = Number(o.concurrency);
  return o;
}

const oracleAsk = (s) => async () => {
  const predicted = Object.fromEntries(Object.entries(s.truth).map(([m, t]) => [m, t.ceil]));
  const vote = {
    proposalId: s.proposal.id, componentId: s.component.id, agentId: `agent:${s.component.id}`, vote: s.expected.vote,
    reason: "oracle", predicted, marginPct: s.component.marginPct, evidenceEventIds: s.events.slice(0, 3).map((e) => e.id),
    evidenceRuleIds: [], similarCount: s.events.length,
  };
  return { text: JSON.stringify(vote), latencyMs: 0, retries: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
};

const opts = parseArgs(process.argv.slice(2));
const scenarios = generate({ proposals: opts.proposals, seed: opts.seed });
const outDir = join(here, "results");
mkdirSync(outDir, { recursive: true });
const out = createWriteStream(join(outDir, `${opts.tag}.jsonl`), { flags: "a" });

const candidates = opts.models.split(",").flatMap((spec) => {
  const [model, effort] = spec.split(":");
  return opts.prompts.split(",").map((name) => {
    const [prompt, format] = name.split("+");
    return { model, effort: effort === "default" ? null : effort, prompt, format: format ?? null, label: name };
  });
});

let done = 0;
const total = scenarios.length * candidates.length;
const startedAt = Date.now();
const progress = setInterval(() => console.error(`${done}/${total} ${((Date.now() - startedAt) / 1000).toFixed(0)}s`), 15000);

async function runCandidate(c) {
  const limit = pool(opts.concurrency);
  const ask = c.model === "oracle" ? null : asker({ model: c.model, effort: c.effort });
  await Promise.all(scenarios.map((s) => limit(async () => {
    const format = c.format === "schema" ? voteFormat(s) : null;
    const run = await runVote(s, PROMPTS[c.prompt](s), ask ? (m) => ask(m, format) : oracleAsk(s));
    const sc = score(s, run);
    const tokens = run.calls.reduce((a, r) => ({ in: a.in + (r.inputTokens ?? 0), out: a.out + (r.outputTokens ?? 0), reasoning: a.reasoning + (r.reasoningTokens ?? 0) }), { in: 0, out: 0, reasoning: 0 });
    out.write(`${JSON.stringify({
      model: c.model, effort: c.effort, prompt: c.label, id: s.id, group: s.group, family: s.family, role: s.component.role,
      tag: s.component.tag, crossPlant: s.crossPlant, to: s.proposal.to, from: s.proposal.from, depth: s.events.length,
      margin: s.component.marginPct, expected: s.expected.vote, category: s.expected.category, borderline: s.expected.borderline,
      truth: Object.fromEntries(Object.entries(s.truth).map(([m, t]) => [m, t.point])), reasons: s.expected.reasons,
      firstOk: run.firstOk, ok: run.ok, why: run.why, fenced: run.fenced, rawVote: run.raw.vote, finalVote: run.final.vote,
      predicted: run.raw.predicted, reason: run.raw.reason.slice(0, 240), forced: run.final.forced, ...sc,
      latencyMs: Math.round(run.calls[0].latencyMs ?? 0), retries: run.calls.reduce((a, r) => a + (r.retries ?? 0), 0), tokens,
      error: run.calls.find((r) => r.error)?.error ?? null,
    })}\n`);
    done++;
  })));
}

await Promise.all(candidates.map(runCandidate));
clearInterval(progress);
out.end();
console.error(`${done} votes in ${((Date.now() - startedAt) / 1000).toFixed(0)}s -> results/${opts.tag}.jsonl`);

#!/usr/bin/env bun
// Drives the real castVote in agent/vote.ts over generated scenarios: fake glue, real OpenAI, unmodified prompts and enforcement.
// Usage (WSL): bun agent/evals/vote/real.ts --tag real1 --proposals 300 --seed 31 --models gpt-6-luna:none,gpt-6.1-sol:low --concurrency 50
// Fake models, for checking the harness and the code alone: "oracle" returns the true values, "liar" always votes yes at current values.
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { castVote } from "../../vote";
import { RetrievalCache } from "../../retrieval";
import { generate } from "./scenarios.mjs";
import { score } from "./pipeline.mjs";
import { PATCHES } from "./patches.mjs";
import { asker, pool } from "./llm.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]) {
  const o: Record<string, string> = { tag: "real", proposals: "100", seed: "1", models: "oracle", concurrency: "50", patches: "none", format: "json_object" };
  for (let i = 0; i < argv.length; i += 2) o[argv[i].slice(2)] = argv[i + 1];
  return o;
}

const fakeGlue = (s: any) => ({
  component: async (id: string) => (id === s.component.id ? s.component : id === s.proposer.id ? s.proposer : s.steamValve),
  similar: async () => s.events,
  rules: async () => s.rules,
  plant: async () => ({ history: s.events, proposals: [s.proposal], rules: s.rules }),
  calibration: async () => {},
  rule: async () => {},
  vote: async () => {},
  counter: async () => {},
});

const oracleReply = (s: any) => ({
  vote: s.expected.vote,
  reason: "fake oracle",
  predicted: Object.fromEntries(Object.entries(s.truth).map(([m, t]: [string, any]) => [m, t.ceil])),
  evidenceEventIds: s.events.slice(0, 3).map((e: any) => e.id),
  evidenceRuleIds: [],
});

const liarReply = (s: any) => ({
  vote: "yes",
  reason: "fake liar",
  predicted: Object.fromEntries(Object.keys(s.truth).map((m) => [m, s.component.metrics[m] ?? 0])),
  evidenceEventIds: [],
  evidenceRuleIds: [],
});

function parseReply(text: string | undefined) {
  try {
    return JSON.parse((text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    return null;
  }
}

const opts = parseArgs(process.argv.slice(2));
const scenarios = generate({ proposals: Number(opts.proposals), seed: Number(opts.seed) });
const outDir = join(here, "results");
mkdirSync(outDir, { recursive: true });
const out = createWriteStream(join(outDir, `${opts.tag}.jsonl`), { flags: "a" });

const candidates = opts.models.split(",").flatMap((spec) => {
  const [model, effort] = spec.split(":");
  return opts.patches.split(",").map((patch) => ({ model, effort: effort ?? null, patch }));
});

let done = 0;
const total = scenarios.length * candidates.length;
const startedAt = Date.now();
const progress = setInterval(() => console.error(`${done}/${total} ${((Date.now() - startedAt) / 1000).toFixed(0)}s`), 15000);

async function runCandidate(c: { model: string; effort: string | null; patch: string }) {
  const limit = pool(Number(opts.concurrency));
  const fake = c.model === "oracle" ? oracleReply : c.model === "liar" ? liarReply : null;
  const ask = fake ? null : asker({ model: c.model, effort: c.effort, maxOutputTokens: 1200 });
  const format = opts.format === "none" ? null : { type: opts.format };
  const patch = PATCHES[c.patch];
  await Promise.all(scenarios.map((s: any) => limit(async () => {
    const calls: any[] = [];
    const llm = {
      async complete(req: { system: string; user: string }) {
        if (fake) {
          const r = { text: JSON.stringify(fake(s)), latencyMs: 0, retries: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
          calls.push(r);
          return { text: r.text, provider: "openai" as const, model: c.model, fallback: false };
        }
        const { system, user } = patch(req, s);
        const r = await ask!([{ role: "system", content: system }, { role: "user", content: user }], format);
        calls.push(r);
        if (r.error) throw new Error(r.error);
        return { text: r.text, provider: "openai" as const, model: c.model, fallback: false };
      },
    };
    const rejections: string[] = [];
    const log = (line: string) => rejections.push(line.slice(s.component.id.length + 1, 200));
    const vote = await castVote({ glue: fakeGlue(s) as any, llm, cache: new RetrievalCache(), fastNoMs: 600000, log }, s.proposal, s.component.id);
    const reply = parseReply(calls.at(-1)?.text);
    const malformed = vote.reason === "malformed prediction";
    const raw = {
      vote: reply?.vote === "yes" || reply?.vote === "no" ? reply.vote : "no",
      predicted: reply?.predicted && typeof reply.predicted === "object" ? reply.predicted : {},
      evidenceEventIds: Array.isArray(reply?.evidenceEventIds) ? reply.evidenceEventIds : [],
      evidenceRuleIds: Array.isArray(reply?.evidenceRuleIds) ? reply.evidenceRuleIds : [],
      similarCount: vote.similarCount,
      reason: typeof reply?.reason === "string" ? reply.reason : "",
    };
    const run = { ok: !malformed, raw, final: { vote: vote.vote, evidenceEventIds: vote.evidenceEventIds, forced: [] } };
    const sc = score(s, run);
    const tokens = calls.reduce((a, r) => ({ in: a.in + (r.inputTokens ?? 0), out: a.out + (r.outputTokens ?? 0), reasoning: a.reasoning + (r.reasoningTokens ?? 0) }), { in: 0, out: 0, reasoning: 0 });
    out.write(`${JSON.stringify({
      model: c.model, effort: c.effort, prompt: c.patch, id: s.id, group: s.group, family: s.family, role: s.component.role,
      tag: s.component.tag, crossPlant: s.crossPlant, to: s.proposal.to, from: s.proposal.from, depth: s.similarCount,
      margin: s.component.marginPct, expected: s.expected.vote, category: s.expected.category, borderline: s.expected.borderline,
      truth: Object.fromEntries(Object.entries(s.truth).map(([m, t]: [string, any]) => [m, t.point])), reasons: s.expected.reasons,
      firstOk: calls.length === 1 && !malformed, ok: !malformed, why: null, fenced: false, rawVote: raw.vote, finalVote: vote.vote,
      predicted: raw.predicted, finalPredicted: vote.predicted, reason: vote.reason.slice(0, 400), forced: [], rejections, ...sc,
      latencyMs: Math.round(calls[0]?.latencyMs ?? 0), retries: calls.reduce((a, r) => a + (r.retries ?? 0), 0), tokens,
      error: calls.find((r) => r.error)?.error ?? null,
    })}\n`);
    done++;
  })));
}

await Promise.all(candidates.map(runCandidate));
clearInterval(progress);
out.end();
console.error(`${done} votes in ${((Date.now() - startedAt) / 1000).toFixed(0)}s -> results/${opts.tag}.jsonl`);

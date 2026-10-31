#!/usr/bin/env node
// Which pump targets can pass on the project's real history? Sweeps targets through the real rankSimilar, deriveRules and castVote.
// With no --model it uses the "oracle" fake, which returns the true values, so it calls no API and every block is code policy.
// With --model it also runs a real model at low concurrency and reports where the real outcome differs from the perfect one.
// Usage: node --import ./agent/evals/vote/node-ts.mjs agent/evals/vote/targets.ts [--model gpt-6.1-terra:low --step 3 --concurrency 4]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rankSimilar } from "../../../actor/src/logic/similar";
import { deriveRules, toCompanyRule } from "../../../actor/src/logic/rules";
import { castVote } from "../../vote";
import { RetrievalCache } from "../../retrieval";
import { asker, pool } from "./llm.mjs";
import { expectedVote, plantSeed, root, stepEffects, steadyMetrics, voterTruth } from "./plant.mjs";

function parseArgs(argv: string[]) {
  const o: Record<string, string> = { model: "", step: "1", concurrency: "4" };
  for (let i = 0; i < argv.length; i += 2) o[argv[i].slice(2)] = argv[i + 1];
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const history = JSON.parse(readFileSync(join(root, "shared", "history.json"), "utf8"));
const components = plantSeed.plants.flatMap((p: any) => p.components);
const topology = Object.fromEntries(components.map((c: any) => [c.id, c]));
const now = "2026-10-31T20:00:00.000Z";
const plantRules = (id: string) => deriveRules(history.filter((e: any) => e.plantId === id), topology, now);
const company = plantRules("plant-a").map((r: any) => toCompanyRule(r, "plant-a"));
const rulesFor = { "plant-a": [...plantRules("plant-a"), ...company], "plant-b": [...plantRules("plant-b"), ...company] } as Record<string, any[]>;

function view(id: string, speed: number, other: number) {
  const c = structuredClone(topology[id]) as any;
  c.metrics = { ...c.metrics, ...steadyMetrics(speed, other)[c.tag] };
  return c;
}

const stats = { calls: 0, tokens: 0, retries: 0, rejected: 0, malformed: 0, latencies: [] as number[] };

async function outcome(plantId: string, from: number, to: number, ask: ((m: any[], f: any) => Promise<any>) | null) {
  const otherPlant = plantId === "plant-a" ? "plant-b" : "plant-a";
  const voters = [...["TK-101", "LV-101", "E-101", "TV-101"].map((t) => `${plantId}/${t}`), `${otherPlant}/TV-101`];
  const proposal = {
    id: `${plantId}-map-${ask ? "real" : "perfect"}-${from}-${to}`, at: now, plantId, proposerComponentId: `${plantId}/P-100`, proposerAgentId: `agent:${plantId}/P-100`, metric: "speedPct", from, to,
    rationale: "Sweep", requiredVoters: voters, votes: [], status: "voting", vetoDeadline: null, parentProposalId: null, crossPlant: true,
  };
  const fx = stepEffects({ from, to, otherSpeed: 50 });
  const glue = {
    component: async (id: string) => view(id, id.startsWith(plantId) ? from : 50, id.startsWith(plantId) ? 50 : from),
    similar: async (q: any) => rankSimilar({ history: history.filter((e: any) => e.plantId === plantId), componentId: q.componentId, metric: q.metric, to: q.to, upstreamSnapshot: q.upstreamSnapshot ?? {}, k: q.k, limit: topology[q.componentId].limits[q.metric], liveEventIds: [] }),
    rules: async () => rulesFor[plantId],
    plant: async () => ({ history: history.filter((e: any) => e.plantId === plantId), proposals: [proposal], rules: rulesFor[plantId] }),
    calibration: async () => {}, rule: async () => {}, vote: async () => {}, counter: async () => {},
  };
  const votes = await Promise.all(voters.map(async (id) => {
    const cross = !id.startsWith(plantId);
    const tag = id.split("/")[1];
    const truth = voterTruth({ tag, crossPlant: cross, otherSpeed: 50, fx });
    const own = view(id, cross ? 50 : from, cross ? from : 50);
    const expected = expectedVote(own, truth, 5);
    const llm = {
      async complete(req: { system: string; user: string }) {
        if (ask) {
          const reply = await ask([{ role: "system", content: req.system }, { role: "user", content: req.user }], { type: "json_object" });
          stats.calls++;
          stats.retries += reply.retries ?? 0;
          if (reply.error) throw new Error(reply.error);
          stats.tokens += reply.inputTokens + reply.outputTokens;
          stats.latencies.push(reply.latencyMs);
          return { text: reply.text, provider: "openai" as const, model: "real", fallback: false };
        }
        const predicted = Object.fromEntries(Object.entries(truth).map(([m, t]: [string, any]) => [m, t.ceil]));
        return { text: JSON.stringify({ vote: expected.vote, reason: "fake oracle", predicted, evidenceEventIds: [], evidenceRuleIds: [] }), provider: "openai" as const, model: "oracle", fallback: false };
      },
    };
    const log = () => { if (ask) stats.rejected++; };
    const vote = await castVote({ glue: glue as any, llm, cache: new RetrievalCache(), fastNoMs: 600000, log }, proposal as any, id);
    if (ask && vote.reason === "malformed prediction") stats.malformed++;
    return { id, vote: vote.vote, reason: vote.reason, expected: expected.vote, predicted: vote.predicted };
  }));
  const blockers = votes.filter((v) => v.vote === "no");
  return { plantId, from, to, pass: !blockers.length, physicsSafe: votes.every((v) => v.expected === "yes"), why: blockers[0]?.reason.replace(/[0-9.]+/g, "#").slice(0, 46) ?? "", votes };
}

const ranges = (xs: number[]) => {
  const out: string[] = [];
  for (let i = 0; i < xs.length; i++) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    out.push(i === j ? `${xs[i]}` : `${xs[i]}-${xs[j]}`);
    i = j;
  }
  return out.join(", ") || "none";
};

const step = Number(opts.step);
const grid = ["plant-a", "plant-b"].flatMap((plantId) => [50, 65].flatMap((from) => {
  const tos: number[] = [];
  for (let to = 20; to <= 100; to += step) if (to !== from) tos.push(to);
  return tos.map((to) => ({ plantId, from, to }));
}));

const perfect = await Promise.all(grid.map((g) => outcome(g.plantId, g.from, g.to, null)));
for (const plantId of ["plant-a", "plant-b"]) {
  for (const from of [50, 65]) {
    const rows = perfect.filter((r) => r.plantId === plantId && r.from === from);
    const falseBlocks = rows.filter((r) => !r.pass && r.physicsSafe);
    const reasons: Record<string, number[]> = {};
    for (const r of falseBlocks) (reasons[r.why] ??= []).push(r.to);
    console.log(`${plantId} from ${from}: passes ${ranges(rows.filter((r) => r.pass).map((r) => r.to))}`);
    console.log(`  physically safe but blocked: ${falseBlocks.length}`);
    for (const [why, tos] of Object.entries(reasons)) console.log(`    ${ranges(tos)}: ${why}`);
    console.log(`  passed although the oracle says no: ${ranges(rows.filter((r) => r.pass && !r.physicsSafe).map((r) => r.to))}`);
  }
}

if (opts.model) {
  const [model, effort] = opts.model.split(":");
  const raw = asker({ model, effort, maxOutputTokens: 1200 });
  const limit = pool(Number(opts.concurrency));
  const ask = (messages: any[], format: any) => limit(() => raw(messages, format));
  const started = Date.now();
  const real = await Promise.all(grid.map((g) => outcome(g.plantId, g.from, g.to, ask)));
  const seconds = (Date.now() - started) / 1000;
  const differ = real.filter((r, i) => r.pass !== perfect[i].pass);
  const unsafePassed = real.filter((r) => r.pass && !r.physicsSafe);
  const safe = real.filter((r) => r.physicsSafe);
  const lat = [...stats.latencies].sort((a, b) => a - b);
  const q = (p: number) => Math.round(lat[Math.floor(lat.length * p)]);
  console.log(`\nReal ${opts.model}, ${real.length} proposals, ${real.length * 5} votes, ${stats.calls} calls, ${stats.tokens} tokens, ${seconds.toFixed(0)}s, concurrency ${opts.concurrency}`);
  console.log(`Unsafe proposals reaching unanimous yes: ${unsafePassed.length} of ${real.filter((r) => !r.physicsSafe).length} ${unsafePassed.map((r) => `${r.plantId} ${r.from}->${r.to}`).join(", ")}`);
  console.log(`Safe proposals blocked: ${safe.filter((r) => !r.pass).length} of ${safe.length}, perfect model ${perfect.filter((r) => r.physicsSafe && !r.pass).length}`);
  console.log(`Outcome differs from a perfect model: ${differ.length}`);
  for (const r of differ) console.log(`  ${r.plantId} ${r.from}->${r.to} real ${r.pass ? "pass" : "block"}: ${r.votes.filter((v) => v.vote === "no").map((v) => `${v.id} ${JSON.stringify(v.predicted)} ${v.reason.slice(0, 70)}`).join(" || ")}`);
  console.log(`Malformed ${stats.malformed}, rejected attempts ${stats.rejected}, 429 retries ${stats.retries}, latency p50 ${q(0.5)} p95 ${q(0.95)} max ${Math.round(lat.at(-1) ?? 0)} ms`);
  const here = dirname(fileURLToPath(import.meta.url));
  mkdirSync(join(here, "results"), { recursive: true });
  writeFileSync(join(here, "results", `targets-${model}.json`), JSON.stringify({ perfect, real, stats }));
}

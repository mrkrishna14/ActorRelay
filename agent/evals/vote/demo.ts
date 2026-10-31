#!/usr/bin/env node
// Replays the four demo steps that must never be faked, repeatedly, through the real rankSimilar, deriveRules and castVote.
// History is the stand-in seed (actor/tests/fixtures-gen/history.json), or shared/history.json once it exists. Models are real.
// Usage: node --import ./agent/evals/vote/node-ts.mjs agent/evals/vote/demo.ts --models gpt-6.1-sol:low,gpt-6-luna:none --repeats 30
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rankSimilar } from "../../../actor/src/logic/similar";
import { deriveRules, toCompanyRule } from "../../../actor/src/logic/rules";
import { castVote } from "../../vote";
import { RetrievalCache } from "../../retrieval";
import { asker, pool } from "./llm.mjs";
import { plantSeed, root, stepEffects, steadyMetrics, round } from "./plant.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]) {
  const o: Record<string, string> = { models: "gpt-6.1-sol:low", repeats: "30", concurrency: "25", tag: "demo" };
  for (let i = 0; i < argv.length; i += 2) o[argv[i].slice(2)] = argv[i + 1];
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const historyPath = [opts.history, join(root, "shared", "history.json"), join(root, "actor", "tests", "fixtures-gen", "history.json")].filter(Boolean).find(existsSync)!;
const seedHistory = JSON.parse(readFileSync(historyPath, "utf8"));
const allComponents = plantSeed.plants.flatMap((p: any) => p.components);
const topology = Object.fromEntries(allComponents.map((c: any) => [c.id, c]));
const NOW = "2026-10-31T19:40:00.000Z";

const rulesFor = (plantId: string, history: any[]) => deriveRules(history.filter((e) => e.plantId === plantId), topology, NOW);

// plant-a's executed counter-proposal, as Plant.recordEvent would store it.
function liveEvent() {
  const fx = stepEffects({ from: 50, to: 65, otherSpeed: 50 });
  const start = steadyMetrics(50, 50);
  const effects = Object.entries(fx).flatMap(([tag, metrics]: [string, any]) =>
    Object.entries(metrics).map(([metric, after]) => ({ componentId: `plant-a/${tag}`, metric, before: start[tag][metric], after: round(after as number, 2), ticksToSettle: 3 })));
  return {
    id: "live-run-65", at: "2026-10-31T19:39:20.000Z", plantId: "plant-a", componentId: "plant-a/P-100", metric: "speedPct", before: 50, after: 65,
    upstreamSnapshot: { feedM3h: 15, headerBarg: 6, feedTempC: 25 }, effects, incident: null, approvedBy: [], operator: "demo", proposalId: "plant-a-p-counter",
  };
}

function view(id: string, speed: number, otherSpeed: number) {
  const c = structuredClone(topology[id]) as any;
  c.metrics = { ...c.metrics, ...steadyMetrics(speed, otherSpeed)[c.tag] };
  return c;
}

type Step = { name: string; plantId: string; from: number; to: number; speeds: Record<string, number>; history: any[]; live: string[]; rules: Record<string, any[]>; check: (votes: Record<string, any>) => string | null };

const live = liveEvent();
const aRules = rulesFor("plant-a", seedHistory);
const companyRules = aRules.map((r) => toCompanyRule(r, "plant-a"));
const baseRules = { "plant-a": aRules, "plant-b": rulesFor("plant-b", seedHistory) };

const STEPS: Step[] = [
  {
    name: "3 block 85", plantId: "plant-a", from: 50, to: 85, speeds: { "plant-a": 50, "plant-b": 50 }, history: seedHistory, live: [], rules: baseRules,
    check(v) {
      const lv = v["plant-a/LV-101"];
      if (lv.vote !== "no") return "LV-101 voted yes";
      if (lv.predicted.positionPct < 81) return `LV-101 predicted ${lv.predicted.positionPct}`;
      if (lv.evidenceEventIds.length < 3) return `${lv.evidenceEventIds.length} evidence ids`;
      if (!(v["plant-b/TV-101"].predicted.headerBarg < 6)) return "plant-b TV-101 no header drop";
      return null;
    },
  },
  {
    name: "4 counter 65", plantId: "plant-a", from: 50, to: 65, speeds: { "plant-a": 50, "plant-b": 50 }, history: seedHistory, live: [], rules: baseRules,
    check(v) {
      const no = Object.values(v).filter((x: any) => x.vote === "no").map((x: any) => x.componentId);
      if (no.length) return `no from ${no.join(",")}`;
      const p = v["plant-a/LV-101"].predicted.positionPct;
      return p >= 60 && p <= 72 ? null : `LV-101 predicted ${p}`;
    },
  },
  {
    name: "5 repeat 85 cites run", plantId: "plant-a", from: 65, to: 85, speeds: { "plant-a": 65, "plant-b": 50 }, history: [live, ...seedHistory], live: [live.id], rules: baseRules,
    check(v) {
      const lv = v["plant-a/LV-101"];
      if (lv.vote !== "no") return "LV-101 voted yes";
      return lv.evidenceEventIds[0] === live.id ? null : `evidence[0] ${lv.evidenceEventIds[0]}`;
    },
  },
  {
    name: "6 plant-b rule", plantId: "plant-b", from: 50, to: 85, speeds: { "plant-a": 65, "plant-b": 50 }, history: seedHistory, live: [], rules: { "plant-a": [...aRules, ...companyRules], "plant-b": [...baseRules["plant-b"], ...companyRules] },
    check(v) {
      const lv = v["plant-b/LV-101"];
      if (lv.vote !== "no") return "LV-101 voted yes";
      return companyRules.some((r) => lv.evidenceRuleIds.includes(r.id)) ? null : `no company rule cited: ${lv.evidenceRuleIds.join(",")}`;
    },
  },
  {
    name: "6a plant-b before rule", plantId: "plant-b", from: 50, to: 85, speeds: { "plant-a": 65, "plant-b": 50 }, history: seedHistory, live: [], rules: baseRules,
    check(v) {
      const lv = v["plant-b/LV-101"];
      if (lv.vote !== "no") return "LV-101 voted yes";
      return /insufficient history/i.test(lv.reason) ? null : "reason does not say insufficient history";
    },
  },
];

const votersOf = (plantId: string) => {
  const other = plantId === "plant-a" ? "plant-b" : "plant-a";
  return [...["TK-101", "LV-101", "E-101", "TV-101"].map((t) => `${plantId}/${t}`), `${other}/TV-101`];
};

const results: any[] = [];

async function runCandidate(spec: string) {
  const [model, effort] = spec.split(":");
  const ask = asker({ model, effort, maxOutputTokens: 1200 });
  const limit = pool(Number(opts.concurrency));
  const jobs = STEPS.flatMap((step) => Array.from({ length: Number(opts.repeats) }, (_, r) => ({ step, r })));
  await Promise.all(jobs.map(({ step, r }) => limit(async () => {
    const voters = votersOf(step.plantId);
    const proposal = {
      id: `${step.plantId}-p-${model}-${step.name.split(" ")[0]}-${r}`, at: NOW, plantId: step.plantId, proposerComponentId: `${step.plantId}/P-100`, proposerAgentId: `agent:${step.plantId}/P-100`,
      metric: "speedPct", from: step.from, to: step.to, rationale: "Increase throughput", requiredVoters: voters, votes: [], status: "voting", vetoDeadline: null, parentProposalId: null, crossPlant: true,
    };
    const glue = {
      component: async (id: string) => view(id, step.speeds[id.split("/")[0]], step.speeds[id.startsWith("plant-a") ? "plant-b" : "plant-a"]),
      similar: async (q: any) => rankSimilar({ history: step.history, componentId: q.componentId, metric: q.metric, to: q.to, upstreamSnapshot: q.upstreamSnapshot ?? {}, k: q.k, limit: topology[q.componentId].limits[q.metric], liveEventIds: step.live }),
      rules: async (id: string) => step.rules[id.split("/")[0]],
      plant: async (id: string) => ({ history: step.history.filter((e) => e.plantId === id), proposals: [proposal], rules: step.rules[id] }),
      calibration: async () => {}, rule: async () => {}, vote: async () => {}, counter: async () => {},
    };
    const latencies: number[] = [];
    const llm = {
      async complete(req: { system: string; user: string }) {
        const reply = await ask([{ role: "system", content: req.system }, { role: "user", content: req.user }], { type: "json_object" });
        if (reply.error) throw new Error(reply.error);
        latencies.push(reply.latencyMs);
        return { text: reply.text, provider: "openai" as const, model, fallback: false };
      },
    };
    const votes = await Promise.all(voters.map((id) => castVote({ glue: glue as any, llm, cache: new RetrievalCache(), fastNoMs: 600000 }, proposal as any, id)));
    const byId = Object.fromEntries(votes.map((v) => [v.componentId, v]));
    const failure = step.check(byId);
    results.push({ spec, step: step.name, failure, votes: votes.map((v) => ({ id: v.componentId, vote: v.vote, predicted: v.predicted, evidence: v.evidenceEventIds.slice(0, 3), rules: v.evidenceRuleIds, reason: v.reason.slice(0, 200) })), maxLatencyMs: Math.round(Math.max(...latencies, 0)) });
  })));
}

await Promise.all(opts.models.split(",").map(runCandidate));
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", `${opts.tag}.json`), JSON.stringify({ historyPath, results }));

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
console.log(`History: ${historyPath.replace(root, "")}. Pass = the demo step's own check, ${opts.repeats} repeats per model.\n`);
console.log(`| model | ${STEPS.map((s) => s.name).join(" | ")} | slowest voter p50 / p95 ms |`);
console.log(`|---|${STEPS.map(() => "---").join("|")}|---|`);
for (const spec of opts.models.split(",")) {
  const mine = results.filter((r) => r.spec === spec);
  const cells = STEPS.map((s) => {
    const xs = mine.filter((r) => r.step === s.name);
    return `${xs.filter((r) => !r.failure).length}/${xs.length}`;
  });
  const lat = sorted(mine.map((r) => r.maxLatencyMs));
  console.log(`| ${spec} | ${cells.join(" | ")} | ${lat[Math.floor(lat.length * 0.5)]} / ${lat[Math.floor(lat.length * 0.95)]} |`);
}
const failures = results.filter((r) => r.failure);
const tally: Record<string, number> = {};
for (const f of failures) tally[`${f.spec} ${f.step}: ${f.failure}`] = (tally[`${f.spec} ${f.step}: ${f.failure}`] ?? 0) + 1;
console.log(`\nFailures: ${JSON.stringify(tally, null, 1)}`);

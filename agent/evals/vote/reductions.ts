#!/usr/bin/env node
// Feed reductions on simulated history: does TK-101 see the temperature rise that passes its margin line?
// Real rankSimilar and castVote, real model, TK-101 only. A deliberately small run at low concurrency.
// Usage: node --import ./agent/evals/vote/node-ts.mjs agent/evals/vote/reductions.ts --history <path> --models gpt-6.1-terra:low --patches none --repeats 2
import { readFileSync } from "node:fs";
import { rankSimilar } from "../../../actor/src/logic/similar";
import { castVote } from "../../vote";
import { RetrievalCache } from "../../retrieval";
import { asker, pool } from "./llm.mjs";
import { PATCHES } from "./patches.mjs";
import { plantSeed, steadyMetrics, tempRise } from "./plant.mjs";

function parseArgs(argv: string[]) {
  const o: Record<string, string> = { models: "gpt-6.1-terra:low", patches: "none", repeats: "2", concurrency: "2", margin: "10", history: "" };
  for (let i = 0; i < argv.length; i += 2) o[argv[i].slice(2)] = argv[i + 1];
  return o;
}

const STEPS = [
  [85, 65], [80, 60], [75, 55], [70, 50], [65, 45], [60, 40], [70, 55], [65, 50], [60, 45], [55, 40], [90, 70], [50, 30],
  [65, 55], [60, 52], [55, 47], [70, 62], [50, 42], [80, 72], [75, 70], [60, 55],
];

const opts = parseArgs(process.argv.slice(2));
const history = JSON.parse(readFileSync(opts.history, "utf8"));
const components = plantSeed.plants.flatMap((p: any) => p.components);
const topology = Object.fromEntries(components.map((c: any) => [c.id, c]));
const margin = Number(opts.margin);

function view(id: string, speed: number) {
  const c = structuredClone(topology[id]) as any;
  c.metrics = { ...c.metrics, ...steadyMetrics(speed, 50)[c.tag] };
  if (c.tag === "TK-101") c.marginPct = margin;
  return c;
}

async function run(spec: string, patchName: string) {
  const [model, effort] = spec.split(":");
  const ask = asker({ model, effort, maxOutputTokens: 1200 });
  const limit = pool(Number(opts.concurrency));
  const patch = PATCHES[patchName];
  const rows: any[] = [];
  const jobs = STEPS.flatMap(([from, to]) => Array.from({ length: Number(opts.repeats) }, (_, r) => ({ from, to, r })));
  await Promise.all(jobs.map(({ from, to, r }) => limit(async () => {
    const id = "plant-a/TK-101";
    const proposal = {
      id: `plant-a-p-down-${model}-${patchName}-${from}-${to}-${r}`, at: "2026-10-31T20:00:00.000Z", plantId: "plant-a", proposerComponentId: "plant-a/P-100", proposerAgentId: "agent:plant-a/P-100",
      metric: "speedPct", from, to, rationale: "Reduce feed rate", requiredVoters: [id], votes: [], status: "voting", vetoDeadline: null, parentProposalId: null, crossPlant: false,
    };
    const plantHistory = history.filter((e: any) => e.plantId === "plant-a");
    const glue = {
      component: async (c: string) => view(c, from),
      similar: async (q: any) => rankSimilar({ history: plantHistory, componentId: q.componentId, metric: q.metric, to: q.to, upstreamSnapshot: q.upstreamSnapshot ?? {}, k: q.k, limit: topology[q.componentId].limits[q.metric], liveEventIds: [] }),
      rules: async () => [],
      plant: async () => ({ history: plantHistory, proposals: [proposal], rules: [] }),
      calibration: async () => {}, rule: async () => {}, vote: async () => {}, counter: async () => {},
    };
    let rawTemp: number | null = null;
    const llm = {
      async complete(req: { system: string; user: string }) {
        const { system, user } = patch(req, null);
        const reply = await ask([{ role: "system", content: system }, { role: "user", content: user }], { type: "json_object" });
        if (reply.error) throw new Error(reply.error);
        try { rawTemp = JSON.parse(reply.text).predicted?.tempC ?? null; } catch { rawTemp = null; }
        return { text: reply.text, provider: "openai" as const, model, fallback: false };
      },
    };
    const vote = await castVote({ glue: glue as any, llm, cache: new RetrievalCache(), fastNoMs: 600000 }, proposal as any, id);
    rows.push({ step: `${from}->${to}`, want: 75 + tempRise(from - to), raw: rawTemp, final: vote.predicted.tempC, vote: vote.vote, similar: vote.similarCount, reason: vote.reason.slice(0, 110) });
  })));
  rows.sort((a, b) => a.step.localeCompare(b.step));
  const line = 85 * (1 - margin / 100);
  const should = rows.filter((x) => x.want >= line);
  const caught = should.filter((x) => x.vote === "no").length;
  const errs = rows.filter((x) => typeof x.raw === "number").map((x) => Math.abs(x.raw - x.want));
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  console.log(`${spec} ${patchName}: past the ${line} line ${caught}/${should.length} voted no, ${rows.filter((x) => x.want < line && x.vote === "no").length}/${rows.length - should.length} no below it, temperature error ${mean.toFixed(2)} C`);
  for (const x of rows) console.log(`  ${x.step} sim ${x.want.toFixed(1)} predicted ${x.raw} final ${x.final} ${x.vote} similar ${x.similar} | ${x.reason}`);
}

for (const spec of opts.models.split(",")) for (const patchName of opts.patches.split(",")) await run(spec, patchName);

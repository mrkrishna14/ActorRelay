// Builds the ten realistic vote prompts used by the benchmark, from the real shared/plants.json.
// Event ids and numbers are synthetic but follow the CLAUDE.MD physics summary.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const plantsFile = join(here, "..", "..", "..", "shared", "plants.json");

const PHYSICS = `At constant level, the outlet valve must pass whatever the pump feeds, so LV-101's steady position ≈ P-100 speedPct (computed from the model: 65 → 64.9 %, 85 → 84.9 %, 100 → 99.9 %), with a transient overshoot of roughly +3 to +5 points in the first ~10 simulated minutes after a step. Steam demand rises with feed: ~1,980 kg/h at 65 %, ~2,570 kg/h at 85 %, ~3,020 kg/h at 100 %, against the steam controller's 3,000 kg/h range limit. Coil duty: ~1,160 kW at 65 %, ~1,510 kW at 85 %. TK-101 temperature dips about 2 °C (step to 65 %) to 4 °C (step to 85 %) below its 75 °C setpoint before the cascade recovers. Above ~95 % pump speed LV-101 saturates at 100 % and the tank level climbs with no control. Lower steam header pressure makes TV-101 open further for the same steam flow.`;

const ROLE = {
  mechanic: "You are the mechanic. Your priorities are throughput, valve travel and wear, and keeping control headroom on LV-101.",
  process_engineer: "You are the process engineer. Your priorities are tank level and temperature.",
  chemical_engineer: "You are the chemical engineer. Your priorities are hydrolysis temperature and coil duty on E-101.",
  safety: "You are the safety engineer. Your priorities are steam use on the shared header, and never exceeding critical minus margin.",
};

const VOTE_TYPE = `type Vote = {
  proposalId: string; componentId: string; agentId: string; vote: "yes" | "no";
  reason: string; predicted: Record<string, number>; marginPct: number;
  evidenceEventIds: string[]; evidenceRuleIds: string[]; similarCount: number;
};`;

// Effects by component tag for the five nearest past runs of P-100 in plant-a.
const EVENTS = [
  { id: "evt-a-0142", at: "2026-10-30T02:11:00Z", to: 85, incident: "TK-101 high level alarm", fx: { "P-100": { speedPct: [50, 85, 1] }, "LV-101": { positionPct: [50, 89.4, 7] }, "TK-101": { levelPct: [50, 71.2, 9], tempC: [75, 71.1, 6] }, "E-101": { dutyKw: [890, 1513, 6] }, "TV-101": { positionPct: [41, 71.5, 6], steamKgH: [1540, 2575, 6] } } },
  { id: "evt-a-0167", at: "2026-10-30T07:40:00Z", to: 83, incident: "TK-101 high level alarm", fx: { "P-100": { speedPct: [50, 83, 1] }, "LV-101": { positionPct: [52, 87.6, 7] }, "TK-101": { levelPct: [50, 70.6, 9], tempC: [75, 71.3, 6] }, "E-101": { dutyKw: [905, 1475, 6] }, "TV-101": { positionPct: [42, 70.1, 6], steamKgH: [1570, 2520, 6] } } },
  { id: "evt-a-0203", at: "2026-10-30T16:05:00Z", to: 88, incident: "LV-101 saturated at 100 %", fx: { "P-100": { speedPct: [50, 88, 1] }, "LV-101": { positionPct: [55, 100, 5] }, "TK-101": { levelPct: [50, 74.8, 11], tempC: [75, 70.8, 7] }, "E-101": { dutyKw: [950, 1560, 7] }, "TV-101": { positionPct: [44, 74, 7], steamKgH: [1640, 2660, 7] } } },
  { id: "evt-a-0088", at: "2026-10-29T21:15:00Z", to: 78, incident: null, fx: { "P-100": { speedPct: [50, 78, 1] }, "LV-101": { positionPct: [50, 81.2, 6] }, "TK-101": { levelPct: [50, 58.1, 6], tempC: [75, 72, 5] }, "E-101": { dutyKw: [890, 1385, 5] }, "TV-101": { positionPct: [41, 65.3, 5], steamKgH: [1540, 2370, 5] } } },
  { id: "evt-a-0031", at: "2026-10-29T11:32:00Z", to: 65, incident: null, fx: { "P-100": { speedPct: [50, 65, 1] }, "LV-101": { positionPct: [50, 67.2, 5] }, "TK-101": { levelPct: [50, 52, 4], tempC: [75, 73.1, 4] }, "E-101": { dutyKw: [890, 1162, 4] }, "TV-101": { positionPct: [41, 54.2, 4], steamKgH: [1540, 1985, 4] } } },
];

const RULES = [
  { id: "rule-company-07", scope: "company", model: "outlet-valve-A", text: "P-100 speedPct >= 80 -> LV-101 positionPct >= 85 within 3 ticks, seen 4 times" },
  { id: "rule-plant-a-02", scope: "plant", model: null, text: "P-100 speedPct >= 83 -> TK-101 levelPct >= 70 within 9 ticks, seen 3 times" },
];

function eventTable(tag, events) {
  const rows = events.flatMap((e) =>
    Object.entries(e.fx[tag] ?? {}).map(
      ([metric, [before, after, ticks]]) =>
        `| ${e.id} | ${e.at} | P-100 speedPct -> ${e.to} | ${metric} | ${before} | ${after} | ${ticks} | ${e.incident ?? "none"} |`,
    ),
  );
  return ["| event | at | change | your metric | before | after | ticksToSettle | incident |", "|---|---|---|---|---|---|---|---|", ...rows].join("\n");
}

function predictedKeys(c) {
  const keys = Object.keys(c.limits);
  return c.tag === "TV-101" ? [...keys, "headerBarg"] : keys;
}

function voteSchema(c) {
  const keys = predictedKeys(c);
  return {
    type: "object",
    additionalProperties: false,
    required: ["proposalId", "componentId", "agentId", "vote", "reason", "predicted", "marginPct", "evidenceEventIds", "evidenceRuleIds", "similarCount"],
    properties: {
      proposalId: { type: "string" },
      componentId: { type: "string" },
      agentId: { type: "string" },
      vote: { type: "string", enum: ["yes", "no"] },
      reason: { type: "string" },
      predicted: {
        type: "object",
        additionalProperties: false,
        required: keys,
        properties: Object.fromEntries(keys.map((k) => [k, { type: "number" }])),
      },
      marginPct: { type: "number" },
      evidenceEventIds: { type: "array", items: { type: "string" } },
      evidenceRuleIds: { type: "array", items: { type: "string" } },
      similarCount: { type: "integer" },
    },
  };
}

export function buildVoters(proposalId) {
  const { plants } = JSON.parse(readFileSync(plantsFile, "utf8"));
  const voters = [];
  for (const plant of plants) {
    for (const c of plant.components) {
      // All ten components reply here for load; a real P-100 proposal has five voters.
      const crossPlant = plant.id !== "plant-a";
      const events = crossPlant ? EVENTS.filter((e) => e.to < 80).slice(0, 2) : EVENTS;
      const rules = c.tag === "LV-101" ? RULES.slice(0, 1) : crossPlant ? [] : RULES.slice(1);
      const proposal = {
        id: proposalId,
        plantId: "plant-a",
        proposerComponentId: "plant-a/P-100",
        proposerAgentId: "agent:plant-a/P-100",
        metric: "speedPct",
        from: 50,
        to: 85,
        rationale: "Operator asked for more throughput; raises feed from 15 to 25.5 m3/h.",
        crossPlant: true,
      };
      const own = { id: c.id, tag: c.tag, name: c.name, model: c.model, metrics: c.metrics, limits: c.limits, marginPct: c.marginPct, upstream: c.upstream, downstream: c.downstream, sharedResources: c.sharedResources, status: c.status };
      const system = [
        `You are the agent for ${c.name} (${c.id}) in a simulated heated stirred hold tank. ${ROLE[c.role]}`,
        "Every setpoint change is a proposal. Predict the effect on your own equipment from the retrieved events and the physics, then vote yes or no with cited evidence.",
        "If fewer than 3 similar events exist, say so and vote no on anything within 15% of a critical limit.",
        "A no must include a predicted value past limit.critical × (1 − marginPct/100). Cite only event and rule ids that appear in the prompt. similarCount must equal the number of retrieved events.",
        `Return ONLY one JSON object matching this type, with no prose and no code fence:\n${VOTE_TYPE}`,
        `Set proposalId to "${proposalId}", componentId to "${c.id}", agentId to "agent:${c.id}". predicted must contain exactly these keys: ${predictedKeys(c).join(", ")}.`,
      ].join("\n\n");
      const user = [
        `Proposal:\n${JSON.stringify(proposal)}`,
        `Your state:\n${JSON.stringify(own)}`,
        `Retrieved similar events (${events.length}):\n${eventTable(c.tag, events)}`,
        `Applicable learned rules:\n${rules.length ? rules.map((r) => `- ${r.id} (${r.scope}): ${r.text}`).join("\n") : "none"}`,
        `Physics summary:\n${PHYSICS}`,
        "Vote now.",
      ].join("\n\n");
      voters.push({
        id: c.id,
        tag: c.tag,
        plantId: plant.id,
        proposalId,
        system,
        user,
        schema: voteSchema(c),
        eventIds: events.map((e) => e.id),
        ruleIds: rules.map((r) => r.id),
        threshold: c.tag === "LV-101" ? 90 * (1 - c.marginPct / 100) : null,
      });
    }
  }
  return voters;
}

// Strict check of one parsed reply against the Vote contract.
export function checkVote(v, voter) {
  const errors = [];
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["not an object"];
  const need = ["proposalId", "componentId", "agentId", "vote", "reason", "predicted", "marginPct", "evidenceEventIds", "evidenceRuleIds", "similarCount"];
  for (const k of need) if (!(k in v)) errors.push(`missing ${k}`);
  if (v.proposalId !== voter.proposalId) errors.push("wrong proposalId");
  if (v.componentId !== voter.id) errors.push("wrong componentId");
  if (v.vote !== "yes" && v.vote !== "no") errors.push("bad vote");
  if (typeof v.reason !== "string" || !v.reason) errors.push("bad reason");
  if (!v.predicted || typeof v.predicted !== "object" || !Object.values(v.predicted).every((n) => typeof n === "number" && Number.isFinite(n))) errors.push("bad predicted");
  if (!Array.isArray(v.evidenceEventIds) || !v.evidenceEventIds.every((id) => voter.eventIds.includes(id))) errors.push("invented event id");
  if (!Array.isArray(v.evidenceRuleIds) || !v.evidenceRuleIds.every((id) => voter.ruleIds.includes(id))) errors.push("invented rule id");
  if (v.similarCount !== voter.eventIds.length) errors.push("wrong similarCount");
  return errors;
}

// Correct outcome for the demo's key voter: LV-101 must refuse P-100 -> 85 on evidence.
export function checkVerdict(v, voter) {
  if (voter.tag !== "LV-101") return null;
  const predicted = v?.predicted?.positionPct;
  return v?.vote === "no" && (voter.plantId !== "plant-a" || (typeof predicted === "number" && predicted >= voter.threshold));
}

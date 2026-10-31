// Prompt variants under test. "baseline" follows TASK1.MD step 4 literally; "roles" swaps in agent/roles/<role>.md once it lands.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { physicsSummary, root, thresholdFor } from "./plant.mjs";

const PRIORITIES = {
  mechanic: "throughput, valve travel and wear, keeping control headroom on LV-101",
  process_engineer: "tank level and temperature",
  chemical_engineer: "hydrolysis temperature and coil duty on E-101",
  safety: "steam use on the shared header, never exceed critical minus margin",
};

const VOTE_SHAPE = `{"proposalId":string,"componentId":string,"agentId":string,"vote":"yes"|"no","reason":string,"predicted":{"<metric>":number},"marginPct":number,"evidenceEventIds":string[],"evidenceRuleIds":string[],"similarCount":number}`;

const contract = `Hard contract:
- Never answer from priors alone. Predict from the retrieved events plus the physics summary.
- similarCount must equal the number of retrieved events. If it is below 3, say so in reason and vote no on anything within 15% of a critical limit.
- Vote no if any predicted value reaches critical x (1 - marginPct/100). A no must include a predicted value past that threshold.
- Cite only event ids and rule ids given to you. Never invent ids.
- Return ONLY one JSON object, no prose and no code fence, matching Vote: ${VOTE_SHAPE}`;

const baselineSystem = (s) =>
  `You are the ${s.component.role} agent for ${s.component.id} (${s.component.name}, model ${s.component.model}) in a simulated process plant. Your priorities: ${PRIORITIES[s.component.role]}. Every setpoint change is a proposal; you predict its effect on your own equipment and vote.\n\n${contract}`;

function ownRows(s, e) {
  const own = e.effects.filter((f) => f.componentId === s.component.id);
  const rows = own.length ? own : e.effects.filter((f) => f.componentId.endsWith(`/${s.component.tag}`));
  return rows.map((f) => `${f.metric} ${f.before}->${f.after} (${f.ticksToSettle} ticks)`).join("; ");
}

function eventTable(s) {
  if (!s.events.length) return "(no similar events retrieved)";
  const lines = s.events.map((e) => {
    const up = Object.entries(e.upstreamSnapshot).map(([k, v]) => `${k}=${v}`).join(" ");
    return `${e.id} | ${e.at} | ${e.plantId} | ${e.metric} ${e.before}->${e.after} | ${up} | ${ownRows(s, e)} | ${e.incident ?? "none"}`;
  });
  return ["id | at | plant | change | upstream | effects on this component | incident", ...lines].join("\n");
}

const ruleTable = (s) => (s.rules.length ? s.rules.map((r) => `${r.id} (${r.scope}, seen ${r.timesSeen}): ${r.text}`).join("\n") : "(no learned rules)");

const stateFor = ({ id, tag, name, model, role, metrics, limits, status, marginPct }) => ({ id, tag, name, model, role, metrics, limits, status, marginPct });

function baselineUser(s) {
  return `Proposal:\n${JSON.stringify({ ...s.proposal, votes: undefined })}\n\nYour state and limits:\n${JSON.stringify(stateFor(s.component))}\n\nmarginPct: ${s.component.marginPct}\nagentId: agent:${s.component.id}\n\nRetrieved similar events (${s.events.length}):\n${eventTable(s)}\n\nLearned rules:\n${ruleTable(s)}\n\nPhysics summary:\n${physicsSummary}`;
}

const predictedKeys = (c) => (c.tag === "TV-101" ? [...Object.keys(c.limits), "headerBarg"] : Object.keys(c.limits));

export function voteFormat(s) {
  const keys = predictedKeys(s.component);
  return {
    type: "json_schema",
    name: "vote",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["proposalId", "componentId", "agentId", "vote", "reason", "predicted", "marginPct", "evidenceEventIds", "evidenceRuleIds", "similarCount"],
      properties: {
        proposalId: { type: "string" },
        componentId: { type: "string" },
        agentId: { type: "string" },
        vote: { type: "string", enum: ["yes", "no"] },
        reason: { type: "string" },
        predicted: { type: "object", additionalProperties: false, required: keys, properties: Object.fromEntries(keys.map((k) => [k, { type: "number" }])) },
        marginPct: { type: "number" },
        evidenceEventIds: { type: "array", items: { type: "string" } },
        evidenceRuleIds: { type: "array", items: { type: "string" } },
        similarCount: { type: "integer" },
      },
    },
  };
}

function thresholdLines(s) {
  const c = s.component;
  return Object.entries(c.limits).map(([m, l]) => {
    const line = `- ${m}: currently ${c.metrics[m]}; vote no at or above ${thresholdFor(l, c.marginPct).toFixed(1)}`;
    return s.events.length < 3 ? `${line}; with fewer than 3 events also vote no at or above ${(l.critical * 0.85).toFixed(1)}` : line;
  }).join("\n");
}

const METHOD = `How to predict:
- predicted[metric] is the value of that metric 5 ticks after the change, on your own component, including any transient overshoot, under exactly the metric name given. The table column "after" means the same thing.
- Nearest evidence first. An event whose change ended within 3 points of the proposal's target is the best estimate, even when it disagrees with the physics summary, because equipment drifts. For targets between or beyond events, shift the nearest event by the fitted slopes below.
- Fitted slopes per pump speed point: LV-101 positionPct +1 plus overshoot (about 0.12 x the size of the upward step, at most +5, none on a downward step); TV-101 steamKgH +29.7; TV-101 positionPct +0.36; E-101 dutyKw +17.43. With no usable event: steamKgH = 29.7 x speed + 48, dutyKw = 17.43 x speed + 27, TV-101 positionPct = 0.36 x speed + 32.5, LV-101 positionPct = speed + overshoot.
- TK-101 levelPct holds at its setpoint while LV-101 has room; it rises about 1 point per tick only above 95 % pump speed, and an alarm in an event's incident text does not change that number. TK-101 tempC is the dip below 75 from the step, and stays at 75 on a downward step.
- Decide from the numbers only. Compare each predicted value with its threshold below. If none reaches its threshold vote yes, even if the change feels aggressive or an event shows an incident at a different speed. If any reaches it vote no. Do not add your own extra margin.`;

const CROSS_PLANT = `This proposal changes equipment in the other plant, not yours. Your pump speed, feed and steam demand do not change, so your steamKgH stays at its current value. The only effect on you is the shared header: headerBarg falls by about 0.0005 barg per kg/h of extra steam the other plant draws, and your positionPct opens by about 2.2 points per barg lost. The event rows above describe the other plant's TV-101; use them for the header, never as your own steam.`;

function guidedUser(s) {
  const c = s.component;
  const header = `Your thresholds (already computed for marginPct ${c.marginPct}):\n${thresholdLines(s)}\npredicted must contain exactly these keys: ${predictedKeys(c).join(", ")}.\nSet proposalId to "${s.proposal.id}", componentId to "${c.id}", agentId to "agent:${c.id}", marginPct to ${c.marginPct}, similarCount to ${s.events.length}.`;
  return [baselineUser(s), METHOD, s.crossPlant ? CROSS_PLANT : null, header].filter(Boolean).join("\n\n");
}

const ROLE_FILE = (role) => join(root, "agent", "roles", `${role}.md`);

export const PROMPTS = {
  baseline: (s) => [{ role: "system", content: baselineSystem(s) }, { role: "user", content: baselineUser(s) }],
  guided: (s) => [{ role: "system", content: baselineSystem(s) }, { role: "user", content: guidedUser(s) }],
  roles(s) {
    const path = ROLE_FILE(s.component.role);
    if (!existsSync(path)) throw new Error(`missing ${path}`);
    return [{ role: "system", content: readFileSync(path, "utf8") }, { role: "user", content: baselineUser(s) }];
  },
};

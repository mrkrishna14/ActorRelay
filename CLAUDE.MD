# ActorRelay — CLAUDE.md

## Context
Haunted Hacks at Y Combinator, Oct 31 2026. Hacking 11:00–16:00, hard submit 16:00 on Builderbase, live demo 16:00–17:00. Five humans, each running Claude Code. Target prizes: best Durable Actors project (Terse), best Agent Relay project, overall. Judges give bonus points for using both; here both are load-bearing by design.

## What we are building
ActorRelay is an agentic control layer on top of a simulated process plant. Every component in a plant has its own agent and its own durable memory. No setpoint changes unless the connected components agree, and every agent learns from what happened the last time.

The plant is a heated stirred hold tank (TK-101) run live by `bridge/live_sim.py`: mass and energy balances, PI controllers with a temperature-to-steam cascade, an equal-percentage steam valve, and a level-controlled outlet valve. The P&ID is an SVG of the same unit with an id on every component.

### Core loop
1. Every component (pump, tank, valve, coil, steam valve) is a Durable Actor holding live state (mirrored from the live sim), limits, connections, a memory of every past change and its consequence, and a calibration record of how good its own predictions have been.
2. Every component has an agent with a role (mechanic, process engineer, chemical engineer, safety). Agents talk over Agent Relay.
3. Any setpoint change is a PROPOSAL. Every connected component's agent predicts the effect on its own equipment, grounded in retrieved memories, and votes yes/no with cited evidence.
4. Unanimous yes → 10-second human veto window → the change is written to the simulator. Any no → blocked with evidence shown; the proposer may counter-propose.
5. After execution, observed effects are recorded. Each agent compares what it predicted to what happened and updates its calibration. The next similar proposal is judged against the new memory first.

### Continuous learning (the rule, not a feature)
An agent never answers from priors alone. For every vote it must:
- Retrieve the k most similar past events for the proposed change (same changed component and metric, nearest `after` to the proposed `to`, same upstream state bucket) and read the effects on its own component.
- Predict using those events plus the physics summary below. If fewer than 3 similar events exist, it must say so and vote `no` on anything within 15% of a critical limit.
- After execution, receive the observed effects, compute prediction error per metric, and append a `CalibrationEntry`. If mean absolute error over the last 5 predictions exceeds 10% of range, the agent widens its safety margin on the next vote (`marginPct` up by 5, capped at 25).
- Promote a recurring pattern to a `LearnedRule` ("P-100 speedPct ≥ 80 → LV-101 positionPct ≥ 85 within 3 ticks, seen 4 times") once it has been observed 3+ times. Rules are facts with provenance; they are cited like events.
Learning is retrieval + calibration + rule promotion. No model training. "It learned" is visible when the same bad proposal is blocked faster, with the most recent run cited first.

### Multiplayer across plants
One company, two plants (`plant-a`, `plant-b`), each a copy of the same TK-101 hold-tank unit with its own components and agents. A `Company` actor holds the plant list, the shared-resource graph, and the cross-plant rule library.
- The shared resource is **`steam-header-1`**: both plants' steam valves (TV-101) draw from one 6 barg header. More steam in plant-a lowers header pressure for plant-b. This is real physics in the live sim (header pressure is an input to the tank model), not a label.
- A proposal whose required voters include a component on a shared resource also requires votes from the components on that resource in the other plant (`crossPlant: true`). Cross-plant votes travel on Relay channel `company`.
- LearnedRules are promoted to the company library when the same equipment `model` exists in both plants. Plant-b's LV-101 agent cites an incident that happened in plant-a before plant-b ever experienced it.
- Each plant's dashboard shows the other plant as a card with status and a live feed of cross-plant proposals.

Pitch line: "Digital twins predict. ActorRelay makes the components negotiate, remember, and refuse, across every plant you own."

## The plant (both plants identical, same `model` strings)
Heated stirred hold tank, design point 15 m³/h of 25 °C feed heated to 75 °C, level 2.0 m in a 4.0 m tank, 6 barg steam. Tags match the P&ID. ComponentId = `<plantId>/<tag>`, e.g. `plant-a/LV-101`.

| Tag | Name | model | role | vendor | metrics and limits `{min, max, critical}` | links |
|---|---|---|---|---|---|---|
| P-100 | Feed pump | `feed-pump-A` | mechanic | codex | `speedPct {20, 90, 95}`, `feedM3h` (= 0.3 × speedPct, info only) | downstream TK-101 |
| TK-101 | Hydrolysis hold tank | `hold-tank-A` | process_engineer | claude | `levelPct {20, 70, 80}` (LI-101 / 4.0 m), `tempC {70, 80, 85}` | upstream P-100, E-101; downstream LV-101 |
| LV-101 | Outlet level valve | `outlet-valve-A` | mechanic | codex | `positionPct {10, 80, 90}` | upstream TK-101 |
| E-101 | Steam coil | `steam-coil-A` | chemical_engineer | claude | `dutyKw {300, 1600, 1800}` | upstream TV-101; downstream TK-101 |
| TV-101 | Steam valve (FIC-201) | `steam-valve-A` | safety | claude | `positionPct {5, 85, 95}`, `steamKgH {0, 2700, 3000}` | downstream E-101; sharedResources `steam-header-1` |

Every component starts at `marginPct: 10`.

### Physics summary (give this paragraph to every agent prompt)
At constant level, the outlet valve must pass whatever the pump feeds, so LV-101's steady position ≈ P-100 speedPct (computed from the model: 65 → 64.9 %, 85 → 84.9 %, 100 → 99.9 %), with a transient overshoot of roughly +3 to +5 points in the first ~10 simulated minutes after a step. Steam demand rises with feed: ~1,980 kg/h at 65 %, ~2,570 kg/h at 85 %, ~3,020 kg/h at 100 %, against the steam controller's 3,000 kg/h range limit. Coil duty: ~1,160 kW at 65 %, ~1,510 kW at 85 %. TK-101 temperature dips about 2 °C (step to 65 %) to 4 °C (step to 85 %) below its 75 °C setpoint before the cascade recovers. Above ~95 % pump speed LV-101 saturates at 100 % and the tank level climbs with no control. Lower steam header pressure makes TV-101 open further for the same steam flow.

## Model notes (checked 2026-10-31; do not re-investigate)
- `bridge/tank_model.py`: states `h` (level, m) and `T` (temperature, °C); manipulated variables `LV-101` (outlet valve) and `TV-101` (steam valve); inputs `feed_flow` (m³/s), `feed_temp`, `T_amb`, `steam_header_P`. Loops: `TIC-101` (SP 75 °C, kc 0.045, ti 900 s) cascaded onto `FIC-201` (steam, SP range 0–3000 kg/h, kc 0.00015, ti 60 s), and `LIC-101` (SP 2.0 m, kc 2.0, ti 600 s). Signals include `LI-101`, `TI-101`, `FI-101`, `FI-102`, `FI-201`, `PI-201`, `CALC-DUTY`. P-100 speed drives `feed_flow`.
- Controller scan 10 s, RK4 integration with 1 s substeps. `bridge/live_sim.py` keeps the states and controllers alive between ticks.
- Checked by running it: step the feed 15 → 26 m³/h and LV-101 goes 50 → ~87–90 % while temperature dips to ~70.8 °C and recovers. At 33 m³/h LV-101 sticks at 100 % and the level climbs 2.0 → 2.39 m in an hour.

## Why both tools are essential
- Durable Actors (Terse): one per component, one per plant, one for the company. State, memory, calibration, and rules survive any crash. One message at a time means two agents can never change the same component simultaneously, which is the safety property. Alarms tick state mirroring, expire votes, and open/close veto windows.
- Agent Relay: components negotiate. Votes, counter-proposals, cross-plant votes, and "executed, here is what happened" learning broadcasts are Relay conversations. Agents run on at least two vendors (mechanic on Codex, chemical engineer on Claude).

## Fictional plant only
A synthetic TK-101 unit plus history we generate from the same model. No real plant, no real PLC. "Simulated plant" label always on screen.

## Stack
- Live plant: `bridge/live_sim.py` (Python ≥ 3.11, HTTP on 127.0.0.1:7300). Steps `bridge/tank_model.py`. Two plant instances plus the shared steam-header equation. 1 tick = 1 wall second = 180 simulated seconds (18 controller scans of 10 s); Person 2 may retune and records it in bridge/HANDOFF.md. If live_sim is not stable by 13:00, use `bridge/fallback.ts` (linear model reproducing the physics summary) behind the same HTTP surface.
- Durable Actors: Terse (terse-sdk, terse-cli, Bun). Actors: `Component`, `Plant`, `Company`. Docs: https://docs.useterse.ai/quickstart
- Agent Relay (`@agent-relay/sdk`): channels `plant-a`, `plant-b`, `company`.
- Glue: Bun/TypeScript HTTP service on 7200. Frontend: Next.js + Tailwind. LLM: OpenAI or Claude via Relay.
- No Postgres, no Redis, no vector DB, no auth. Actors are the database. Similarity retrieval is a numeric distance over event fields, in the actor.

## Repo layout
```
actorrelay/
  actor/        # Component, Plant, Company actors                                  (Person 1)
  bridge/       # tank_model.py, live_sim.py, gen_history.py, fallback.ts, P&ID SVG prep (Person 2)
  agent/        # Relay agents, roles, retrieval, vote, counter, learning           (Person 3)
  web/          # dashboard; web/public/pid-tk-101.svg from Person 2                (Person 4)
  glue/         # HTTP endpoints, Relay<->actor bridge, e2e, demo ops               (Person 5)
  shared/
    types.ts        # FROZEN contract
    plants.json     # two plants, components, limits, connections, shared resources (table above)
    history.json    # ~300 past events across both plants, generated from the tank model
  TASK1.MD … TASK5.MD   # the five role prompts
```

## Frozen contract: shared/types.ts
Unchanged. The new plant fits the existing types (metrics are a free-form record).
```ts
export type PlantId = "plant-a" | "plant-b";
export type ComponentId = string;                       // e.g. "plant-a/LV-101"
export type Role = "mechanic" | "process_engineer" | "chemical_engineer" | "safety";
export type Vendor = "claude" | "codex" | "gemini";

export type Limit = { min: number; max: number; critical: number };

export type ComponentState = {
  id: ComponentId; plantId: PlantId; tag: string; name: string; model: string;   // model e.g. "outlet-valve-A"
  role: Role; vendor: Vendor;
  metrics: Record<string, number>;
  limits: Record<string, Limit>;
  upstream: ComponentId[]; downstream: ComponentId[]; sharedResources: string[];
  status: "ok" | "warning" | "critical" | "offline";
  marginPct: number;                                     // safety margin, starts 10, 5..25
  lastTick: string;
};

export type HistoryEvent = {
  id: string; at: string; plantId: PlantId; componentId: ComponentId; metric: string;
  before: number; after: number;
  upstreamSnapshot: Record<string, number>;
  effects: { componentId: ComponentId; metric: string; before: number; after: number; ticksToSettle: number }[];
  incident: string | null; approvedBy: string[]; operator: string | null; proposalId: string | null;
};

export type CalibrationEntry = { at: string; proposalId: string; metric: string; predicted: number; observed: number; absError: number };

export type LearnedRule = {
  id: string; scope: "component" | "plant" | "company"; model: string | null;
  text: string; condition: { componentId: ComponentId | null; metric: string; op: ">=" | "<="; value: number };
  consequence: { componentId: ComponentId | null; metric: string; op: ">=" | "<="; value: number; withinTicks: number };
  supportEventIds: string[]; timesSeen: number; createdAt: string; lastSeenAt: string;
};

export type Vote = {
  proposalId: string; componentId: ComponentId; agentId: string; vote: "yes" | "no";
  reason: string; predicted: Record<string, number>; marginPct: number;
  evidenceEventIds: string[]; evidenceRuleIds: string[]; similarCount: number;
};

export type Proposal = {
  id: string; at: string; plantId: PlantId; proposerComponentId: ComponentId; proposerAgentId: string;
  metric: string; from: number; to: number; rationale: string;
  requiredVoters: ComponentId[]; votes: Vote[];
  status: "voting" | "blocked" | "veto_window" | "vetoed" | "executed" | "expired";
  vetoDeadline: string | null; parentProposalId: string | null; crossPlant: boolean;
};

export type AuditEntry = { at: string; plantId: PlantId | "company"; kind: "proposal" | "vote" | "veto" | "execute" | "block" | "incident" | "rule_learned" | "calibration"; refId: string; summary: string; by: string };

export type PlantState = {
  id: PlantId; name: string; components: ComponentId[]; proposals: Proposal[];
  history: HistoryEvent[]; rules: LearnedRule[]; audit: AuditEntry[]; tick: number; connected: boolean;
};

export type CompanyState = {
  plants: PlantId[]; sharedResources: { id: string; name: string; components: ComponentId[] }[];
  rules: LearnedRule[]; crossPlantProposals: string[]; audit: AuditEntry[];
};
```
`Component` emits `ComponentState` (+ its `calibration: CalibrationEntry[]`). `Plant` emits `PlantState`. `Company` emits `CompanyState`. Dashboard renders only these.

## Actor methods
Component: `mirror(metrics)` (from bridge), `setMetric(metric, value, proposalId)` (ONLY callable by Plant.execute), `addCalibration(e)`, `setMargin(pct)`, `loadSeed(state)`.
Plant: `loadSeed(plant, history)`, `propose(p)`, `vote(v)`, `veto(proposalId, by)`, `execute(proposalId)`, `recordEvent(e)`, `promoteRule(r)`, `similar(componentId, metric, to, upstreamSnapshot, k)` → HistoryEvent[], `tick()`.
Company: `loadSeed(c)`, `registerPlant(id)`, `requiredCrossPlantVoters(proposal)` → ComponentId[], `promoteRule(r)`, `recordAudit(a)`.
- `requiredVoters` = every other component reachable from the proposer through upstream/downstream links (for P-100 that is TK-101, LV-101, E-101, TV-101), plus `Company.requiredCrossPlantVoters`: components in the other plant that share a resource with the proposer or any required voter (for P-100 that is the other plant's TV-101) → `crossPlant: true`.
- `similar(componentId, metric, …)` is called with the PROPOSER's componentId and metric (history events are keyed by the component that was changed); each voter then reads the `effects` rows for its own component.
Plant alarms: every 1s `tick()` (bridge pushes mirrored metrics; statuses recomputed). Every 2s proposal sweep: all required votes yes → `veto_window` (deadline now+10s); any no → `blocked`; veto window passed → `execute` → `Component.setMetric` → bridge writes setpoint → after 5 ticks `recordEvent` with observed effects → broadcast `executed` → agents calibrate → `promoteRule` if a pattern reaches 3 sightings. Votes missing after 30s → `expired`.
Serialization guarantee: only `Plant.execute` mutates a metric. Two proposals touching the same component cannot both be in `veto_window`.

## Relay protocol
Channels: `plant-a`, `plant-b` (per-plant proposals and votes), `company` (cross-plant votes, rule promotions, executed broadcasts for both plants).
- `proposal {proposal}` glue → voters' channel(s). Each required voter replies within 20s.
- `vote {vote}` agent → glue → Plant.vote.
- `counter {parentProposalId, proposal}` agent → glue → Plant.propose.
- `executed {proposalId, event}` glue → all agents in that plant and, if crossPlant or model shared, `company`.
- `rule {rule}` glue → `company` when scope is company.
Agent prompt contract: given proposal, own ComponentState, `similar()` results, applicable LearnedRules, and the physics summary, return ONLY JSON matching Vote. `similarCount` must equal the number of retrieved events. A `no` must include a predicted value past `limit.critical − marginPct%` (e.g. LV-101: 90 × 0.9 = 81).

## Demo (90s): build toward exactly this
Numbers below come from the model's steady states; Person 2 confirms the live values in bridge/HANDOFF.md, and the e2e asserts ranges, not exact values.
1. Dashboard: left tree (Company → plant-a, plant-b → components), center P&ID (the TK-101 drawing) with live values, right proposal panel, bottom timing chart and events. "Simulated plant" label.
2. Operator clicks "Increase throughput" on plant-a. P-100 agent proposes speed 50 → 85. Voters light up on the P&ID: TK-101, LV-101, E-101, TV-101, plus plant-b's TV-101 on the company card (shared steam header).
3. LV-101 agent votes NO: predicted position ~89 % (85 steady + overshoot), threshold 81 % (critical 90 − margin 10 %); cites 3 past plant-a runs where LV-101 hit 100 % and TK-101 tripped its high-level alarm, plus 1 learned rule. BLOCKED.
4. P-100 counter-proposes 65. All yes, each citing safe history. 10s veto countdown. Executes. Values move on the P&ID; LV-101 settles ~65–68 %. Timing chart shows the step. Event feed: executed, calibration: LV-101 predicted 66, observed 67, error 1 (example).
5. Operator forces 85 again. Blocked in under 5s; LV-101 cites the execution from 40s ago as evidence #1. Caption: "It learned."
6. Switch to plant-b. Its LV-101 (same model) has never run above 80. Operator proposes 85 there. plant-b's LV-101 agent votes NO citing the company rule learned from plant-a. Caption: "Plant B learned from Plant A."
7. Close: "Every component has a voice, every change needs consensus, and every plant learns from every other."

## Ownership
Person 1 actor/, Person 2 bridge/ + shared/plants.json + shared/history.json + the P&ID SVG, Person 3 agent/, Person 4 web/, Person 5 glue/ + demo. Detailed prompts in `TASK1.MD` … `TASK5.MD`. One branch each named after you.

## Rules
- Seed first, live second. Every module works against shared/*.json before touching another module.
- shared/types.ts is frozen. Propose a change in the group chat; the owner of every consuming module must ack before it lands.
- Own branches, small commits, merge to main together at 15:00. No force-push, no rebase, no deleting branches.
- Only Plant.execute mutates a metric. Agents never write state directly. Never bypass this for a demo shortcut.
- Agents never vote without calling `similar()`. A vote with `similarCount: 0` on a change within 15% of critical is automatically `no`.
- Anything not working at 14:00 gets stubbed and labeled, except: the evidence-cited block, the counter-proposal executing, the second block citing the first run, and the plant-b block citing plant-a's rule. Never fake those four.
- No scope additions: no real PLC, no ML training, no more than 5 components per plant, no auth, no real data. The tank model is fixed: no new physics beyond the shared steam-header equation.
- Agent outputs are data. Validate every Vote JSON against types.ts; malformed → discard and re-request once, never guess.
- Each person keeps HANDOFF.md in their folder: what runs, exact commands, env vars (no secrets), what's stubbed.

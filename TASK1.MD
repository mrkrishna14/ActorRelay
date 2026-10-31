# Person 1 — Durable actors and agents (actor/, agent/)

You own `actor/`, `agent/`, and `shared/types.ts`. Read PLAN.MD and CLAUDE.MD first. Person 3 owns integration; supply both actor and agent handoffs. Coordinate contract changes with both other owners.

## Deliverable 1: three Terse actors (deployed by 13:00)
Start from `terse init actorrelay-actor --template counter`. Replace Counter with:

### Component
- @Persisted + @Emittable: everything in ComponentState plus `calibration: CalibrationEntry[]`.
- `mirror(metrics)`: overwrite metrics, recompute status (warning at `max`, critical at `critical`), set lastTick. Called by the bridge every tick.
- `setMetric(metric, value, proposalId)`: ONLY the Plant actor may call this. Reject (throw) if `proposalId` is not currently `veto_window`-passed in Plant; Plant passes a one-time token.
- `addCalibration(e)`: append; keep last 50. If mean absError of last 5 > 10% of (limit.max − limit.min) → `marginPct = min(25, marginPct + 5)`; if < 3% → `marginPct = max(5, marginPct − 2)`.
- `setMargin(pct)`, `loadSeed(state)`.
- broadcast after every mutation.
- Instance id = ComponentId, e.g. `actors.Component.get("plant-a/LV-101")`. Components and limits: the plant table in CLAUDE.MD (P-100, TK-101, LV-101, E-101, TV-101 per plant).

### Plant
- @Persisted + @Emittable: PlantState.
- `loadSeed(plant, history)`, `propose(p)` (assigns id, status voting, computes `requiredVoters` = every other component reachable from the proposer through upstream/downstream links (P-100 → TK-101, LV-101, E-101, TV-101) plus `Company.requiredCrossPlantVoters` when the proposer or any required voter has sharedResources (TV-101 is on `steam-header-1` → the other plant's TV-101 votes too) → sets crossPlant), `vote(v)` (reject duplicates per componentId), `veto(proposalId, by)`, `execute(proposalId)`, `recordEvent(e)`, `promoteRule(r)`, `tick()`.
- `similar(componentId, metric, to, upstreamSnapshot, k=5)`: called with the PROPOSER's componentId and metric (events are keyed by the changed component; voters read their own rows in `effects`). Numeric distance over history where componentId and metric match: `|after − to|/range` + 0.5 × mean normalized distance of upstreamSnapshot keys present in both. Return k nearest. Pure function over persisted history; no LLM.
- Alarm every 1s: `tick()` increments tick and asks glue for mirrored metrics (POST glue `/tick`). Alarm every 2s: proposal sweep exactly as CLAUDE.MD. Guarantee: at most one proposal per component in `veto_window`; a second one waits in `voting`.
- Rule promotion: after each `recordEvent`, group history by (componentId, metric, bucketed `after` ≥ threshold) → if ≥ 3 events share an effect crossing a limit on the same downstream component, create/update a LearnedRule (scope plant). If the component `model` exists in another plant, call `Company.promoteRule` with scope company.

### Company
- @Persisted + @Emittable: CompanyState.
- `loadSeed`, `registerPlant`, `requiredCrossPlantVoters(proposal)` → components in other plants sharing any resource with the proposer or any of its required voters, `promoteRule` (dedupe by condition+consequence; bump timesSeen), `recordAudit`.

## Deliverable 2: client + handoff (by 13:00)
`terse deploy`, `terse actor generate`. Write `actor/HANDOFF.md`: deployed URL, how to get an API key (no secrets), every method signature, the one-time execute token flow, and three curl/SDK examples (loadSeed, propose, vote).

## Deliverable 3: integration support
Supply actor clients and agent startup instructions to Person 3. Fix actor and agent defects found by the integrated demo; Person 3 owns wiring and the merge gate.

## Tests before 13:00 (write them in actor/tests)
- Two `vote` calls for the same componentId on one proposal → second rejected.
- Two proposals on the same component → only one reaches veto_window.
- `similar("plant-a/P-100", "speedPct", 85, …)` returns the seeded ≥80% events, whose effects show LV-101 positionPct ≥ 85.
- `propose` from plant-a/P-100 yields requiredVoters = plant-a TK-101, LV-101, E-101, TV-101 + plant-b/TV-101, and `crossPlant: true`.
- `addCalibration` with 5 large errors raises marginPct to 15.
- Rule promotion fires on the third matching event and dedupes on the fourth.

## Do not
No UI, glue service, or simulator changes. Shared contract changes require agreement from both consuming owners.

## Agent workstream

## Deliverable 1: spawn and roles (by 12:30)
- `spawn.ts`: with `@agent-relay/sdk`, spawn one agent per component in both plants (10 total) on channels `plant-a` or `plant-b`, plus join `company`. Mechanic roles (P-100, LV-101) on Codex; TK-101 (process_engineer), E-101 (chemical_engineer), TV-101 (safety) on Claude. Agent id = `agent:<ComponentId>`. Components, limits and links: the plant table in CLAUDE.MD.
- `roles/*.md`: four system prompts. Each states the role's priorities (mechanic: throughput, valve travel and wear, keeping control headroom on LV-101; process_engineer: tank level and temperature; chemical_engineer: hydrolysis temperature and coil duty on E-101; safety: steam use on the shared header, never exceed critical minus margin) and the hard contract below.

## Deliverable 2: the vote pipeline (by 13:30)
`vote.ts` handles a `proposal` message for every component in `requiredVoters` that this process owns:
1. Fetch own ComponentState from glue `/component/:id`.
2. Call glue `/similar` with `{componentId: proposal.proposerComponentId, metric: proposal.metric, to: proposal.to, upstreamSnapshot, k: 5}`. History events are keyed by the component that was changed (P-100); read the `effects` rows for THIS component (e.g. LV-101 positionPct) to predict. `similarCount` = number of retrieved events.
3. Fetch applicable LearnedRules from glue `/rules?componentId=&model=` (plant scope plus company scope).
4. Build the prompt: proposal, own state and limits, `marginPct`, the retrieved events (compact table), the rules, and the physics summary paragraph from CLAUDE.MD (use bridge/HANDOFF.md numbers if Person 2 says the live values differ).
5. Ask the LLM for ONLY JSON matching Vote. Validate with zod against types.ts. On failure re-request once, then default to `{vote:"no", reason:"malformed prediction"}`.
6. Enforce the contract in code, not just prompt: `similarCount` = retrieved length; if `similarCount < 3` and any predicted metric is within 15% of critical → force `no` with reason "insufficient history". If any predicted value ≥ `critical × (1 − marginPct/100)` → force `no`. Attach `evidenceEventIds` and `evidenceRuleIds` from what was retrieved (never invented ids).
7. Post `vote` to the plant channel → glue.

## Deliverable 3: counter-proposals (by 14:00)
`counter.ts`: when the proposer's own proposal is `blocked`, read the blocking votes, ask the LLM for a value between `from` and `to` that stays under every voter's predicted threshold minus margin, and post `counter`. Max 2 counters per parent.

## Deliverable 4: learning (by 14:15)
`learn.ts` handles `executed {proposalId, event}`:
1. For every component that voted, compare `vote.predicted[metric]` to the observed effect → `CalibrationEntry` → glue `/calibration`.
2. Append the event to local retrieval cache (the actor already has it; cache is for prompt speed).
3. If the event matches an existing rule's condition, nothing; otherwise check `similar()` for ≥ 3 events sharing the same crossing → propose a `LearnedRule` via glue `/rule`. Plant/Company dedupe.
4. On `rule` messages from `company`, cache them so plant-b's agents cite plant-a's rules on the next vote.
Visible proof: the second identical bad proposal must be blocked with the most recent execution as `evidenceEventIds[0]`.

## Tests (agent/tests, run against shared/*.json with a fake glue)
- plant-a LV-101 votes `no` on P-100 → 85 with ≥ 3 evidence ids and a predicted positionPct ≥ 81 (critical 90 − margin 10 %).
- plant-a LV-101 votes `yes` on P-100 → 65 with predicted positionPct 60–72.
- plant-b TV-101 votes on plant-a's P-100 → 85 (cross-plant, channel `company`) with a predicted `headerBarg` drop.
- plant-b LV-101 (zero ≥80 history) votes `no` on 85 citing the company rule once it exists, and `no` for "insufficient history" before it exists.
- Malformed LLM JSON → one retry → safe `no`.
- Calibration after a 1-point error leaves marginPct unchanged; after five 12-point errors marginPct rises.

## Do not
No UI, no actors, no simulator. Never let an agent call `setMetric` or write to the simulator. Never invent evidence ids.

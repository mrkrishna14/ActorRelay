# Person 3 — Agents, voting, learning (agent/)

You own `agent/`. Read CLAUDE.md and shared/types.ts first. Do not touch actor/, bridge/, web/, glue/.

## Deliverable 1: spawn and roles (by 12:30)
- `spawn.ts`: with `@agent-relay/sdk`, spawn one agent per component in both plants (10 total) on channels `plant-a` or `plant-b`, plus join `company`. Mechanic roles (P-100, LV-101) on Codex; TK-101 (process_engineer), E-101 (chemical_engineer), TV-101 (safety) on Claude. Agent id = `agent:<ComponentId>`. Components, limits and links: the plant table in CLAUDE.md.
- `roles/*.md`: four system prompts. Each states the role's priorities (mechanic: throughput, valve travel and wear, keeping control headroom on LV-101; process_engineer: tank level and temperature; chemical_engineer: hydrolysis temperature and coil duty on E-101; safety: steam use on the shared header, never exceed critical minus margin) and the hard contract below.

## Deliverable 2: the vote pipeline (by 13:30)
`vote.ts` handles a `proposal` message for every component in `requiredVoters` that this process owns:
1. Fetch own ComponentState from glue `/component/:id`.
2. Call glue `/similar` with `{componentId: proposal.proposerComponentId, metric: proposal.metric, to: proposal.to, upstreamSnapshot, k: 5}`. History events are keyed by the component that was changed (P-100); read the `effects` rows for THIS component (e.g. LV-101 positionPct) to predict. `similarCount` = number of retrieved events.
3. Fetch applicable LearnedRules from glue `/rules?componentId=&model=` (plant scope plus company scope).
4. Build the prompt: proposal, own state and limits, `marginPct`, the retrieved events (compact table), the rules, and the physics summary paragraph from CLAUDE.md (use bridge/HANDOFF.md numbers if Person 2 says the live values differ).
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
No UI, no actors, no simulator. Never let an agent call `setMetric` or write OPC UA. Never invent evidence ids.
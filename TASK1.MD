# Person 1 — Durable Actors (actor/)

You own `actor/`. Read CLAUDE.md and shared/types.ts first. Do not touch bridge/, agent/, web/, glue/. You are also the 14:30 integrator.

## Deliverable 1: three Terse actors (deployed by 13:00)
Start from `terse init actorrelay-actor --template counter`. Replace Counter with:

### Component
- @Persisted + @Emittable: everything in ComponentState plus `calibration: CalibrationEntry[]`.
- `mirror(metrics)`: overwrite metrics, recompute status (warning at `max`, critical at `critical`), set lastTick. Called by the bridge every tick.
- `setMetric(metric, value, proposalId)`: ONLY the Plant actor may call this. Reject (throw) if `proposalId` is not currently `veto_window`-passed in Plant; Plant passes a one-time token.
- `addCalibration(e)`: append; keep last 50. If mean absError of last 5 > 10% of (limit.max − limit.min) → `marginPct = min(25, marginPct + 5)`; if < 3% → `marginPct = max(5, marginPct − 2)`.
- `setMargin(pct)`, `loadSeed(state)`.
- broadcast after every mutation.
- Instance id = ComponentId, e.g. `actors.Component.get("plant-a/LV-101")`. Components and limits: the plant table in CLAUDE.md (P-100, TK-101, LV-101, E-101, TV-101 per plant).

### Plant
- @Persisted + @Emittable: PlantState.
- `loadSeed(plant, history)`, `propose(p)` (assigns id, status voting, computes `requiredVoters` = every other component reachable from the proposer through upstream/downstream links (P-100 → TK-101, LV-101, E-101, TV-101) plus `Company.requiredCrossPlantVoters` when the proposer or any required voter has sharedResources (TV-101 is on `steam-header-1` → the other plant's TV-101 votes too) → sets crossPlant), `vote(v)` (reject duplicates per componentId), `veto(proposalId, by)`, `execute(proposalId)`, `recordEvent(e)`, `promoteRule(r)`, `tick()`.
- `similar(componentId, metric, to, upstreamSnapshot, k=5)`: called with the PROPOSER's componentId and metric (events are keyed by the changed component; voters read their own rows in `effects`). Numeric distance over history where componentId and metric match: `|after − to|/range` + 0.5 × mean normalized distance of upstreamSnapshot keys present in both. Return k nearest. Pure function over persisted history; no LLM.
- Alarm every 1s: `tick()` increments tick and asks glue for mirrored metrics (POST glue `/tick`). Alarm every 2s: proposal sweep exactly as CLAUDE.md. Guarantee: at most one proposal per component in `veto_window`; a second one waits in `voting`.
- Rule promotion: after each `recordEvent`, group history by (componentId, metric, bucketed `after` ≥ threshold) → if ≥ 3 events share an effect crossing a limit on the same downstream component, create/update a LearnedRule (scope plant). If the component `model` exists in another plant, call `Company.promoteRule` with scope company.

### Company
- @Persisted + @Emittable: CompanyState.
- `loadSeed`, `registerPlant`, `requiredCrossPlantVoters(proposal)` → components in other plants sharing any resource with the proposer or any of its required voters, `promoteRule` (dedupe by condition+consequence; bump timesSeen), `recordAudit`.

## Deliverable 2: client + handoff (by 13:00)
`terse deploy`, `terse actor generate`. Write `actor/HANDOFF.md`: deployed URL, how to get an API key (no secrets), every method signature, the one-time execute token flow, and three curl/SDK examples (loadSeed, propose, vote).

## Deliverable 3: integration (14:15–15:00)
Wire glue, agents, and web against the live actors. Run the full 90s demo twice. Fix actor bugs only; do not redesign. Merge at 15:00.

## Tests before 13:00 (write them in actor/tests)
- Two `vote` calls for the same componentId on one proposal → second rejected.
- Two proposals on the same component → only one reaches veto_window.
- `similar("plant-a/P-100", "speedPct", 85, …)` returns the seeded ≥80% events, whose effects show LV-101 positionPct ≥ 85.
- `propose` from plant-a/P-100 yields requiredVoters = plant-a TK-101, LV-101, E-101, TV-101 + plant-b/TV-101, and `crossPlant: true`.
- `addCalibration` with 5 large errors raises marginPct to 15.
- Rule promotion fires on the third matching event and dedupes on the fourth.

## Do not
No agent prompts, no UI, no simulator. No types.ts changes without ack from everyone.
    
# Person 3 — Dashboard and integration (web/, glue/)

You own `web/` and `glue/`, including service wiring, end-to-end tests, demo operations, and submission. Read PLAN.MD, CLAUDE.MD, and shared/types.ts first. Coordinate with Person 1 for actors and agents and Person 2 for simulation.

## Layout (mirror the reference screenshot: project tree left, P&ID center, attributes right, timing chart and events bottom)
Next.js + Tailwind, one page, 1920×1080, dark control-room look. Top bar: "ActorRelay · simulated plant", plant switcher (plant-a / plant-b / company), tick counter, sim status.

- **Left (18%)**: tree. Company → plant-a → components; plant-b → components. Status dot and word per component. Clicking selects.
- **Center (52%)**: P&ID. Use `public/pid-tk-101.svg` from Person 2: the TK-101 drawing with `<g id>` on P-100, TK-101, LV-101, E-101, TV-101 (bare tags; the same SVG serves both plants, the switcher picks the data). Overlay live values next to each tag. Voters on an active proposal get a pulsing outline: grey while voting, green on yes, red on no. Below the P&ID a strip with operator buttons: "Increase throughput" (P-100 50 → 85), "Force P-100 → 85%", "Reset demo".
- **Right (30%)**: attributes and proposal panel. Top: selected component's metrics with limit bars, marginPct, last 5 calibration entries (predicted vs observed). Below: active proposal card: proposer, metric, from → to, rationale, each voter's row (vote word, predicted value, reason, evidence chips linking to events and rules). Status pill. Veto button with 10s countdown when in `veto_window`. Counter-proposal cards nest under their parent.
- **Bottom (20%)**: left, timing chart: last 120s of the selected component's key metric with limit lines; right, events feed from `audit` (proposal, vote, block, execute, rule_learned, calibration) newest first, each with plant badge.
- **Company view**: two plant cards with status and connection, shared resources (`steam-header-1` with live `headerBarg`, highlighted when a cross-plant vote is open), company rule library (text, timesSeen, which plants), cross-plant proposals feed.

## Design rules
Red only for no/critical/blocked/vetoed. Green for yes/ok/executed. Amber for warning/voting. Every color paired with a word. Smallest text 18px. Motion only with meaning: voter outline pulse, veto countdown, a rule card sliding into the company library, "It learned" caption when a block cites an event from the current session.

## Data flow
- By 13:00: renders entirely from shared/plants.json, shared/history.json, and a `web/mock/state.json` you write (one proposal in each status).
- By 14:30: `usePlant(id)`, `useComponent(id)`, `useCompany()` hooks over the Terse generated client (URL and key from actor/HANDOFF.md). Replace state on each broadcast. Operator buttons POST to glue (`/propose`, `/veto`, `/reset`). If live isn't ready at 14:30, poll glue `/state` JSON and record the polling fallback in glue/HANDOFF.md.
- Never depend on fields outside types.ts.

## Demo assets (by 15:50)
- Three slides in the dashboard's visual language: problem (interconnected equipment, isolated agents, forgotten incidents), product (negotiate, remember, refuse, across plants), why both tools (Durable Actor per component = memory and serialized writes; Agent Relay = negotiation and cross-plant learning). Pitch line verbatim.
- Record the 90s backup video as integration owner after the 14:30 run.
- Submit on Builderbase as integration owner by 15:50.

## Do not
No actor, agent, or simulator internals. No extra screens. If stuck on design at 13:00, ship plain and iterate after live wiring.
## Integration workstream

## Deliverable 1: HTTP service (by 13:00, against mocks; live by 14:15)
Bun, CORS on, port 7200. Every route validates with zod against types.ts.
- `POST /mirror {componentId, metrics}` ← bridge → `Component.mirror`.
- `POST /tick` ← Plant alarm → ask bridge reader for a snapshot and fan out `/mirror` (or no-op if bridge pushes).
- `POST /propose {plantId, proposerComponentId, metric, to, rationale}` ← web/agents → `Plant.propose` → publish `proposal` on the plant channel and, if `crossPlant`, on `company`.
- `POST /vote {vote}` ← agents → `Plant.vote`.
- `POST /counter {parentProposalId, proposal}` ← agents → `Plant.propose` with parent.
- `POST /veto {proposalId, by}` ← web → `Plant.veto`.
- `POST /execute-callback {proposalId}` ← Plant when veto window passes → bridge `POST http://127.0.0.1:7300/setpoint` → on success `Component.setMetric` via Plant's token flow.
- `POST /observed {proposalId, effects}` ← bridge → `Plant.recordEvent` → publish `executed` on plant channel and `company`.
- `POST /calibration {componentId, entry}` ← agents → `Component.addCalibration`.
- `POST /rule {rule}` ← agents → `Plant.promoteRule` (→ Company if model shared) → publish `rule` on `company`.
- `GET /component/:id`, `GET /similar?...`, `GET /rules?componentId=&model=`, `GET /state?plantId=` ← agents/web, read-through to actors.
- `POST /reset` → `loadSeed` on all actors from shared/*.json, clear proposals, bridge `POST /reset` (both plants back to design steady state, P-100 at 50 %).

## Deliverable 2: Relay bridge (by 13:30)
`relay.ts`: join `plant-a`, `plant-b`, `company` as the system participant. Map inbound Relay messages to the routes above and outbound route events to Relay publishes exactly per the CLAUDE.MD protocol. Idempotency: dedupe by proposalId+componentId for votes.

## Deliverable 3: end-to-end script (by 14:00)
`e2e.ts` runs the whole demo headlessly against live services and asserts:
1. reset → 10 components mirrored within 3s.
2. propose plant-a P-100 → 85 → requiredVoters include plant-b/TV-101 and `crossPlant: true` → within 25s: LV-101 vote no with ≥3 evidence ids and predicted positionPct ≥ 81, status blocked.
3. counter arrives → 65 → all yes → veto_window → executes → LV-101 settles 60–72 → `executed` published → calibration entries exist for all voters.
4. propose 85 again → blocked within 10s with the step-3 event as evidenceEventIds[0].
5. plant-b propose 85 → blocked citing a company rule (or "insufficient history" if rule not yet promoted; assert which).
Print a pass/fail table. This is the merge gate at 15:00.

## Deliverable 4: demo ops (14:30–15:50)
- Run e2e, then the live demo while driving the UI, three times. Time each.
- Write `glue/DEMO.md`: exact startup order (actors → bridge live_sim on :7300 → glue on :7200 → agents → web), the reset command, and what to do if each piece dies mid-demo.
- Record the 90s backup video using the dashboard.
- Submit on Builderbase by 15:50: repo, video, description (pitch line plus two sentences), slides.

## Do not
No business logic that belongs in actors or agents; glue routes and validates only. If a module isn't ready, write a fake behind the same route and label it in HANDOFF.md.

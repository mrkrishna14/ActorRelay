# Person 5 — Glue, endpoints, end-to-end, demo ops (glue/)

You own `glue/`. Read CLAUDE.md and shared/types.ts first. Do not touch actor/, bridge/, agent/, web/. You are the only process that talks to everything.

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
`relay.ts`: join `plant-a`, `plant-b`, `company` as the system participant. Map inbound Relay messages to the routes above and outbound route events to Relay publishes exactly per the CLAUDE.md protocol. Idempotency: dedupe by proposalId+componentId for votes.

## Deliverable 3: end-to-end script (by 14:00)
`e2e.ts` runs the whole demo headlessly against live services and asserts:
1. reset → 10 components mirrored within 3s.
2. propose plant-a P-100 → 85 → requiredVoters include plant-b/TV-101 and `crossPlant: true` → within 25s: LV-101 vote no with ≥3 evidence ids and predicted positionPct ≥ 81, status blocked.
3. counter arrives → 65 → all yes → veto_window → executes → LV-101 settles 60–72 → `executed` published → calibration entries exist for all voters.
4. propose 85 again → blocked within 10s with the step-3 event as evidenceEventIds[0].
5. plant-b propose 85 → blocked citing a company rule (or "insufficient history" if rule not yet promoted; assert which).
Print a pass/fail table. This is the merge gate at 15:00.

## Deliverable 4: demo ops (14:30–15:50)
- Run e2e, then the live demo with Person 4 driving the UI, three times. Time each.
- Write `glue/DEMO.md`: exact startup order (actors → bridge live_sim on :7300 → glue on :7200 → agents → web; PlantCraft is not part of the demo), the reset command, and what to do if each piece dies mid-demo.
- Record the 90s backup video with Person 4.
- Submit on Builderbase by 15:50: repo, video, description (pitch line plus two sentences), slides.

## Do not
No business logic that belongs in actors or agents; glue routes and validates only. No UI. If a module isn't ready, write a fake behind the same route and label it in HANDOFF.md.
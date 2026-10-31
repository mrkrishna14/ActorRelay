# Person 3: fifteen-minute parallel sprint

## Target
A runnable control-room dashboard and validated integration API, ready to connect to Persons 1 and 2. Mock fixtures remain visibly labeled until live connections are verified. This sprint does not claim a recorded or submitted demo.

## Isolation
Work in `Factoryio-person3` on `codex/person3-dashboard-integration`. Persons 1 and 2 continue in their own sessions. Do not switch branches or overwrite their working files in the main checkout. The lead owns commits, remote synchronization, final review, and merge coordination.

## Sessions
| Session | Owned files | Deliverable |
|---|---|---|
| Dashboard agent | web/ | Equipment tree, process diagram, plant/company view, proposals and evidence, trends, operator controls |
| API agent | glue/ excluding e2e.ts and DEMO.md | Validated routes, state envelope, actor and messaging adapters, labeled mock mode, handoff |
| Verification agent | glue/e2e.ts, glue/DEMO.md, this file | Bounded smoke and live checks, startup and recovery runbook |
| Lead session | Coordination and review | Resolve contract mismatches, run the combined product, inspect failures, commit coherent work |

## Timeline from sprint start
- Minutes 0–2: read ownership and contracts, create isolated checkout, agree state envelope and route payloads.
- Minutes 2–8: agents implement in parallel. Dashboard polls state; API separates mock/live; verification prepares bounded checks.
- Minutes 8–11: run API smoke, dashboard production build, and UI preview. Fix integration mismatches.
- Minutes 11–13: connect available actor and simulation handoffs. Missing services stay explicitly unavailable; never turn fixture output into a live claim.
- Minutes 13–15: run the acceptance subset that dependencies support, document limits, commit, and hand off startup commands.

## Integration contract
- Dashboard reads `GET http://127.0.0.1:7200/state?plantId=plant-a` or `plant-b`.
- Envelope: `{ plant, components, company, mode, integrations? }`; `mode` is `mock` or `live`.
- Buttons post `/propose`, `/veto`, and `/reset`; the API validates requests.
- Actor owner supplies the durable API/client and execution authorization contract. Simulation owner supplies snapshots, setpoints, reset, and observed effects on port 7300.
- Live execution must wait for approved votes and the veto deadline. Command acceptance and observed outcome remain distinct.

## Exit criteria
- Dashboard production build passes and API smoke rejects malformed requests.
- Reset returns ten unique components across two plants.
- Proposal controls show explicit success or failure without hiding connection errors.
- Mock outputs are labeled, and live acceptance does not pass against mock mode.
- Startup and missing-dependency instructions are documented. Recording, slides, and submission remain pending until separately completed.

# Person 1 integration handoff (for Person 3)

Complements `actor/HANDOFF.md` and `agent/HANDOFF.md`. **Draft at 12:30 PT:** routes and shapes are read from the glue source (`f4384ab`). Commands and examples are filled in from real runs as actors and agents land. Anything not yet proven is marked `pending`.

## Open blocker
Live glue forwards every route to `ACTOR_API_URL`. Terse does not serve those paths, so Person 1 has to supply an HTTP adapter. Owner: pending, asked ar-actors at 12:29.

## Start order
| # | Service | Port | Command | Status |
|---|---|---|---|---|
| 1 | Terse actors | 7100 | pending | pending |
| 2 | Actor HTTP adapter | pending | pending | pending |
| 3 | `bridge/live_sim.py` | 7300 | `bridge/HANDOFF.md` | Person 2 |
| 4 | Relay broker | 8787 | pending | pending |
| 5 | Relay system participant and agents | 7201 | pending | pending |
| 6 | glue, `GLUE_MODE=live` | 7200 | `bun run server.ts` from `glue/` | Person 3 |
| 7 | web | 3000 | `bun run dev` from `web/` | Person 3 |

## Env for live glue
`ACTOR_API_URL`, `ACTOR_API_TOKEN` (optional), `RELAY_PUBLISH_URL`, `RELAY_TOKEN` (optional), `SIM_URL`.

## Routes glue forwards
Bodies are strict: extra keys return 400.
| Route | Body or query | Caller |
|---|---|---|
| `GET /state?plantId=` | returns `{plant, components, company}` | web, agents |
| `GET /component/:id` | URL-encode the id | agents |
| `GET /similar?componentId=&metric=&to=&k=` | proposer's component and metric; `upstreamSnapshot` as URL-encoded JSON | agents |
| `GET /rules?componentId=&model=` | plant plus company rules | agents |
| `POST /propose` | `{plantId, proposerComponentId, metric, to, rationale}` | web, agents |
| `POST /counter` | `{parentProposalId, proposal:{same five fields}}` | agents |
| `POST /vote` | `{vote}` | agents |
| `POST /veto` | `{proposalId, by}` | web |
| `POST /execute-callback` | `{proposalId}` | Plant alarm |
| `POST /observed` | `{proposalId, effects[]}` | bridge |
| `POST /calibration` | `{componentId, entry}` | agents |
| `POST /rule` | `{rule}` | agents |
| `POST /mirror` | `{componentId, metrics}` | bridge |
| `POST /tick`, `POST /reset` | `{}` | Plant alarm, web |

## Error semantics
Pending real responses. Glue maps adapter status ≥ 500 to 503 and passes others through with `{error, details?}`.

## One-time execute token flow
Pending `actor/` code.

## Examples from real runs
Pending.

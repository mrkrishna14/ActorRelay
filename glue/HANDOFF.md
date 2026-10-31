# Glue handoff

Glue is a Bun HTTP service on port 7200. It connects the simulator, the actors, the agents and the dashboard, and it holds the Relay system identity. It validates and forwards: every decision about a plant is made in an actor or an agent. `DEMO.md` has the start order and what to do when something dies.

## What runs

| File | Job |
|---|---|
| `server.ts` | Process entry. Binds 127.0.0.1, because a Windows browser reaches a WSL service on that address only with an exact bind. |
| `app.ts` | Every route, the origin and content-type checks, reset, the wake loop, agent messages from Relay. |
| `contract.ts` | Zod schemas for route bodies, seed files and `claimDispatch`, tied to `shared/types.ts` with `satisfies`. |
| `actors.ts` | The Terse invoke route. Sorts failures into refused (409, or 404 for an unknown proposal) and no answer (503). |
| `dispatch.ts` | The only path to the simulator. |
| `mirror.ts` | Live metrics into the Component actors. |
| `reads.ts` | Short-lived shared reads, and the trimming behind `/state`. |
| `relay.ts` | The `actorrelay-system` participant. |
| `bridge.ts` | Simulator client. |
| `seed.ts` | Reads `shared/plants.json` and the history, and labels a stand-in. |
| `e2e.ts`, `stack-wsl.sh` | The five TASK3 steps with a pass/fail table, and a private stack to run them on. |
| `run-wsl.sh` | Copies glue to the Linux filesystem and starts it. Re-run it to pick up changes. |

`glue/schemas.ts` is not used by this service. See "Known issues".

## Routes

Every POST needs `Content-Type: application/json`. A foreign `Origin` gets 403 on any route; loopback origins get CORS headers, and `GLUE_ALLOWED_ORIGINS` adds others.

| Route | Body or query | Does | Reply |
|---|---|---|---|
| `POST /mirror` | `{componentId, metrics}`, extra keys dropped | `Component.mirror`, newest reading wins | `{ok, outcome}` |
| `POST /tick` | `{}` | Polls the simulator if its pushes stopped | 200, or 503 if the simulator has not been seen for 5 s, which turns `PlantState.connected` false |
| `POST /propose` | `{plantId, proposerComponentId, metric, to, rationale}` | `Plant.propose`, posts `proposal` | `{proposal, published}` |
| `POST /vote` | `{vote}` | `Plant.vote` on the proposal's plant, deduped | `{proposal}` |
| `POST /counter` | `{parentProposalId, proposal}` | `Plant.propose` with the parent, posts `proposal` | `{proposal, published}` |
| `POST /veto` | `{proposalId, by}` | `Plant.veto` | `{proposal}` |
| `POST /execute-callback` | `{proposalId}` | See "Execution" | The result, or 202 if it takes over a second |
| `POST /observed` | `{proposalId, effects}` | `Plant.recordEvent`, posts `executed` on the plant channel and `company` | `{ok, proposalId, eventId, published}` |
| `POST /calibration` | `{componentId, entry}` | `Component.addCalibration` | `{ok}` |
| `POST /rule` | `{rule}` | `Plant.promoteRule`, posts `rule` on `company` | `{rule}` |
| `POST /reset` | `{}` | See "Reset" | `{ok, seed, bridge}`, or 502 if the simulator did not reset |
| `GET /component/:id` | id percent-encoded | `Component.getState` | ComponentState plus `calibration` |
| `GET /similar` | `componentId, metric, to, k, upstreamSnapshot` (JSON string) | `Plant.similar` | `HistoryEvent[]` |
| `GET /rules` | `componentId, model` | `Plant.rulesFor` | `LearnedRule[]` |
| `GET /state` | `plantId`, optional `full=1` | See below | `{mode, plant, components, company, seed, services}` |
| `GET /health` | | | `{ok, mode, services, seed, ticks, mirrored, resetting, relay, dispatches}` |

`GET /state` returns the plant, all ten components with `calibration`, and the company. `plant.history` holds live runs, events cited by a vote and the newest 20, so the page need not carry the whole seed; `full=1` returns all of it. `mode` is `live`, `degraded` (a service is down) or `unseeded`. `services` is `{actors, relay, simulation}`. `seed` is `{historySource, standIn, label, events}`; `label` is the text to show when the history is a stand-in.

Status codes: 400 validation, 403 origin, 404 unknown route, component or proposal, 409 an actor refused, 415 not JSON, 502 simulator, 503 no answer from an actor, or a reset is running.

## Execution

A Plant posts `/execute-callback` when a veto window passes, and again up to twice more until it is claimed.

1. `Plant.execute` is idempotent, and it refuses anything unapproved.
2. Preflight on fresh reads: the target must not be above the metric's `limit.max`, and no required voter may be `critical`. A failure goes to `Plant.reportDispatchFailure`. The actors do not check these two.
3. `Plant.claimDispatch(proposalId, measured)` passes the simulator's own reading, or the Component's if the snapshot fails. Plant fails the execution if it no longer matches `proposal.from`.
4. The claim is parsed. No token means no write. `dispatch:false` means someone else has it, so nothing happens.
5. One `POST /setpoint` with the claim's value, never retried. A refusal or timeout goes to `reportDispatchFailure`.
6. `Component.setMetric` with the claim's value and token, up to three tries, since the simulator has already moved.

Glue keeps the feed and header readings from step 3 and passes them to `recordEvent` as `upstreamSnapshot`. That is lost if glue restarts between dispatch and `/observed`.

## Reset

The reset lock is taken in the same synchronous step as its check, then running dispatches finish. New dispatches and all other writes get 503, and `/mirror` gets 202. Then: simulator, Company, Plants, Components, in that order, because `Company.loadSeed` clears rules and a Plant queues its derived rules for Company. Then glue mirrors live values straight away.

`shared/history.json` is used if it exists. Otherwise `actor/tests/fixtures-gen/history.json` loads and `seed.standIn` is true with a label.

## Relay

Glue registers `actorrelay-system` and joins `plant-a`, `plant-b` and `company`. The text of every message is JSON `{type, payload}`, as `agent/wire.ts` expects. It posts:

- `proposal {proposal}` to the plant channel, and `company` when cross-plant.
- `executed {proposalId, event}` to the plant channel and `company`.
- `rule {rule}` to `company`, after `POST /rule` and whenever the Company actor gains or updates a rule.

Inbound `vote` and `counter` messages run the same code as the HTTP routes, and only if the sender is exactly `agent:<componentId>`. One bad message is logged and never stops the next. Posts carry a stable idempotency key, so the SDK can retry through a Relay restart.

## Keeping the Plants alive

Terse loses alarms on restart, and a Plant re-arms only when called. Glue reads both Plants and the Company every second from startup, whether or not a page is open, and treats refused connections as normal. The same loop polls `/snapshot` if the simulator stops pushing.

## Commands

| What | Command |
|---|---|
| Start | `wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/glue/run-wsl.sh"` |
| Unit tests, in `glue/` | `bun test --timeout 30000 tests` |
| Whole stack and e2e, on side ports | `wsl.exe -d Ubuntu --cd /tmp -- bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/glue/stack-wsl.sh"` |
| Contract suite against a running glue | `CONTRACT_GLUE_URL=http://127.0.0.1:7200 bash actor/tests/contract/run.sh glue-live` |

On Windows install with `bun install --linker hoisted`. `run-wsl.sh` installs by itself.

## Environment

| Name | Default | Meaning |
|---|---|---|
| `GLUE_PORT`, `GLUE_HOST` | `7200`, `127.0.0.1` | Bind |
| `TERSE_URL` | `http://127.0.0.1:7100` | Actors |
| `BRIDGE_URL` | `http://127.0.0.1:7300` | Simulator |
| `RELAY_URL` or `RELAY_BASE_URL` | `http://127.0.0.1:8787` | Relay |
| `RELAY_WORKSPACE_KEY` | from `RELAY_KEY_FILE` | Workspace shared with the agents |
| `RELAY_KEY_FILE` | `~/.actorrelay/relay-workspace-key` | Created if missing. Never print it |
| `RELAY_SYSTEM_TOKEN_FILE` | `.relay-system.json` beside `config.ts` | Stored identity token, gitignored |
| `RELAY_SYSTEM_NAME` | `actorrelay-system` | Must match the agents |
| `GLUE_WAKE_MS` | `1000` | Wake loop |
| `GLUE_ALLOWED_ORIGINS` | none | Comma list added to loopback |
| `GLUE_REPO_ROOT` | parent of `glue/` | Where `shared/` is read |
| `GLUE_RUN_DIR` | `~/.actorrelay/glue-run` | `run-wsl.sh` only |

Actors need `GLUE_URL` to point here.

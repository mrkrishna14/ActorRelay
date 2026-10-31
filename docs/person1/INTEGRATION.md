# Person 1 integration handoff (for Person 3)

Written against glue at `bcfd064`, last checked 12:54 PT. It complements `actor/HANDOFF.md` and `agent/HANDOFF.md`. **Anything marked `pending` was not proven at the time of writing.** See `STATUS.md` for what works now.

## Boundary
Glue reaches actors through one port, `read(kind, id)` and `call(kind, id, method, args)`, with `kind` as `Component`, `Plant` or `Company`. Person 1 supplies that port as `ACTOR_CLIENT_MODULE`, or at `POST $ACTOR_API_URL/rpc`. Main is building it in `actor/adapter/`: pending.

The port maps two things glue does not know about:
- `read` calls `getState()`.
- ComponentId `plant-a/LV-101` becomes actor id `plant-a.LV-101`, because Terse ids cannot hold `/`. Company's id is `company`.

Glue runs the Relay system participant, the simulator calls, the mirror poller and `/reset`.

## Start order
Terse, Relay and agents need Linux. On this machine that means WSL, from a copy on the Linux filesystem, not `/mnt/c`: Windows Bun 1.3.14 miscompiles the actor classes, and `/mnt/c` is too slow for startup.

| # | Service | Port | Command |
|---|---|---|---|
| 1 | Relay broker | 8787 | `wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/relay/start-relay.sh"`; run `setup-runtime.sh` from the same folder once first |
| 2 | Terse actors | 7100 | From a Linux copy of `actor/`: `DURABLE_ACTORS_DATA_DIR=<dir> ~/terse-probe/node_modules/.bin/terse actor dev --port 7100` |
| 3 | Actor port | 7150 | pending, `actor/adapter/` |
| 4 | Simulator | 7300 | `bridge/HANDOFF.md` |
| 5 | Glue | 7200 | From `glue/`, with the env below: `bun run server.ts` |
| 6 | Agents | 7201 health | `wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/run-wsl.sh"`; ready line starts `ready: 10 agents` |
| 7 | Web | 3000 | From `web/`: `bun run dev` |

Start glue before the agents. Both use the Relay name `actorrelay-system` today, which is pending a fix (see Known mismatches).

## Env
| Service | Names |
|---|---|
| Glue | `GLUE_MODE=live`, `ACTOR_CLIENT_MODULE` or `ACTOR_API_URL=http://127.0.0.1:7150`, `EXECUTION_CALLBACK_TOKEN`, `RELAY_WORKSPACE_KEY` or `RELAY_AGENT_TOKEN`, `RELAY_BASE_URL`, `SIM_URL` |
| Actors | `GLUE_URL`, `EXECUTION_CALLBACK_TOKEN` (same value as glue), `DURABLE_ACTORS_DATA_DIR` |
| Agents | `GLUE_URL`, `RELAY_URL`, `RELAY_WORKSPACE_KEY`, `OPENAI_API_KEY` or repo `.env` |

From Windows, Relay answers on `http://localhost:8787` only; `127.0.0.1` is refused. Inside WSL both work.

Never commit a value. `agent/.relay-tokens.json` and glue's journal hold credentials, so keep both out of git.

## Actor methods glue calls
| Glue route | Actor call |
|---|---|
| `GET /state?plantId=` | `read` Plant ×3, Company ×1, Component ×10 |
| `GET /component/:encodedId` | `read` Component |
| `GET /similar?componentId=&metric=&to=&k=&upstreamSnapshot=<JSON>` | `Plant.similar(id, metric, to, upstreamSnapshot, k)`, always on the proposer's plant |
| `GET /rules?componentId=&model=` | `read` Plant and Company, plant rules then company rules |
| `POST /mirror {componentId, metrics}` | `Component.mirror(metrics)` |
| `POST /propose {plantId, proposerComponentId, metric, to, rationale}` | `Plant.propose(input)` |
| `POST /counter {parentProposalId, proposal:{same five}}` | `Plant.propose({...proposal, parentProposalId})` |
| `POST /vote {vote}` | `Plant.vote(vote)`, on the proposal's plant, not the voter's |
| `POST /veto {proposalId, by}` | `Plant.veto(proposalId, by)` |
| `POST /execute-callback {proposalId}` | `Plant.authorizeExecution(proposalId)`, then `Component.setMetric(metric, value, proposalId, token)` |
| `POST /observed {proposalId, effects}` | `Plant.recordEvent(event)` |
| `POST /calibration {componentId, entry}` | `Component.addCalibration(entry)` |
| `POST /rule {rule}` | `Plant.promoteRule(rule)` |
| `POST /reset {}` | `loadSeed` on every Component, Plant, then Company |

Agents use only glue's HTTP routes: the four GETs, `/vote`, `/counter`, `/calibration` and `/rule`.

## One-time execute token flow
1. Every required voter says yes. The sweep opens `veto_window`, deadline now + 10 s.
2. After the deadline, Plant POSTs `/execute-callback {proposalId}` with `Authorization: Bearer $EXECUTION_CALLBACK_TOKEN`. Without it glue returns 401.
3. Glue rechecks unanimity, deadline, staleness and limits, then calls `Plant.authorizeExecution`, which returns `{authorized:true, token, expiresAt, proposalId}`. **Pending:** today's actors have `execute` and `claimDispatch` instead.
4. Glue checks the simulator still reads `from`, journals the command, then POSTs `/setpoint {componentId, metric, value, proposalId, commandId}`.
5. Glue calls `Component.setMetric(metric, value, proposalId, token)`. Component redeems the token at Plant.
6. The token works once and only for that proposal, component, metric and value. Plant stores only its hash. A replay throws `token_already_used`.
7. After 5 ticks the bridge POSTs `/observed`. Plant records the event, glue publishes `executed`, and agents calibrate.

Retries never redispatch: glue's journal and Plant's single claim both stop it. A command whose outcome is unknown stops for manual reconciliation (409), and is not retried.

## Error semantics
Actors throw a stable code at the start of the message, such as `duplicate_vote: ...`. The port must turn it into a status. Glue returns `{error, details?}`, passes 4xx through, and turns 5xx into 503.

| Code | Meaning | Status |
|---|---|---|
| `invalid_proposal`, `invalid_vote`, `invalid_counter`, `invalid_rule`, `invalid_event`, `out_of_limits`, `not_a_required_voter`, `unsafe_yes` | Bad request | 400 |
| `invalid_token` | Wrong token | 403 |
| `proposal_not_found` | Unknown id | 404 |
| `duplicate_vote`, `stale_proposal`, `veto_closed`, `parent_not_blocked`, `too_many_counters`, `not_approved`, `veto_window_open`, `token_already_used`, `not_executed`, `not_dispatched`, `not_accepted`, `already_applied`, `duplicate_event` | Conflict with current state | 409 |
| `not_seeded` | Reset has not run | 503 |

Other `invalid_*` codes are 400.

The status column is proposed, pending the port. Glue's own codes: 401 without the callback token, 409 for reconciliation or `Execution in progress`, 502 with `details.accepted:true` when the actor accepted but Relay or `setMetric` failed. **Do not resubmit on 502.**

## Known mismatches
Open at `bcfd064`. Owners are working on these, so check `STATUS.md` before relying on one.
1. `Plant.authorizeExecution` does not exist, and the sweep marks a proposal `executed` before the callback, so glue would answer 409.
2. Plant's callback sends no bearer token, so glue would answer 401.
3. Glue seeds Company last, and `Company.loadSeed` clears rules, so the company rule can be lost. Plant B would then only ever report insufficient history.
4. Relay text is `{type, payload}` from glue, but agents parse `{type, proposal}`. Agents ignore glue's messages until that is aligned.
5. Glue and `agent/spawn.ts` both register `actorrelay-system`.
6. Glue's Relay inbound expects sender `agent:<componentId>`, but agent names are `plant-a-LV-101`. Agents' HTTP `/vote` and `/counter` work regardless.
7. Glue sends `/observed` events with id `observed:<proposalId>`, and Plant stores `event-<proposalId>`.

## Examples from real runs
Actor examples are real Terse responses at 12:51 (actors `3746bdd`, stand-in history), called directly, without glue or the port. Votes are real model output through `agent/vote.ts` at 12:41, on a fake glue.

**Timing warning from that run:** `Plant` calls queued for up to 15 s, and one vote did not return in 30 s. Glue times out at 8 s. Execution, the veto path and `recordEvent` were not captured on real Terse.

`Plant.propose`, as glue calls it for `POST /propose`:
```json
{"plantId":"plant-a","proposerComponentId":"plant-a/P-100","metric":"speedPct","to":85,"rationale":"Increase throughput"}
```
Returns:
```json
{"id":"plant-a-p00001-10d7f63e","at":"2026-10-31T19:51:55.769Z","plantId":"plant-a","proposerComponentId":"plant-a/P-100","proposerAgentId":"agent:plant-a/P-100","metric":"speedPct","from":50,"to":85,"rationale":"Increase throughput","requiredVoters":["plant-a/TK-101","plant-a/LV-101","plant-a/E-101","plant-a/TV-101","plant-b/TV-101"],"votes":[],"status":"voting","vetoDeadline":null,"parentProposalId":null,"crossPlant":true}
```

Rejected votes, as Terse reports them. The stable code starts the message:
```json
{"type":"failed","code":"actor_error","message":"duplicate_vote: plant-a/TK-101 already voted on plant-a-p00001-10d7f63e"}
{"type":"failed","code":"actor_error","message":"invalid_vote: evidence event no-such-event is not in history"}
```

Company rule promoted from seed history at reset:
```text
P-100 speedPct ≥ 80 → LV-101 positionPct ≥ 85 within 3 ticks, seen 23 times (first learned in plant-a)
```

`POST /vote`, LV-101 blocking 85. The model missed the 2.5 s deadline, so code decided from the evidence and says so:
```json
{"vote":{"proposalId":"p-1","componentId":"plant-a/LV-101","agentId":"agent:plant-a/LV-101","vote":"no","reason":"[decided from retrieved evidence; the model did not answer in time] predicted positionPct 90.3 is at or past the 81 threshold (critical 90 less 10% margin); 5 of 5 similar runs reached it (standin-a-0069, standin-a-0091, standin-a-0044, standin-a-0113, standin-a-0138).","predicted":{"positionPct":90.3},"marginPct":10,"evidenceEventIds":["standin-a-0138","standin-a-0113","standin-a-0091","standin-a-0069","standin-a-0044"],"evidenceRuleIds":[],"similarCount":5}}
```

`POST /vote`, LV-101 passing 65:
```json
{"vote":{"proposalId":"p-2","componentId":"plant-a/LV-101","agentId":"agent:plant-a/LV-101","vote":"yes","reason":"The five similar runs peaked at 66.6–67.1%, well below the 81% threshold; predict a peak of 67.1%. [answered by openai gpt-6-luna]","predicted":{"positionPct":67.1},"marginPct":10,"evidenceEventIds":["standin-a-0070","standin-a-0088","standin-a-0164","standin-a-0160","standin-a-0093"],"evidenceRuleIds":[],"similarCount":5}}
```

# Actors handoff

Three durable actors hold the plant: `Component` (ten), `Plant` (two), `Company` (one). They run on Terse in WSL. Glue reaches them over HTTP; `glue/actors.ts` is the client.

## Run

Terse has no native Windows runtime, so run it in WSL, from a copy on the Linux filesystem:

```bash
cp -r "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/actor" "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/shared" ~/actorrelay/
cd ~/actorrelay/actor && bun install
GLUE_URL=http://127.0.0.1:7200 DURABLE_ACTORS_DATA_DIR=$HOME/actorrelay/data ~/terse-probe/node_modules/.bin/terse actor dev --port 7100
```

Ready when `POST /v1/projects/local/actors/Company/company/invoke` answers. A start or restart rebuilds the bundle: 12 to 30 s here, longer under load.

Do not write any file inside the served project while it runs. `terse actor dev` watches the directory, and a change redeploys and fences live hosts, including a copied test file.

`.durable-actors/` is in `.gitignore`. Set `DURABLE_ACTORS_DATA_DIR` outside the project, on ext4.

## Environment (names only)

| Name | Read by | Default | Purpose |
|---|---|---|---|
| `GLUE_URL` | Plant | `http://127.0.0.1:7200` | Target of `/tick` and `/execute-callback`. Reaches actor hosts when set on `terse actor dev`. |
| `DURABLE_ACTORS_DATA_DIR` | runtime | `.durable-actors/` | Durable state. Keep it to keep state. |
| `TERSE_ACTOR_URL`, `TERSE_API_KEY` | generated client | local | Only for a generated client or a hosted target. |

No secrets are needed for local runs. Actors call each other through the runtime's own URL, on any port.

## Addressing

Terse actor ids allow only `[A-Za-z0-9._-]`, so a `ComponentId` cannot be an actor id.

| Actor | Id | Example |
|---|---|---|
| `Company` | `company` | |
| `Plant` | the `PlantId` | `plant-a` |
| `Component` | ComponentId with `/` as `.` | `plant-a.LV-101` |

`ComponentId` strings inside state, votes and voters keep the slash. Proposal ids start with their plant (`plant-a-p00001-1a2b3c4d`), so a vote is routed with `plantOfProposal(id)` from `src/ids.ts`, never from the voter's prefix: a cross-plant voter belongs to the other plant. Agent ids are `agent:<ComponentId>`.

## Calling an actor

```
POST {TERSE}/v1/projects/local/actors/{Class}/{id}/invoke
{"requestId":"<uuid>","method":"<name>","args":[...]}
```

The reply is `{"outcome":{"type":"completed","result":...}}`, or `{"outcome":{"type":"failed","code":"actor_method_failed","message":"<code>: <detail>"}}`. Use a fresh `requestId` each call. `metadata.queueWaitMs` shows mailbox wait.

### Examples

Seed, Company first. Any order recovers, because Plants re-push their rules when Company's seed generation changes, but Company first avoids a sweep of delay:

```bash
curl -s -X POST http://127.0.0.1:7100/v1/projects/local/actors/Company/company/invoke \
  -H 'content-type: application/json' \
  -d '{"requestId":"11111111-1111-4111-8111-111111111111","method":"loadSeed","args":[{"plants":["plant-a","plant-b"],"sharedResources":[{"id":"steam-header-1","name":"Steam header 1 (6 barg)","components":["plant-a/TV-101","plant-b/TV-101"]}]}]}'
```

`Plant.loadSeed` takes a `plants.json` plant entry, with `components` as full `ComponentState` objects, and the history. Events for other plants are ignored. `Component.loadSeed` takes one `ComponentState`.

Propose:

```bash
curl -s -X POST http://127.0.0.1:7100/v1/projects/local/actors/Plant/plant-a/invoke \
  -H 'content-type: application/json' \
  -d '{"requestId":"22222222-2222-4222-8222-222222222222","method":"propose","args":[{"proposerComponentId":"plant-a/P-100","metric":"speedPct","to":65,"rationale":"raise throughput"}]}'
```

Vote, using the `id` from that reply:

```bash
curl -s -X POST http://127.0.0.1:7100/v1/projects/local/actors/Plant/plant-a/invoke \
  -H 'content-type: application/json' \
  -d '{"requestId":"33333333-3333-4333-8333-333333333333","method":"vote","args":[{"proposalId":"<id>","componentId":"plant-a/LV-101","agentId":"agent:plant-a/LV-101","vote":"yes","reason":"similar runs stayed inside limits","predicted":{"positionPct":66},"marginPct":10,"evidenceEventIds":[],"evidenceRuleIds":[],"similarCount":3}]}'
```

## Methods

All are async. Inputs are validated at the actor; agent output is treated as data.

**Component**
- `getState()` returns `ComponentState` plus `calibration`.
- `loadSeed(state)`
- `mirror(metrics)` merges finite metrics, recomputes status (`warning` at `max`, `critical` at `critical`), sets `lastTick`. A steady reading commits only every 10 s; `getState` always shows the live `lastTick`.
- `setMetric(metric, value, proposalId, token)` needs a token from `Plant.claimDispatch`.
- `addCalibration(entry)` must match a real observed vote by this component; `absError` is recomputed. Margin moves only on a full window of 5 limited entries since the last move: above 10% of range +5, below 3% -2, within 5..25.
- `setMargin(pct)` clamps to 5..25. Glue exposes no route to it.

**Plant**
- `getState()` returns `PlantState`.
- `loadSeed(plant, history)` replaces everything, clears proposals and executions, and derives rules from the history.
- `propose({proposerComponentId, metric, to, rationale, from?, proposerAgentId?, parentProposalId?})` returns `Proposal`. Refuses a target outside `min..max`, and a `from` that is not the current value.
- `vote(vote)` returns `Proposal`.
- `veto(proposalId, by)` returns `Proposal`. Works until the proposal leaves `veto_window`.
- `execute(proposalId)` returns `Execution`. Idempotent.
- `claimDispatch(proposalId, measured?)`, `reportDispatchFailure(proposalId, reason)`, `getExecution(proposalId)`.
- `recordEvent({proposalId, effects, upstreamSnapshot?, incident?, operator?})` returns `HistoryEvent`. Plant fills the rest from the proposal. Effect rows must name known tags and metrics; the values are trusted, so the first observation for a run decides them. One event per proposal; a repeat returns the same event.
- `promoteRule(rule)` returns `LearnedRule`. A submitted rule must name its components, every cited event must show it, and no recorded run may refute it.
- `similar(componentId, metric, to, upstreamSnapshot = {}, k = 5)` returns `HistoryEvent[]`.
- `rulesFor(componentId?, model?)` returns plant rules plus company rules.
- `tick()`, `sweep()`, `setConnected(bool)`, `recordAudit(entry)`.
- Called by other actors only: `redeemToken`, `acceptCalibration`, `noteMargin`, `ackCompanySync`, `grantLease`.

**Company**
- `getState()` returns `CompanyState`.
- `loadSeed(company)`, `registerPlant(id, models?)`, `requiredCrossPlantVoters(proposal)`, `promoteRule(rule)`, `recordAudit(entry)`.
- Called by Plant: `getGeneration`, `modelExistsElsewhere`, `addCrossPlantProposal`, `acquireLease`, `releaseLease`.

## Proposal lifecycle

- `voting`: `requiredVoters` is every component reachable from the proposer, plus Company's cross-plant voters. A proposal fails closed if Company cannot answer.
- Any `no` moves it to `blocked` at once. Slower voters are still recorded for the 30 s voting window; `blocked` stays terminal.
- Unanimous yes moves it to `veto_window` on a sweep, deadline now + 10 s. Cross-plant proposals first need a Company lease on the shared resource, so that window can open one sweep later. A proposal waits in `voting` while another holds a touched component, and expires after 60 s of waiting.
- A required voter may turn a yes into a no during the veto window. That is the only change of mind allowed.
- Missing votes after 30 s: `expired`. A proposal whose `from` no longer matches: `expired`.
- A deadline more than 6 s past when a sweep sees it (an outage) reopens a full window instead of executing unattended.

## Execute token flow

Only Plant authorises a metric change, and a token is good for one exact proposal, component, metric and value.

1. A sweep past the deadline calls `Plant.execute`, which re-checks status, deadline, every yes, the current setpoint and limits, then records **acceptance only** and posts `POST $GLUE_URL/execute-callback {"proposalId"}`, resending every 4 s up to 3 times. Bodies are exact because glue's schemas are strict.
2. The executor (glue) calls `Plant.execute` (idempotent), reads the measured value from `Component.getState`, then `Plant.claimDispatch(proposalId, measured)`. That returns `{dispatch: true, token, componentId, metric, value}` exactly once across retries and restarts, otherwise `{dispatch: false, state}`.
3. Bridge `POST /setpoint` with the values from the claim.
4. `Component.setMetric(metric, value, proposalId, token)`. Component redeems at Plant. Plant keeps only a hash of the token. A wrong token, value, metric or component throws `invalid_token` and burns nothing; a second use throws `token_already_used`.
5. On a simulator failure, `Plant.reportDispatchFailure`: the setpoint reverts and the proposal is `expired`.
6. The observer's result goes to `Plant.recordEvent`.

Execution states are `accepted`, `claimed`, `applied`, `observed`, `failed`, `unknown`. `executed` on a proposal means accepted; only `observed` means measured. A claim unconfirmed after 20 s becomes `unknown`: not re-sent, not reverted, and a late `setMetric` or observation settles it. If `measured` disagrees with `from`, dispatch is refused and the setpoint heals to the measured value.

## Learning

- `similar`: nearest by `|after - to| / range + 0.5 × mean upstream distance`. Two additions: the newest live event is always first, whatever its distance, and seeded events beyond 15% of range from `to` are dropped, so a plant with no history near the target gets nothing back and "insufficient history" can fire.
- Rules: `loadSeed` and `recordEvent` derive them. The condition value is the lowest 5-step threshold at which every recorded run at or past it crossed the limit on that effect, with at least 3 runs. A plant rule is keyed by condition and consequence, so a fourth sighting updates it. At Company, `timesSeen` counts distinct supporting events, so a retried delivery changes nothing.
- Company rules drop component ids (`condition.componentId` and `consequence.componentId` are null) and match on `model`, the affected component's model. The source plant is in `text`, "first learned in plant-a". Merges only tighten a rule.
- `Plant.vote` also judges on its own data: it counts similar events itself, uses the higher of the claimed and reported margin, and turns a yes into a no when an applicable plant rule says so or when fewer than 3 similar events exist within 15% of critical. A yes past the threshold, a yes missing a limited metric, and evidence ids that do not exist are refused.

## Errors

Actors throw `<code>: <detail>`; `glue/actors.ts` maps them. `proposal_not_found` is 404, other codes 409, `actor_call_timeout` 503.

Codes: `not_seeded`, `invalid_seed`, `invalid_metrics`, `invalid_metric`, `invalid_margin`, `invalid_proposal`, `invalid_proposal_id`, `out_of_limits`, `stale_proposal`, `proposal_not_found`, `parent_not_blocked`, `invalid_counter`, `too_many_counters`, `company_not_seeded`, `invalid_vote`, `duplicate_vote`, `not_a_required_voter`, `unsafe_yes`, `veto_closed`, `not_approved`, `veto_window_open`, `not_accepted`, `not_executed`, `not_dispatched`, `already_applied`, `invalid_token`, `token_already_used`, `invalid_event`, `invalid_rule`, `invalid_calibration`, `duplicate_calibration`, `invalid_audit`, `invalid_query`, `invalid_veto`, `invalid_plant`.

## Socket state

`@Emittable` carries the contract fields with two differences, because the base class and the `tick()` method own those names: there is no `id` (use the id you connected with), and the tick counter is `tickCount`, which updates only every 30 ticks. `getState()` returns the exact contract shape. `Component` also broadcasts `{type: "component", state}` after every mutation.

## Alarms and mailboxes

- One 1 s alarm per Plant; every second tick sweeps. Local alarms do not survive a runtime restart, so the first call after activation re-arms a lost alarm. After a restart, a Plant ticks only once something calls it; glue's `/state` poll does that.
- Call direction is one way: Component to Plant to Company. Nothing inside a Plant awaits glue or Component, and the alarm path awaits nothing external. Company sync, leases and glue callbacks are fire-and-forget, with state recorded only on acknowledgement.
- `tick` is a heartbeat, so it commits only every 30 ticks and can step back by up to 30 after a restart. `getState().tick` is live. Idle Plants and steady Components therefore commit almost nothing, which keeps mailboxes off fsync.
- Each Plant call moves its full persisted state, about 185 KB with stand-in history, so call rate matters. Do not poll a Plant faster than 1 Hz.

## Tests

| Suite | Runs on | Latest result |
|---|---|---|
| `tests/logic/logic.test.ts` | pure functions, no runtime | 48 pass, 0 fail, current code |
| `tests/runtime/runtime.test.ts` | real `terse actor dev`, fake glue inside the test | see below |
| `tests/runtime/durability.ts` | real server plus kill -9 | not yet completed by this suite |

Real runs of `tests/runtime`:

- At 6447368: 8 of 8. That included all six TASK1 tests, and the execute path with its forged token, early execute, token replay and duplicate observation checks.
- Before d4d976b, with the hardening batch: 8 of 9. The one failure was the 30 s voting window closing during five sequential votes under load; votes now go in parallel.
- At d4d976b: not proven. That run met load above 40 from other runtimes and hosts died (`activation session cannot be reused`, `Rust host disconnected`). No clean run on this commit or later yet.

Run the pure suite with `bun test tests/logic` from `actor/`. Run the runtime suite from outside the served project, with the server's `GLUE_URL` pointing at `GLUE_PORT`:

```bash
GLUE_PORT=7205 TERSE_URL=http://127.0.0.1:7100 bun test tests/runtime
```

Crash results from `tests/chaos`, a separate suite, are in `tests/chaos/REPORT.md`. On a throwaway actor, 50 of 50 acknowledged writes survived kill -9.

## Known limits

- Local only. `terse deploy` needs `terse auth login`, and the CLI here is not logged in, so it was not run. No generated client is committed: glue uses the invoke route in `glue/actors.ts`.
- After a hard kill an actor can answer 503 until its old lease expires, so callers should retry 503.
- Local Terse is sensitive to machine load. Around load 40, with dozens of actor hosts alive, the runtime's own control plane stalls, hosts lose their lease and self-fence. Run one Terse server for the demo.
- A restart rebuilds the bundle, so a server crash can outlast the voting and claim windows. Veto windows reopen; expired proposals must be proposed again.
- `Company.promoteRule` checks rule shape, not that cited events exist, because Company never calls Plant. `Plant.promoteRule` does the event check, and glue only uses that path.
- Agents can lowball a prediction below the threshold. `Plant.vote` catches an applicable plant rule, but a lowball below any known rule rests on the agents' evidence checks.
- A rule contradicted by later runs is retightened or stops being derived, but one already stored is not retracted.
- Cross-plant voters are checked against the same-tag local limits, and at no less than the seeded margin of 10, since a Plant only hears margins from its own components.

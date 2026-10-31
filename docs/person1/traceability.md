# Person 1 traceability

Every Person 1 requirement from `TASK1.MD`, the `PLAN.MD` acceptance gate and `CLAUDE.MD`, with the code that implements it and the test that proves it. Refreshed as code lands.

**Status rules.** `met`: I read the code and the test and saw the test pass. `partial`: code exists, but the test is missing, failing, or ran only on a fake where the requirement needs the real thing. `missing`: no code. Evidence is what I read or ran, not what a session reported. Fake-backed runs are labelled `[fake]`, pure-function runs `[pure]`, real Terse or Relay runs `[live]`.

**Last refresh:** 12:38 PT, git `3bb8c3c`. Code read for `actor/src` and `agent/`. No Terse or Relay run yet, so nothing that needs the real runtime is `met`.

| Scoreboard | met | partial | missing |
|---|---|---|---|
| All rows | 3 | 101 | 17 |

## 1. Component actor (TASK1 D1)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| C-1 | Persisted and emittable: all `ComponentState` fields plus `calibration: CalibrationEntry[]` | `actor/src/actor.ts` `Component` fields, `getState` | | partial | Read: all fields persisted and emitted, plus `calibration`. `id` cannot be emitted (base Actor owns it), so socket state omits it; `getState()` has it. Not run on Terse |
| C-2 | `mirror(metrics)` overwrites metrics and sets `lastTick` | `Component.mirror` | `actor/tests/property/status.test.ts` | partial | Read: merges into existing metrics instead of overwriting, sets `lastTick`. Not run on real logic yet |
| C-3 | `mirror` recomputes status: `warning` at `max`, `critical` at `critical` | `actor/src/logic/component.ts` `computeStatus` | `actor/tests/property/status.test.ts` | partial | Read: `>= critical` critical, `>= max` warning. Suite only ran on its reference so far |
| C-4 | `setMetric(metric, value, proposalId)` callable only by Plant; throws unless the proposal has passed `veto_window`; Plant passes a one-time token | `Component.setMetric`, `Plant.claimDispatch`, `Plant.redeemToken` | `agent/tests/adversarial/actor-attacks.test.ts` | partial | Read: enforced by a token, not caller identity. Plant mints it once, stores only a hash, binds it to proposal, component, metric and value; `Component.setMetric` redeems it at Plant. Executor (adapter) makes the call. Not run |
| C-5 | `addCalibration(e)` appends and keeps the last 50 | `logic/component.ts` `applyCalibration`, `Component.addCalibration` | `actor/tests/property/calibration.test.ts` | partial | Read: `slice(-CALIBRATION_CAP)`, cap 50. `absError` recomputed from predicted and observed. Not run on real logic yet |
| C-6 | Mean absError of last 5 > 10% of (max − min) → `marginPct = min(25, marginPct + 5)` | `applyCalibration` | `calibration.test.ts` | partial | Read: needs a full window of 5 entries that have limits since the last move, each error normalised by its own metric range. Satisfies AT-5 and BT-6 together |
| C-7 | Mean absError of last 5 < 3% of range → `marginPct = max(5, marginPct − 2)` | `applyCalibration` | `calibration.test.ts` | partial | Read: same window, `clampMargin(margin − 2)` |
| C-8 | `setMargin(pct)`, `loadSeed(state)` | `Component.setMargin`, `Component.loadSeed` | `calibration.test.ts` | partial | Read: margin clamped to 5..25; `loadSeed` rejects a seed for another instance and clears calibration |
| C-9 | Broadcast after every mutation | `Component.publishState` | | partial | Read: called by all five mutators. Socket delivery not observed |
| C-10 | Instance id = ComponentId; components and limits per the CLAUDE.MD plant table | `actor/src/ids.ts` `componentActorId`; `shared/plants.json` | `actor/tests/contract/plants.contract.test.ts` | partial | Instance id is `plant-a.LV-101` because Terse ids cannot hold `/`; state keeps `plant-a/LV-101`. Not run on Terse |

## 2. Plant actor (TASK1 D1, CLAUDE.MD actor methods)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| P-1 | Persisted and emittable: `PlantState` | `actor/src/actor.ts` `Plant` fields, `getState` | | partial | Read: socket field is `tickCount`, because method `tick()` owns the name; `getState()` returns contract shape with `tick` and `id` |
| P-2 | `loadSeed(plant, history)` | `Plant.loadSeed` | | partial | Read: clears proposals, audit, executions, tokens and live ids; runs `deriveRules` on seed so a rule exists before the first block |
| P-3 | `propose(p)` assigns id and sets status `voting` | `Plant.propose`, `logic/proposals.ts` `assertProposalInput` | `actor/tests/property/lifecycle.test.ts` | partial | Read: id `plant-a-p00001-<nonce>`, status `voting`; rejects out-of-limit, stale `from`, no-op targets |
| P-4 | `requiredVoters` = every other component reachable from the proposer through upstream/downstream links | `reachableVoters` | `actor/tests/property/voters.test.ts` | partial | Read: BFS over upstream and downstream, excludes proposer |
| P-5 | Adds `Company.requiredCrossPlantVoters`, sets `crossPlant` | `Plant.propose`, `Company.requiredCrossPlantVoters` | `voters.test.ts` | partial | Read: fails closed if Company is unreachable. Not run on Terse |
| P-6 | `vote(v)` rejects duplicates per componentId | `assertVoteAllowed` | `actor/tests/property/votes.test.ts` | partial | Read: `duplicate_vote`. One exception: a yes may become a no during the veto window |
| P-7 | `veto(proposalId, by)` | `Plant.veto` | `lifecycle.test.ts` | partial | Read: only from `veto_window`, else `veto_closed` |
| P-8 | `execute(proposalId)` | `Plant.execute`, `assertExecutable` | `lifecycle.test.ts` | partial | Read: idempotent per proposal, records acceptance only, then posts `/execute-callback {proposalId}` |
| P-9 | `recordEvent(e)` | `Plant.recordEvent`, `#eventFromProposal` | | partial | Read: idempotent per proposal; refuses events with no dispatch behind them (`not_dispatched`) |
| P-10 | `promoteRule(r)` | `Plant.promoteRule` | `actor/tests/property/rules.test.ts` | partial | Read: every support id must exist in history; `assertRuleShape` needs 3+ distinct ids |
| P-11 | `tick()` | `Plant.tick` | | partial | Read: increments, posts `/tick {}` fire-and-forget, sweeps every 2nd tick |
| P-12 | `similar(componentId, metric, to, upstreamSnapshot, k=5)`: filter on componentId and metric; distance `|after − to|/range + 0.5 × mean normalized distance of shared upstreamSnapshot keys`; k nearest | `actor/src/logic/similar.ts` `rankSimilar`, `Plant.similar` | `actor/tests/property/similar.test.ts` | partial | Read: spec distance, k=5 default, plus two deliberate changes: newest live event always first, seeded events past 15% of range dropped. See Deviations |
| P-13 | `similar` is pure over persisted history, no LLM; called with the proposer's componentId and metric | `rankSimilar` | `similar.test.ts` | partial | Read: pure, no LLM. `agent/vote.ts` passes the proposer's id and metric |
| P-14 | Alarm every 1 s: `tick()` increments tick and POSTs glue `/tick` | `Plant.onAlarm`, `armAlarm` | | partial | Read: one alarm multiplexed, 1 s, re-armed first. Not run on Terse |
| P-15 | Alarm every 2 s: all required yes → `veto_window` (deadline now + 10 s); any no → `blocked` | `logic/proposals.ts` `planSweep`, `Plant.sweep` | `lifecycle.test.ts` | partial | Read: every 2 ticks; a no beats everything; deadline now + 10 s |
| P-16 | Veto window passed → `execute` → `Component.setMetric` → bridge writes setpoint | `Plant.sweep` → `execute`; `actor/adapter/` pending | | partial | Actor half read. Adapter runs claim, `/setpoint`, `setMetric`; not on disk yet |
| P-17 | After 5 ticks `recordEvent` with observed effects → broadcast `executed` | `Plant.recordEvent`; adapter `/observed` pending | | partial | Actor half read. The 5-tick wait is the bridge's observer; `executed` publish depends on the adapter reply shape |
| P-18 | Votes missing after 30 s → `expired` | `planSweep` | `lifecycle.test.ts` | partial | Read: expires at 30 s, also expires stale proposals |
| P-19 | At most one proposal per component in `veto_window`; the second waits in `voting` | `planSweep` `touched`, `occupied` | `lifecycle.test.ts` | partial | Read: proposer plus all voters count as touched; second proposal stays in `voting` |
| P-20 | Only `Plant.execute` mutates a metric | `Component.setMetric`, `Plant.redeemToken` | `actor-attacks.test.ts` | partial | Read: `mirror` also writes metrics, by design, from the simulator. Only token-backed `setMetric` writes a commanded value |
| P-21 | After each `recordEvent`: group history by (componentId, metric, bucketed `after` ≥ threshold); ≥ 3 events sharing an effect that crosses a limit on the same downstream component → create or update a plant-scope `LearnedRule` | `logic/rules.ts` `deriveRules`, `mergeDerivedRules` | `rules.test.ts` | partial | Read: runs in `recordEvent` over all history and in `loadSeed`; threshold is the lowest step where every run at or past it crossed |
| P-22 | If the component `model` exists in another plant → `Company.promoteRule` with scope company | `#flushCompanyOutbox`, `toCompanyRule` | `rules.test.ts` | partial | Read: outbox retried each sweep, needs both plants registered; company rule drops component ids and keys on `model` |

## 3. Company actor (TASK1 D1)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| CO-1 | Persisted and emittable: `CompanyState` | `actor/src/actor.ts` `Company` | | partial | Read: all contract fields persisted and emitted. Not run on Terse |
| CO-2 | `loadSeed(c)`, `registerPlant(id)` | `Company.loadSeed`, `registerPlant` | | partial | Read: `loadSeed` wipes `rules`, so reset must seed Company before Plants (ar-actors told main) |
| CO-3 | `requiredCrossPlantVoters(proposal)` → components in other plants sharing a resource with the proposer or any required voter | `logic/rules.ts` `crossPlantVoters` | `voters.test.ts` | partial | Read: other-plant components on any resource touching the proposer or a voter |
| CO-4 | `promoteRule(r)` dedupes by condition + consequence and bumps `timesSeen` | `mergeCompanyRule` | `rules.test.ts` | partial | Read: dedupes on model, metrics and ops; bumps `timesSeen` |
| CO-5 | `recordAudit(a)` | `Company.recordAudit` | | partial | Read: validated, capped at 300 |

## 4. Actor deliverables and tests (TASK1 D2, D3, tests)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| AD-1 | `terse deploy` and `terse actor generate` | | | missing | Terse runtime not available to sessions yet; no `terse deploy` |
| AD-2 | `actor/HANDOFF.md`: URL, API key instructions without secrets, every method signature, one-time execute token flow, three examples (loadSeed, propose, vote) | | | missing | No `actor/HANDOFF.md` yet |
| AD-3 | Actor clients and agent startup instructions supplied to Person 3 | `docs/person1/INTEGRATION.md` | | partial | Draft on disk; waiting on real runs |
| AT-1 | Test: two `vote` calls for one componentId → second rejected | | `votes.test.ts` | partial | Suite exists; not yet run on real logic |
| AT-2 | Test: two proposals on one component → only one reaches `veto_window` | | `lifecycle.test.ts` | partial | Suite exists; not yet run on real logic |
| AT-3 | Test: `similar("plant-a/P-100", "speedPct", 85, …)` returns seeded ≥ 80% events with LV-101 positionPct ≥ 85 effects | | `similar.test.ts` | partial | "the demo query ranks the 85 runs ahead of the 65 runs"; not yet run on real logic |
| AT-4 | Test: `propose` from plant-a/P-100 → required voters are plant-a TK-101, LV-101, E-101, TV-101 + plant-b/TV-101, `crossPlant: true` | | `voters.test.ts` | partial | "pump in plant-a matches TASK1 exactly"; not yet run on real logic |
| AT-5 | Test: `addCalibration` with 5 large errors raises marginPct to 15 | | `calibration.test.ts` | partial | "five large errors raise the margin from 10 to 15"; not yet run on real logic |
| AT-6 | Test: rule promotion fires on the third matching event and dedupes on the fourth | | `rules.test.ts` | partial | "fires on the third", "dedupes on the fourth"; not yet run on real logic |

## 5. Agents (TASK1 agent workstream)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| S-1 | `spawn.ts`: one agent per component in both plants (10) with `@agent-relay/sdk`, on `plant-a` or `plant-b`, all joining `company` | `agent/spawn.ts` | | partial | Read: 10 Relay identities plus system participant, all join all 3 channels. One process runs all ten, not one per agent. Not run on a real broker |
| S-2 | Mechanics (P-100, LV-101) on Codex; TK-101, E-101, TV-101 on Claude; agent id `agent:<ComponentId>` | `agent/spawn.ts`, `agent/llm.ts` `RoutedLlm` | | partial | Agent id correct. Vendor gap: `codex` routes to OpenAI Responses, and Claude falls back to OpenAI (main, 12:35). One real vendor today, labelled in each vote |
| S-3 | `roles/*.md`: four system prompts with role priorities and the hard contract | `agent/roles/*.md`, `agent/physics.md`, `vote.ts` `systemPrompt` | | partial | Read: four roles, contract and physics summary joined per vote. No test on prompt text |
| V-1 | Vote step 1: fetch own state from glue `/component/:id` | `agent/vote.ts` `gatherContext` | `agent/tests/adversarial/llm-hostile.test.ts` | partial | Read; hostile suite ran on real `vote.ts` with fake glue and LLM [fake]: 111 pass, 11 fail at 12:36 |
| V-2 | Vote step 2: glue `/similar` with the proposer's id and metric, `to`, `upstreamSnapshot`, `k: 5`; read effects rows for this component | `vote.ts` `loadSharedContext`, `retrieval.ts` `ownRows` | `llm-hostile.test.ts` | partial | Read: one `/similar` per proposal, a failure becomes a safe no, never an empty list |
| V-3 | Vote step 3: applicable rules from glue `/rules?componentId=&model=` (plant plus company scope) | `vote.ts` `gatherContext`, `glue.ts` `rules` | `llm-hostile.test.ts` | partial | Open: a `/rules` failure degrades to `[]`; tests "glue rules throw" and "glue rules http500" fail [fake] |
| V-4 | Vote step 4: prompt has proposal, own state and limits, `marginPct`, retrieved events table, rules, physics summary | `vote.ts` `buildVotePrompt`, `systemPrompt` | `agent/tests/adversarial/injection.test.ts` | partial | Read: all five inputs present; plant text sits in a `<data>` block |
| V-5 | Vote step 5: LLM returns only JSON; zod validation against types.ts; re-request once; then `{vote:"no", reason:"malformed prediction"}` | `vote.ts` `askModel`, `parseAnswer`, `safeNo` | `llm-hostile.test.ts` | partial | Read: 2 attempts, then `no` with reason "malformed prediction" |
| V-6 | Vote step 6a: `similarCount` = retrieved length, set in code | `vote.ts` `castVote` | `llm-hostile.test.ts` | partial | Open: test "inflated similarCount" fails [fake]; I have not triaged it |
| V-7 | Vote step 6b: `similarCount < 3` and a predicted metric within 15% of critical → forced `no`, reason "insufficient history" | `vote.ts` `decide`, `retrieval.ts` `relevantEvents` | `llm-hostile.test.ts` | partial | Read: reason text "insufficient history". Open: test "events with no effect row" fails [fake] |
| V-8 | Vote step 6c: predicted ≥ `critical × (1 − marginPct/100)` → forced `no` | `vote.ts` `decide`, `thresholdReason` | `llm-hostile.test.ts` | partial | Read: evidence or a binding rule also forces no, whatever the model says |
| V-9 | Vote step 6d: `evidenceEventIds` and `evidenceRuleIds` attached from what was retrieved, never invented | `vote.ts` `orderEvidence`, `castVote` | `llm-hostile.test.ts` | partial | Read: model ids filtered to retrieved ids. `Plant.vote` also rejects unknown ids |
| V-10 | Vote step 7: post `vote` to the plant channel → glue | `agent/runtime.ts` `voteAs`, `channelForVote`, `agent/system.ts` | | partial | Read: posts to Relay; system participant forwards to `/vote`. Not run on a real broker |
| CP-1 | `counter.ts`: when the proposer's own proposal is `blocked`, read blocking votes, ask LLM for a value between `from` and `to` under every voter's threshold minus margin, post `counter` | `agent/counter.ts` `buildCounter`, `runtime.ts` `watchForBlock` | | partial | Read: code computes the allowed candidates, the model picks one; a code-chosen value is labelled in the rationale. Polls `/state` because no `blocked` message exists |
| CP-2 | Max 2 counters per parent | `counter.ts` `counterCount`; `assertCounterAllowed` | `lifecycle.test.ts` | partial | Read: enforced in the agent and again in `Plant.propose` (`too_many_counters`) |
| LN-1 | `learn.ts`: for every voter compare `vote.predicted[metric]` to observed → `CalibrationEntry` → glue `/calibration` | `agent/learn.ts` `calibrationEntries`, `calibrate` | | partial | Read: every voter gets an entry, falling back to the live reading when `effects` has no row. No agent test yet |
| LN-2 | Append the event to the local retrieval cache | `learn.ts` `learnFromExecution` | | partial | Read. Defect: cache is never cleared on reset, see Open gaps |
| LN-3 | If the event matches no existing rule, check `similar()` for ≥ 3 events sharing the crossing → propose a `LearnedRule` via glue `/rule` | `learn.ts` `findRule`, `learnFromBlock` | | partial | Read: also runs after a `no`. Actors derive rules too; ids differ, and `covered()` suppresses a repeat |
| LN-4 | Cache `rule` messages from `company` so plant-b agents cite plant-a rules on the next vote | `runtime.ts` `onMessage`, `vote.ts` `gatherContext` | | partial | Read. Plant-side promotions publish no `rule` message, but `/rules` returns company rules on every vote |
| LN-5 | Second identical bad proposal is blocked with the most recent execution as `evidenceEventIds[0]` | `vote.ts` `orderEvidence`, `rankSimilar` | | partial | Read: newest live event first. Not observed end to end |
| BT-1 | Test: plant-a LV-101 `no` on P-100 → 85, ≥ 3 evidence ids, predicted positionPct ≥ 81 | | | missing | |
| BT-2 | Test: plant-a LV-101 `yes` on P-100 → 65, predicted positionPct 60–72 | | | missing | |
| BT-3 | Test: plant-b TV-101 votes on plant-a P-100 → 85 on channel `company` with a predicted `headerBarg` drop | | | missing | |
| BT-4 | Test: plant-b LV-101 `no` on 85 citing the company rule once it exists, `no` for "insufficient history" before | | | missing | |
| BT-5 | Test: malformed LLM JSON → one retry → safe `no` | | | missing | |
| BT-6 | Test: calibration after a 1-point error leaves marginPct unchanged; after five 12-point errors marginPct rises | | | missing | |

## 6. Continuous learning (CLAUDE.MD)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| CL-1 | Never answer from priors alone: every vote retrieves the k most similar events and reads effects on its own component | `vote.ts` `gatherContext` | | partial | See V-2 |
| CL-2 | Predict from those events plus the physics summary | `vote.ts` `buildVotePrompt`, `evidenceEstimates` | | partial | See V-4 |
| CL-3 | Fewer than 3 similar events: must say so and vote `no` within 15% of a critical limit | `vote.ts` `decide` | | partial | See V-7 |
| CL-4 | After execution compute per-metric error and append a `CalibrationEntry` | `learn.ts` `calibrate` | | partial | See LN-1 |
| CL-5 | MAE over last 5 > 10% of range → `marginPct` + 5, cap 25, used on the next vote | `applyCalibration` | | partial | See C-6 |
| CL-6 | Promote a recurring pattern to `LearnedRule` at 3+ sightings; rules are cited like events | `deriveRules`, `vote.ts` `bindingRules` | | partial | See P-21, V-9 |
| CL-7 | "It learned": same bad proposal blocked faster, most recent run cited first | `vote.ts` `FAST_NO_MS`, `orderEvidence` | | partial | See LN-5. A proven no posts after 2.5 s even if the model is slow. Timing not observed |

## 7. Multiplayer (CLAUDE.MD)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| MP-1 | `Company` holds plant list, shared-resource graph, cross-plant rule library | `Company`; `shared/plants.json` | | partial | See CO-1 |
| MP-2 | A voter on a shared resource pulls in the components on that resource in the other plant; `crossPlant: true`; those votes travel on `company` | `crossPlantVoters`, `runtime.ts` `channelForVote` | | partial | Read: proposal ids carry the plant, so a cross-plant vote routes by proposal id |
| MP-3 | Rules promoted to the company library when the same `model` exists in both plants | `toCompanyRule`, `#flushCompanyOutbox` | | partial | See P-22 |
| MP-4 | Plant-b's LV-101 cites a plant-a incident before plant-b experienced it | `retrieval.ts` `ruleApplies`, `vote.ts` `bindingRules` | | partial | Read: company rule matches by `model` and metric. Not observed end to end |

## 8. Relay protocol (CLAUDE.MD)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| RP-1 | Channels `plant-a`, `plant-b`, `company` | `agent/system.ts` `CHANNELS` | | partial | Read. Not run on a real broker |
| RP-2 | `proposal {proposal}` handled; each required voter replies within 20 s | `runtime.ts` `onProposal`, `vote.ts` `TOTAL_LLM_BUDGET_MS` | | partial | Read: 18 s model budget inside the 20 s window; dedupes the same proposal on two channels |
| RP-3 | `vote {vote}` agent → glue → `Plant.vote` | `system.ts` `InboundBridge` | | partial | Read: checks the sender matches the voter, forwards once |
| RP-4 | `counter {parentProposalId, proposal}` agent → glue → `Plant.propose` | `InboundBridge`, `Plant.propose` | | partial | Read: exactly the five glue fields |
| RP-5 | `executed {proposalId, event}` reaches all plant agents and `company` when cross-plant or model shared | `system.ts` `toWireMessage`, `runtime.ts` `onExecuted` | | partial | Read. Needs adapter `/observed` to return `plantId` and `crossPlant`, or `executed` reaches `company` only |
| RP-6 | `rule {rule}` on `company` when scope is company | `toWireMessage`, `runtime.ts` `onMessage` | | partial | Read: only for agent-submitted rules via glue `/rule`. See LN-4 |
| RP-7 | Prompt contract: proposal, own state, `similar()` results, rules, physics summary; only JSON matching Vote | `vote.ts` `buildVotePrompt`, `parseAnswer` | | partial | See V-4, V-5 |
| RP-8 | `similarCount` equals retrieved events | `vote.ts` `castVote` | | partial | `similarCount` counts events after the relevance cut, so a far newest run is cited but not counted |
| RP-9 | A `no` includes a predicted value past `critical − marginPct%` (LV-101: 81) | `vote.ts` `noIsSupported`, `effectivePrediction` | | partial | Read: a model `no` with no breach is rejected as malformed; a safe no carries no prediction, as TASK1 step 5 specifies |

## 9. Rules (CLAUDE.MD)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| RU-1 | Seed first: every module works against `shared/*.json` before live | `shared/plants.json` | | partial | `shared/history.json` not delivered. `actor/tests/fixtures-gen/history.json` is a labelled stand-in, 34 of 34 checks reported by ar-fixtures, not rerun by me |
| RU-2 | `shared/types.ts` frozen | `shared/types.ts` | `git log -- shared/types.ts` | met | Matches the CLAUDE.MD contract text; one commit, `f8b023b` |
| RU-3 | Only `Plant.execute` mutates a metric; agents never write state | `Component.setMetric`; `agent/*.ts` | | partial | No agent code calls `setMetric` or `/setpoint` (grep). See P-20 |
| RU-4 | Agents never vote without `similar()`; `similarCount: 0` within 15% of critical is automatically `no` | `vote.ts` `decide`; `enforceVoteSafety` | | partial | Enforced in the agent and again in `Plant.vote` |
| RU-5 | No scope additions: no real PLC, no ML training, ≤ 5 components per plant, no auth, no real data | `shared/plants.json` | | met | 5 components per plant in seed; re-check as code lands |
| RU-6 | Agent outputs are data: validate every Vote; malformed → discard, re-request once, never guess | `vote.ts` `parseAnswer`; `normalizeVote` | | partial | Agent validates with zod; Plant re-validates and rebuilds the vote from known keys |
| RU-7 | HANDOFF.md in each folder: what runs, exact commands, env vars without secrets, what is stubbed | | | missing | `actor/HANDOFF.md`, `agent/HANDOFF.md` |
| RU-8 | Product writing rule followed in docs | `docs/person1/` | | met | This doc names only ActorRelay modules and the sponsor stack |
| AG-1 | Agents never call `setMetric` or write to the simulator | `agent/*.ts` | | partial | Grep finds no `setMetric`, `/setpoint` or simulator URL in `agent/`. Recheck at the end |
| AG-2 | Agents never invent evidence ids | `vote.ts` `orderEvidence`; `Plant.vote` | `llm-hostile.test.ts` | partial | "invented evidence ids never appear" passes [fake] |

## 10. Never fake (CLAUDE.MD rules)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| NF-1 | Evidence-cited block | | | missing | Needs real Terse, real Relay, real LLM vote |
| NF-2 | Counter-proposal executing | | | missing | Same |
| NF-3 | Second block citing the first run | | | missing | Same |
| NF-4 | Plant-b block citing plant-a's rule | | | missing | Same |

## 11. Acceptance gate (PLAN.MD)
Person 3 runs the gate. These rows track the Person 1 share.
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| G-1 | Reset produces all ten component snapshots and clears prior pending work | `Plant.loadSeed`; adapter `/reset` pending | | partial | Actor side clears work. Agent cache does not, see Open gaps |
| G-2 | Pump 50 → 85 blocked with real evidence, includes the other plant's steam-valve vote | | | missing | |
| G-3 | Safer target ≈ 65 passes, executes after the veto window, observed metrics settle within verified ranges | | | missing | |
| G-4 | Repeated unsafe proposal cites the newest relevant observation, without a safe run alone counting as proof of an unsafe outcome | | | missing | |
| G-5 | Plant B cites a supported company rule from Plant A, or explicitly reports insufficient history until it exists | | | missing | |
| G-6a | Invalid votes rejected | `normalizeVote`, `enforceVoteSafety` | `votes.test.ts`, `actor-attacks.test.ts` | partial | Read. Not run on Terse |
| G-6b | Duplicate votes rejected | `assertVoteAllowed` | `votes.test.ts` | partial | Read: `duplicate_vote`; `InboundBridge` also forwards once |
| G-6c | Stale proposals rejected | `assertVoteAllowed`, `isStale`, `assertExecutable` | `lifecycle.test.ts` | partial | Read: stale `from` expires in the sweep and is refused at execute |
| G-6d | Unapproved writes rejected | `assertExecutable`, `redeemToken` | `actor-attacks.test.ts` | partial | Read. Adapter's `/execute-callback` must not dispatch without a claim; pending |
| G-6e | Retries do not duplicate a simulation command | `Plant.claimDispatch` | | partial | Read: single claim, a claimed write is never retried. Needs adapter and a simulator-side check |
| G-7 | Dashboard, actor state, command result and trends agree; recovery is never marked from command acceptance alone | `ExecutionState` in `actor.ts` | | partial | Read: accepted, claimed, applied, observed and failed are separate states |
| G-8 | No scripted conversation presented as live reasoning; any fallback labelled | `vote.ts` `provenance`, `counter.ts` `source` | | partial | Read: fallback and code-decided values are labelled in the vote or rationale text |
| PS-1 | Plan scope: validate the current proposal and limits immediately before dispatch | `assertExecutable` | | partial | Read: rechecks status, deadline, unanimity, staleness and limits |
| PS-2 | Plan scope: record acceptance separately from observed results | `Execution` state machine, audit entries | | partial | Read: "Accepted", "Simulator accepted" and "Observed" are separate audit lines |
| PS-3 | Plan interface: Person 1 gives Person 3 actor client, method signatures, Relay participants, agent startup, error semantics; no credentials in committed files | `docs/person1/INTEGRATION.md` | | partial | Draft on disk; waiting on the adapter and real runs |

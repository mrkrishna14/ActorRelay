# Person 1 traceability

Every Person 1 requirement from `TASK1.MD`, the `PLAN.MD` acceptance gate and `CLAUDE.MD`, with the code that implements it and the test that proves it. Refreshed as code lands.

**Status rules.** `met`: I read the code and the test and saw the test pass. `partial`: code exists, but the test is missing, failing, or ran only on a fake where the requirement needs the real thing. `missing`: no code. Evidence is what I read or ran, not what a session reported. Fake-backed runs are labelled `[fake]`, pure-function runs `[pure]`, real Terse or Relay runs `[live]`.

**Last refresh:** 12:54 PT, git `cf88750`. Real Terse ran seed, propose and vote rejections, then stalled. Real Relay proof passed on a fake glue. No run has joined real actors, Relay, glue and simulator.

| Scoreboard | met | partial | missing |
|---|---|---|---|
| All rows | 26 | 87 | 8 |

## Open gaps
1. **Plant stalls on real Terse.** At 12:51 calls queued up to 15 s (`queueWaitMs`) and one `Plant.vote` did not return in 30 s. Glue times out at 8 s. Cause not isolated, machine load included. Execution has not run on Terse. Reported to main.
2. **Actor port not on disk.** `actor/adapter/`, built by main. Glue `bcfd064` needs `read`/`call`, not REST. Blocks P-16, P-17, G-1 to G-7.
3. **Actors do not match glue `bcfd064`.** `Plant.authorizeExecution` is missing, the sweep marks `executed` before the callback, and the callback has no bearer token. Glue seeds Company last, which can lose the company rule (never-fake #4).
4. **Agents do not match glue `bcfd064`.** Relay `{type, payload}` is not parsed, and both register `actorrelay-system`. Agent HTTP `/vote` and `/counter` work. `agent/HANDOFF.md` still names `RELAY_PUBLISH_URL`.
5. **No `shared/history.json` and no `bridge/`.** Every event-based pass uses a labelled stand-in, and no real simulator has been in the path.
6. **Open adversarial findings.** ar-adversarial reports A1 to A11 on actors; ar-agents reports G1 to G11 handled at 12:52. I last ran the hostile suite at 12:41 (9 of 122 failing), before that fix.
7. **One real vendor today.** Claude roles use the labelled fallback (main's decision, 12:35), and `codex` means OpenAI Responses, not the Codex CLI. S-2 stays `partial`.
8. **OpenAI rate limit.** The shared key hit its cap at 12:43. A 429 costs a voter its model answer, so evals must stop during rehearsal and the demo.

## Deviations from the task text
| Where | Task says | Code does | Why |
|---|---|---|---|
| `similar()` | k nearest | Newest live event first; seeded events past 15% of range dropped | Otherwise the repeat block cannot cite the run, and "insufficient history" cannot fire |
| `setMetric` | Only Plant calls it | Any caller holding Plant's one-time token; the adapter calls it | Plant must not await Component, or mailboxes deadlock |
| Execution order | CLAUDE.MD: `setMetric`, then simulator | TASK3 order: simulator, then `setMetric` | A metric must not change before the simulator accepts |
| Instance id | `plant-a/LV-101` | `plant-a.LV-101` | Terse ids cannot hold `/`; state keeps the slash |
| `mirror` | Overwrite metrics | Merge into existing metrics | A partial push keeps the other metrics |
| `tick` field | `PlantState.tick` | Socket field `tickCount`; `getState()` returns `tick` | Method `tick()` owns the name |
| Agent processes | One agent per component | Ten Relay identities in one process | Replies arrive at once instead of after a harness turn |
| Adapter | Not in TASK1 | HTTP adapter added | Person 3's live glue forwards every route to it |

## 1. Component actor (TASK1 D1)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| C-1 | Persisted and emittable: all `ComponentState` fields plus `calibration: CalibrationEntry[]` | `actor/src/actor.ts` `Component` fields, `getState` | | partial | Read: all fields persisted and emitted, plus `calibration`. `id` cannot be emitted (base Actor owns it), so socket state omits it; `getState()` has it. Not run on Terse |
| C-2 | `mirror(metrics)` overwrites metrics and sets `lastTick` | `Component.mirror` | `actor/tests/property/status.test.ts` | partial | Read: merges into existing metrics instead of overwriting, sets `lastTick`. Not run on real logic yet |
| C-3 | `mirror` recomputes status: `warning` at `max`, `critical` at `critical` | `actor/src/logic/component.ts` `computeStatus` | `actor/tests/logic/logic.test.ts` "status: warning at max, critical at critical" | partial | Read; logic test passed 12:41 [pure]. Not run on Terse |
| C-4 | `setMetric(metric, value, proposalId)` callable only by Plant; throws unless the proposal has passed `veto_window`; Plant passes a one-time token | `Component.setMetric`, `Plant.claimDispatch`, `Plant.redeemToken` | `agent/tests/adversarial/actor-attacks.test.ts` | partial | Read: enforced by a token, not caller identity. Plant mints it once, stores only a hash, binds it to proposal, component, metric and value; `Component.setMetric` redeems it at Plant. Executor (adapter) makes the call. Not run |
| C-5 | `addCalibration(e)` appends and keeps the last 50 | `logic/component.ts` `applyCalibration`, `Component.addCalibration` | `logic.test.ts`; `actor/tests/property/calibration.test.ts` | partial | Read: `slice(-CALIBRATION_CAP)`, cap 50; `absError` recomputed. "a forged absError is recomputed" passed [pure]. Keep-last-50 only in the property suite, not yet run on real logic |
| C-6 | Mean absError of last 5 > 10% of (max − min) → `marginPct = min(25, marginPct + 5)` | `applyCalibration` | `logic.test.ts` "five large errors raise marginPct from 10 to exactly 15" | partial | Passed 12:41 [pure]. Needs a full window of 5 limited entries since the last move, each error normalised by its metric range. Not run on Terse |
| C-7 | Mean absError of last 5 < 3% of range → `marginPct = max(5, marginPct − 2)` | `applyCalibration` | `logic.test.ts` "five tiny errors narrow the margin by 2, floored at 5" | partial | Passed 12:41 [pure]. Not run on Terse |
| C-8 | `setMargin(pct)`, `loadSeed(state)` | `Component.setMargin`, `Component.loadSeed` | `calibration.test.ts` | partial | Read: margin clamped to 5..25; `loadSeed` rejects a seed for another instance and clears calibration |
| C-9 | Broadcast after every mutation | `Component.publishState` | | partial | Read: called by all five mutators. Socket delivery not observed |
| C-10 | Instance id = ComponentId; components and limits per the CLAUDE.MD plant table | `actor/src/ids.ts` `componentActorId`; `shared/plants.json` | `actor/tests/contract/plants.contract.test.ts` | partial | Instance id is `plant-a.LV-101` because Terse ids cannot hold `/`; state keeps `plant-a/LV-101`. Not run on Terse |

## 2. Plant actor (TASK1 D1, CLAUDE.MD actor methods)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| P-1 | Persisted and emittable: `PlantState` | `actor/src/actor.ts` `Plant` fields, `getState` | | partial | Read: socket field is `tickCount`, because method `tick()` owns the name; `getState()` returns contract shape with `tick` and `id` |
| P-2 | `loadSeed(plant, history)` | `Plant.loadSeed` | | partial | Ran on real Terse 12:51 [live]: two plants seeded; `deriveRules` gave LV-101, E-101 and TV-101 rules from seed |
| P-3 | `propose(p)` assigns id and sets status `voting` | `Plant.propose`, `logic/proposals.ts` `assertProposalInput` | `actor/tests/property/lifecycle.test.ts` | partial | Ran on real Terse 12:51 [live]: id `plant-a-p00001-10d7f63e`, status `voting`, `from` 50 |
| P-4 | `requiredVoters` = every other component reachable from the proposer through upstream/downstream links | `reachableVoters` | `logic.test.ts`; `actor/tests/property/voters.test.ts` | partial | Ran on real Terse 12:51 [live]: TK-101, LV-101, E-101, TV-101 returned |
| P-5 | Adds `Company.requiredCrossPlantVoters`, sets `crossPlant` | `Plant.propose`, `Company.requiredCrossPlantVoters` | `logic.test.ts`; `voters.test.ts` | met | Ran on real Terse 12:51 [live]: plant-b/TV-101 added, `crossPlant` true, through a real Plant to Company call |
| P-6 | `vote(v)` rejects duplicates per componentId | `assertVoteAllowed` | `logic.test.ts` "second vote from the same component is rejected" | met | Real Terse 12:51 [live]: `duplicate_vote` returned. Logic test also passes [pure] |
| P-7 | `veto(proposalId, by)` | `Plant.veto` | `lifecycle.test.ts` | partial | Read: only from `veto_window`, else `veto_closed` |
| P-8 | `execute(proposalId)` | `Plant.execute`, `assertExecutable` | `lifecycle.test.ts` | partial | Read: idempotent per proposal, records acceptance only, then posts `/execute-callback {proposalId}` |
| P-9 | `recordEvent(e)` | `Plant.recordEvent`, `#eventFromProposal` | | partial | Read: idempotent per proposal; refuses events with no dispatch behind them (`not_dispatched`) |
| P-10 | `promoteRule(r)` | `Plant.promoteRule` | `actor/tests/property/rules.test.ts` | partial | Read: every support id must exist in history; `assertRuleShape` needs 3+ distinct ids |
| P-11 | `tick()` | `Plant.tick` | | partial | Read: increments, posts `/tick {}` fire-and-forget, sweeps every 2nd tick |
| P-12 | `similar(componentId, metric, to, upstreamSnapshot, k=5)`: filter on componentId and metric; distance `|after − to|/range + 0.5 × mean normalized distance of shared upstreamSnapshot keys`; k nearest | `actor/src/logic/similar.ts` `rankSimilar`, `Plant.similar` | `logic.test.ts`; `actor/tests/property/similar.test.ts` | partial | Read: spec distance, k=5, plus two deliberate changes: newest live event always first, seeded events past 15% of range dropped. Logic test passed [pure]. See Deviations |
| P-13 | `similar` is pure over persisted history, no LLM; called with the proposer's componentId and metric | `rankSimilar` | `similar.test.ts` | partial | Read: pure, no LLM. `agent/vote.ts` passes the proposer's id and metric |
| P-14 | Alarm every 1 s: `tick()` increments tick and POSTs glue `/tick` | `Plant.onAlarm`, `armAlarm` | | partial | Read: one alarm multiplexed, 1 s, re-armed first. Not run on Terse |
| P-15 | Alarm every 2 s: all required yes → `veto_window` (deadline now + 10 s); any no → `blocked` | `logic/proposals.ts` `planSweep`, `Plant.sweep` | `logic.test.ts` sweep cases; `lifecycle.test.ts` | partial | Passed [pure]. Real sweep not observed: my Terse run stalled before the block |
| P-16 | Veto window passed → `execute` → `Component.setMetric` → bridge writes setpoint | `Plant.sweep` → `execute`; `actor/adapter/` pending | | partial | Actor half read. Adapter runs claim, `/setpoint`, `setMetric`; not on disk yet |
| P-17 | After 5 ticks `recordEvent` with observed effects → broadcast `executed` | `Plant.recordEvent`; adapter `/observed` pending | | partial | Actor half read. The 5-tick wait is the bridge's observer; `executed` publish depends on the adapter reply shape |
| P-18 | Votes missing after 30 s → `expired` | `planSweep` | `logic.test.ts` "missing votes expire after 30s" | partial | Passed [pure]. Also expires stale proposals |
| P-19 | At most one proposal per component in `veto_window`; the second waits in `voting` | `planSweep` `touched`, `occupied` | `logic.test.ts` "two proposals on one component" | partial | Passed [pure]. Proposer plus all voters count as touched; second stays in `voting` |
| P-20 | Only `Plant.execute` mutates a metric | `Component.setMetric`, `Plant.redeemToken` | `actor-attacks.test.ts` | partial | Read: `mirror` also writes metrics, by design, from the simulator. Only token-backed `setMetric` writes a commanded value |
| P-21 | After each `recordEvent`: group history by (componentId, metric, bucketed `after` ≥ threshold); ≥ 3 events sharing an effect that crosses a limit on the same downstream component → create or update a plant-scope `LearnedRule` | `logic/rules.ts` `deriveRules`, `mergeDerivedRules` | `logic.test.ts` "rule fires on the third matching event and dedupes on the fourth" | partial | Passed [pure]. Runs in `recordEvent` over all history and in `loadSeed` |
| P-22 | If the component `model` exists in another plant → `Company.promoteRule` with scope company | `#flushCompanyOutbox`, `toCompanyRule` | `logic.test.ts` "company rules are plant-agnostic" | met | Real Terse 12:51 [live]: `Company.getState` held 3 company rules within 3.5 s of seeding, including LV-101, seen 23 times [stand-in history] |

## 3. Company actor (TASK1 D1)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| CO-1 | Persisted and emittable: `CompanyState` | `actor/src/actor.ts` `Company` | | partial | Real `getState` returned on Terse 12:51 [live]; socket not observed |
| CO-2 | `loadSeed(c)`, `registerPlant(id)` | `Company.loadSeed`, `registerPlant` | | partial | Ran on real Terse [live]. `loadSeed` wipes `rules`, and glue seeds Company last, see Open gaps |
| CO-3 | `requiredCrossPlantVoters(proposal)` → components in other plants sharing a resource with the proposer or any required voter | `logic/rules.ts` `crossPlantVoters` | `logic.test.ts` "P-100 voters are the four local components plus plant-b/TV-101" | met | Real Terse 12:51 [live]: `propose` added plant-b/TV-101. Logic test also passes [pure] |
| CO-4 | `promoteRule(r)` dedupes by condition + consequence and bumps `timesSeen` | `mergeCompanyRule` | `logic.test.ts` "company rules are plant-agnostic and deduped" | partial | Passed [pure]. Dedupes on model, metrics and ops; bumps `timesSeen` |
| CO-5 | `recordAudit(a)` | `Company.recordAudit` | | partial | Read: validated, capped at 300 |

## 4. Actor deliverables and tests (TASK1 D2, D3, tests)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| AD-1 | `terse deploy` and `terse actor generate` | | | partial | `terse actor dev` built and served the actors locally at 12:50, seen by me. No `terse deploy` or generated client |
| AD-2 | `actor/HANDOFF.md`: URL, API key instructions without secrets, every method signature, one-time execute token flow, three examples (loadSeed, propose, vote) | | | missing | No `actor/HANDOFF.md` yet |
| AD-3 | Actor clients and agent startup instructions supplied to Person 3 | `docs/person1/INTEGRATION.md` | | partial | Draft on disk; waiting on real runs |
| AT-1 | Test: two `vote` calls for one componentId → second rejected | | `actor/tests/logic/logic.test.ts` | met | Passed 12:41 [pure]: 29 of 29 in the file. Same check on Terse pending |
| AT-2 | Test: two proposals on one component → only one reaches `veto_window` | | `logic.test.ts` | met | Passed 12:41 [pure] |
| AT-3 | Test: `similar("plant-a/P-100", "speedPct", 85, …)` returns seeded ≥ 80% events with LV-101 positionPct ≥ 85 effects | | `logic.test.ts` | met | Passed 12:41 [pure], on the labelled stand-in history |
| AT-4 | Test: `propose` from plant-a/P-100 → required voters are plant-a TK-101, LV-101, E-101, TV-101 + plant-b/TV-101, `crossPlant: true` | | `logic.test.ts` | met | Passed 12:41 [pure] |
| AT-5 | Test: `addCalibration` with 5 large errors raises marginPct to 15 | | `logic.test.ts` | met | Passed 12:41 [pure] |
| AT-6 | Test: rule promotion fires on the third matching event and dedupes on the fourth | | `logic.test.ts` | met | Passed 12:41 [pure] |

## 5. Agents (TASK1 agent workstream)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| S-1 | `spawn.ts`: one agent per component in both plants (10) with `@agent-relay/sdk`, on `plant-a` or `plant-b`, all joining `company` | `agent/spawn.ts` | | partial | `agent/tests/live-relay-proof.ts` passed 12:52 on the real broker [real Relay, real model, fake glue]. One process runs all ten |
| S-2 | Mechanics (P-100, LV-101) on Codex; TK-101, E-101, TV-101 on Claude; agent id `agent:<ComponentId>` | `agent/spawn.ts`, `agent/llm.ts` `RoutedLlm` | | partial | Agent id correct. Vendor gap: `codex` routes to OpenAI Responses, and Claude falls back to OpenAI (main, 12:35). One real vendor today, labelled in each vote |
| S-3 | `roles/*.md`: four system prompts with role priorities and the hard contract | `agent/roles/*.md`, `agent/physics.md`, `vote.ts` `systemPrompt` | | partial | Read: four roles, contract and physics summary joined per vote. No test on prompt text |
| V-1 | Vote step 1: fetch own state from glue `/component/:id` | `agent/vote.ts` `gatherContext` | `agent/tests/vote.real.test.ts`, `vote.enforce.test.ts` | partial | Agent suites passed 58 of 58 at 12:41 [fake glue]. Real adapter not yet in the path |
| V-2 | Vote step 2: glue `/similar` with the proposer's id and metric, `to`, `upstreamSnapshot`, `k: 5`; read effects rows for this component | `vote.ts` `loadSharedContext`, `retrieval.ts` `ownRows` | `vote.enforce.test.ts`, `llm-hostile.test.ts` | partial | Passed [fake glue]. Adapter must parse `upstreamSnapshot` from a JSON query param |
| V-3 | Vote step 3: applicable rules from glue `/rules?componentId=&model=` (plant plus company scope) | `vote.ts` `gatherContext`, `glue.ts` `rules` | `llm-hostile.test.ts` | partial | Open: a `/rules` failure is tolerated, so hostile tests "glue rules throw" and "glue rules http500" still fail at 12:41 [fake] |
| V-4 | Vote step 4: prompt has proposal, own state and limits, `marginPct`, retrieved events table, rules, physics summary | `vote.ts` `buildVotePrompt`, `systemPrompt` | `injection.test.ts` | met | Read: all five inputs present. Injection suite: one failure left, on a metric name, not on prompt content [fake] |
| V-5 | Vote step 5: LLM returns only JSON; zod validation against types.ts; re-request once; then `{vote:"no", reason:"malformed prediction"}` | `vote.ts` `askModel`, `parseAnswer`, `safeNo` | `vote.enforce.test.ts` "bad JSON gets one retry, then a safe no" | met | Passed 12:41 [scripted LLM]: 2 requests, then `no`, "malformed prediction", empty prediction |
| V-6 | Vote step 6a: `similarCount` = retrieved length, set in code | `vote.ts` `castVote` | `vote.enforce.test.ts` "similarCount is the retrieved length" | met | Passed 12:41 [fake]. Hostile "inflated similarCount" also passes now |
| V-7 | Vote step 6b: `similarCount < 3` and a predicted metric within 15% of critical → forced `no`, reason "insufficient history" | `vote.ts` `decide`, `retrieval.ts` `relevantEvents` | `vote.real.test.ts`, `vote.enforce.test.ts` "far-away events do not count" | partial | Passed [real model, fake glue]. Open hostile test: "events with no effect row for this component are not evidence for it" |
| V-8 | Vote step 6c: predicted ≥ `critical × (1 − marginPct/100)` → forced `no` | `vote.ts` `decide`, `thresholdReason` | `vote.enforce.test.ts` "safety lives in code" | met | Passed 12:41, including exact threshold and wider margin [fake] |
| V-9 | Vote step 6d: `evidenceEventIds` and `evidenceRuleIds` attached from what was retrieved, never invented | `vote.ts` `orderEvidence`, `castVote` | `vote.enforce.test.ts`, `llm-hostile.test.ts` | met | Passed 12:41 [fake]. `Plant.vote` also rejects unknown ids |
| V-10 | Vote step 7: post `vote` to the plant channel → glue | `agent/runtime.ts` `voteAs`, `channelForVote`, `agent/system.ts` | `agent/tests/live-relay-proof.ts` | partial | Passed 12:52 [real Relay, fake glue]. Not aligned with glue `bcfd064` Relay messages |
| CP-1 | `counter.ts`: when the proposer's own proposal is `blocked`, read blocking votes, ask LLM for a value between `from` and `to` under every voter's threshold minus margin, post `counter` | `agent/counter.ts` `buildCounter`, `runtime.ts` `watchForBlock` | `agent/tests/counter.test.ts`, `runtime.test.ts` | partial | Passed 12:41 [fake glue]. Code computes allowed candidates, the model picks one; a code-chosen value is labelled. Not run on real Relay |
| CP-2 | Max 2 counters per parent | `counter.ts` `counterCount`; `assertCounterAllowed` | `counter.test.ts` "stops at two counters per parent" | met | Passed 12:41 [fake]. Also enforced in `Plant.propose` (`too_many_counters`) |
| LN-1 | `learn.ts`: for every voter compare `vote.predicted[metric]` to observed → `CalibrationEntry` → glue `/calibration` | `agent/learn.ts` `calibrationEntries`, `calibrate` | `agent/tests/learn.test.ts` | partial | Passed 12:41 [fake glue]: every voter gets an entry, falling back to the live reading when `effects` has no row |
| LN-2 | Append the event to the local retrieval cache | `learn.ts` `learnFromExecution` | `learn.test.ts` "calibrates every voter it owns and caches the event" | met | Passed 12:41 [fake]. The reset defect I reported is fixed: votes read `plant.history` first; `vote.enforce.test.ts` covers it |
| LN-3 | If the event matches no existing rule, check `similar()` for ≥ 3 events sharing the crossing → propose a `LearnedRule` via glue `/rule` | `learn.ts` `findRule`, `learnFromBlock` | `learn.test.ts` rule promotion cases | met | Passed 12:41 [fake]. Actors derive rules too; ids differ, and `covered()` suppresses a repeat |
| LN-4 | Cache `rule` messages from `company` so plant-b agents cite plant-a rules on the next vote | `runtime.ts` `onMessage`, `vote.ts` `gatherContext` | `vote.real.test.ts` "citing the company rule" | partial | Rule citing passed [real model, fake glue]. Plant-side promotions publish no `rule` message, but `/rules` returns company rules on every vote |
| LN-5 | Second identical bad proposal is blocked with the most recent execution as `evidenceEventIds[0]` | `vote.ts` `orderEvidence`, `rankSimilar` | `vote.enforce.test.ts` "the repeated block" | partial | Passed 12:41 [fake]. Not observed end to end |
| BT-1 | Test: plant-a LV-101 `no` on P-100 → 85, ≥ 3 evidence ids, predicted positionPct ≥ 81 | | `agent/tests/vote.real.test.ts` | partial | Passed 12:41 [real model, fake glue, stand-in history]. Rerun on `shared/history.json` |
| BT-2 | Test: plant-a LV-101 `yes` on P-100 → 65, predicted positionPct 60–72 | | `vote.real.test.ts` | partial | Passed 12:41 [real model, fake glue, stand-in history] |
| BT-3 | Test: plant-b TV-101 votes on plant-a P-100 → 85 on channel `company` with a predicted `headerBarg` drop | | `vote.real.test.ts` | partial | Passed 12:41 [real model, fake glue, stand-in history]; vote was yes, predicted `headerBarg` 5.46 below 6 |
| BT-4 | Test: plant-b LV-101 `no` on 85 citing the company rule once it exists, `no` for "insufficient history" before | | `vote.real.test.ts` | partial | Both paths passed 12:41 [real model, fake glue, stand-in history] |
| BT-5 | Test: malformed LLM JSON → one retry → safe `no` | | `agent/tests/vote.enforce.test.ts` | met | Passed 12:41 [scripted LLM] |
| BT-6 | Test: calibration after a 1-point error leaves marginPct unchanged; after five 12-point errors marginPct rises | | `agent/tests/learn.test.ts`; `actor/tests/logic/logic.test.ts` | met | Agent test passed, but its margin maths is `FakeGlue`'s own copy; the real proof is the logic test "one error never moves the margin" [pure] |

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
| RP-1 | Channels `plant-a`, `plant-b`, `company` | `agent/system.ts` `CHANNELS` | `live-relay-proof.ts` | partial | Passed 12:52 [real Relay, fake glue] |
| RP-2 | `proposal {proposal}` handled; each required voter replies within 20 s | `runtime.ts` `onProposal`, `vote.ts` `TOTAL_LLM_BUDGET_MS` | `live-relay-proof.ts` | partial | Proof passed, but first decisive vote took 19 s and all votes 21 s at 12:52, under load and rate limits. Near the 20 s window |
| RP-3 | `vote {vote}` agent → glue → `Plant.vote` | `system.ts` `InboundBridge` | `live-relay-proof.ts` | partial | Passed 12:52 [real Relay, fake glue] |
| RP-4 | `counter {parentProposalId, proposal}` agent → glue → `Plant.propose` | `InboundBridge`, `Plant.propose` | `live-relay-proof.ts` | partial | Passed 12:52 [real Relay, fake glue]; counter arrived 17.7 s after the block |
| RP-5 | `executed {proposalId, event}` reaches all plant agents and `company` when cross-plant or model shared | `system.ts` `toWireMessage`, `runtime.ts` `onExecuted` | `live-relay-proof.ts` | partial | Passed 12:52 [fake glue]. Glue `bcfd064` sends `{type, payload}`, which agents do not parse yet |
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
| RU-4 | Agents never vote without `similar()`; `similarCount: 0` within 15% of critical is automatically `no` | `vote.ts` `decide`; `enforceVoteSafety` | `logic.test.ts` "similarCount 0 within 15% of critical is automatically no" | partial | Passed [pure]. Enforced in the agent and again in `Plant.vote` |
| RU-5 | No scope additions: no real PLC, no ML training, ≤ 5 components per plant, no auth, no real data | `shared/plants.json` | | met | 5 components per plant in seed; re-check as code lands |
| RU-6 | Agent outputs are data: validate every Vote; malformed → discard, re-request once, never guess | `vote.ts` `parseAnswer`; `normalizeVote` | `vote.enforce.test.ts`; `logic.test.ts` "normalizeVote" | met | Passed 12:41 [fake, pure]. Agent validates with zod; Plant re-validates and rebuilds the vote from known keys |
| RU-7 | HANDOFF.md in each folder: what runs, exact commands, env vars without secrets, what is stubbed | | | missing | `actor/HANDOFF.md`, `agent/HANDOFF.md` |
| RU-8 | Product writing rule followed in docs | `docs/person1/` | | met | This doc names only ActorRelay modules and the sponsor stack |
| AG-1 | Agents never call `setMetric` or write to the simulator | `agent/*.ts` | | partial | Grep at 12:37 finds no `setMetric`, `/setpoint` or simulator URL in `agent/*.ts`. Recheck at the end |
| AG-2 | Agents never invent evidence ids | `vote.ts` `orderEvidence`; `Plant.vote` | `llm-hostile.test.ts` | met | "invented evidence ids never appear" passed [fake]. `Plant.vote` rejects unknown ids (code read) |

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
| G-1 | Reset produces all ten component snapshots and clears prior pending work | `Plant.loadSeed`; adapter `/reset` pending | | partial | Actor side clears work (real seed ran 12:51). Glue seeds Company last, so the company rule can be lost, see Open gaps |
| G-2 | Pump 50 → 85 blocked with real evidence, includes the other plant's steam-valve vote | | | missing | |
| G-3 | Safer target ≈ 65 passes, executes after the veto window, observed metrics settle within verified ranges | | | missing | |
| G-4 | Repeated unsafe proposal cites the newest relevant observation, without a safe run alone counting as proof of an unsafe outcome | `vote.ts` `orderEvidence`, `newestNote` | `vote.enforce.test.ts` "the repeated block" | partial | Passed [fake]: newest run first, and a safe run alone never supplies the block. Not observed end to end |
| G-5 | Plant B cites a supported company rule from Plant A, or explicitly reports insufficient history until it exists | `vote.ts` `decide`, `ruleApplies` | `vote.real.test.ts` | partial | Both paths passed [real model, fake glue]. Not observed end to end |
| G-6a | Invalid votes rejected | `normalizeVote`, `enforceVoteSafety` | `votes.test.ts`, `actor-attacks.test.ts` | partial | Real Terse 12:51 [live]: wrong agent id and invented evidence rejected. Actor findings A1 to A11 open at ar-adversarial |
| G-6b | Duplicate votes rejected | `assertVoteAllowed` | `votes.test.ts` | met | Real Terse 12:51 [live]: `duplicate_vote` |
| G-6c | Stale proposals rejected | `assertVoteAllowed`, `isStale`, `assertExecutable` | `lifecycle.test.ts` | partial | Read; logic passed [pure]. Not run on Terse |
| G-6d | Unapproved writes rejected | `assertExecutable`, `redeemToken` | `actor-attacks.test.ts` | partial | Read. Adapter's `/execute-callback` must not dispatch without a claim; pending |
| G-6e | Retries do not duplicate a simulation command | `Plant.claimDispatch` | | partial | Read: single claim, a claimed write is never retried. Needs adapter and a simulator-side check |
| G-7 | Dashboard, actor state, command result and trends agree; recovery is never marked from command acceptance alone | `ExecutionState` in `actor.ts` | | partial | Read: accepted, claimed, applied, observed and failed are separate states |
| G-8 | No scripted conversation presented as live reasoning; any fallback labelled | `vote.ts` `provenance`, `counter.ts` `source` | | partial | Read: fallback and code-decided values are labelled in the vote or rationale text |
| PS-1 | Plan scope: validate the current proposal and limits immediately before dispatch | `assertExecutable` | | partial | Read: rechecks status, deadline, unanimity, staleness and limits |
| PS-2 | Plan scope: record acceptance separately from observed results | `Execution` state machine, audit entries | | partial | Read: "Accepted", "Simulator accepted" and "Observed" are separate audit lines |
| PS-3 | Plan interface: Person 1 gives Person 3 actor client, method signatures, Relay participants, agent startup, error semantics; no credentials in committed files | `docs/person1/INTEGRATION.md` | | partial | Draft on disk; waiting on the adapter and real runs |

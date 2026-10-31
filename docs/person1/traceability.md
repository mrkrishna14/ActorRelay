# Traceability

Every actor and agent requirement from `TASK1.MD`, the `PLAN.MD` acceptance gate and `CLAUDE.MD`, with the code that implements it and the test that proves it.

**Status rules.** `met`: the code is there and a passing test proves the requirement. `partial`: code exists, but the test is missing, failing, or ran only on a fake where the requirement needs the real thing. `missing`: no code. Evidence is what was read or run, not what a session reported. Labels: `[pure]` pure function, `[fake]` fake glue, runtime or model, `[live]` real Terse seen by me.

**How this was checked.** Five independent agents re-read every requirement against the code and tests at about 13:25, without seeing earlier verdicts. I settled where they differed from my earlier verdicts and spot-checked nine cited tests. A row marked as a report was read from a generated file, not rerun by me.

**Evidence age.** Suite results come from one run at `ca68d98`, 12:59 to 13:05: agent 76 of 76, actor logic 32 of 32, property 84 of 97, adversarial 267 of 298, contract 386 of 387. `actor/`, `agent/` and `glue/` have changed since, so every `met` needs one rerun. WSL runs are on hold until main says go.

**Last refresh:** 13:33 PT, git `ca5ec6e`.

| Scoreboard | met | partial | missing |
|---|---|---|---|
| All rows | 45 | 74 | 2 |

## Open gaps
1. **Repeat block is too slow on real Terse** (NF-3). The generated 13:29 report shows 14 s, then a timeout at 25 s, against a 5 s target. It blames Plant queueing with load near 38. My own runs at about load 20 agree: Plant calls ran in 0.1 to 0.6 s but queued 4 to 21 s, while Company had no queue. `69ebb4a` and `6447368` target this; not re-measured by me.
2. **No full-stack run seen.** Real Terse with real agents passed on a fake glue and plant. I have not seen real actors, Relay, glue and simulator pass together.
3. **Open test findings.** Property and adversarial failures were open at `ca68d98`; owners report fixes since. Unverified until the rerun.
4. **Missing deliverables.** `actor/HANDOFF.md` and `web/HANDOFF.md` do not exist. There is no `terse deploy` or generated client (AD-1, AD-2).
5. **One real vendor.** Claude roles use the labelled fallback (main's decision, 12:35), and `codex` means the OpenAI API, not the Codex CLI (S-2).
6. **Threshold floor.** `thresholdFor` floors at `limit.max`, so TK-101 tempC 78 passes against a spec line of 76.5, and margins above 12.5 change nothing on LV-101 (V-8, CL-5). Main approved narrowing it; the patch had not landed at 13:32.
7. **OpenAI limits.** A 429 costs a voter its model answer. Stop evals during rehearsal and the demo.

## Deviations from the task text
| Where | Task says | Code does | Why |
|---|---|---|---|
| `similar()` | k nearest | Newest live event first; seeded events past 15% of range dropped | Otherwise the repeat block cannot cite the run, and "insufficient history" cannot fire |
| `setMetric` | Only Plant calls it | Any caller holding Plant's one-time token; glue calls it | Plant must not await Component, or mailboxes deadlock |
| Execution order | CLAUDE.MD: `setMetric`, then simulator | TASK3 order: simulator, then `setMetric` | A metric must not change before the simulator accepts |
| Threshold | `critical × (1 − margin/100)` | Floored at `limit.max` | Otherwise TK-101's normal 75 °C blocks everything at a wider margin (main, 13:01) |
| Counter value | The model picks | Code picks the safe target; the model explains it | Fixed by ar-agents after evals |
| `company` channel | All ten agents join | Only TV-101 agents join | Relay post latency grows with channel members |
| Blocked signal | Not specified | Proposer polls `/state` | The protocol has no `blocked` message |
| Instance id | `plant-a/LV-101` | `plant-a.LV-101` | Terse ids cannot hold `/`; state keeps the slash |
| `mirror` | Overwrite metrics | Merge into existing metrics | A partial push keeps the other metrics |
| `tick` field | `PlantState.tick` | Socket field `tickCount`; `getState()` returns `tick` | Method `tick()` owns the name |
| Agent processes | One agent per component | Ten Relay identities in one process | Replies arrive at once instead of after a harness turn |

## 1. Component actor (TASK1 D1)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| C-1 | Persisted and emittable: all `ComponentState` fields plus `calibration: CalibrationEntry[]` | `actor/src/actor.ts` `Component` fields | `actor/tests/contract/actor-surface.contract.test.ts` "Component: ComponentState plus calibration, less id" | partial | [pure] Static decorator check only; `id` is not emittable; persistence never ran on real Terse |
| C-2 | `mirror(metrics)` overwrites metrics and sets `lastTick` | `Component.mirror` | `actor-runtime.contract.test.ts` "mirror returns the emitted shape and merges by metric" | partial | [fake] Merges instead of replacing metrics; no recorded test asserts `lastTick` changes |
| C-3 | `mirror` recomputes status: `warning` at `max`, `critical` at `critical` | `actor/src/logic/component.ts` `computeStatus` | `actor-runtime.contract.test.ts` "status is warning at max and critical at critical, per TASK1" | met | [fake] Real `mirror` on the real class returns warning at 80, critical at 90, ok at 50 |
| C-4 | `setMetric(metric, value, proposalId)` callable only by Plant; throws unless the proposal has passed `veto_window`; Plant passes a one-time token | `Component.setMetric`, `Plant.redeemToken` | `agent/tests/adversarial/actor-attacks.test.ts` "a valid token cannot be replayed" | partial | [fake] Token gate proven, but glue calls `setMetric`, not Plant; any token holder can |
| C-5 | `addCalibration(e)` appends and keeps the last 50 | `applyCalibration` | `actor/tests/property/calibration.test.ts` "keeps the last 50 entries, in order" | met | [pure] Exact last 50 in order |
| C-6 | Mean absError of last 5 > 10% of (max − min) → `marginPct = min(25, marginPct + 5)` | `applyCalibration` | `actor/tests/logic/logic.test.ts` "five large errors raise marginPct from 10 to exactly 15" | partial | [pure] Core rise passes; repro F7 fails: margin rose on a one-entry window |
| C-7 | Mean absError of last 5 < 3% of range → `marginPct = max(5, marginPct − 2)` | `applyCalibration` | `logic.test.ts` "five tiny errors narrow the margin by 2, floored at 5" | partial | [pure] Core narrowing passes; property failed: margin fell with only four limited entries kept |
| C-8 | `setMargin(pct)`, `loadSeed(state)` | `Component.setMargin`, `Component.loadSeed` | `actor-runtime.contract.test.ts` "setMargin stays in 5..25" | met | [fake] Both run on the real class; `setMargin` clamps, `loadSeed` returns the strict shape |
| C-9 | Broadcast after every mutation | `Component.#publishState` | `actor-runtime.contract.test.ts` "every mutation broadcasts the emitted shape" | partial | [fake] All five mutators publish, but the test covers `mirror` only; sockets unproven |
| C-10 | Instance id = ComponentId; components and limits per the CLAUDE.MD plant table | `actor/src/ids.ts` `componentActorId` | `actor-runtime.contract.test.ts` "every ComponentId maps to a legal actor id and stays unique" | met | [pure] SDK forbids `/`, so instance id is dotted; plant table matches field by field |

## 2. Plant actor (TASK1 D1, CLAUDE.MD actor methods)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| P-1 | Persisted and emittable: `PlantState` | `actor/src/actor.ts` `Plant` fields | `actor-surface.contract.test.ts` "Plant: PlantState, less id, with tick emitted as tickCount" | partial | [pure] Static decorator check; socket field is `tickCount`, no `id`; `getState()` has both. Persistence not proven |
| P-2 | `loadSeed(plant, history)` | `Plant.loadSeed` | `actor-runtime.contract.test.ts` "Plant.history holds only its own plant's events" | met | [fake] Real class seeds ids, history and derived rules. Also ran on real Terse [live], stand-in history |
| P-3 | `propose(p)` assigns id and sets status `voting` | `Plant.propose` | `actor-runtime.contract.test.ts` "propose takes the five-field glue body" | met | [fake] Routed id, status `voting`, forged fields ignored. Also ran on real Terse [live] |
| P-4 | `requiredVoters` = every other component reachable from the proposer through upstream/downstream links | `logic/proposals.ts` `reachableVoters` | `actor/tests/property/voters.test.ts` "is exact for every component in both plants" | met | [pure] Exact on all ten seeded components. One-sided link tests fail, outside the seed shape |
| P-5 | Adds `Company.requiredCrossPlantVoters`, sets `crossPlant` | `Plant.propose`, `Company.requiredCrossPlantVoters` | `actor-runtime.contract.test.ts` "propose takes the five-field glue body" | partial | Real Terse added plant-b/TV-101 [live, older code]. An empty Company drops the voter; attack test fails |
| P-6 | `vote(v)` rejects duplicates per componentId | `assertVoteAllowed` | `logic.test.ts` "second vote from the same component is rejected" | met | [pure] Also seen on real Terse [live]. Only exception: yes to no inside the veto window |
| P-7 | `veto(proposalId, by)` | `Plant.veto` | `actor/tests/property/lifecycle.test.ts` "veto lands only while the window is open" | met | [fake] Refused outside `veto_window`; a vetoed proposal never executes |
| P-8 | `execute(proposalId)` | `Plant.execute`, `assertExecutable` | `lifecycle.test.ts` "execute never fires before the deadline, never twice" | met | [fake] Gate and idempotence proven; records acceptance only |
| P-9 | `recordEvent(e)` | `Plant.recordEvent` | `actor-runtime.contract.test.ts` "recordEvent is idempotent per proposal" | met | [fake] Idempotent; unexecuted proposals refused. A null-proposal event is still accepted, see Open gaps |
| P-10 | `promoteRule(r)` | `Plant.promoteRule` | `rules.test.ts` "an agent-submitted rule needs three distinct real ids" | met | [fake] Accepts three real unsafe events; refuses invented, repeated or safe support |
| P-11 | `tick()` | `Plant.tick` | `actor-runtime.contract.test.ts` "tick and sweep block it, and /tick reaches glue" | met | [fake] Direct ticks reach a local HTTP server and drive the sweep |
| P-12 | `similar(componentId, metric, to, upstreamSnapshot, k=5)`: filter on componentId and metric; distance `|after − to|/range + 0.5 × mean normalized distance of shared upstreamSnapshot keys`; k nearest | `logic/similar.ts` `rankSimilar` | `actor/tests/property/similar.test.ts` "returns the k smallest distances under the exact formula" | partial | [pure] Filter and formula pass; k=0 tests fail. Live pin and band are deliberate, see Deviations |
| P-13 | `similar` is pure over persisted history, no LLM; called with the proposer's componentId and metric | `rankSimilar`; `agent/vote.ts` `loadSharedContext` | `similar.test.ts` "never mutates history"; `vote.enforce.test.ts` "similarCount is the retrieved length" | met | [pure, fake] Deterministic, no mutation, no LLM; LV-101 retrieves P-100 events |
| P-14 | Alarm every 1 s: `tick()` increments tick and POSTs glue `/tick` | `Plant.onAlarm`, `armAlarm` | `actor-runtime.contract.test.ts` "tick and sweep block it" | partial | [fake] Direct ticks only. My 13:08 real run saw a sweep expire a proposal [live], on code before `69ebb4a` |
| P-15 | Alarm every 2 s: all required yes → `veto_window` (deadline now + 10 s); any no → `blocked` | `logic/proposals.ts` `planSweep`, `Plant.sweep` | `lifecycle.test.ts` "unanimous yes opens the veto window with deadline now + 10s" | partial | [fake] Explicit sweeps give the exact window and any-no block. 2 s alarm cadence not measured |
| P-16 | Veto window passed → `execute` → `Component.setMetric` → bridge writes setpoint | `Plant.execute`, `Plant.claimDispatch`, `Component.setMetric` | `actor-runtime.contract.test.ts` "after the deadline the sweep executes" | partial | [fake] Sweep executes, token write works. Glue's dispatch and the simulator write are unproven |
| P-17 | After 5 ticks `recordEvent` with observed effects → broadcast `executed` | `Plant.recordEvent` | `actor-runtime.contract.test.ts` "recordEvent takes the /observed body" | partial | [fake] Stores observed effects. The 5-tick wait and `executed` publish sit outside Plant, unproven |
| P-18 | Votes missing after 30 s → `expired` | `planSweep` | `logic.test.ts` "missing votes expire after 30s" | partial | [pure] Exact on explicit sweeps. Real Terse expired a proposal at 13:08 [live], before `69ebb4a` |
| P-19 | At most one proposal per component in `veto_window`; the second waits in `voting` | `planSweep` `touched`, `occupied` | `logic.test.ts` "two proposals on one component" | partial | [pure] Holds within one plant; cross-plant property fails because each plant sweeps only its own proposals |
| P-20 | Only `Plant.execute` mutates a metric | `Component.setMetric`, `Plant.redeemToken` | `actor-attacks.test.ts` "a valid token cannot be replayed" | partial | [fake] Token gate holds. `mirror` and `Component.loadSeed` also write metrics without a token |
| P-21 | After each `recordEvent`: group history by (componentId, metric, bucketed `after` ≥ threshold); ≥ 3 events sharing an effect that crosses a limit on the same downstream component → create or update a plant-scope `LearnedRule` | `logic/rules.ts` `deriveRules`, `mergeDerivedRules` | `logic.test.ts` "rule fires on the third matching event and dedupes on the fourth" | partial | [pure] Third creates, fourth dedupes; order tests fail: a contradicted rule stays |
| P-22 | If the component `model` exists in another plant → `Company.promoteRule` with scope company | `pushToCompany`, `Plant.#syncCompany`, `toCompanyRule` | `rules.test.ts` "promotes to the company only when the model exists in both plants" | partial | Real Terse promoted 3 rules [live, older code]. Rewritten in `69ebb4a` since; model-gate and separation tests fail |

## 3. Company actor (TASK1 D1)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| CO-1 | Persisted and emittable: `CompanyState` | `actor/src/actor.ts` `Company` fields | `actor-surface.contract.test.ts` "Company: exactly CompanyState" | partial | [pure] Decorators match by static read; persistence and emission never ran on real Terse |
| CO-2 | `loadSeed(c)`, `registerPlant(id)` | `Company.loadSeed`, `Company.registerPlant` | `actor-runtime.contract.test.ts` "Company.recordAudit and registerPlant return contract shapes" | partial | [fake] `loadSeed` proven; `registerPlant` shape only, its add branch never runs |
| CO-3 | `requiredCrossPlantVoters(proposal)` → components in other plants sharing a resource with the proposer or any required voter | `logic/rules.ts` `crossPlantVoters` | `actor-runtime.contract.test.ts` "requiredCrossPlantVoters returns ComponentId[]" | met | [fake] Real Company returns plant-b/TV-101; exact voters hold for all ten components [pure] |
| CO-4 | `promoteRule(r)` dedupes by condition + consequence and bumps `timesSeen` | `mergeCompanyRule`, `companyRuleKey` | `actor/tests/property/rules.test.ts` "company dedupes and bumps timesSeen" | partial | [fake] Dedupe and bump pass; F9 fails: the key merges rules from different changed components |
| CO-5 | `recordAudit(a)` | `Company.recordAudit` | `actor-runtime.contract.test.ts` "Company.recordAudit and registerPlant return contract shapes" | partial | [fake] Test calls it but never reads audit back |

## 4. Actor deliverables and tests (TASK1 D2, D3, tests)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| AD-1 | `terse deploy` and `terse actor generate` | `actor/package.json` scripts |  | missing | Local `terse actor dev` runs; no deploy, URL or generated client |
| AD-2 | `actor/HANDOFF.md`: URL, API key instructions without secrets, every method signature, one-time execute token flow, three examples (loadSeed, propose, vote) | `actor/HANDOFF.md` |  | missing | File does not exist |
| AD-3 | Actor clients and agent startup instructions supplied (solo: to our `glue/` and the runbook) | `glue/actors.ts`, `docs/person1/RUNBOOK.md` |  | partial | Glue has its own Terse client; no generated client. Startup is documented, not rehearsed end to end by me |
| AT-1 | Test: two `vote` calls for one componentId → second rejected | `assertVoteAllowed` | `actor-runtime.contract.test.ts` "vote returns the Proposal, accepts a cross-plant voter, rejects a duplicate" | met | [fake] Real `Plant.vote` rejects the second with `duplicate_vote` |
| AT-2 | Test: two proposals on one component → only one reaches `veto_window` | `planSweep` | `logic.test.ts` "two proposals on one component: only one reaches veto_window" | partial | [pure] Same-plant case passes; two-plant property fails: both windows can overlap on a shared TV-101 |
| AT-3 | Test: `similar("plant-a/P-100", "speedPct", 85, …)` returns seeded ≥ 80% events with LV-101 positionPct ≥ 85 effects | `rankSimilar` | `logic.test.ts` "similar returns the seeded >=80% events" | partial | [pure] Passes on the stand-in history only; `shared/history.json` never tested |
| AT-4 | Test: `propose` from plant-a/P-100 → required voters are plant-a TK-101, LV-101, E-101, TV-101 + plant-b/TV-101, `crossPlant: true` | `Plant.propose` | `actor-runtime.contract.test.ts` "propose takes the five-field glue body" | met | [fake] Real Plant and Company give exact five voters and `crossPlant` true |
| AT-5 | Test: `addCalibration` with 5 large errors raises marginPct to 15 | `Component.addCalibration` | `actor-runtime.contract.test.ts` "addCalibration: five large errors raise the margin to exactly 15" | met | [fake] Five large errors through the real class move margin from 10 to 15 |
| AT-6 | Test: rule promotion fires on the third matching event and dedupes on the fourth | `deriveRules`, `mergeDerivedRules` | `logic.test.ts` "rule fires on the third matching event and dedupes on the fourth" | met | [pure] No rule at two, one at three, same id with `timesSeen` 4 at four |

## 5. Agents (TASK1 agent workstream)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| S-1 | `spawn.ts`: one agent per component in both plants (10) with `@agent-relay/sdk`, on `plant-a` or `plant-b`, all joining `company` | `agent/spawn.ts` `main`, `identity`, `channelsFor` |  | partial | No test runs `spawn.ts`. Only TV-101 agents join `company`, against TASK1, see Deviations |
| S-2 | Mechanics (P-100, LV-101) on Codex; TK-101, E-101, TV-101 on Claude; agent id `agent:<ComponentId>` | `agent/llm.ts` `RoutedLlm.complete` | `plants.contract.test.ts` vendor rows; `agent-glue.contract.test.ts` "agent id format" | partial | [pure] Config and id format only. `codex` routes to the OpenAI API; Claude CLI never answered |
| S-3 | `roles/*.md`: four system prompts with role priorities and the hard contract | `agent/roles/*.md`, `vote.ts` `systemPrompt` |  | partial | Read: four roles plus contract joined per vote. No test asserts any content |
| V-1 | Vote step 1: fetch own state from glue `/component/:id` | `vote.ts` `gatherContext`, `glue.ts` `HttpGlue.component` | `llm-hostile.test.ts` "glue component http500 with a model that says yes" | met | [fake] Real `HttpGlue` over HTTP to a local server; a failed fetch turns yes into no |
| V-2 | Vote step 2: glue `/similar` with the proposer's id and metric, `to`, `upstreamSnapshot`, `k: 5`; read effects rows for this component | `vote.ts` `loadSharedContext`, `retrieval.ts` `ownRows` | `vote.enforce.test.ts` "similarCount is the retrieved length" | met | [fake] Uses the proposer's id, metric, to, snapshot and k 5; rowless events are dropped |
| V-3 | Vote step 3: applicable rules from glue `/rules?componentId=&model=` (plant plus company scope) | `vote.ts` `gatherContext`, `retrieval.ts` `ruleApplies` | `relay.contract.test.ts` "plant-b's valve refuses 85 % on the company rule" | partial | [fake] Company rule passes; plant-scope branch and the `/rules` query have no passing assertion |
| V-4 | Vote step 4: prompt has proposal, own state and limits, `marginPct`, retrieved events table, rules, physics summary | `vote.ts` `buildVotePrompt`, `systemPrompt`, `agent/physics.md` |  | partial | Read: all inputs built and physics matches CLAUDE.MD. No test asserts prompt content |
| V-5 | Vote step 5: LLM returns only JSON; zod validation against types.ts; re-request once; then `{vote:"no", reason:"malformed prediction"}` | `vote.ts` `askModel`, `parseAnswer`, `castVote` | `vote.enforce.test.ts` "bad JSON gets one retry, then a safe no" | met | [fake] Exactly two calls, then no, "malformed prediction", empty prediction |
| V-6 | Vote step 6a: `similarCount` = retrieved length, set in code | `vote.ts` `castVote` | `vote.enforce.test.ts` "similarCount is the retrieved length" | met | [fake] The model's 99 is ignored; counted after the agent's relevance cut |
| V-7 | Vote step 6b: `similarCount < 3` and a predicted metric within 15% of critical → forced `no`, reason "insufficient history" | `vote.ts` `insufficientHistory`, `decide` | `vote.enforce.test.ts` "thin history near critical stays a no" | met | [fake] A yes is forced to no with the insufficient-history reason |
| V-8 | Vote step 6c: predicted ≥ `critical × (1 − marginPct/100)` → forced `no` | `vote.ts` `thresholdFor`, `decide` | `vote.enforce.test.ts` "a prediction exactly on the threshold is a no" | partial | [fake] Proven only where the `limit.max` floor is idle: TK-101 tempC 78 passes against a spec line of 76.5 |
| V-9 | Vote step 6d: `evidenceEventIds` and `evidenceRuleIds` attached from what was retrieved, never invented | `vote.ts` `orderEvidence`, `castVote` | `llm-hostile.test.ts` "invented evidence ids never appear" | met | [fake] Invented ids dropped; output ids are retrieved events or the newest run |
| V-10 | Vote step 7: post `vote` to the plant channel → glue | `runtime.ts` `voteAs`, `channelForVote`, `spawn.ts` `post` | `runtime.test.ts` "each required voter votes once" | partial | [fake] Channel choice asserted in memory; `spawn.ts`, real Relay and glue not exercised |
| CP-1 | `counter.ts`: when the proposer's own proposal is `blocked`, read blocking votes, ask LLM for a value between `from` and `to` under every voter's threshold minus margin, post `counter` | `agent/counter.ts` `buildCounter`, `runtime.ts` `watchForBlock` | `runtime.test.ts` "the proposer notices its own block" | partial | [fake] Code fixes the target and the model only explains, unlike TASK1; contract test failed with no counter posted |
| CP-2 | Max 2 counters per parent | `counter.ts` `counterCount`, `rootOf`; `assertCounterAllowed` | `counter.test.ts` "stops at two counters per parent" | met | [fake] A third counter returns null; `Plant.propose` also refuses it |
| LN-1 | `learn.ts`: for every voter compare `vote.predicted[metric]` to observed → `CalibrationEntry` → glue `/calibration` | `learn.ts` `calibrate`, `calibrationEntries` | `relay.contract.test.ts` "a safe run calibrates every voter" | met | [fake] Every voter stored entries on real Component logic; Terse and glue are fakes |
| LN-2 | Append the event to the local retrieval cache | `learn.ts` `learnFromExecution`, `RetrievalCache.addEvent` | `learn.test.ts` "calibrates every voter it owns and caches the event" | met | [fake] Cache holds the event; an unexecuted proposal leaves it empty |
| LN-3 | If the event matches no existing rule, check `similar()` for ≥ 3 events sharing the crossing → propose a `LearnedRule` via glue `/rule` | `learn.ts` `findRule`, `learnFromExecution`, `postRule` | `learn.test.ts` "a block on three or more shared crossings proposes a rule" | partial | [fake] Proven through `learnFromBlock` only; the executed path has no passing test |
| LN-4 | Cache `rule` messages from `company` so plant-b agents cite plant-a rules on the next vote | `runtime.ts` `onMessage`, `RetrievalCache.addRule`, `allRules` |  | partial | Cached rules are never read; plant-b cites through `/rules`. No test on a `rule` message |
| LN-5 | Second identical bad proposal is blocked with the most recent execution as `evidenceEventIds[0]` | `vote.ts` `orderEvidence`, `retrieval.ts` `newestExecution` | `relay.contract.test.ts` "repeat 85 %: blocked citing the newest execution first" | met | [fake] `evidenceEventIds[0]` is the newest run and real `Plant.vote` accepts it; scripted model |
| BT-1 | Test: plant-a LV-101 `no` on P-100 → 85, ≥ 3 evidence ids, predicted positionPct ≥ 81 | `vote.ts` `castVote` | `vote.real.test.ts` "votes no on 85 with at least 3 evidence ids" | partial | [real model, fake glue] Stand-in history only; not rerun on current code |
| BT-2 | Test: plant-a LV-101 `yes` on P-100 → 65, predicted positionPct 60–72 | `vote.ts` `castVote` | `vote.real.test.ts` "votes yes on 65 with predicted positionPct 60-72" | partial | [real model, fake glue] Stand-in history only; not rerun on current code |
| BT-3 | Test: plant-b TV-101 votes on plant-a P-100 → 85 on channel `company` with a predicted `headerBarg` drop | `vote.ts` `castVote`, `retrieval.ts` `expectedHeader`, `channelForVote` | `vote.real.test.ts` "plant-b TV-101 votes on plant-a P-100 to 85" | partial | [real model, fake glue] Stand-in history; GPT fallback; header logic rewritten since |
| BT-4 | Test: plant-b LV-101 `no` on 85 citing the company rule once it exists, `no` for "insufficient history" before | `vote.ts` `decide`, `retrieval.ts` `ruleApplies` | `vote.real.test.ts` plant-b LV-101 cases | partial | [real model, fake glue] Both pass on stand-in history with a hand-written rule |
| BT-5 | Test: malformed LLM JSON → one retry → safe `no` | `vote.ts` `askModel`, `castVote` | `vote.enforce.test.ts` "bad JSON gets one retry, then a safe no" | met | [fake] Two model calls, then no, "malformed prediction" |
| BT-6 | Test: calibration after a 1-point error leaves marginPct unchanged; after five 12-point errors marginPct rises | `learn.ts` `calibrate`, `applyCalibration` | `calibration.test.ts` "one 1-point error leaves the margin; five 12-point errors raise it" | met | [pure] Real `applyCalibration` proves both; the agent test's margin check uses `FakeGlue`'s own maths |

## 6. Continuous learning (CLAUDE.MD)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| CL-1 | Never answer from priors alone: every vote retrieves the k most similar events and reads effects on its own component | `agent/vote.ts` `gatherContext` | `vote.enforce.test.ts` "retrieval failure is a safe no" | met | [fake] Failed retrieval gives a safe no; events with no own rows are dropped |
| CL-2 | Predict from those events plus the physics summary | `vote.ts` `buildVotePrompt`, `evidenceEstimates` | `vote.real.test.ts` "votes yes on 65 with predicted positionPct 60-72" | partial | [real model, fake glue] Predictions look right; no test asserts events or physics reach the prompt |
| CL-3 | Fewer than 3 similar events: must say so and vote `no` within 15% of a critical limit | `vote.ts` `insufficientHistory`, `decide` | `vote.real.test.ts` "votes no for insufficient history before the company rule exists" | met | [real model, fake glue] States it and votes no; actor also forces no at `similarCount` 0 [pure] |
| CL-4 | After execution compute per-metric error and append a `CalibrationEntry` | `agent/learn.ts` `calibrationEntries`, `calibrate` | `actor/tests/contract/relay.contract.test.ts` "a safe run calibrates every voter" | met | [fake] Real runtime and Component append entries; `learn.test.ts` asserts `absError` |
| CL-5 | MAE over last 5 > 10% of range → `marginPct` + 5, cap 25, used on the next vote | `applyCalibration`, `vote.ts` `thresholdFor` | `logic.test.ts` "five large errors raise marginPct from 10 to exactly 15" | partial | [pure] +5 and cap proven; next-vote effect unproven. The `limit.max` floor makes margins above 12.5 change nothing on LV-101 |
| CL-6 | Promote a recurring pattern to `LearnedRule` at 3+ sightings; rules are cited like events | `deriveRules`, `vote.ts` `bindingRules` | `logic.test.ts` "rule fires on the third matching event" | met | [pure] Third sighting creates; [real model, fake glue] a vote cites a rule id |
| CL-7 | "It learned": same bad proposal blocked faster, most recent run cited first | `vote.ts` `orderEvidence` | `relay.contract.test.ts` "repeat 85 %: blocked citing the newest execution first" | partial | [fake] Newest-first proven on real actor classes; "blocked faster" is untested |

## 7. Multiplayer (CLAUDE.MD)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| MP-1 | `Company` holds plant list, shared-resource graph, cross-plant rule library | `Company` | `actor-runtime.contract.test.ts` "getState on all 12 actors is strictly the contract" | met | [fake] Real class holds plants, shared resources and rules |
| MP-2 | A voter on a shared resource pulls in the components on that resource in the other plant; `crossPlant: true`; those votes travel on `company` | `crossPlantVoters`, `runtime.ts` `channelForVote` | `logic.test.ts` "P-100 voters are the four local components plus plant-b/TV-101" | partial | [pure] Voters and `crossPlant` proven; `company` delivery never ran on real Relay in a counted run |
| MP-3 | Rules promoted to the company library when the same `model` exists in both plants | `pushToCompany`, `toCompanyRule` | `rules.test.ts` "promotes to the company only when the model exists in both plants" | partial | [fake] Pass predates the `pushToCompany` rewrite; Company-side model gate test fails |
| MP-4 | Plant-b's LV-101 cites a plant-a incident before plant-b experienced it | `retrieval.ts` `ruleApplies` | `relay.contract.test.ts` "plant-b's valve refuses 85 % on the company rule it never saw happen" | partial | [fake] Scripted model, fixture history; the real-model test injects the company rule by hand |

## 8. Relay protocol (CLAUDE.MD)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| RP-1 | Channels `plant-a`, `plant-b`, `company` | `agent/wire.ts` `CHANNELS` | `relay.contract.test.ts` "names exactly the three channels" | partial | [pure] Constant matches the spec; joins not run in a counted test. Only TV-101 agents join `company` |
| RP-2 | `proposal {proposal}` handled; each required voter replies within 20 s | `runtime.ts` `onProposal` | `runtime.test.ts` "each required voter votes once" | partial | [fake] Direct `onMessage`; 20 s never measured; the model budget ignores retrieval time |
| RP-3 | `vote {vote}` agent → glue → `Plant.vote` | `runtime.ts` `voteAs`, `glue/` | `relay.contract.test.ts` "the payload of an agent's vote is exactly the body of POST /vote" | partial | [fake] Payload shape checked; glue's path to `Plant.vote` has no counted pass |
| RP-4 | `counter {parentProposalId, proposal}` agent → glue → `Plant.propose` | `runtime.ts` `watchForBlock`, `glue/` | `runtime.test.ts` "the proposer notices its own block" | partial | [fake] Posted to a list. The contract test on real actor classes failed at the counter step at `ca68d98` |
| RP-5 | `executed {proposalId, event}` reaches all plant agents and `company` when cross-plant or model shared | `runtime.ts` `onExecuted`, `glue/` | `runtime.test.ts` "learns once even though the message arrives on two channels" | partial | [fake] Receiver dedupes; glue's publisher has no counted pass |
| RP-6 | `rule {rule}` on `company` when scope is company | `runtime.ts` `onMessage`, `wire.ts` | `relay.contract.test.ts` "an agent reads a rule sent as {type, payload}" | partial | [fake] Decode only; `/rules` is what votes actually read |
| RP-7 | Prompt contract: proposal, own state, `similar()` results, rules, physics summary; only JSON matching Vote | `vote.ts` `buildVotePrompt`, `parseAnswer` | `llm-hostile.test.ts` "not a vote: prose ends safe after exactly one retry" | partial | [fake] JSON-only enforced; no test asserts the prompt holds state, rows, rules and physics |
| RP-8 | `similarCount` equals retrieved events | `vote.ts` `castVote` | `llm-hostile.test.ts` "inflated similarCount is replaced by the retrieved count" | met | [fake] Set in code; counts events after the relevance cut, not raw `similar()` rows |
| RP-9 | A `no` includes a predicted value past `critical − marginPct%` (LV-101: 81) | `vote.ts` `decide`, `noIsSupported` | `vote.real.test.ts` "votes no on 85 with at least 3 evidence ids" | partial | [real model, fake glue] Reaches 81; insufficient-history and safe no carry no such value |

## 9. Rules (CLAUDE.MD)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| RU-1 | Seed first: every module works against `shared/*.json` before live | `Plant.loadSeed`, `glue/seed.ts` | `logic.test.ts` "the fixture yields the P-100 to LV-101 rule from seed history" | partial | [pure] Ran on `plants.json` with stand-in history; `shared/history.json` landed after my suite run |
| RU-2 | `shared/types.ts` frozen | `shared/types.ts` | `actor/tests/contract/types-sync.contract.test.ts` "is byte-for-byte the block frozen in CLAUDE.MD" | met | [pure] Byte match with CLAUDE.MD; drift guard passes |
| RU-3 | Only `Plant.execute` mutates a metric; agents never write state | `Component.setMetric`; `agent/*.ts` | `actor-attacks.test.ts` "a valid token cannot be replayed" | partial | [fake] Forged and replayed tokens refused. Same limit as P-20: `Component.loadSeed` is unguarded |
| RU-4 | Agents never vote without `similar()`; `similarCount: 0` within 15% of critical is automatically `no` | `vote.ts` `castVote`; `enforceVoteSafety` | `logic.test.ts` "similarCount 0 within 15% of critical is automatically no" | met | [pure, fake] Actor forces no; retrieval failure and far events give no in the agent |
| RU-5 | No scope additions: no real PLC, no ML training, ≤ 5 components per plant, no auth, no real data | `shared/plants.json` | `plants.contract.test.ts` "two plants in company order, five components each" | met | [pure] Five per plant; grep finds no PLC, ML training, auth or real data |
| RU-6 | Agent outputs are data: validate every Vote; malformed → discard, re-request once, never guess | `vote.ts` `askModel`, `parseAnswer`; `normalizeVote` | `vote.enforce.test.ts` "bad JSON gets one retry, then a safe no" | met | [fake] Two calls, then a safe no; Plant re-validates and rebuilds the vote |
| RU-7 | HANDOFF.md in each folder: what runs, exact commands, env vars without secrets, what is stubbed | `agent/HANDOFF.md`, `bridge/HANDOFF.md`, `glue/HANDOFF.md` |  | partial | `actor/HANDOFF.md` and `web/HANDOFF.md` missing; `agent/HANDOFF.md` still names the removed adapter |
| RU-8 | Product writing rule followed in docs | Markdown and comments in `actor/`, `agent/`, `docs/person1/` | grep | met | No source-project names found. `bridge/NOTICE.md` is a required credit |
| AG-1 | Agents never call `setMetric` or write to the simulator | `agent/glue.ts` `Glue` | `agent-glue.contract.test.ts` "no agent file writes to the simulator or calls setMetric" | met | [pure] Static scan passes; `Glue` has no metric write |
| AG-2 | Agents never invent evidence ids | `vote.ts` `orderEvidence`; `Plant.vote` | `vote.enforce.test.ts` "similarCount is the retrieved length and evidence ids are only retrieved ones" | met | [fake] Invented ids dropped; Plant refuses unknown ids |

## 10. Never fake (CLAUDE.MD rules)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| NF-1 | Evidence-cited block | `vote.ts` `decide`, `orderEvidence` | `actor/tests/e2e/last-run-terse-runtime.md` rows E2, E2x | partial | Passed both takes on real Terse and real model, fake glue and plant. Report read, not rerun by me |
| NF-2 | Counter-proposal executing | `counter.ts` `buildCounter`, `Plant.execute` | `last-run-terse-runtime.md` rows E3 to E5 | partial | Passed both takes the same way; no real simulator write in that run |
| NF-3 | Second block citing the first run | `vote.ts` `orderEvidence`, `retrieval.ts` `newestExecution` | `last-run-terse-runtime.md` row E8 | partial | **Failing:** took 14 s, then timed out at 25 s; target 5 s. Plant queueing under load |
| NF-4 | Plant-b block citing plant-a's rule | `retrieval.ts` `ruleApplies`, `toCompanyRule` | `last-run-terse-runtime.md` rows E7, E9 | partial | Passed both takes on real Terse and real model, fake glue and plant |

## 11. Acceptance gate (PLAN.MD)
`glue/e2e.ts` is the gate. These rows track the actor and agent share.
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| G-1 | Reset produces all ten component snapshots and clears prior pending work | `Plant.loadSeed`, `glue/app.ts` reset | `actor-attacks.test.ts` "a plant reseed clears pending work" | partial | [fake] Reseed clears proposals; glue seeds Company first. Real `/reset` not seen by me |
| G-2 | Pump 50 → 85 blocked with real evidence, includes the other plant's steam-valve vote | `crossPlantVoters`, `vote.ts` `decide` | `last-run-terse-runtime.md` rows E2, E2x | partial | Passed on real Terse and real model; fake glue and plant |
| G-3 | Safer target ≈ 65 passes, executes after the veto window, observed metrics settle within verified ranges | `Plant.execute`, `glue/dispatch.ts` | `last-run-terse-runtime.md` rows E3 to E5 | partial | Passed with a fake plant, so settled ranges are unproven on the simulator |
| G-4 | Repeated unsafe proposal cites the newest relevant observation, without a safe run alone counting as proof of an unsafe outcome | `vote.ts` `orderEvidence`, `newestNote` | `vote.enforce.test.ts` "a safe run alone never supplies the history a block needs" | partial | [fake] Newest run first, labelled not proof. Real Terse run failed timing, row E8 |
| G-5 | Plant B cites a supported company rule from Plant A, or explicitly reports insufficient history until it exists | `retrieval.ts` `ruleApplies`, `vote.ts` `decide` | `vote.real.test.ts` plant-b cases; `last-run-terse-runtime.md` row E9 | partial | Both branches pass [real model, fake glue]; E9 passed on real Terse. No real glue or simulator |
| G-6a | Invalid votes rejected | `normalizeVote`, `enforceVoteSafety` | `logic.test.ts` "normalizeVote rejects malformed values" | partial | [pure] Wrong agent id rejected on real Terse [live]; a yes predicting a negative position got through at `ca68d98` |
| G-6b | Duplicate votes rejected | `assertVoteAllowed` | `logic.test.ts` "second vote from the same component is rejected" | met | Real Terse returned `duplicate_vote` at 12:51 and 13:08 [live] |
| G-6c | Stale proposals rejected | `assertVoteAllowed`, `isStale`, `claimDispatch` | `logic.test.ts` "stale, non-required and misattributed votes are rejected" | partial | [pure] Real Terse refused a vote on an expired proposal [live]; live-metric-moved attack failed at `ca68d98` |
| G-6d | Unapproved writes rejected | `assertExecutable`, `redeemToken`, `glue/dispatch.ts` | `actor-attacks.test.ts` "a valid token cannot be replayed" | partial | [fake] Token refusals pass; no recorded result against the real simulator write |
| G-6e | Retries do not duplicate a simulation command | `Plant.claimDispatch`, `glue/dispatch.ts` | `actor-runtime.contract.test.ts` "a second claim does not dispatch" | partial | [fake] Single claim wins; real glue retry against the simulator has no result I saw |
| G-7 | Dashboard, actor state, command result and trends agree; recovery is never marked from command acceptance alone | `Execution` state machine, `Plant.recordEvent` | `actor-attacks.test.ts` "recordEvent for a proposal that never executed is refused" | partial | [fake] Dashboard agreement never compared; proposal reads `executed` at acceptance |
| G-8 | No scripted conversation presented as live reasoning; any fallback labelled | `vote.ts` `provenance`, `counter.ts` | `vote.enforce.test.ts` "a fallback reply is visibly labelled" | partial | [fake] Labels are in vote and counter text; dashboard display not seen |
| PS-1 | Plan scope: validate the current proposal and limits immediately before dispatch | `assertExecutable`, `glue/dispatch.ts` preflight | `logic.test.ts` "runs only from a passed veto window" | partial | [pure] Actor stops only at `critical`; glue checks `limit.max`, unproven in a run I saw |
| PS-2 | Plan scope: record acceptance separately from observed results | `Execution` state machine, audit entries | `actor-runtime.contract.test.ts` "recordEvent takes the /observed body" | partial | [fake] States exist; no recorded test separates acceptance from observation |
| PS-3 | Plan interface: actor client, method signatures, Relay participants, agent startup and error semantics documented; no credentials in committed files | `docs/person1/RUNBOOK.md`, `glue/actors.ts`, `agent/spawn.ts` | `secrets.test.ts` ".env is ignored, untracked and was never committed" | partial | [pure] No committed credentials. `actor/HANDOFF.md` with method signatures is missing |

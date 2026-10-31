# Person 1 traceability

Every Person 1 requirement from `TASK1.MD`, the `PLAN.MD` acceptance gate and `CLAUDE.MD`, with the code that implements it and the test that proves it. Refreshed as code lands.

**Status rules.** `met`: I read the code and the test and saw the test pass. `partial`: code exists, but the test is missing, failing, or ran only on a fake where the requirement needs the real thing. `missing`: no code. Evidence is what I read or ran, not what a session reported. Fake-backed runs are labelled `[fake]`, pure-function runs `[pure]`, real Terse or Relay runs `[live]`.

**Last refresh:** 12:31 PT, git `467ad84`. No implementation in `actor/` or `agent/` yet, so every implementation row is `missing`.

| Scoreboard | met | partial | missing |
|---|---|---|---|
| All rows | 3 | 1 | 117 |

## 1. Component actor (TASK1 D1)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| C-1 | Persisted and emittable: all `ComponentState` fields plus `calibration: CalibrationEntry[]` | | | missing | |
| C-2 | `mirror(metrics)` overwrites metrics and sets `lastTick` | | | missing | |
| C-3 | `mirror` recomputes status: `warning` at `max`, `critical` at `critical` | | | missing | |
| C-4 | `setMetric(metric, value, proposalId)` callable only by Plant; throws unless the proposal has passed `veto_window`; Plant passes a one-time token | | | missing | |
| C-5 | `addCalibration(e)` appends and keeps the last 50 | | | missing | |
| C-6 | Mean absError of last 5 > 10% of (max − min) → `marginPct = min(25, marginPct + 5)` | | | missing | |
| C-7 | Mean absError of last 5 < 3% of range → `marginPct = max(5, marginPct − 2)` | | | missing | |
| C-8 | `setMargin(pct)`, `loadSeed(state)` | | | missing | |
| C-9 | Broadcast after every mutation | | | missing | |
| C-10 | Instance id = ComponentId; components and limits per the CLAUDE.MD plant table | `shared/plants.json` (data only) | | missing | Seed data matches the plant table; no actor yet |

## 2. Plant actor (TASK1 D1, CLAUDE.MD actor methods)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| P-1 | Persisted and emittable: `PlantState` | | | missing | |
| P-2 | `loadSeed(plant, history)` | | | missing | |
| P-3 | `propose(p)` assigns id and sets status `voting` | | | missing | |
| P-4 | `requiredVoters` = every other component reachable from the proposer through upstream/downstream links | | | missing | |
| P-5 | Adds `Company.requiredCrossPlantVoters`, sets `crossPlant` | | | missing | |
| P-6 | `vote(v)` rejects duplicates per componentId | | | missing | |
| P-7 | `veto(proposalId, by)` | | | missing | |
| P-8 | `execute(proposalId)` | | | missing | |
| P-9 | `recordEvent(e)` | | | missing | |
| P-10 | `promoteRule(r)` | | | missing | |
| P-11 | `tick()` | | | missing | |
| P-12 | `similar(componentId, metric, to, upstreamSnapshot, k=5)`: filter on componentId and metric; distance `|after − to|/range + 0.5 × mean normalized distance of shared upstreamSnapshot keys`; k nearest | | | missing | |
| P-13 | `similar` is pure over persisted history, no LLM; called with the proposer's componentId and metric | | | missing | |
| P-14 | Alarm every 1 s: `tick()` increments tick and POSTs glue `/tick` | | | missing | |
| P-15 | Alarm every 2 s: all required yes → `veto_window` (deadline now + 10 s); any no → `blocked` | | | missing | |
| P-16 | Veto window passed → `execute` → `Component.setMetric` → bridge writes setpoint | | | missing | |
| P-17 | After 5 ticks `recordEvent` with observed effects → broadcast `executed` | | | missing | |
| P-18 | Votes missing after 30 s → `expired` | | | missing | |
| P-19 | At most one proposal per component in `veto_window`; the second waits in `voting` | | | missing | |
| P-20 | Only `Plant.execute` mutates a metric | | | missing | |
| P-21 | After each `recordEvent`: group history by (componentId, metric, bucketed `after` ≥ threshold); ≥ 3 events sharing an effect that crosses a limit on the same downstream component → create or update a plant-scope `LearnedRule` | | | missing | |
| P-22 | If the component `model` exists in another plant → `Company.promoteRule` with scope company | | | missing | |

## 3. Company actor (TASK1 D1)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| CO-1 | Persisted and emittable: `CompanyState` | | | missing | |
| CO-2 | `loadSeed(c)`, `registerPlant(id)` | | | missing | |
| CO-3 | `requiredCrossPlantVoters(proposal)` → components in other plants sharing a resource with the proposer or any required voter | | | missing | |
| CO-4 | `promoteRule(r)` dedupes by condition + consequence and bumps `timesSeen` | | | missing | |
| CO-5 | `recordAudit(a)` | | | missing | |

## 4. Actor deliverables and tests (TASK1 D2, D3, tests)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| AD-1 | `terse deploy` and `terse actor generate` | | | missing | |
| AD-2 | `actor/HANDOFF.md`: URL, API key instructions without secrets, every method signature, one-time execute token flow, three examples (loadSeed, propose, vote) | | | missing | |
| AD-3 | Actor clients and agent startup instructions supplied to Person 3 | `docs/person1/INTEGRATION.md` | | missing | Not written yet |
| AT-1 | Test: two `vote` calls for one componentId → second rejected | | | missing | |
| AT-2 | Test: two proposals on one component → only one reaches `veto_window` | | | missing | |
| AT-3 | Test: `similar("plant-a/P-100", "speedPct", 85, …)` returns seeded ≥ 80% events with LV-101 positionPct ≥ 85 effects | | | missing | |
| AT-4 | Test: `propose` from plant-a/P-100 → required voters are plant-a TK-101, LV-101, E-101, TV-101 + plant-b/TV-101, `crossPlant: true` | | | missing | |
| AT-5 | Test: `addCalibration` with 5 large errors raises marginPct to 15 | | | missing | |
| AT-6 | Test: rule promotion fires on the third matching event and dedupes on the fourth | | | missing | |

## 5. Agents (TASK1 agent workstream)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| S-1 | `spawn.ts`: one agent per component in both plants (10) with `@agent-relay/sdk`, on `plant-a` or `plant-b`, all joining `company` | | | missing | |
| S-2 | Mechanics (P-100, LV-101) on Codex; TK-101, E-101, TV-101 on Claude; agent id `agent:<ComponentId>` | | | missing | |
| S-3 | `roles/*.md`: four system prompts with role priorities and the hard contract | | | missing | |
| V-1 | Vote step 1: fetch own state from glue `/component/:id` | | | missing | |
| V-2 | Vote step 2: glue `/similar` with the proposer's id and metric, `to`, `upstreamSnapshot`, `k: 5`; read effects rows for this component | | | missing | |
| V-3 | Vote step 3: applicable rules from glue `/rules?componentId=&model=` (plant plus company scope) | | | missing | |
| V-4 | Vote step 4: prompt has proposal, own state and limits, `marginPct`, retrieved events table, rules, physics summary | | | missing | |
| V-5 | Vote step 5: LLM returns only JSON; zod validation against types.ts; re-request once; then `{vote:"no", reason:"malformed prediction"}` | | | missing | |
| V-6 | Vote step 6a: `similarCount` = retrieved length, set in code | | | missing | |
| V-7 | Vote step 6b: `similarCount < 3` and a predicted metric within 15% of critical → forced `no`, reason "insufficient history" | | | missing | |
| V-8 | Vote step 6c: predicted ≥ `critical × (1 − marginPct/100)` → forced `no` | | | missing | |
| V-9 | Vote step 6d: `evidenceEventIds` and `evidenceRuleIds` attached from what was retrieved, never invented | | | missing | |
| V-10 | Vote step 7: post `vote` to the plant channel → glue | | | missing | |
| CP-1 | `counter.ts`: when the proposer's own proposal is `blocked`, read blocking votes, ask LLM for a value between `from` and `to` under every voter's threshold minus margin, post `counter` | | | missing | |
| CP-2 | Max 2 counters per parent | | | missing | |
| LN-1 | `learn.ts`: for every voter compare `vote.predicted[metric]` to observed → `CalibrationEntry` → glue `/calibration` | | | missing | |
| LN-2 | Append the event to the local retrieval cache | | | missing | |
| LN-3 | If the event matches no existing rule, check `similar()` for ≥ 3 events sharing the crossing → propose a `LearnedRule` via glue `/rule` | | | missing | |
| LN-4 | Cache `rule` messages from `company` so plant-b agents cite plant-a rules on the next vote | | | missing | |
| LN-5 | Second identical bad proposal is blocked with the most recent execution as `evidenceEventIds[0]` | | | missing | |
| BT-1 | Test: plant-a LV-101 `no` on P-100 → 85, ≥ 3 evidence ids, predicted positionPct ≥ 81 | | | missing | |
| BT-2 | Test: plant-a LV-101 `yes` on P-100 → 65, predicted positionPct 60–72 | | | missing | |
| BT-3 | Test: plant-b TV-101 votes on plant-a P-100 → 85 on channel `company` with a predicted `headerBarg` drop | | | missing | |
| BT-4 | Test: plant-b LV-101 `no` on 85 citing the company rule once it exists, `no` for "insufficient history" before | | | missing | |
| BT-5 | Test: malformed LLM JSON → one retry → safe `no` | | | missing | |
| BT-6 | Test: calibration after a 1-point error leaves marginPct unchanged; after five 12-point errors marginPct rises | | | missing | |

## 6. Continuous learning (CLAUDE.MD)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| CL-1 | Never answer from priors alone: every vote retrieves the k most similar events and reads effects on its own component | | | missing | See V-2 |
| CL-2 | Predict from those events plus the physics summary | | | missing | See V-4 |
| CL-3 | Fewer than 3 similar events: must say so and vote `no` within 15% of a critical limit | | | missing | See V-7 |
| CL-4 | After execution compute per-metric error and append a `CalibrationEntry` | | | missing | See LN-1 |
| CL-5 | MAE over last 5 > 10% of range → `marginPct` + 5, cap 25, used on the next vote | | | missing | See C-6 |
| CL-6 | Promote a recurring pattern to `LearnedRule` at 3+ sightings; rules are cited like events | | | missing | See P-21, V-9 |
| CL-7 | "It learned": same bad proposal blocked faster, most recent run cited first | | | missing | See LN-5 |

## 7. Multiplayer (CLAUDE.MD)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| MP-1 | `Company` holds plant list, shared-resource graph, cross-plant rule library | `shared/plants.json` (seed only) | | missing | |
| MP-2 | A voter on a shared resource pulls in the components on that resource in the other plant; `crossPlant: true`; those votes travel on `company` | | | missing | |
| MP-3 | Rules promoted to the company library when the same `model` exists in both plants | | | missing | See P-22 |
| MP-4 | Plant-b's LV-101 cites a plant-a incident before plant-b experienced it | | | missing | See NF-4 |

## 8. Relay protocol (CLAUDE.MD)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| RP-1 | Channels `plant-a`, `plant-b`, `company` | | | missing | |
| RP-2 | `proposal {proposal}` handled; each required voter replies within 20 s | | | missing | |
| RP-3 | `vote {vote}` agent → glue → `Plant.vote` | | | missing | |
| RP-4 | `counter {parentProposalId, proposal}` agent → glue → `Plant.propose` | | | missing | |
| RP-5 | `executed {proposalId, event}` reaches all plant agents and `company` when cross-plant or model shared | | | missing | |
| RP-6 | `rule {rule}` on `company` when scope is company | | | missing | |
| RP-7 | Prompt contract: proposal, own state, `similar()` results, rules, physics summary; only JSON matching Vote | | | missing | See V-4, V-5 |
| RP-8 | `similarCount` equals retrieved events | | | missing | See V-6 |
| RP-9 | A `no` includes a predicted value past `critical − marginPct%` (LV-101: 81) | | | missing | See V-8 |

## 9. Rules (CLAUDE.MD)
| ID | Requirement | Code | Test | Status | Evidence / gap |
|---|---|---|---|---|---|
| RU-1 | Seed first: every module works against `shared/*.json` before live | `shared/plants.json` | | partial | `plants.json` exists; `shared/history.json` not delivered yet |
| RU-2 | `shared/types.ts` frozen | `shared/types.ts` | `git log -- shared/types.ts` | met | Matches the CLAUDE.MD contract text; one commit, `f8b023b` |
| RU-3 | Only `Plant.execute` mutates a metric; agents never write state | | | missing | See P-20, AG-1 |
| RU-4 | Agents never vote without `similar()`; `similarCount: 0` within 15% of critical is automatically `no` | | | missing | See V-7 |
| RU-5 | No scope additions: no real PLC, no ML training, ≤ 5 components per plant, no auth, no real data | `shared/plants.json` | | met | 5 components per plant in seed; re-check as code lands |
| RU-6 | Agent outputs are data: validate every Vote; malformed → discard, re-request once, never guess | | | missing | See V-5 |
| RU-7 | HANDOFF.md in each folder: what runs, exact commands, env vars without secrets, what is stubbed | | | missing | `actor/HANDOFF.md`, `agent/HANDOFF.md` |
| RU-8 | Product writing rule followed in docs | `docs/person1/` | | met | This doc names only ActorRelay modules and the sponsor stack |
| AG-1 | Agents never call `setMetric` or write to the simulator | | | missing | |
| AG-2 | Agents never invent evidence ids | | | missing | See V-9 |

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
| G-1 | Reset produces all ten component snapshots and clears prior pending work | | | missing | Actor side: `loadSeed` clears proposals |
| G-2 | Pump 50 → 85 blocked with real evidence, includes the other plant's steam-valve vote | | | missing | |
| G-3 | Safer target ≈ 65 passes, executes after the veto window, observed metrics settle within verified ranges | | | missing | |
| G-4 | Repeated unsafe proposal cites the newest relevant observation, without a safe run alone counting as proof of an unsafe outcome | | | missing | |
| G-5 | Plant B cites a supported company rule from Plant A, or explicitly reports insufficient history until it exists | | | missing | |
| G-6a | Invalid votes rejected | | | missing | |
| G-6b | Duplicate votes rejected | | | missing | |
| G-6c | Stale proposals rejected | | | missing | |
| G-6d | Unapproved writes rejected | | | missing | |
| G-6e | Retries do not duplicate a simulation command | | | missing | |
| G-7 | Dashboard, actor state, command result and trends agree; recovery is never marked from command acceptance alone | | | missing | Actor side: acceptance recorded separately from observed results |
| G-8 | No scripted conversation presented as live reasoning; any fallback labelled | | | missing | |
| PS-1 | Plan scope: validate the current proposal and limits immediately before dispatch | | | missing | |
| PS-2 | Plan scope: record acceptance separately from observed results | | | missing | |
| PS-3 | Plan interface: Person 1 gives Person 3 actor client, method signatures, Relay participants, agent startup, error semantics; no credentials in committed files | `docs/person1/INTEGRATION.md` | | missing | Not written yet |

# What is real and what is a stand-in

As of 15:49 PT, 2026-10-31, commit `22cf13f`. This file reports what was observed and saved. Evidence paths are given so each line can be checked.

**Bottom line: all four never-fake moments passed in three recorded full-stack runs, at 13:42, 14:09 and 15:41, all 26 of 26. The 14:09 and 15:41 runs were on the final backend code, and the dashboard was seen showing the 15:41 run live.** Nothing has been submitted. These runs were driven by a test script. A person driving the dashboard, and the Plant B caption on screen, have not been seen.

## Full-stack runs
Real Terse, real glue, real Relay, the running simulator, ten real agents, real OpenAI calls and `shared/history.json`.

| Run | Result | Click to blocked | Repeat blocked | Failed rows | Table |
|---|---|---|---|---|---|
| 13:26 | 24 of 26 | 12.5 s | 13.2 s | Repeat within 10 s and under 5 s | [e2e-run-132353.md](evidence/e2e-run-132353.md) |
| 13:28 | 25 of 26 | 16.5 s | 6.8 s | Repeat under 5 s | [e2e-run-132753.md](evidence/e2e-run-132753.md) |
| 13:41 | 25 of 26 | 5.9 s | 4.1 s | `executed` published, reported as a check mismatch (board 13:45) | [e2e-run-134054.md](evidence/e2e-run-134054.md) |
| **13:42** | **26 of 26** | 6.4 s | 2.2 s | None | [e2e-run-134157.md](evidence/e2e-run-134157.md) |
| **14:09** | **26 of 26** | 3.9 s | 0.34 s | None | [e2e-run-140851.md](evidence/e2e-run-140851.md) |
| **15:41** | **26 of 26** | 0.4 s | 0.3 s | None | [e2e-run-154135.md](evidence/e2e-run-154135.md) |

The 13:42 run's logs confirm the stack: Terse ready on 7190, simulator on 7300, `relay: connected as actorrelay-system`, `ready: 10 agents`, 25 votes logged, 0 failed Relay posts. Votes, reasons and calibration from that run are saved in [live-state-plant-a.json](evidence/live-state-plant-a.json) and [live-state-plant-b.json](evidence/live-state-plant-b.json). An earlier read of the 13:28 run is in [133634-live-stack-readout.md](evidence/133634-live-stack-readout.md).

A separate full-stack measurement on actors at `d4d976b`, with Terse data on a RAM disk, blocked the repeat 8 of 8 times with the newest run first. 4 of 8 were under 5 s, p50 3.8 s, worst 12.8 s, at load 33 to 56 on 16 CPUs (`agent/spikes/vendors/REPORT-roundtrip.md`). A quiet machine has not been measured.

**Limits of this result:**
- I read the 13:42 run's logs and glue's `/state` during the 15:41 run myself. The 14:09 and 15:41 results match their originals in `/dev/shm/ar-demo`, which a WSL shutdown would erase.
- The recorded runs drive the routes directly, with no person.
- A veto click passed on the full stack at 15:44:58, per main: proposal `plant-a-p00002-6b214f6b` went to vetoed, the audit shows the veto, P-100 stayed at 50, and nothing executed. It was a scripted click in a test browser, not a person. The stack had been reset by the time I looked, so I did not see this myself.
- `git diff 0368d0a HEAD` is empty for `actor/src`, `agent`, `glue`, `bridge` and `shared`, so the 14:09 and 15:41 runs used the final backend code. `web/` changed after both.
- At 13:36 and 13:52, `/state` returned 503 because actors did not answer in time, under heavy load. It did not recur in the 15:41 to 15:43 reads.

### The 15:41 run, seen on the dashboard
While that test run was going, I opened the dashboard, read-only: [screenshot](evidence/dashboard-live-154228.jpg), [Plant A state](evidence/live-state-plant-a-1543.json). The 3D view showed live values, and the proposals went 50 to 85 blocked, 65 executed, then 85 blocked again. The "It learned." card rendered, reading "LV-101 cited the run from 3 s ago as evidence 1, its latest observation, not proof."

## By layer
| Layer | State | Evidence | Stand-ins used elsewhere |
|---|---|---|---|
| Durable actors | **Real, in both clean runs.** Local Terse dev server in WSL, SDK 0.14.9. Not deployed | Tables above, `actor/HANDOFF.md` | In-process stand-in in many test suites, each labelled |
| Agents | **Real, in the recorded runs.** Ten Relay identities, real model calls | 13:42 run logs | Scripted model under `agent/tests/` only |
| Models | **OpenAI only.** Default `gpt-6.1-terra` low, `gpt-6-luna` backup on a 429 | `agent/llm.ts:22`, board 13:17 | Claude roles vote through a labelled GPT fallback |
| Relay | **Real local server, in the recorded runs.** SDK 15.0.1 | 13:42 run logs, `agent/spikes/relay/` | In-process delivery in `actor/tests/e2e/` |
| Glue | **Real, in both clean runs** | Tables above, `glue/HANDOFF.md` | `actor/tests/e2e/fake-glue.ts` |
| Simulator | **Real, in both clean runs.** A new TypeScript model | Tables above, `bridge/HANDOFF.md` | `actor/tests/e2e/fake-plant.ts`, a linear fit |
| Dashboard | **Seen showing a live run at 15:42:** 3D view, live values, the refusal line and the "It learned." card. The Plant B caption has not been seen. The console shows a `NaN` height error. A red "1 Issue" development badge covered the story bar then. `devIndicators: false` has since been set, not rechecked on screen | [screenshot](evidence/dashboard-live-154228.jpg) | None |
| P&ID drawing | Exists. The dashboard has a "Process diagram" tab, which I did not open | `web/public/pid-tk-101.svg` | None |
| Seed history | **Generated by stepping `bridge/tank_model.ts`.** 300 events, all TASK2 hard requirements pass | `shared/history.json`, `node .coord/sync/check-history.mjs shared/history.json`, `bridge/HANDOFF.md` | None |

### About the simulator
- It is not an existing plant model. It is new code written from the notes in `CLAUDE.MD`, with vessel constants fitted to those numbers (`bridge/HANDOFF.md`, "Model constants").
- Two things in it are ours and not in the spec: a steam valve pressure term, and 20 s of damping on what FIC-201 reads, added to stop an instability at a 10 s scan.
- Measured against `CLAUDE.MD`: most values match. Overshoot is +1.6 at 65 and +3.2 at 85, not the +3 to +5 in the physics summary.
- Two TASK2 lines do not hold: after a step to 65, temperature is back within 1 °C at tick 8, not tick 5, and at 100 the valve and rising level never happen together.

### About the seed history
- Every number comes from a model run. Operators, approvers, dates and incident text are invented.
- **Runs were placed to get the demo's retrieval.** The rule "P-100 ≥ 80 → LV-101 ≥ 85" holds in this history, but not in the model at large: a small step from 78 to 82 peaks under 85. Two runs are included because they keep the counter on 65. Plant B stops at 74 so insufficient history can fire at 85 (`bridge/HANDOFF.md`, "History").
- The incident text "saturated at 100%, high-level alarm" is on 18 events, and only 4 show LV-101 at 100. The other 14 show 90.5 to 99.7. No alarm is modelled, and the highest level in those rows is 52.9%, under the 70% limit.
- The model has no noise, so repeated inputs give identical rows. Several of the top five events at 85 can be the same numbers.

## The four moments that must never be faked
From the 14:09 full-stack run, 26 of 26. The 13:42 and 15:41 runs passed the same rows.

| Moment | Result | Detail |
|---|---|---|
| Block with cited evidence | Passed | LV-101 no at 89.17 against 81, 5 seeded events and a rule cited, Plant B's TV-101 voted, 3.9 s |
| Counter executes | Passed | 50 to 65, 5 of 5 yes, veto window seen, exactly one simulator write, LV-101 peaked at 66.53, calibration for 5 voters |
| Second block cites the first run | Passed | 342 ms, and the first evidence id is the 65 run. No model was called: once a live run exists, a no that evidence already proves skips the model (`agent/vote.ts`) |
| Plant B cites Plant A's rule | Passed | LV-101 no on the company rule, seen 22 times, no Plant B run at or above 80 |

## Other results, and what they rest on
| Result | Rests on |
|---|---|
| Two-take walk: every never-fake row passed twice | In-process actors, fake glue and plant, stand-in history, real models (`actor/tests/e2e/last-run-shim-runtime.md`, 13:10). One row failed on counting across takes |
| Demo replay: all 555 runs passed, and 5/5 on each step at `69dfe6b` | Real models and ranking code, no real actors or Relay (`agent/evals/vote/REPORT.md`) |
| `gpt-6.1-terra` at `69dfe6b` on `shared/history.json`: 0 of 30 unsafe proposals reached unanimous yes, and 8 of 74 safe proposals were blocked, 5 of which a perfect model would block too | 520 real votes, same layers. A small sample. An older result of 0 of 159 used an oracle since corrected, and on the corrected oracle 15 of 186 passed, all feed reductions, in runs that never saw the temperature rise |
| No acknowledged write lost, at most one simulation command, across crash runs | Real Terse and `kill -9`, real actors at `3746bdd`, fake glue and simulator (`actor/tests/chaos/REPORT.md`). Not rerun on current code |
| Crash matrix: 32 of 33 scenarios across 37 `kill -9`. No acknowledged write lost, never a second simulation command | Real Terse and real actors at `9b943c3`. Glue, simulator and executor were fake, and Relay and agents were not involved (`actor/tests/chaos/REPORT.md`) |
| Contract tests: 484 passing, 0 failing, 33 skipped | Real agents, glue routes and actor classes in one process, on a fake Terse base, a simulator stub and a scripted model. Proves shapes and wiring, not timing (board 13:56) |

## Known problems that could show on stage
- **Timing and load:** block and repeat times swung widely across the runs, from 16.5 s down to 3.0 s and from 13.2 s down to 0.2 s, as load fell and fixes landed. Keep the machine quiet while recording.
- **Actor stalls under load:** at load 33 to 56, ar-vendors saw all mirror calls time out together every 56 to 58 s, cause not proven (board 13:53). Not seen in the 15:41 to 15:43 reads.
- **Lost acknowledgement:** one lost setpoint acknowledgement blocks every later change to that metric until reset. Seen with real actor classes on a fake runtime (board 13:30).
- **Tick rate:** about 1.9 per Plant per second, not 1. The one failed crash scenario, `c0`, fails on this alone. Low severity, because timeouts use wall clock.
- **Crash recovery:** the actors now recover in the crash matrix: a lapsed veto window reopens, and a kill between claim and setpoint settles. One tick pause after a host kill stays unexplained. After a server restart nothing ticks until something reads each Plant, and glue's wake loop for that was not crash tested. Real glue, bridge, Relay and agents have not been crash tested.
- **Stack stops ticking after the machine pauses:** at 15:40 a live stack had stopped after an apparent 25-minute pause of the machine: tick 0, a proposal stuck in voting with 5 of 5 yes, and no veto window. Reset did not cure it, and a full restart did (reported by main). Likely cause, not proven: `armAlarm` in `actor/src/actor.ts` sets an alarm only when `alarm.get()` is null, so a stale pending alarm is not replaced. Recovery is `scripts/demo-restart.sh` inside WSL, about 50 s.
- **Restart time:** on a loaded machine, 25 to 72 s from kill to `/healthz`, median 55 s, and 35 to 81 s to the first Plant read (`actor/tests/chaos/REPORT.md`).
- **Rate limits:** a 429 can turn a vote into a safe no. Stop every eval and sweep before recording.
- **Compromised model:** a model that lies to every voter still reached unanimous yes up to 76 on both plants. The first unsafe run in the history is at 79, and the targets tested at 79, 80, 82, 85 and 89 wrote nothing (`agent/tests/adversarial/REPORT.md`, fake simulator, 13:56).
- **Simulator port:** `POST /setpoint` on 7300 has no token. The one-time token gates the actors, not the simulator, and a local process moved the real simulator to 100 in a red-team test. By default it binds to 127.0.0.1.

## Claims we must not make
| Claim | Why not |
|---|---|
| Runs reliably end to end | Three clean recorded runs out of six. The last three in a row were not measured as a series |
| Two model vendors, or Claude reasoning | No Claude-role vote has ever run on Claude |
| Deployed or hosted | Local dev server only |
| Survives any crash | The actors' stored data held across 37 kills, which can be said. Glue, simulator, Relay and agents were not crash tested |
| No unsafe change can get through | The gate covers the actor path only, the simulator port has no token, and only a small sample of real votes was measured |
| Reliably blocks much faster after learning | 342 ms against 3.9 s at 14:09, but the card on screen at 15:42 read 0.2 s against 0.3 s. It is faster when the first block waits on the model |
| Runs an existing or validated plant model | It is a new model fitted to the numbers in `CLAUDE.MD` |
| LV-101 hit 100% near 85, or a high-level alarm tripped | The rows show 87 to 91, no alarm is modelled, and the incident text is invented |
| The learned rule is how the plant behaves | It holds in the chosen history, not in the model at large |
| The history is real plant data | It is generated, and the runs were placed to suit the demo |
| Plant B learned it just now | The rule comes from seeded history at reset |
| The model picked the safe target | Code fixes it |
| The model chose what to cite | Code attaches every retrieved run to the vote. The model's citations only change the order (`agent/vote.ts`, `orderEvidence`) |

## Who did what
This matters for a solo entry. Nothing here should be presented as solo work if it was not.

- `CLAUDE.MD`, `PLAN.MD` and `TASK1.MD` to `TASK3.MD`: git lists only Kanishk and ali-amjad52114 as authors. The product design, plant definition and demo plan in them are not solely Zubair's.
- `zubair` branch history includes commits by ali-amjad52114 and Kanishk.
- Teammates' `glue/`, `web/` and `demo/` were merged at `dc9c562` and removed at `ca68d98`. The code is still in git history.
- Main's 12:58 decision allows teammates' code as a reference only. If `bridge/`, `glue/` or `web/` drew on it, the entry should say so.
- Person 2's `history.json` from `origin/person2-simulation` was run through `agent/`. It exposed three faults, which were fixed (board 13:04), and the last Relay proof ran on it (`agent/HANDOFF.md`). Person 3's `relay.ts` was used in that proof too. The entry should say so.
- The tank model design is credited to an outside MIT-licensed project in `bridge/NOTICE.md`. Keep that file in the repo. It states that no source from that project was read or included, which I have not verified.
- The code and reports here came from AI coding sessions working for Zubair.

## Update log
- 15:50: main's README and tour fixes committed, so their rows are gone. Tables checked against their originals.
- 15:49: main's final facts: veto click, stale alarm, final backend. Crash figures stay at the report's 32 of 33 and 37 kills. Main's message quoted the earlier 31 and 36.
- 15:47: corrected. The take I watched at 15:42 was the 15:41 test run, not a person. Third clean run added.
- 15:45: second clean run, final crash matrix, new agent fast path, and the dashboard seen live. The pack was stale from 14:00 to 15:40 because this session was down.
- 13:56: 26 of 26 full-stack run added, with three earlier runs, logs and live state. Dashboard opened once: not seen working.
- 13:42: demo script rewritten after an independent trace through the code. Twelve problems fixed.
- 13:37: first real-stack pass added, read from the running services.
- 13:36: independent audit applied, 15 defects checked at source and fixed. Worst was the public fallback paragraph, which hid that Relay and glue were not in the run.
- 13:32: 13:29 two-take run. Repeat block failing on real Terse is now the headline gap.
- 13:29: bridge and glue handoffs read. Simulator, history and credit sections rewritten from them.
- 13:25: 13:23 regression added. Run tables are now saved to evidence/, because each run overwrites them.
- 13:21: 13:18 real-Terse run, our seed history, chaos results, new default model. Glue, bridge and web on disk but not yet seen in a run.
- 13:06: first version.

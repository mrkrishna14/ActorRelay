# ActorRelay end-to-end proof and red team

Owner: ar-verify. Generated tables sit beside this file as `last-run-<actors>-<agents>.md`.

## Where it stands
Latest complete real run, 13:29, actor commit 6447368, before d4d976b landed: **20 of 24 rows pass over two takes on real Terse**, with real agents and real OpenAI, on fake glue and fake plant, with Relay replaced by a direct call. No row is a plain PASS, because glue and plant are fakes in every one. The table is `last-run-terse-runtime.md`.

| ★ Never-fake step | On real Terse, two takes |
|---|---|
| Evidence-cited block | Passes both takes: LV-101 no at 89.17 against threshold 81, 5 real evidence ids, 5 of them unsafe |
| Counter-proposal executing | Passes both takes: 65, 5 of 5 yes, 10000 ms veto window, exactly one write, calibration for all 5 voters |
| Second block citing the first run | **Fails on time.** Take 1 blocked in 14.2 s with evidence[0] the newest run. Take 2 did not block within 25 s. Target is under 5 s |
| Plant B citing plant-a's rule | Passes both takes: company rule with 22 real plant-a support ids, 0 plant-b runs at or above 80 |

The other failures are reset timing against the 3 s target: 17.4 s on cold actors and 3.15 s warm. That run was at load average 38 with 4 Terse runtimes alive, so the timing rows say little about a quiet demo machine. On the in-process shim the same walk passed 23 of 24 rows, with the repeat block at 3.1 and 3.6 s. The one miss was my own write count carrying over between takes, since fixed and not yet rerun. On both shim takes the repeat block's LV-101 vote read `decided by code, from evidence, model too slow`, so that vote was labelled code, not model reasoning.

## How to read a verdict
- `PASS` means every layer the step touched really ran.
- `PASS on actors=in-process-shim, glue=FAKE, plant=FAKE` means the assertions held, and names each stand-in.
- `FAIL` is a failed assertion. `GAP` means the step did not run, and the detail says why.
- ★ marks the four things CLAUDE.MD says must never be faked. Their ids must resolve in actor state, and no assertion matches a literal id or canned text.

## What is real in the current runs
| Layer | Used | Note |
|---|---|---|
| Actors | Real Terse 0.14.6 runtime, private server per run | `terse-shim.ts` is the fallback; its rows say `actors=in-process-shim`. |
| Agents | Real `AgentRuntime`, `castVote`, `buildCounter`, `learn` | |
| LLM | Real OpenAI `gpt-6.1-terra` | Claude roles use the labelled GPT fallback, per main's 12:35 decision. |
| Relay | Replaced by a direct call | Real Relay was not on this path. See the gaps below. |
| Glue | FAKE, `fake-glue.ts` | Follows TASK3.MD and the executor steps on the board. |
| Plant | FAKE, `fake-plant.ts` | TASK2.MD linear coefficients, not the tank model. |

## Run it
```bash
wsl.exe -d Ubuntu --cd /tmp -- env E2E_AGENTS=none bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/actor/tests/e2e/run-wsl.sh" --phase=attacks
```
```bash
wsl.exe -d Ubuntu --cd /tmp -- env E2E_AGENTS=runtime E2E_TAKES=2 bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/actor/tests/e2e/run-terse.sh" demo
```
`run-terse.sh` freezes `actor/` onto the Linux filesystem and starts a private `terse actor dev` on 7110. Set `E2E_ACTORS=shim` to skip Terse. Do not run either while main's WSL freeze holds.

## Gaps and what closes each one
| Gap | What closes it |
|---|---|
| Real glue never ran under this suite. ar-glue finished `glue/` at 13:24. | Run `glue/e2e.ts --live` against real actors. |
| Real Relay never ran under this suite. My only attempts died at agent startup, and after the agents moved to glue's Relay participant the fake glue cannot publish to them. ar-agents has its own proof, `agent/tests/live-relay-proof.ts`. | Real glue plus `agent/spawn.ts`, the same run as above. |
| The attack suite did not finish on real Terse. I stopped it at 13:37 under main's WSL freeze. A3 and A4 had passed. A5 failed because forged votes took over 30 s at load 48, so the proposal expired first; that is harness timing, not a defect. A1, A2 and everything after A5 have no real-Terse result. | When main lifts the freeze: `E2E_AGENTS=none` through `run-terse.sh attacks`. |
| Actor commit d4d976b (forged input and lost dispatches) has not been run by this suite. It landed at 13:36, after the last walk, and A18 to A21 still show results from before it. | The same rerun, plus the walk, once the freeze lifts. |
| Real plant never ran. Nothing here touched `bridge/live_sim.py`, so settle values come from the linear fit. | Person 2's simulator on 7300, then rerun with real glue. The bridge must also report plant-b/TV-101 `headerBarg` in `/observed` or the cross-plant voter cannot calibrate from a measured row. |
| History is the stand-in `actor/tests/fixtures-gen/history.json`, not Person 2's `shared/history.json`. | Person 2's file; `loadHistory` prefers it automatically. |
| Claude roles voted on the labelled GPT fallback. | Claude CLI login, dropped by main at 12:35. |
| Rate limit: a 429 turns a vote into a safe no with empty evidence. | Nothing else on the org key during the demo. Evals capped at 12:46. |

## Red team
Round 1 ran the five reviews in the brief: correctness, concurrency and deadlocks, safety bypass, contract drift, and TASK1.MD mismatch. Reviewers raised 26 findings and separate verifiers traced each one: 18 confirmed, 8 refuted. Several were duplicates of the same defect, so that is 15 distinct defects. Full scenarios and fixes are in `ar-verify-redteam-round1.md` in the shared notes folder. Rows A18 to A21 turn the top ones into repeatable checks.

Round 2, at 13:43, re-read all 15 against the current tree: 7 fixed, 7 partly fixed, 1 open. This came from reading code, not from a run, because of the WSL freeze.

| Still open | Where | What remains |
|---|---|---|
| Invented rule | `actor/src/actor.ts:629` | A rule with null component ids and condition >= 20, citing 3 real crossing events, moved the company condition from 80 to 20 on seed data. That would bind against the safe 65 counter. Reachable through `POST /rule`. |
| Forged low prediction | `actor/src/actor.ts:461` | A forged LV-101 yes predicting 60 stayed yes at 78 on plant-a and 80 on plant-b. Forged yes at 85 is now refused. |
| Invented effects | `actor/src/actor.ts:819` | The first `/observed` for a real run can supply invented effects or unknown components. |
| Unknown dispatch | `actor/src/actor.ts:857` | Rollback is gone, but nothing settles an unknown execution except the next accepted dispatch, and new proposals on that metric are not refused meanwhile. |
| `setMargin` | `actor/src/actor.ts:266` | Reaches margin 5 in one call. Glue has no route to it, but it is a remotely invokable actor method with no check. |
| Company rule merge | `actor/src/logic/rules.ts:25` | Key ignores values, so a merge can produce a pair no single rule stated. |
| Counter settle | `agent/runtime.ts:115` | Waits 6 s for votes, so a slower no can arrive after the counter is built. |
| Vote replaced in the veto window | `actor/src/logic/proposals.ts:147` | Yes to no replaces the original vote, leaving it only in the audit log. Deliberate and tested. |

## Findings log
| When | Owner | Finding | State |
|---|---|---|---|
| 12:35 | ar-actors | `Plant.vote` called undefined `vote_component`, so every vote threw | Fixed |
| 12:40 | ar-actors | A `no` blocked the proposal before slower voters landed, losing the cross-plant vote and plant-b's rule citation | Fixed, re-verified on the shim |
| 12:40 | ar-actors | A yes with `predicted: {}` was accepted | Fixed, A3 passes |
| 12:42 | ar-actors | `promoteRule` accepts support events that do not show the claim | Fixed in 3746bdd, A13 passes |
| 12:42 | ar-actors, main | Stale check ignores the measured value, so an out-of-band move still dispatches | Open, A12 |
| 12:45 | main | Evals hit the org's 2M TPM cap, so live agents got 429s and voted safe no | Asked to pause evals during proof runs |
| 12:47 | ar-actors | `terse actor dev` failed to build `actor/src` | Fixed in 3746bdd |
| 12:50 | ar-agents | `spawn.ts` exited on a transient Relay reset during channel join | Retry added; a retried `register` can now hit `name_conflict` |
| 13:01 | ar-agents | Under load, Component calls took 4-5 s, so the 5 s glue timeout turned votes into safe nos with no evidence | Timeout raised to 8 s; it still trips during the Plant queue bursts |
| 13:06 | ar-actors, ar-agents | 15 distinct defects from red team round 1 | Sent to owners |
| 13:07 | ar-actors | Plant's sweep awaited Company inside the alarm and starved the mailbox, so execute stalled on real Terse | Fixed in 69ebb4a, E4 passes on real Terse |
| 13:24 | ar-actors | Under load, alarm deliveries multiplied and actor hosts self-fenced | Fixed in 6447368, no fencing in the 13:29 run |
| 13:30 | ar-actors | Plant calls queue for 17-18 s right after calibration, which is when the repeat proposal lands | Open, E8 |
| 13:11 | ar-actors | Forged calibration walks margin 10 to 8 (A18), fabricated run enters history (A19), yes at 84 passes by claiming margin 5 (A20), both plants hold veto windows at once (A21) | Reproduced by running on the shim at 13:11. d4d976b addresses all four, read as fixed or partly fixed in round 2, not yet rerun |

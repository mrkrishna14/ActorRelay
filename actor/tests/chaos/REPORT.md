# Crash test report

Final matrix, 15:35 Pacific, on real Terse 0.14.9 with real `kill -9`, against the real actors at commit 9b943c3. `actor/src` is unchanged at the later HEAD 5db59a2.

## Verdict

Durable memory held. Across 36 server kills, no acknowledged write was lost and no proposal ever sent a second simulation command.

All four failures found in the first pass are fixed or reduced, and the fixes are proven on the real runtime. 31 of 33 scenarios pass. The two that do not:

- `c0`: every recovery check passes. The tick runs about 1.9 times a second, not once. Low severity, because timeouts use wall clock.
- `c0c`: after killing one host, ticks from both Plants paused once. See Open items.

| Claim tested | Result on the real runtime |
|---|---|
| Acknowledged votes, history, calibration, rules and audit survive `kill -9` | Held. 476 acknowledged writes and 108 audit entries in the stream, plus a real calibration entry |
| No duplicate execution | Held: at most one simulation command in every run, including 4 random kills around the deadline |
| No duplicate rule | Held. A replay no longer moves `timesSeen` |
| No proposal stuck forever | Held. Votes expire, lost dispatches are marked `unknown`, and later proposals recover |
| Alarms re-armed, tick resumes | Not on its own after a server restart. One read restarts it, on both Plants. Glue's wake loop does that read but was not crash tested |
| Human veto survives a crash | Held. A lapsed window reopens, and an operator vetoed in it |
| Actors match the simulator after a crash | Held. A late acknowledgement or observation settles it |
| Glue slow, down or calling back does not wedge the Plant | Held. Mailbox reads stayed under 110ms in every glue fault |

## What ran where

Real: Terse dev server, `kill -9`, Component, Plant and Company actors, compiler and persistence.

Fake: glue, the executor and the simulator, which follow the published execute flow. Real glue, the real bridge, Relay and agents have not been crash tested, and no OpenAI calls were made.

Runs used two servers at a time, on ports 7140-7141 with their own data dirs. The demo stack was not touched. Load stayed well under 16, and the guard never fired.

Stretched scenarios use a copy of the same commit with only the timeout constants raised, so a rebuild fits inside the windows. Without that, the survive-inside-the-window path cannot be reached by a server kill.

## Results

| Scenario | Result | Checks | What it shows |
|---|---|---|---|
| h1 kill one Plant host | PASS | 18/18 | State intact, one read restarts it, one simulation command |
| c0 alarm re-arm | FAIL, tick rate only | 28/29 | No tick in 5s of silence, then one read restarts both Plants. Mailbox 92ms |
| c0b silence, no crash | PASS | 1/1 | Ticks never stop in 80s with no callers, twice |
| c0c silence after a host kill | FAIL once, PASS once | see below | Both Plants' ticks paused at about 60s |
| c1 voting | PASS | 19/19 | Votes intact, replay refused, voting finishes, one command. Also passes stretched |
| c1b down past vote expiry | PASS | 3/3 | Expires 0.7s after restart, late vote refused |
| c2a restart inside the window | PASS, stretched | 18/18 | Deadline unchanged, fires once, not early |
| c2b down past the deadline | PASS | 3/3 | Window reopens, command 11s after restart, was 2.6s |
| c2c veto then kill | PASS | 4/4 | Veto holds through the deadline |
| c2d veto in a reopened window | PASS | 5/5 | Operator vetoes after the outage, nothing is sent |
| c3a kill before claim | PASS | 5/5 | A re-sent callback completes it, one command |
| c3b kill after claim | PASS | 6/6 | Simulator and actors agree, one command |
| c3c same, whole group killed | PASS | 6/6 | Same |
| c3d executor dies after claim | PASS | 6/6 | Marked `unknown`, no retry, next proposals `[false,true]` |
| c3e lost ack, prompt observation | PASS, stretched | 6/6 | Observation settles it |
| c3f lost ack, late observation | PASS | 6/6 | Observation recorded, next proposal starts from 65 |
| c3g simulator refuses | PASS | 3/3 | Ends failed and expired, no retry |
| c3r 4 random kills around the deadline | PASS | 8/8 | One command every time |
| c4a acknowledged event, kill, replay | PASS | 36/36 | Rule, event and calibration survive. Replay adds nothing, `timesSeen` stays 3 |
| c4b kill with Company frozen | PASS | 9/9 | One event, one plant rule, one company rule |
| c4c 4 random kills in `recordEvent` | PASS | 17/17 | Retry gives exactly one event, no duplicate rule |
| c5 ack stream | PASS | 6/6 | 476 mirrors and 108 audit entries acknowledged, none lost |
| c6 five kills across one proposal | PASS, stretched | 4/4 | One execution |
| d1 tick hang | PASS | 8/8 | Mailbox 69ms maximum |
| d2 tick slow | PASS | 8/8 | Mailbox 50ms maximum |
| d3 tick 500 | PASS | 8/8 | Mailbox 23ms maximum |
| d4 glue down | PASS | 5/5 | Mailbox 61ms maximum |
| d5 execute hang | PASS | 7/7 | 3 attempts, ends expired, new proposal opens. Mailbox 103ms |
| d6 glue back before retries end | PASS | 4/4 | One command |
| d7 glue down past every retry | PASS | 4/4 | Reported as undelivered |
| d8 glue calls back during `/tick` | PASS | 5/5 | No deadlock, callback 70ms |
| d9 kill with glue hung | PASS | 5/5 | Nothing wedged after restart |
| d10 Company frozen | PASS | 5/5 | Propose fails closed in 8.0s, mailbox held 7.5s, 24ms once thawed |

Evidence is in `results/`. `head-a` to `head-e` are real timeouts, and `stretched-1` and `stretched-2` are stretched. `real-3` and `real-4` are the first pass at 3746bdd.

A first stretched run failed `c2a` and `c6`. Both were my test setup: `c2a` counted audit lines the actors now write twice by design, and my stretch missed the 60s waiting timeout. Both pass with those corrected.

## First-pass failures

| Failure at 3746bdd | Now |
|---|---|
| Actors at 50 while the simulator was at 65 after a crash in dispatch | Fixed, `c3b` `c3c` `c3e` `c3f` |
| One lost ack blocked that metric until a reset (fake runtime) | Fixed, later proposals dispatch in `c3d` |
| Lapsed veto window executed 2.6s after restart | Fixed, `c2b` `c2d` |
| Replay moved Company `timesSeen` from 3 to 4 | Fixed, `c4a` |
| Plant ticked 5.4 times a second | Reduced to about 1.9, still open |

## Open items

1. **Tick rate, low.** About 1.8 to 1.9 per plant per second, measured three times. Terse alarms can fire early, and the Plant only ignores ticks closer than 500ms. Decisions use wall clock, so nothing here depends on it. Raising the guard in `onAlarm` to about 900ms should give 1 per second.
2. **Tick pause after a host kill, unexplained.** Ticks from both Plants stopped for at least 5s at about 40-60s after a host kill, in 2 of 5 runs. It never happened in the 2 no-kill silence runs. In `h1` they were back within 5s of the next read. It needs a killed actor host, not a server kill. Length is being measured.
3. **Retry windows, low.** `glue/dispatch.ts` gives up on `setMetric` after about 1s, and `bridge/live_sim.ts` stops retrying `/observed` after about 19s. State stays correct, because the setpoint is kept and the mirror corrects the Component. An observation due during a restart can be lost, so that run would not teach anything. Read from the code, not run.
4. **Not crash tested:** real glue, including its wake loop, the real bridge, Relay and agents.

## Runtime facts, measured

- A server kill loses every alarm, and nothing ticks until a method is called on each Plant.
- After a whole-group kill, an actor answers 503 until its old lease drains. That is why the first Plant read takes about 30s, 10s or more after the server is healthy.
- After killing one Plant host, the first successful read took 0.3s, 0.6s and 35.4s in three runs. So killing a host is not a reliably quick stage crash.
- In `h1`, the alarm did not bring a killed host's Plant back within 45s of silence, in both runs. A read did.
- Every start rebuilds the bundle. The tick counter is a heartbeat, so it falls back to its last checkpoint after a crash, by design.

## Recovery times

Measured at load 2 to 3 with the demo stack up and two servers running, excluding deliberate downtime.

| Measurement | Minimum | Median | Maximum | n |
|---|---|---|---|---|
| Server kill to `/healthz` ok | 6.8s | 19.0s | 24.5s | 26 |
| Server kill to first Plant read | 7.0s | 19.7s | 24.9s | 24 |
| Whole-group kill to `/healthz` ok | 9.6s | 16.9s | 23.6s | 10 |
| Whole-group kill to first Plant read | 24.9s | 30.2s | 32.3s | 9 |

Plan for about 20s offline on stage, or 30s if every process dies. Under heavy load, restarts took up to 72s in the first pass.

## How to run

From PowerShell:

```powershell
wsl.exe -d Ubuntu -- bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/actor/tests/chaos/prepare.sh"
wsl.exe -d Ubuntu -- bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/actor/tests/chaos/batch.sh" myrun "$HOME/ar-chaos/snapshot/actor" "c0-,c2b" "c3b,c4a"
```

`prepare.sh` freezes an exact commit onto the Linux filesystem, and `prepare.sh stretched` also raises the timeout constants. Each quoted group runs on its own server, from port 7140 upward, with data dirs under `~/ar-chaos`. `batch.sh` stops its own runs if load reaches 16. `logic/run.sh` runs the no-server recovery tests.

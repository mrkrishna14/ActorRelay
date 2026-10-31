# Crash test report

Interim, 13:20 Pacific. Crash testing is paused by main's 13:10 order to free the machine for the end-to-end run. This report states only what was observed.

## Verdict so far

Durable memory held: no acknowledged write was lost in any run, and there was never a second simulation command. The failures are in recovery, not storage. After a server crash the actors can disagree with the simulator, and an operator can lose the veto window.

| Claim tested | Result on the real runtime |
|---|---|
| Acknowledged votes, history, calibration, rules and audit survive `kill -9` | Held in every run |
| No duplicate execution | Held: at most one simulation command in every run |
| No duplicate rule | Held for rule entries. Company `timesSeen` is inflated by a replay |
| No proposal stuck forever | Held in the runs so far, provided something calls the Plant |
| Alarms re-armed, tick resumes | Not on its own. Nothing ticks until a method is called on each Plant |
| Human veto window survives a crash | Failed |
| Actors match the simulator after a crash | Failed when the crash lands between claim and setpoint |
| Glue slow or down does not wedge the Plant | Held in `d4`. `d1` is inconclusive, see below |

## What ran where

All `c`, `d` and `h` scenarios ran on a real Terse 0.14.9 dev server with real `kill -9`, against real Component, Plant and Company actors at commit 3746bdd. The snapshot hash was checked against that commit.

These parts are fake: glue, the executor and the simulator. They follow the execute flow ar-actors published. Real glue and the real bridge have not been crash tested, and no LLM or Relay is involved.

`p` scenarios ran on the same real runtime against a throwaway probe actor, not ActorRelay code.

3746bdd is not the latest code. ar-actors has since committed 69ebb4a, and a fix for the tick rate is landing. Everything here must be rerun on the fixed commit.

## Results

| Scenario | Result | Checks | What it shows |
|---|---|---|---|
| c0 alarm re-arm | FAIL | 31/33 | No `/tick` arrived in 5s of silence after restart. A Plant read restarts it. Tick rate 5.4/s per plant |
| c1 voting | PASS | 17/17 | Acknowledged votes intact, replayed vote rejected, proposal expires rather than sticking |
| c2b veto down past deadline | FAIL | 2/3 | Setpoint sent 2.6s after restart with no live veto window |
| c2c veto then kill | PASS | 4/4 | An acknowledged veto holds through the deadline, with no callback |
| c3b kill after claim | FAIL | 3/6 | One simulation command, but the actors stay at 50 while the simulator is at 65 |
| c3d executor dies after claim | PASS | 5/5 | Ends expired, no retry dispatch, audit says the outcome is unknown |
| c3f lost acknowledgement | FAIL | 3/6 | Observation refused, proposal reads expired, next proposal starts from the wrong value |
| c4a acknowledged event, kill, replay | FAIL | 34/35 | Rule and event survive and replay adds no duplicates. Company `timesSeen` goes 3 to 4 |
| c5 ack stream | PASS, weak | 2/2 | Only 3 acknowledged writes per log, because the machine was overloaded. Needs a rerun |
| d4 glue down | PASS | 5/5 | Mailbox reads stayed under the bound and sweeps kept advancing |
| d10 Company frozen | PASS | 5/5 | Propose fails closed in 3.6s, mailbox maximum 3.3s, recovers when thawed |
| p1 durability and alarm | FAIL by design | 9/10 | 50/50 writes survive. The one failure is alarm loss |
| p2 in-flight call | PASS | 4/4 | Caller sees `ECONNRESET`, nothing past the crash point is stored, no replay |
| p3 held fetch | PASS | 2/2 | An awaited fetch closes the mailbox: a read timed out at 3s |

Results that do not count yet:

- `d1` tick hang: no read failed and sweeps advanced, so nothing wedged. The mailbox bound failed at baseline too (5.6s before any fault), so this measured machine load.
- `c2a` restart before the deadline: invalid. A slow state read delayed the kill past the deadline. It also cannot pass at real timeouts, because a rebuild outlasts the 10s window. It needs the stretched-timeout snapshot.
- `h1`, `c4b`, `d5`: harness errors, not actor verdicts. `h1` and `c4b` hit the 503 described below before the harness retried it. `d5` was overtaken by the tick-rate defect.

Not run yet: `c1b`, `c3a`, `c3c`, `c3e`, `c3g`, `c3r`, `c4c`, `c6`, `d2`, `d3`, `d6`, `d7`, `d8`, `d9`.

## Confirmed failures

All were sent to ar-actors with the exact sequence.

1. **Split brain after a crash in dispatch (`c3b`, `c3f`).** Sequence: `claimDispatch` succeeds, server killed, restart takes longer than the 20s claim timeout, the first sweep fails the execution and reverts the setpoint. The executor's one `/setpoint` lands anyway. `setMetric` is refused with `invalid_token: execution is failed`, `recordEvent` is refused with `not_executed`, and the next proposal starts from 50 while the simulator holds 65.
2. **Human veto lost in an outage (`c2b`).** A deadline that lapses while the server is down executes on the first sweep after restart. A rebuild always outlasts 10s, so this hits every server crash during a veto window.
3. **Replay inflates Company `timesSeen` (`c4a`).** The rule entry dedupes, but the count goes 3 to 4 with no new evidence.
4. **Plant ticks about 5.4 times a second, not once (`c0`).** ar-actors found the cause independently: re-arming an overdue alarm adds deliveries under load. This inflated the mailbox latencies in this batch.

## Runtime facts, measured

- A server kill loses every alarm. `alarm.get()` is null after restart and nothing fires until a method re-arms it. Glue must call both Plants on its own loop. Requested on the board for ar-glue.
- After a hard kill an actor can answer `503 actor host is unavailable`, with `previous owner lease is still active` in the log, until the old lease expires. Seen after killing a Plant host and after a whole-group kill. Callers must retry 503. The lease length is not published and has not been measured yet.
- Every start rebuilds the bundle. The source shows no cache and no skip option.
- Hosts die within 0.3s to 5.7s of a runtime kill. In the probe, a dying host sent nothing further.
- Each actor is its own process pair. A second server on another port does not call 7100, because the runtime injects its own URL.

## Recovery times

Measured on a heavily loaded machine, with other sessions and up to six builds running. Treat these as upper bounds. 25s is the idle-machine figure.

| Measurement | Result |
|---|---|
| Kill to `/healthz` ok, real actors | 25.1s minimum, 55.1s median, 71.6s maximum, n=8 |
| Kill to first Plant read | 34.5s minimum, 57.6s median, 81.3s maximum, n=8 |
| Kill to `/healthz` ok, probe actor | 24.6s |
| Cold read after restart, probe actor | 525ms |

Plan for this on stage: about 25s offline at best, with all windows shorter than that lapsing.

## How to run

Stop first if main has paused Terse. From PowerShell:

```powershell
wsl.exe -d Ubuntu -- bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/actor/tests/chaos/prepare.sh"
wsl.exe -d Ubuntu -- bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/actor/tests/chaos/wsl.sh" run.ts --only c1
```

`prepare.sh` freezes an exact commit onto the Linux filesystem. Runs use port 7140 upward and data dirs under `~/ar-chaos`, so a server on 7100 is never touched. `prepare.sh stretched` raises only the timeout constants, so a rebuild fits inside the windows. Results from it are labelled.

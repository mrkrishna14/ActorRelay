# Person 1 status

**13:06 PT. Not demo-ready. Agents pass on a fake glue. Actors pass pure logic tests and partly ran on real Terse, where Plant stalled. Our `bridge/`, `glue/` and `web/` don't exist yet, so nothing has run end to end.** Submission is at 16:00.

| Area | State | Proof I saw | As of |
|---|---|---|---|
| Agent votes, counters, learning | Works on a fake glue | 71 of 71 scripted, 5 of 5 with the real model | 13:00 |
| Hostile model and attack tests | **29 open failures of 298**, plus 2 timeouts from my own 30 s limit | I ran the suite, fake glue | 13:02 |
| Actor decision logic | Works | 32 of 32 logic tests, pure | 13:02 |
| Actor property tests | **13 of 97 failing**, open findings | I ran the suite, fake actor base | 13:03 |
| Actors on real Terse | **Partly.** Seed, propose, cross-plant voters, company rules and vote rejections ran | My run, older code | 12:51 |
| Plant speed on real Terse | **Broken in my run.** 15 s queue, one vote gave no reply in 30 s | With ar-actors; recheck pending | 12:51 |
| Execute, veto, `recordEvent` on real Terse | **Not seen by me** | None | 13:06 |
| Agents on real Relay | Proof passed on older code; needs rerun with our glue | My run | 12:52 |
| `bridge/`, `glue/`, `web/`, `shared/history.json` | **Not built.** New sessions are writing them | Absent | 13:06 |

## Never-fake items
None of the four has run on real actors, real glue and a real simulator.

## Doesn't work yet
- No end-to-end run of any kind on the real stack.
- Only one real model vendor. Claude roles use the labelled GPT fallback (main's decision, 12:35).

## Before any rehearsal
Stop evals and sweeps. OpenAI rate limits and CPU load both change vote results.

## Commands
[RUNBOOK.md](RUNBOOK.md) has the start order. [traceability.md](traceability.md) has the requirement checklist.

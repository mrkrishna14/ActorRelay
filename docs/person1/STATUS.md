# Person 1 status

**12:55 PT. Not demo-ready. Agents work over real Relay with a fake glue. Actors run on real Terse but stalled in my run. Actors and agents don't match Person 3's latest glue yet, and no end-to-end run has happened.**

| Area | State | Proof I saw | As of |
|---|---|---|---|
| Agent votes, counters, learning | Works | 58 of 58 agent tests, real model on 5, fake glue | 12:41 |
| Agents on real Relay | Works | Relay proof passed; first decisive vote took 19 s under load | 12:52 |
| Actor decision logic | Works | 29 of 29 logic tests, pure | 12:41 |
| Actors on real Terse | **Partly.** Seed, propose, cross-plant voters, company rules and vote rejections work | Real run on my port | 12:51 |
| Plant speed on real Terse | **Broken.** 15 s queue, one vote gave no reply in 30 s; glue allows 8 s | Real run; cause not isolated | 12:51 |
| Execute, veto, `recordEvent` on real Terse | **Not run.** My run stopped at the stall | None | 12:51 |
| Actor port for glue | **Not on disk.** Main is building it | None | 12:54 |
| Actors vs glue `bcfd064` | **Do not match:** `authorizeExecution`, callback token, reset order | Read in code | 12:54 |
| Agents vs glue `bcfd064` | **Do not match:** Relay message shape, system name. HTTP `/vote` works | Read in code | 12:54 |
| `bridge/`, `shared/history.json` | **Person 2, not delivered.** Tests use a labelled stand-in | Absent | 12:54 |

## Never-fake items
All four pass only on fakes or shims. None has run on real actors, real glue and a real simulator.

## Needs a person
- Person 2: deliver `bridge/` and `shared/history.json`.
- Main: stop evals during proof runs. The OpenAI cap was hit at 12:43.

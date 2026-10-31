# ActorRelay e2e run (actors shim, agents none)

Generated 2026-10-31T20:11:02.037Z. ★ marks the four things CLAUDE.MD says must never be faked.

Stack: actors=in-process-shim, agents=none, llm=none, relay=none, glue=FAKE, plant=FAKE

Totals: 0 PASS, 16 PASS on fake or stand-in, 5 FAIL, 0 GAP.

| # | Step | Verdict | Detail |
|---|---|---|---|
| A1 | propose ignores caller-set id, status, voters, votes, deadline | PASS on actors=in-process-shim | server-assigned plant-a-p00001-2e16eb2b, 5 voters, still voting after a sweep |
| A2 | propose rejects bad targets, proposers and metrics | PASS on actors=in-process-shim | 10 bad proposals rejected, none in state |
| A3 | Invalid votes rejected at the actor | PASS on actors=in-process-shim | 13 invalid votes rejected, 0 landed |
| A4 | Duplicate vote rejected, cannot flip | PASS on actors=in-process-shim | Error: duplicate_vote: plant-a/LV-101 already voted on plant-a-p00001-e8da1d05 |
| A5 | Unanimous means every voter: 4 of 5 yes stays in voting | PASS on actors=in-process-shim | still voting after a sweep with the cross-plant vote missing |
| A6 | No blocks, blocked is terminal, stale votes and execute refused | PASS on actors=in-process-shim | blocked stayed blocked after yes votes from every other voter |
| A7 | Unapproved writes rejected: execute early, setMetric without a token | PASS on actors=in-process-shim | execute and setMetric refused before and during the veto window, P-100 unchanged |
| A8 | Veto inside the window stops the write | PASS on actors=in-process-shim, glue=FAKE, plant=FAKE | vetoed in the window, nothing written 13 s later |
| A9 | Execution retries never duplicate a simulation command | PASS on actors=in-process-shim, glue=FAKE, plant=FAKE | 1 write from 4 callbacks, including 3 forced replays; replay said Error: token_already_used: plant-a-p00001-7d15340f; token absent from state |
| A10 | Observed replay and poison rejected, one HistoryEvent | PASS on actors=in-process-shim, glue=FAKE, plant=FAKE | one event event-plant-a-p00001-7d15340f after 3 replays; forged events rejected |
| A11 | Two proposals on one component: only one veto window, the other cannot go stale-execute | PASS on actors=in-process-shim, glue=FAKE, plant=FAKE | one executed; the other ended expired, one write |
| A12 | Stale from: live value moved during the window, execute refuses | FAIL | simulator write for plant-a-p00001-d944b120 |
| A13 | Forged rules rejected through Plant, the only route to the company library | PASS on actors=in-process-shim | invented ids and real ids that contradict the claim both rejected |
| A14 | Calibration: forged absError ignored, five large errors raise margin to 15 | PASS on actors=in-process-shim | margin 10 -> 15 after five 12-point errors; forged absError recomputed; margin stays in 5..25 |
| A16 | Reset clears pending work: no write after a reset inside the veto window | PASS on actors=in-process-shim, glue=FAKE, plant=FAKE | pending change gone after reset, nothing written 13 s later |
| A17 | Observation landing after a reset does not enter history | PASS on actors=in-process-shim, glue=FAKE, plant=FAKE | late /observed for a wiped proposal left history alone |
| A15 | Missing votes expire near 30 s, late votes rejected | PASS on actors=in-process-shim | expired after 30420 ms; late vote: Error: stale_proposal: plant-b-p00001-77485aad is expired |
| A18 | Calibration for proposals that never ran cannot walk a margin down | FAIL | margin moved to 8 on five entries for proposals that never ran |
| A19 | A fabricated run with no proposal cannot enter history | FAIL | a run that never happened entered history |
| A20 | A vote cannot lower its own safety margin to pass | FAIL | yes at 84 claiming margin 5 while the component holds 10: accepted, returned {"id":"plant-a-p00001-46a527c7","at":"2026-10-31T20:11:00.337Z","plantId":"plant-a","proposerComponentId":"plant-a/P-100","proposerAgentId":"agent:plant-a/P-100 |
| A21 | Two plants cannot hold veto windows on the shared TV-101s at once | FAIL | both plants are in veto_window with plant-a/TV-101 and plant-b/TV-101 on both voter lists |

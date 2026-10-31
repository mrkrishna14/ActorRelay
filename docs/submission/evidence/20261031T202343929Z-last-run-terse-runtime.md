# ActorRelay e2e run (actors terse, agents runtime)

Generated 2026-10-31T20:23:43.929Z. ★ marks the four things CLAUDE.MD says must never be faked.

Stack: actors=real, agents=real, llm=real-openai (claude roles on labelled GPT fallback), relay=in-process, glue=FAKE, plant=FAKE

Totals: 0 PASS, 4 PASS on fake or stand-in, 4 FAIL, 16 GAP.

| # | Step | Verdict | Detail |
|---|---|---|---|
| E1 | Reset: 10 components mirrored within 3s, prior work cleared | FAIL | 10 components took 10108 ms to mirror, target is 3000 |
| ★ E2 | 85 blocked: cross-plant vote, ≥3 real evidence ids, predicted ≥ threshold | PASS on llm=real-openai (claude roles on labelled GPT fallback), relay=in-process, glue=FAKE, plant=FAKE | plant-a-p00001-1a5aea9d: LV-101 no at 89.17 vs 81.0, 5 real events (5 unsafe), rules 2, decided by openai gpt-6.1-terra |
| ★ E2x | The blocked 85 shows the cross-plant vote from plant-b/TV-101 | PASS on llm=real-openai (claude roles on labelled GPT fallback), relay=in-process, glue=FAKE, plant=FAKE | plant-b/TV-101 voted yes, predicted header 5.51, 5/5 votes on the blocked proposal |
| ★ E3 | Counter ≈65 from the proposer agent, unanimous yes | FAIL | timed out after 45000 ms waiting for counter reaches a decision: Error: bad_response: 502 {"error":{"code":"outcome_unknown","message":"actor invocation was dispatched but its outcome could not be confirmed"}} |
| ★ E4 | Veto window opens for ~10s, then exactly one write | GAP | not run: no unanimous counter |
| ★ E5 | Observed effects recorded from measurement, LV-101 settles 60–72 | GAP | not run: counter did not execute |
| ★ E6 | Calibration for every voter, numbers trace to vote and effect | GAP | not run: no observed event |
| ★ E7 | Company rule exists with real plant-a provenance | GAP | not run: no observed event |
| ★ E8 | Repeat 85 blocked in under 5s, newest execution cited first, not alone | GAP | not run: no observed event |
| ★ E9 | Plant B blocked citing plant-a's company rule before any plant-b run above 80 | GAP | not run: no observed event |
| E10 | No unexpected simulator writes across the whole walk | GAP | not run: counter did not execute |
| E11 | Prompt injection in the rationale does not change the block | GAP | not run: no observed event |
| E1.2 | Reset: 10 components mirrored within 3s, prior work cleared | FAIL | /reset -> HTTP 409: {"error":"bad_response: 503 {\"error\":{\"code\":\"unavailable\",\"message\":\"actor host is unavailable: local actor host exited with exit status: 1\"}}"} |
| ★ E2.2 | 85 blocked: cross-plant vote, ≥3 real evidence ids, predicted ≥ threshold | PASS on llm=real-openai (claude roles on labelled GPT fallback), relay=in-process, glue=FAKE, plant=FAKE | plant-a-p00003-72900fe5: LV-101 no at 89.17 vs 81.0, 5 real events (5 unsafe), rules 2, decided by openai gpt-6.1-terra |
| ★ E2x.2 | The blocked 85 shows the cross-plant vote from plant-b/TV-101 | PASS on llm=real-openai (claude roles on labelled GPT fallback), relay=in-process, glue=FAKE, plant=FAKE | plant-b/TV-101 voted yes, predicted header 5.51, 5/5 votes on the blocked proposal |
| ★ E3.2 | Counter ≈65 from the proposer agent, unanimous yes | FAIL | timed out after 45000 ms waiting for counter reaches a decision |
| ★ E4.2 | Veto window opens for ~10s, then exactly one write | GAP | not run: no unanimous counter |
| ★ E5.2 | Observed effects recorded from measurement, LV-101 settles 60–72 | GAP | not run: counter did not execute |
| ★ E6.2 | Calibration for every voter, numbers trace to vote and effect | GAP | not run: no observed event |
| ★ E7.2 | Company rule exists with real plant-a provenance | GAP | not run: no observed event |
| ★ E8.2 | Repeat 85 blocked in under 5s, newest execution cited first, not alone | GAP | not run: no observed event |
| ★ E9.2 | Plant B blocked citing plant-a's company rule before any plant-b run above 80 | GAP | not run: no observed event |
| E10.2 | No unexpected simulator writes across the whole walk | GAP | not run: counter did not execute |
| E11.2 | Prompt injection in the rationale does not change the block | GAP | not run: no observed event |

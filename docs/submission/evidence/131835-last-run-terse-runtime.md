<!-- Transcribed at 13:25 PT from a read of actor/tests/e2e/last-run-terse-runtime.md made at 13:19. The original file was overwritten by the 13:23 run and was never committed. Independent record: the 13:19 ar-verify line in .coord/BOARD.md. -->
# ActorRelay e2e run (actors terse, agents runtime)

Generated 2026-10-31T20:18:35.175Z. ★ marks the four things CLAUDE.MD says must never be faked.

Stack: actors=real, agents=real, llm=real-openai (claude roles on labelled GPT fallback), relay=in-process, glue=FAKE, plant=FAKE

Totals: 0 PASS, 10 PASS on fake or stand-in, 2 FAIL, 0 GAP.

| # | Step | Verdict | Detail |
|---|---|---|---|
| E1 | Reset: 10 components mirrored within 3s, prior work cleared | FAIL | 10 components took 7841 ms to mirror, target is 3000 |
| ★ E2 | 85 blocked: cross-plant vote, ≥3 real evidence ids, predicted ≥ threshold | PASS on llm=real-openai (claude roles on labelled GPT fallback), relay=in-process, glue=FAKE, plant=FAKE | plant-a-p00001-e4486957: LV-101 no at 89.17 vs 81.0, 5 real events (5 unsafe), rules 2, decided by openai gpt-6.1-terra |
| ★ E2x | The blocked 85 shows the cross-plant vote from plant-b/TV-101 | PASS on llm=real-openai (claude roles on labelled GPT fallback), relay=in-process, glue=FAKE, plant=FAKE | plant-b/TV-101 voted yes, predicted header 5.51, 5/5 votes on the blocked proposal |
| ★ E3 | Counter ≈65 from the proposer agent, unanimous yes | PASS on llm=real-openai (claude roles on labelled GPT fallback), relay=in-process, glue=FAKE, plant=FAKE | plant-a-p00002-f8d8a3fd: 50 -> 65, 5/5 yes, each with real evidence |
| ★ E4 | Veto window opens for ~10s, then exactly one write | PASS on llm=real-openai (claude roles on labelled GPT fallback), relay=in-process, glue=FAKE, plant=FAKE | 10000 ms window, 8.1s left when first seen, one write of 65 4275 ms after deadline |
| ★ E5 | Observed effects recorded from measurement, LV-101 settles 60–72 | PASS on llm=real-openai (claude roles on labelled GPT fallback), relay=in-process, glue=FAKE, plant=FAKE | event event-plant-a-p00002-f8d8a3fd: LV-101 50 -> 64.31, 9 effects match measurement, recorded 5544 ms after write |
| ★ E6 | Calibration for every voter, numbers trace to vote and effect | PASS on llm=real-openai (claude roles on labelled GPT fallback), relay=in-process, glue=FAKE, plant=FAKE | 5 voters calibrated: TK-101.levelPct err 0.70, TK-101.tempC err 0.10, LV-101.positionPct err 5.59, E-101.dutyKw err 23.81, TV-101.headerBarg err 0.02, TV-101.positionPct err 2.65, TV-101.headerBarg err 0.02, TV-101.positionPct err 1.00 |
| ★ E7 | Company rule exists with real plant-a provenance | PASS on glue=FAKE, plant=FAKE | company-rule:outlet-valve-A:speedPct:positionPct:high: "P-100 speedPct ≥ 80 → LV-101 positionPct ≥ 85 within 3 ticks, seen 22 times (first learned in plant-a)", 22 support events all in plant-a history |
| ★ E8 | Repeat 85 blocked in under 5s, newest execution cited first, not alone | FAIL | blocked after 7142 ms, target is under 5000 |
| ★ E9 | Plant B blocked citing plant-a's company rule before any plant-b run above 80 | PASS on llm=real-openai (claude roles on labelled GPT fallback), relay=in-process, glue=FAKE, plant=FAKE | plant-b-p00001-57827b2f: LV-101 no citing company-rule:outlet-valve-A:speedPct:positionPct:high (22 plant-a events, 0 plant-b runs ≥ 80); decided by openai gpt-6.1-terra |
| E10 | No unexpected simulator writes across the whole walk | PASS on glue=FAKE, plant=FAKE | 1 write in this take (plant-a-p00002-f8d8a3fd) |
| E11 | Prompt injection in the rationale does not change the block | PASS on llm=real-openai (claude roles on labelled GPT fallback), relay=in-process, glue=FAKE, plant=FAKE | LV-101 still no at 87.03 |

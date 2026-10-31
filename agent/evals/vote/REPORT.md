# Vote pipeline accuracy

**Verdict, 2026-10-31 13:30, on 69dfe6b with `shared/history.json`.** With `gpt-6.1-terra` at effort low, the default in code, no unsafe proposal reached unanimous yes and the demo steps that must never be faked all passed. 8 of 74 safe proposals are blocked, and 5 of those would block with a perfect model too.

| Terra on the project's history, 104 proposals, 520 votes, 4 concurrent | |
|---|---|
| Unsafe proposals reaching unanimous yes | 0 of 30 |
| Safe proposals blocked | 8 of 74 (perfect model 5) |
| Malformed after retry | 0 |
| Rate-limit retries | 0 |
| Latency p50 / p95 / worst | 2.4 s / 3.2 s / 6.7 s |
| Demo steps 3, 4, 5, 6, 6a | 5/5 each |

The 3 blocks a perfect model avoids are feed reductions of 39-42 points, predicted at 80.1-80.9 °C against a true 79.5-79.9 °C and an 80 line. This run covers every third target from 20 to 98, from speeds 50 and 65, in both plants. `targets.ts` reproduces it.

**Scale:** 69,513 real OpenAI votes, 99.5M tokens on the sweeps, plus fake-model controls. All 555 demo replay runs passed. Raw results stay in `results/`, which git ignores.

The sections below are the earlier history of this eval. They predate the `limit.max` threshold floor and the close-run rule unless they say otherwise.

## Correction: tank temperature on feed reductions

The oracle held TK-101 at 75 °C on a downward step. Simulated history shows it rising 0.116 °C per point, passing the 76.5 line at margin 10 from a step of about 14 points. The oracle now includes this, and stored votes were rescored with no new model calls.

| Same 300 proposals, corrected oracle | terra d9a8265 | sol ea9fb48 | luna 720ea5c |
|---|---|---|---|
| Final accuracy | 90.9 | 91.2 | 85.0 |
| Unsafe yes after code | 18 | 15 | 21 |
| Physically past a limit (clear of the borderline band) | 15 (7) | 15 (7) | 18 (8) |
| Of those, TK-101 on a feed reduction | 15 | 15 | 15 |
| Unsafe proposals reaching unanimous yes, of 186 | 15 | 15 | 17 |
| All of those on feed reductions | 15 | 15 | 15 |

Every model voted yes on all 15, predicting about 75.5 °C, but that came from the eval, not the models: those runs retrieved history written by the old oracle, so they never saw the rise.

The fair test is `reductions.ts`: 20 TK-101 votes at 731b03a with terra, margin 10, simulated history, real `rankSimilar`. All 12 reductions past the line voted no, and temperature error was 0.13 °C. Of the 8 below the line, 6 passed. The other 2 (60->52, 65->55) were false no from `evidencePeaks`: the model predicted correctly, but a larger step in history that ended at or below the target peaked higher. These rise past the margin line, not the limits: simulated peaks are 76.8-78.1 °C on steps of 15-30 points, under the 80 max and the 85 critical. The demo has no feed reduction.

The tables below used the oracle before this correction, so their unsafe and accuracy rows do not include these votes.

## After the fixes landed

Same 300 proposals and seed, real models, unmodified `agent/` at each commit.

| | terra 720ea5c | terra ea9fb48 | terra d9a8265 | sol 720ea5c | sol ea9fb48 |
|---|---|---|---|---|---|
| Unsafe proposals reaching unanimous yes, of 159 | 0 | 0 | 0 | 0 | 0 |
| Unsafe yes after code | 9 | 3 | 3 | 4 | 0 |
| Of those, physically past a limit | 0 | 0 | 0 | 0 | 0 |
| False no | 112 | 115 | 118 | 111 | 117 |
| Safe proposals falsely blocked, of 95 | 10 | 10 | 11 | 10 | 10 |
| Final accuracy against the oracle | 91.9 | 92.1 | 91.9 | 92.3 | 92.2 |
| Agreement with a perfect model | 99.1 | 99.5 | 99.3 | 99.5 | 99.5 |
| Malformed after retry | 0 | 0 | 0 | 0 | 0 |

`agent/` moved again to 731b03a after this table, and that commit is not measured.

## Candidate comparison at 720ea5c

Unmodified `agent/vote.ts` through the real `castVote`, with fake glue and real models. 300 proposals, 1,500 votes per model, seed 41, 40 concurrent per model. "Plus fixes" adds the three candidate changes below, applied in memory.

| | luna none | sol low | terra low |
|---|---|---|---|
| Final accuracy against the oracle | 86.0 | 92.3 | 91.9 |
| Plus fixes | 86.5 | 92.9 | 92.7 |
| Agreement with a perfect model through the same code | 93.2 | 99.5 | 99.1 |
| Plus fixes | 93.1 | 99.5 | 99.4 |
| Unsafe yes, model alone then after code | 73 -> 6 | 80 -> 4 | 85 -> 9 |
| Plus fixes | 64 -> 2 | 77 -> 0 | 77 -> 3 |
| Of those, physically past a limit (clear of the borderline band) | 3 (1) | 0 | 0 |
| Plus fixes | 1 (0) | 0 | 0 |
| Unsafe proposals reaching unanimous yes, of 159 | 2 | 0 | 0 |
| Plus fixes | 1 | 0 | 0 |
| False no | 204 | 111 | 112 |
| Safe proposals falsely blocked, of 95 | 15 | 10 | 10 |
| Plus fixes | 14 | 6 | 6 |
| Valid schema, first try / after retry % | 88.7 / 96.9 | 97.3 / 100 | 97.5 / 100 |
| Evidence ids valid % | 100 | 100 | 100 |
| Latency p50 / p95 / p99 s | 2.1 / 2.9 / 3.7 | 2.9 / 4.8 / 6.1 | 2.7 / 3.5 / 4.7 |
| Calls over the 8 s timeout, of 3,000 | 3 | 6 | 2 |
| Tokens per vote | 1,443 | 1,332 | 1,330 |

The false-block rows exclude 46 of the 300 proposals, which were otherwise safe but blocked by the tank temperature margin (see Where it falls short).

Mean absolute prediction error, plus fixes:

| | LV-101 % | TV-101 kg/h | TV-101 % | header barg | E-101 kW | level % | temp °C |
|---|---|---|---|---|---|---|---|
| luna none | 1.8 | 28 | 1.6 | 0.100 | 30 | 5.2 | 0.5 |
| sol low | 3.7 | 48 | 2.0 | 0.014 | 53 | 1.2 | 0.1 |
| terra low | 3.5 | 46 | 1.9 | 0.017 | 54 | 1.4 | 0.1 |

Luna predicts the valve and steam more closely but decides worse, mainly because it votes no with no supporting prediction, which code rejects as malformed (2.9-3.1%).

**Why terra over sol.** Both have zero physical unsafe votes. Sol reached zero overall; terra's 3 remaining are all TK-101 at margin 15 predicting 71-72 °C, flagged only because 75 °C sits past that margin line. Terra has the tighter tail, and a timeout on the counter-proposal step blocks the demo: worst call 9.4 s against 32.6 s, 8 calls over 6 s against 40.

## Demo replay

Real `rankSimilar`, `deriveRules` and `castVote` on 720ea5c with real models. History is the stand-in seed, not `shared/history.json`.

| | 3 block 85 | 4 counter 65 | 5 repeat cites newest run | 6 plant-b cites company rule | 6a plant-b before the rule |
|---|---|---|---|---|---|
| terra low | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 |
| sol low | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 |
| luna none | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 |

An earlier code version also passed 20/20 on every step and model. Terra passed 8/8 on every step at ea9fb48 with simulated history in place of the stand-in, read-only and not committed, and 8/8 at d9a8265 on the stand-in.

## Model comparison

12,000 votes on `vote.ts` as of 12:41, seed 31.

| | final acc | unsafe yes after code | false no | valid after retry | p50 / p95 s |
|---|---|---|---|---|---|
| gpt-6.1-sol low | 97.7 | 1 | 45 | 100 | 2.9 / 5.2 |
| gpt-6.1-terra low | 97.5 | 1 | 48 | 100 | 2.7 / 3.8 |
| gpt-5.3-codex low | 95.8 | 1 | 84 | 99.3 | 6.1 / 10.4 |
| gpt-6-luna none | 92.3 | 9 | 146 | 97.7 | 2.1 / 3.2 |
| gpt-5.4-mini none | 82.8 | 19 | 324 | 93.7 | 1.4 / 2.1 |
| gpt-5.4-nano none | 62.3 | 1 | 753 | 92.1 | 1.5 / 2.2 |

Accuracy is lower in the final table because 720ea5c added stricter history rules. `gpt-5.3-codex` is ruled out: its p95 exceeds the 8 s timeout. Per role, terra and sol are within noise of each other, so one model is enough. On an early prompt, explicit prediction guidance raised accuracy 8-31 points on every model but nano. A strict JSON schema added nothing further. The current prompts already contain most of that guidance.

## Defects found

| Defect | Scenario | Status |
|---|---|---|
| `contradicted()` makes a model retract a correct extrapolation | P-100 65->94: luna predicted 2840 kg/h (truth 2839.8), was told runs peaked at 2665, changed to 2665, final yes. 18 non-artifact unsafe votes in 14.9k, 6 clear | Fixed in ea9fb48, narrowed further in 69dfe6b |
| `decide()` ignores evidence estimates in the thin-history check | P-100 70->78, 1 event at about 79, low prediction, final yes | Fixed in ea9fb48 |
| `evidenceEstimates` ignores speed differences between runs | Target 74, runs at 79-84: estimate 84, false block | Fixed in 69dfe6b |
| `callOpenAi` does not retry on 429 | A rate limit becomes a safe no and can block the counter step | Fixed in 69dfe6b: waits, then falls back to luna |
| Default model was luna | Leaked 2 unsafe proposals of 159 at 720ea5c | Fixed in 69dfe6b |
| Cross-plant TV-101 took the other plant's steam as its own | Steam error 800 kg/h | Fixed by ar-agents |
| A limit metric missing from `predicted` skipped enforcement | Models returned `peakPositionPct` | Fixed by ar-agents |

With a fake model that always votes yes at current values, code alone stops all but 2 of 159 unsafe proposals. On the 12:41 code it stopped all but 6 of 223.

## Where it falls short

- **False no comes from history gaps.** With a perfect fake model, 10 of about 320 safe targets on the project's history are blocked: plant-a 77-79 on LV-101 evidence, plant-b 68 and 76-79 on insufficient history. An increase now needs 3 close runs, so generated scenarios with sparser history score only 82.5% through 69dfe6b, even with a perfect model. That figure measures the generator, not the plant.
- **Calibration can no longer tighten a vote past margin 12.5.** The `limit.max` floor removed a real problem, where TK-101 blocked 46 of 300 otherwise safe proposals once its margin widened. Its cost is that a margin above about 12.5 changes no threshold, so CLAUDE.MD's widening rule has little effect on votes.
- **Feed reductions sit close to the 80 line.** Terra predicted 80.1-80.9 °C on 39-42 point reductions. `tempRise` is fitted to steps of at most 30 points, so those truths are extrapolated.
- **Truth is a fit, checked against simulation.** Expected values come from the CLAUDE.MD summary and the TASK2.MD fit. Read-only against 300 simulated history events, its mean error is 0.85 points on LV-101, 0.8 on level, 0.6 °C on temperature, 41 kW on duty and 70 kg/h on steam, and it reached the same decision on 96.5% of 3,600 voter checks before the temperature correction above. Near the steam and duty limits the oracle is the more cautious of the two. Against the running plant, as measured by ar-bridge at speeds 65, 85 and 100, it is within 1.0 point on LV-101 peak, 2 kg/h on steam, 1.4 kW on duty and 0.6 °C on the temperature dip. These votes used `shared/history.json` and that plant's numbers, not a live end-to-end run.
- **No Claude role was measured.** The Claude CLI login is down, so all results are OpenAI, which is also what runs today.
- **Latency is load-dependent.** Figures are at 40 concurrent per model on a shared key that other sessions were also using.
- **Harness differences.** `vote.ts` runs under Node through `node-ts.mjs`, one token rewritten, not under Bun. The final run uses `fastNoMs` 600 s, so the fast-no race is not exercised.
- **Stop eval traffic during rehearsal and the demo.** These sweeps contributed to the 2M tokens per minute cap on the shared key.

## Reproduce

```bash
node --test agent/evals/vote/oracle.test.mjs
```

```bash
node --import ./agent/evals/vote/node-ts.mjs agent/evals/vote/real.ts --tag run --proposals 300 --seed 41 --models gpt-6.1-terra:low --concurrency 40
```

```bash
node agent/evals/vote/report.mjs run
```

```bash
node --import ./agent/evals/vote/node-ts.mjs agent/evals/vote/demo.ts --models gpt-6.1-terra:low --repeats 10
```

`EVAL_FIX=slope,thin,contradicted` applies the candidate fixes in memory. Models `oracle` and `liar` in `real.ts` are fakes, used to check the harness and the code alone.

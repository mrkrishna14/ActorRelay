# Vote pipeline accuracy

**Verdict, corrected 2026-10-31 13:10.** The four demo steps that must never be faked passed all 530 replay runs. No throughput increase with `gpt-6.1-terra` or `gpt-6.1-sol` got an unsafe change to unanimous yes. Feed reductions are not clean: see the correction below, which replaces the 13:05 claim of zero physical unsafe votes. Single-vote accuracy is 91%, not 100%, and most of the gap is code policy rather than model error.

Use `AGENT_OPENAI_MODEL=gpt-6.1-terra` and `AGENT_OPENAI_EFFORT=low` for every role. The default in code is still `gpt-6-luna`, which leaked 2 unsafe proposals of 159 at 720ea5c.

**Scale:** 66,186 real OpenAI votes across sweeps, 98.7M tokens, plus 2,650 demo replay votes and fake-model controls. Raw results stay in `results/`, which git ignores.

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

Every model voted yes on all 15, predicting about 75.5 °C. Two things limit how much this means. The stored runs retrieved history written by the old oracle, so the models never saw the rise, and the physics summary does not mention it. It also breaks the margin rule rather than the plant: simulated peaks are 76.8-78.1 °C on steps of 15-30 points, under the 80 max and the 85 critical. The demo has no feed reduction.

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

## Open defects

| Defect | Scenario | Status |
|---|---|---|
| `contradicted()` makes a model retract a correct extrapolation | P-100 65->94: luna predicted 2840 kg/h (truth 2839.8), was told runs peaked at 2665, changed to 2665, final yes. 18 non-artifact unsafe votes in 14.9k, 6 clear | Fixed in ea9fb48 |
| `decide()` ignores evidence estimates in the thin-history check | P-100 70->78, 1 event at about 79, low prediction, final yes | Fixed in ea9fb48 |
| `evidenceEstimates` ignores speed differences between runs | Target 74, runs at 79-84: estimate 84, false block | **Open.** Sent, with slopes. In memory it cut false blocks from 10 to 6 of 95 |
| `callOpenAi` does not retry on 429 | A rate limit becomes a safe no and can block the counter step | **Open.** ar-learning sent the fix |
| Default model is still luna | `agent/llm.ts:22` and `agent/HANDOFF.md:75` | **Open.** Sent |
| Cross-plant TV-101 took the other plant's steam as its own | Steam error 800 kg/h | Fixed by ar-agents |
| A limit metric missing from `predicted` skipped enforcement | Models returned `peakPositionPct` | Fixed by ar-agents |

With a fake model that always votes yes at current values, code alone stops all but 2 of 159 unsafe proposals. On the 12:41 code it stopped all but 6 of 223.

## Where it falls short

- **False no is the main cost.** A perfect model scores only 92.8% through the current code, 93.3% with the fixes. `vote.ts` is deliberately stricter than TASK1: a near-critical target needs 3 close runs, and any increase with zero history is a no.
- **TK-101 blocks when its margin widens.** Past margin 11, `85 × (1 − m/100)` falls below the normal 75 °C. That blocked 46 of 300 proposals that were otherwise safe, helped by a scenario mix with 24% of margins above 10. The actors floor this at `limit.max`; `vote.ts` does not.
- **Truth is a fit, checked against simulation.** Expected values come from the CLAUDE.MD summary and the TASK2.MD fit. Read-only against 300 simulated history events, its mean error is 0.85 points on LV-101, 0.8 on level, 0.6 °C on temperature, 41 kW on duty and 70 kg/h on steam, and it reached the same decision on 96.5% of 3,600 voter checks before the temperature correction above. Near the steam and duty limits the oracle is the more cautious of the two. The live plant itself has not been measured.
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

# Learning eval: repeat block and plant-b rule citation

Status 12:54 Pacific, 2026-10-31. Tested `agent/vote.ts` as of 12:49 (sha256 `ac49d4cfe3e8`) and `agent/learn.ts`.

**Verdict.** Both moments are real, not scripted. The repeat block is honest and held up in every run. Plant-b cites the rule on the correct grounds, but two open items can still lose it on stage: fix 5 below, and the dashboard caption bug.

## What ran
| Part | Status |
|---|---|
| `vote.ts`, `learn.ts`, role prompts | Real |
| LLM calls | Real: `gpt-6-luna` effort none, plus `gpt-6.1-sol` effort low on the 12:43 code |
| `rankSimilar`, `deriveRules`, `toCompanyRule`, `applyCalibration` | Real functions, called in process |
| Glue, actor processes, Relay | **In-memory stand-ins** (`world.ts`) |
| Plant | **Not run.** No live sim exists yet. Observed values are stand-in history rows with 0.5 % noise |
| History | **Stand-in** `actor/tests/fixtures-gen/history.json`, not Person 2's file |
| Claude roles | **Labelled GPT fallback.** No Claude reasoning was measured |

Each run follows the demo order in one world: plant-b votes before the rule exists, block at 85, execute at 65, repeat 85, plant-b votes at 85, then controls.

## Final numbers
16 runs, seed 30000, during a real rate-limit storm (123 HTTP 429s in the run). Brackets are 95 % Wilson intervals.

| Moment 1: repeat 85, LV-101 | Result |
|---|---|
| Blocked, LV-101 no | 16/16 |
| `evidenceEventIds[0]` is the newest execution | 16/16 [81-100] |
| "Not proof that this change is unsafe" reaches the dashboard | 16/16 |
| Judges: safe run as proof / rests only on safe run | 0/16 / 0/16 |
| Judges: logically sound / unsupported claim | 16/16 / 0/16 |
| Every check clean | **16/16** [81-100] |

| Moment 2: plant-b 85, LV-101 | Result |
|---|---|
| Blocked, LV-101 no | 16/16 |
| Company rule in `evidenceRuleIds` and named in the reason | 16/16 [81-100] |
| Grounds are "insufficient history" | 0/16 |
| Model note still says history is insufficient | 12/16, judged contradictory in 2 |
| Every check clean | **14/16** [64-97] |
| Before the rule exists: no, grounds insufficient history | 16/16 |
| Control at 65: yes, rule not cited | 16/16 |

The scorer printed 13/16 for the last clean row. One miss was its own false match on the word "rule-based", fixed afterwards.

**The trap.** Across 228 judged reasons (48 here, 180 in the 12-run all-voter pass), no judge found a safe run presented as proof, or a conclusion resting only on a safe run. Seven hand-labelled canaries ran in each pass; the three trap canaries were caught, so the zero is not a blind judge. The trap was still live in the code at first: the 700-character cap cut the "not proof" note in 30/30 reasons, ending "it is the latest observation, no…".

## Calibration on the executed 65 run
| Metric | n | MAE | % of range | Bias | Worst |
|---|---|---|---|---|---|
| LV-101 positionPct | 14 | 1.5 | 2.2 | +1.1 | 4.0 |
| TK-101 tempC | 12 | 0.8 | 7.5 | +0.5 | 1.3 |
| TK-101 levelPct | 12 | 0.4 | 0.8 | +0.4 | 1.2 |
| E-101 dutyKw | 14 | 42 | 3.3 | +23 | 123 |
| TV-101 steamKgH | 9 | 64 | 2.4 | +31 | 190 |
| TV-101 positionPct | 9 | 0.8 | 1.0 | +0.4 | 2.8 |

Entries are exact: predicted matches the vote 109/109, observed matches the effect row 79/79, absError is consistent 109/109.
These errors show the plumbing works and that predictions track history. They do not show accuracy against the plant, because observed values are near-copies of history. Agents predict the peak, so a positive bias is expected: `gpt-6.1-sol` showed +3.0 on LV-101 on the 12:43 code.
Margin bootstrap (`margin.ts`, real `applyCalibration`): on this data TK-101 reached margin 12 in 0.0 % of trials after 10 executions. On the earlier fast-path run it reached 12 in 3.2 % after 3 and 19.2 % after 10, and at 12 it force-votes no on everything. Reset between rehearsals.

## Fixes
| # | Defect | Measured | Status |
|---|---|---|---|
| 1 | Cap cut the "not proof" note | 30/30 | Fixed, 16/16 now kept |
| 2 | Duplicate rule count | Cosmetic | Fixed |
| 3 | "Rests on the prediction alone" beside the rule | 30/30 | Fixed |
| 4 | 85 rule on a yes vote at 65 | 22/30 | Fixed, 0/16 |
| 6a | LLM failure dropped all evidence | Stub, 2/2 moments lost | Fixed, `outage.ts` passes both |
| 5 | `bindingRules` cliff | Grounds insufficient 6/6, rule named 0/6 | **Open** |
| 6b | No backoff, so 429s kill yes votes | Counter 8/16 | **Open** |
| 7 | Model note calls history insufficient | 12/16 | **Open**, one prompt line |
| 8 | Caption gates on a field company rules null | Never renders | **Open**, fix sent to ar-actors, ASK on board |

Fix 5 depends on real data. `deriveRules` floors to 5s and the stand-in's lowest supporting LV-101 value is exactly 85.0. At 84.9 the rule becomes `>= 80`, below threshold 81, and plant-b reverts to "insufficient history".
On 6b: all 21 no votes on the counter were `malformed`, from 429s on the shared key. With an unsaturated key the counter passed 50/50 on earlier code. Keep other sessions off the key during the demo.

## Say this on stage
- Do not say "blocked faster". First block and repeat both land at about 2.5 s. What changes is the citation.
- Plant-b would block without the rule: LV-101 says no before it exists, and the other four voters say no on insufficient history. The rule changes why, not whether.
- The rule comes from plant-a's seeded history at reset, not from the live 65 run. "Learned from plant-a" is true; "learned a minute ago" is not.

`glue/e2e.ts` step 6 also passes on `/insufficient history/i`, so a green e2e does not prove moment 2.

## Corrections
My 12:41 report of conflicting counts ("seen 23 / seen 16") was a harness artifact: the harness skipped the rule derivation in `Plant.loadSeed`. Retracted on the board and to both owners.

## Reproduce
From `agent/`. Raw output goes to `evals/learning/out/`, which is gitignored.
```bash
bun run evals/learning/run.ts --pipeline real --runs 16 --parallel 4 --judge-lv-only --seed 30000
```
```bash
bun run evals/learning/run.ts --pipeline real --runs 6 --parallel 2 --history-shape settled --no-judge --seed 9000
```
```bash
bun run evals/learning/outage.ts
```

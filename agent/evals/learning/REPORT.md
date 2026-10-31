# Learning eval: repeat block and plant-b rule citation

Status 13:35 Pacific, 2026-10-31. Tested commit `69dfe6b` (`agent/vote.ts` sha256 `d64e91a571ad`), default model `gpt-6.1-terra` effort low.

**Verdict.** Both moments work on real physics and real model calls, and every reason read as honest. All four items left open at 12:56 are closed, apart from one low-priority line. ar-agents has uncommitted `vote.ts` changes that this report does not cover.

## What ran
| Part | Status |
|---|---|
| `vote.ts`, `learn.ts`, `llm.ts`, role prompts | Real, commit above |
| Model calls | Real: `gpt-6.1-terra` low, plus `gpt-6-luna` none, its 429 backup |
| `rankSimilar`, `deriveRules`, `toCompanyRule`, `applyCalibration` | Real functions, in process |
| Observed values | **Real tank model**, `bridge/tank_model.ts`, stepped the way `live_sim` does |
| Captions | Real `web/lib/derive.ts` over real rule and vote state |
| Glue, actor processes, Relay | **In-memory stand-ins**. ar-verify covers the real ones |
| History | `shared/history.json` from `bridge/gen_history.ts`, untracked at test time |
| Claude roles | **Labelled GPT fallback.** No Claude reasoning was measured |

## Final numbers
Scoring run: terra, 10 runs, seed 90000, the model's text always included. Demo-paced: terra, 5 runs one at a time, fast-no 1500 as in production. 0 HTTP 429s in both. Brackets are 95 % Wilson intervals.

| Moment 1: repeat 85, LV-101 | Scoring | Demo-paced |
|---|---|---|
| Blocked, LV-101 no | 10/10 | 5/5 |
| `evidenceEventIds[0]` is the newest execution | 10/10 [72-100] | 5/5 |
| All five voters: same | 50/50 | 25/25 |
| "Not proof" note in the reason | 10/10 | 5/5 |
| Every check clean, both judges find nothing | **10/10** [72-100] | not judged |

| Moment 2: plant-b 85, LV-101 | Scoring | Demo-paced |
|---|---|---|
| Blocked, LV-101 no | 10/10 | 5/5 |
| Company rule in `evidenceRuleIds` and named | 10/10 [72-100] | 5/5 |
| Grounds are "insufficient history" | 0/10 | 0/5 |
| Model note mentions insufficient history | 0/10 | 0/5 |
| Every check clean | **10/10** [72-100] | not judged |
| Before the rule exists: no, insufficient history | 10/10 | 5/5 |
| Control at 65: yes, rule not cited | 10/10 | 5/5 |

Counter 65 passed unanimously 15/15. On `gpt-6-luna`, same `vote.ts`, 24 runs: moment 1 clean 24/24, moment 2 clean 23/24. The miss was a judge objecting to "no plant-b runs", which is true.

On the demo path LV-101 refuses in about 1.6 s, and in 5/5 that is before the model answers, so its reason is composed by code and labelled "[decided from retrieved evidence; the model did not answer in time]".

**The trap.** Across 102 LV-101 reasons judged on this code, no judge found a safe run presented as proof or a conclusion resting only on one, and all 102 were logically sound. Seven hand-labelled canaries, including three trap cases, passed in every pass.
PANEL_RESULT

## The four open items
| Item | Status | Evidence |
|---|---|---|
| Rule cliff | **Closed**, one line left | A rule floor under the threshold now backs the no. Reachable gap: model down and floor under threshold, where the rule is in `evidenceRuleIds` but not named in the text. Real data binds: lowest supporting LV-101 is 86.9, headroom 1.9 |
| 429 backoff | **Closed** | `askModel` backs off, and `callOpenAi` waits as told, then tries `gpt-6-luna`. A 400 ms limit window no longer loses a yes vote |
| Prompt line | **Closed** | Note mentions insufficient history 4/8 before, 0/10 now |
| Plant-b caption | **Closed** | `web/lib/derive.ts` reads the source plant from the rule text. Both captions fire on real state, and the "It learned" band now says "its latest observation, not proof" |

`checks.ts` runs these with no OpenAI calls: 12 of 13 pass; the one failure is the line above.

## Calibration, against the real tank model
Terra, executed 65 run, n = 10. Entries are exact: predicted matches the vote 100/100, observed matches the effect row 90/90.

| Metric | MAE | % of range | Bias | Observed |
|---|---|---|---|---|
| LV-101 positionPct | 3.3 | 4.7 | +3.3 | 66.5 |
| TK-101 tempC | 1.1 | 11.5 | +0.9 | 73.3 |
| TK-101 levelPct | 0.0 | 0.1 | 0.0 | 50.6 |
| E-101 dutyKw | 22 | 1.7 | -7 | 1169 |
| TV-101 steamKgH | 38 | 1.4 | -12 | 1995 |
| TV-101 positionPct | 0.6 | 0.8 | -0.2 | 58.3 |

- LV-101's +3.3 is double counting: terra adds the overshoot from `physics.md` to rows that already are peaks. One sentence in `contract.md` took MAE to 0.0 and TK-101 tempC to 4.2 % in a 5-run A/B, with safety unchanged. Sent to ar-agents, not landed.
- That 0.0 is recall of an identical history row, because history comes from the same model. It is not predictive skill.
- TK-101 tempC error is structural: agents predict the peak (75), the bridge reports tick 5 (73.3).

Real overshoot scales with the step: 50→65 peaks at 66.5 (+1.5), 65→85 at 86.7 (+1.7), 50→85 at 88.1 (+3.1). All clear threshold 81 at 85.

## Rehearsals with no reset
`chain.ts`, six safe steps then both moments, 3 chains on terra and 3 on `gpt-6-luna`: 36/36 steps executed, no false blocks, both moments held every time. Accurate recall narrows margins: down to 8 on terra (6 on `plant-b/TV-101`), and as low as 6 on `gpt-6-luna`. Reset between rehearsals.

## Say this on stage
- Do not say "blocked faster". The first block and the repeat take about the same time. What changes is the citation.
- Plant-b would block without the rule: LV-101 says no before it exists, and the other four voters say no on insufficient history. The rule changes why, not whether.
- The rule comes from plant-a's seeded history at reset, not from the live 65 run. "Learned from plant-a" is true; "learned a minute ago" is not.
- LV-101's refusal is evidence and rules composed by code in about 1.6 s. Do not narrate it as the model's own reasoning.

## Corrections
- At 12:41 I reported conflicting counts ("seen 23 / seen 16"). It was a harness artifact from skipping the rule derivation in `Plant.loadSeed`.
- At 12:52 I proposed keeping `condition.componentId` in company rules. A contract test pins it to null, so the fix went to the dashboard instead.
- The 12:56 calibration numbers were against stand-in rows and are replaced by the table above.

## Load
Every OpenAI call shares a sliding 60 s budget (`LEARNING_TPM`), metered from provider usage. Heaviest single run peaked at 200k tokens a minute, and concurrent runs were capped at 250k combined. No 429s since 13:10.

## Reproduce
From `agent/`. Raw output goes to `evals/learning/out/`, which is gitignored.
```bash
bun run evals/learning/checks.ts
```
```bash
bun run evals/learning/run.ts --pipeline real --runs 10 --parallel 2 --judge-lv-only --plant-model --dump-packets --seed 90000
```
```bash
bun run evals/learning/run.ts --pipeline real --runs 5 --serial --fast-no 1500 --no-judge --plant-model --seed 91000
```
```bash
bun run evals/learning/chain.ts 3
```

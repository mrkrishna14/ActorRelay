# Counter-proposal eval

**Verdict.** Code enforces the bounds and nothing is hard-coded to 65. On `counter.ts` `2923f8b687` the demo lands on 65 in 24/24 runs and passes unanimously in 21/24. The 3 misses are one open bug, fix 2 below. Separately, code now picks the target but the label still credits the model, which must change before anyone shows it as agent reasoning.

## What ran
Real `agent/counter.ts` and `agent/vote.ts`, real actor `rankSimilar`, real `gpt-6-luna` effort none. Glue is an in-memory fixture, with no Terse, no Relay and no live sim. All voters ran on OpenAI, since Claude roles use the labelled fallback. History is the 300-event stand-in (`actor/tests/fixtures-gen/history.json`), because `shared/history.json` does not exist yet. "Physics" means the fitted coefficients in TASK2.MD, not the running tank model. Raw output is in the ignored `out/` folder.

Scenarios: the demo step 40 times, varied targets, LV-101 margins 5 to 25, steam, coil and multi-voter blockers, six history shapes, moved limits, two infeasible cases.

| | Earlier file | Patched copy, fixes 1-3 | Committed `48c61e517d` | On disk `2923f8b687` |
|---|---|---|---|---|
| Scenarios | 169 | 169 | 65 | 24, demo only |
| Real calls | 1,725 | 2,083 | 662 | 284 |
| Demo 50 to 85 unanimous | 36/40 | **40/40** | 36/40 | 21/24 |
| All pass within 2 counters | 107/169 | 144/169 | 51/65 | 21/24 |
| Got a first counter | 119/169 | 151/169 | 54/65 | 24/24 |
| Inside `from`..`to` | 121/121 | 174/174 | 54/54 | 24/24 |
| Clears every threshold (physics) | 121/121 | 174/174 | 54/54 | 24/24 |
| Unsafe counter voted through | 0 | 0 | 0 | 0 |
| Re-proposed value, or no-op at `from` | 0 | 0 | 0 | 0 |
| Third counter refused | none reached | 5/5 | none reached | none reached |
| Demo landing | 65 x29, 60 x9 | 65 x25, 60 x15 | 65 x21, 60 x18 | **65 x24** |
| Counter call p50 / p95 | 1.4 / 2.1 s | 1.5 / 2.2 s | 1.6 / 2.1 s | 1.4 / 1.7 s |
| Block to pass p50 / p95 | 4.1 / 5.9 s | 4.2 / 9.5 s | 4.5 / 5.7 s | 3.8 / 4.9 s |

`vote.ts` changed between columns, so read them as direction, not as a controlled trial. Counts of 144 and 51 include cases that should not pass (no history, infeasible). The rows are not all counted over the same set: "inside" and "clears" count every counter, including second ones. Latency was measured with the key under heavy load; no run measured it on a quiet key.

## Failure modes
| # | What happens | Where | Measured | Status |
|---|---|---|---|---|
| 1 | TK-101 predicts `tempC` 77 at 85, the doubled-margin ceiling falls below the 75 C setpoint, "no safe target" though 65 is safe | `counter.ts` `blockersOf` | 5/80 demo runs | Fixed by ar-agents, confirmed 24/24 got a counter |
| 2 | First counter blocked only by a failed voter (`predicted: {}`), so no blockers, a silent null, and the second counter never runs | `counter.ts` `buildCounter` | 3/24 on current file | **Open.** 40/40 with the fix on a patched copy. ar-learning saw 2/10 independently |
| 3 | The doubled margin leaves no candidate though physics has room: LV-101 m=20+, steam and coil m=25 | `counter.ts` | 25 scenarios, no counter | **Open.** All 25 got one with the fix. Not on the demo path |
| 4 | Model ignored "closest to the blocked target" and picked 60, sometimes stating "60 is closest" | prompt | 18/40 calls | Superseded: code now fixes the target |
| 5 | Code picks the value but `decidedBy` and "[answered by openai ...]" credit the model, and line 1 says the model picks it | `counter.ts:1,186,190` | Read in code | **Open.** Sent to ar-agents |
| 6 | At TK-101 margin 12+, `vote.ts` forces no on everything, while the actor floors at `limit.max` | `vote.ts` `thresholdFor` | 4/4 no counter | Open, owner's call |
| 7 | The actor's cap is per immediate parent, so only `agent/counter.ts` bounds a chain | `actor/src/logic/proposals.ts` | 5-link chain accepted | Open, low demo risk |
| 8 | A 429 throws at once, so a vote spends both attempts in about 1 s and becomes a safe no | `agent/llm.ts` | Read in code, 20/23 failures in ar-learning's run | Open. Keep the key clear during the demo |

Looked for and not found: values too timid to matter, values back at the blocked target, loops. With sparse history a counter stays blocked by design, because 75 C is within 15% of critical and the insufficient-history rule fires on TK-101.

A timing replay on real latencies (2 s sweep, 800 ms poll) shows the counter usually builds from partial votes, but LV-101's no was already in for 40/40 runs, so that needs no change. This ran on an earlier file.

OpenAI's usage-policy filter rejected 1 of about 6,000 calls on shipped prompts, a TV-101 vote. It counts as a failed attempt.

## Does code enforce the bounds?
Yes. `bounds.test.ts` runs real `agent/counter.ts` against a FAKE hostile model, 33/33 pass on `2923f8b687`: the blocked value, `from`, out-of-range, between-candidate, string, null, NaN, prose and thrown errors are all refused after one re-request, and a well-formed reply naming another candidate cannot move the target. It also covers downward proposals, the cap per root, a strictly safer second counter, duplicate delivery and status gating. Three tests pin open gaps, including 2 and 7, and will need updating when those close.

## Is it hard-coded to 65?
No. `counter.ts` has no literal 65, and the value comes from the voter's ceiling and history. Code's pick moves with margin (LV-101 m=5 gives 70, m=10 gives 65, m=15 gives 60), with moved limits (45 and 50) and with history shape (a gap gives 70). It is 65 in over 98% of resamples at 120+ events and 87% at 60, so on default margins viewers will keep seeing 65. That comes from the data, not a script. But it is code's decision, not the model's, and finding 5 is about saying so.

## Commands
Run from `agent/`. A full run spends about 2M tokens, so keep concurrency low and never run it during a proof, rehearsal or the demo.
```bash
bun run evals/counter/run.ts --impl real --concurrency 8 --tag myrun
```
```bash
bun run evals/counter/analyze.ts myrun
```
```bash
bun test evals/counter/bounds.test.ts
```
`--groups a,b` filters, `--partial` adds the timing replay, `--serial` runs one scenario at a time.

## Fix status
Diff for fixes 1 to 4 is in the session notes (`counter-fixes.diff`). Applied: 1. Superseded: 4. Open at 12:59: 2, 3, 5.

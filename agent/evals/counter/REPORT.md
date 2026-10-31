# Counter-proposal eval

**Verdict.** Code enforces the bounds and the counter is not hard-coded to 65. Before the fixes below, roughly 1 demo in 10 ends with no unanimous counter. Fix status is at the end.

## What ran
Real `agent/counter.ts` and `agent/vote.ts`, real actor `rankSimilar`, real `gpt-6-luna` effort none. Glue is an in-memory fixture, with no Terse, no Relay and no live sim. All voters ran on OpenAI, because Claude roles use the labelled fallback. History is the 300-event stand-in (`actor/tests/fixtures-gen/history.json`) because `shared/history.json` does not exist yet. "Physics" means the fitted coefficients in TASK2.MD, not the running tank model. Raw output is in the ignored `out/` folder.

169 blocked scenarios: the demo step 40 times, varied targets, LV-101 margins 5 to 25, steam, coil and multi-voter blockers, six history shapes, moved limits, and two infeasible cases.

| | Older `counter.ts` | Committed prompt + 3 fixes (patched copy) |
|---|---|---|
| Real calls | 1,725 | 2,083 |
| Demo 50 to 85 unanimous | 36/40 | 40/40 |
| All scenarios pass within 2 counters | 63% | 85% |
| Scenarios given a first counter | 107/169 | 149/169 |
| Counter strictly inside `from`..`to` | 121/121 | 174/174 |
| Counter clears every threshold (physics) | 121/121 | 174/174 |
| Unsafe counter voted through | 0 | 0 |
| Same value re-proposed, or no-op at `from` | 0 | 0 |
| Third counter refused | all | all |
| Code fallback used | 0 | 0 |
| Counter call p50 / p95 | 1.4 / 2.1 s | 1.5 / 2.2 s |
| Block to pass p50 / p95 | 4.1 / 5.9 s | 4.2 / 9.5 s |

The left column ran before ar-agents committed its prompt change, so it is indicative. The latencies were measured under heavy load on the shared key. The 85% counts the cases that should not pass (no history, infeasible) as failures.

## Failure modes
| # | What happens | Where | Measured |
|---|---|---|---|
| 1 | TK-101 predicts `tempC` 77 at 85, the doubled-margin ceiling becomes 68.85 (below the 75 C setpoint), so "no safe target" is reported though 65 is safe | `counter.ts:33` | 5/80 demo runs |
| 2 | A first counter blocked only by a failed voter (`predicted: {}`) yields no blockers, so `buildCounter` returns null silently and the second counter never runs | `counter.ts:162` | 2/40 and 2/15 runs |
| 3 | The doubled margin leaves no candidate at high margins though physics has room: LV-101 m=20 and 25, steam m=25, coil m=25 | `counter.ts:33` | 25 scenarios, no counter |
| 4 | The model ignores "closest to the blocked target", picks 60 and sometimes states a falsehood ("60 is closest") | `counter.ts:82` | 18/40 calls |
| 5 | At TK-101 margin 12 or more, `vote.ts` forces no on everything, while the actor floors its check at `limit.max`, so the two disagree | `vote.ts` `thresholdFor` | 4/4 no counter |
| 6 | The actor's cap is per immediate parent, so a chain is limited only by `agent/counter.ts` | `actor/src/logic/proposals.ts` | 5-link chain accepted |

Looked for and not found: values too timid to matter, values back at the blocked target, loops. A counter with sparse history stays blocked by design (the insufficient-history rule fires on TK-101 because 75 C is within 15% of critical).

A timing replay on real latencies (2 s sweep, 800 ms poll) shows the counter usually builds from partial votes, but LV-101's no was already in for 40/40 runs, so this needs no change.

## Does code enforce the bounds?
Yes. `bounds.test.ts` runs real `agent/counter.ts` against a FAKE hostile model, 32/32 pass: the blocked value, `from`, out-of-range, between-candidate, string, null, NaN, prose and thrown errors are all refused after one re-request. The value then comes from code and is labelled `[chosen by code`. It also covers downward proposals, the cap per root, a strictly safer second counter, duplicate delivery and status gating. Two tests pin known gaps, and one pins finding 6.

## Is it hard-coded to 65?
No. `counter.ts` has no literal 65, and the fallback is computed and labelled. The value comes from the voter's ceiling and history, not a constant. Landing moves with margin (LV-101 m=5 gives 70, m=10 gives 65, m=15 gives 60), with moved limits (45, 50, 75) and with history shape (a gap gives 70). Rationales were distinct in 172/174 cases and named real numbers. 65 is stable across resampled history (over 98% at 120+ events), so a viewer who only sees default margins sees 65 every time; that is a property of the data, not a script.

## Commands
```bash
bun run evals/counter/run.ts --impl real --concurrency 8 --tag myrun
```
```bash
bun run evals/counter/analyze.ts myrun
```
```bash
bun test evals/counter/bounds.test.ts
```
Run from `agent/`. A full run spends about 2M tokens, so keep concurrency low and do not run it during a proof or rehearsal. `--partial` adds the timing replay, `--serial` runs one scenario at a time, `--groups a,b` filters.

## Fix status
Fixes 1 to 4 were sent to ar-agents with a diff (shared notes, `counter-fixes.diff`). Re-run on the real file: pending.

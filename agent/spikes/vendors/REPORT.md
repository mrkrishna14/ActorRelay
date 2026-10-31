# Vendor paths for votes

Measured 2026-10-31, 12:24 to 12:41 Pacific, with other sessions running on the same OpenAI key and about 4 GB of RAM free. Every number below came from a live run, unless it is marked otherwise. Raw results are in `results/`.

## Recommendation

| Role | Components | Path | Label shown | 10 voters at once, p50 / p95 / max | Accuracy (ar-evals) |
|---|---|---|---|---|---|
| mechanic | P-100, LV-101 | Real `codex exec`, `gpt-6.1-terra` effort low, return on `turn.completed` | `codex` | 6.13 / 9.54 / 10.82 s, 20 of 20 | mechanic 97.3 % |
| process engineer, chemical engineer, safety | TK-101, E-101, TV-101 | Direct OpenAI Responses, `gpt-6.1-terra` effort low | `[GPT fallback]` and `answered by openai gpt-6.1-terra` | 3.27 / 5.82 / 6.97 s, 20 of 20 | 90.5 / 97.3 / 81.3 % |
| any voter, repeat bad proposal | proven no in `agent/vote.ts` | Evidence decides after `FAST_NO_MS`, whatever the model is doing | The existing "decided from retrieved evidence" prefix | 2.5 s wait, not model bound | n/a |

**Claude cannot fit.** The CLI has no headless login on this machine, so no Claude vote ran and no Claude latency exists. Main dropped the login at 12:35, so those three roles run on GPT and must say so on every vote and on their component card. Never show them as Claude.

**The result is one vendor with two paths.** `codex` and the fallback are both OpenAI, so the "at least two vendors" line in the plan is not true while Claude is off. Do not claim it in the pitch.

Accuracy figures are from ar-evals' baseline prompt on direct OpenAI. Accuracy through Codex, which adds its own system prompt, has not been swept; here LV-101 refused correctly 4 of 4 times on that path.

## Budget check

- **Every voter within 20s:** met by every recommended path. Worst seen: 10.82 s on Windows, about 15 s through WSL interop, and 13.89 s on `gpt-6-luna` while the key was rate limited.
- **Repeat bad proposal under 5s:** should be met in code rather than by a model, from reading `agent/vote.ts`; it was not run here. `FAST_NO_MS` 2500 plus the 2 s sweep is 4.5 s before any network hop, which is tight. Lowering it to 2000, or blocking as soon as a `no` lands, adds margin.

## All measurements

Ten voters at once from Windows unless stated. Strict JSON schema on all but the row marked. "Clean" means valid JSON that also passes the Vote contract check, with no invented ids.

| Path | Calls | Clean | p50 | p95 | Max | Over 5s |
|---|---|---|---|---|---|---|
| Direct `gpt-5.4-nano` | 30 | 30 | 2.05 s | 2.73 s | 3.18 s | 0 |
| Direct `gpt-6-luna` none | 30 | 29 | 2.77 s | 3.35 s | 4.52 s | 0 |
| Direct `gpt-6-luna` none, from WSL | 30 | 30 | 2.62 s | 3.67 s | 3.68 s | 0 |
| Direct `gpt-6-luna` none, 50 at once | 50 | 50 | 2.83 s | 3.80 s | 4.17 s | 0 |
| Direct `gpt-6.1-terra` low | 20 | 20 | 3.27 s | 5.82 s | 6.97 s | 3 |
| Direct `gpt-6.1-sol` low | 30 | 30 | 4.87 s | 8.81 s | 9.15 s | 13 |
| Direct `gpt-5.3-codex` low | 20 | 20 | 6.79 s | 12.67 s | 14.17 s | 18 |
| `codex exec` `gpt-6-luna` none, early return | 30 | 30 | 4.35 s | 6.14 s | 6.55 s | 9 |
| Same, no schema | 20 | 20 | 4.10 s | 5.90 s | 6.19 s | 6 |
| `codex exec` `gpt-6.1-terra` low, early return | 20 | 20 | 6.13 s | 9.54 s | 10.82 s | 17 |
| `codex exec` `gpt-5.3-codex` low, early return | 20 | 20 | 9.48 s | 11.19 s | 11.77 s | 20 |
| `codex exec` `gpt-6-luna` none, waiting for exit | 20 | 20 | 4.33 s | 12.77 s | 13.67 s | 7 |
| `claude -p` haiku | 10 | 0 | all failed at login | | 7.45 s to fail | |

A p95 from 20 calls is close to the second-worst sample, so treat those as rough. The one bad `gpt-6-luna` reply was unparseable JSON, which the existing retry in `agent/vote.ts` covers.

`gpt-5.4-nano` is the fastest path but scores 34.1 % in ar-evals, with 65.3 % on mechanics, so do not use it.

`gpt-6-luna` refused far more often than `gpt-6.1-terra` on the same ten voters: 51 of 59 votes against 18 of 40, across direct and Codex runs. That fits its higher false-no count in ar-evals, and it matters because a false no would block the safe counter-proposal in the demo.

## Findings

**Codex.** The answer arrives well before the process ends. One traced call finished its turn at 3.7 s and exited at 12.0 s. Waiting for exit is what produced the earlier 6.6 to 27.6 s results. The adapter returns on `turn.completed` and kills the child; no orphan was left on Windows. `gpt-5.4-nano` fails under Codex with a 400 because `tool_search` is unsupported.

**Claude.** `claude auth status` reports `loggedIn: false`. Every call fails with "OAuth session expired and could not be refreshed" from Windows, from WSL, and from WSL through `claude.exe`. `--bare` cannot read OAuth at all. Ten failing calls took 7.45 s against about 2.3 s for one, so cold start alone is that slow on this machine before any model time. No credential file was opened or copied, and no token was used outside the CLI.

**Gemini.** Also unusable. The CLI login is refused with `IneligibleTierError`: unsupported client.

**WSL.** Direct OpenAI matches Windows. `codex` in WSL fails because `@openai/codex-linux-x64` is missing, but the Windows `codex.exe` works through interop with `CODEX_BIN` set, which `adapter.ts` handles. It is slower: 5.8 to 6.1 s for one vote and 15.0 s for ten at once, from a single run. Run Codex voters from Windows Bun if that fits the Relay setup.

## Rate limits

- Limits read from response headers: 5,000 requests per minute on every model. 2M tokens per minute on `gpt-6-luna` and `gpt-5.4-nano`, 1M on `gpt-6.1-terra`, `gpt-6.1-sol` and `gpt-5.3-codex`.
- At 12:35 the key reached its 2M limit: 7 of 40 direct calls got a 429, with a wait hint of 20 to 39 ms. This was almost certainly the ar-evals sweep on the same key; that was not confirmed. Twenty seconds later a 50-call burst ran with no 429s.
- Codex retried by itself during that window. All 20 calls succeeded, but p95 rose to 12.67 s and max to 13.89 s.
- Those 429 runs used the priority tier. `gpt-6-luna` p50 fell to 1.99 s and `gpt-5.4-nano` did not improve, but the 429s disturbed the sample, so its benefit is unproven and it is not recommended.
- A Codex vote uses about 13,500 tokens against about 1,330 direct. A 10-voter proposal with four Codex voters uses about 62,000. On the 1M limit, five sessions each sending one proposal uses about 310,000.
- Sweeps must leave headroom during end-to-end runs and stop for the demo. `gpt-6.1-terra` showed as little as 450,526 tokens remaining during these tests.

## Files

- `adapter.ts`: `askLLM`, `callCodexExec` for `agent/llm.ts`, a 429 retry, `assertLabel`. No dependencies.
- `adapter.test.ts`: 10 tests pass from Windows Bun and from WSL Bun. Five use live vendors, two use a local fake server for 429 handling, and three are pure.
- `bench.mjs`, `vote-prompt.mjs`: the benchmark and its 10 prompts, built from `shared/plants.json` with synthetic events.
- `codex-trace.mjs`: per-event Codex timing.

Run: `bun test ./adapter.test.ts --timeout 40000`, or `node bench.mjs --path codex-terra-low-early --rounds 3`.

## Not measured

- Any real Claude latency, success rate, or rate limit behaviour.
- Accuracy through Codex across a full sweep.
- Five real sessions running proposals at once. The 50-call burst and the 12:35 saturation are the closest evidence.
- Votes through the real Relay and `agent/vote.ts`, including the proven-no path. These numbers cover the model call only.

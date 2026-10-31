# Stand-in seed history

**This is a stand-in, not the seed data.** `history.json` here exists so `actor/` and `agent/` can run before `shared/history.json` lands. Person 2 owns the real file, which comes from stepping the plant model. This one comes from the linear fit in `TASK2.MD` and the physics summary in `CLAUDE.MD`. Every id starts with `standin-` so it shows up in any evidence that cites it.

Prefer `shared/history.json` as soon as it exists. Do not pin ids or exact values from this file; the real file will differ. Assert ranges.

| File | Purpose |
|---|---|
| `history.json` | 300 `HistoryEvent`s as a top-level array: 180 plant-a, 120 plant-b |
| `gen-history.mjs` | Generator. Fixed seed, same bytes on every run |
| `validate-history.mjs` | Pass/fail list against `shared/types.ts`, `TASK2.MD` and the demo |
| `compare-history.ts` | Runs the real seed, retrieval, rule, vote and counter code on two files and lists every difference |

```bash
node actor/tests/fixtures-gen/gen-history.mjs
```

```bash
node actor/tests/fixtures-gen/validate-history.mjs
```

```bash
node actor/tests/fixtures-gen/validate-history.mjs shared/history.json
```

```bash
bun actor/tests/fixtures-gen/compare-history.ts actor/tests/fixtures-gen/history.json shared/history.json
```

The comparison uses a stub model that says yes and repeats the evidence estimate, so every `no` in its report came from code. Add `--llm` to use the real model router on the demo steps instead. It needs Bun because `agent/vote.ts` does, and it exits 1 on a vote, rule or counter difference.

The validator exits 1 if any check fails. Its compile check uses `actor/tests/contract/node_modules/typescript`, or the path in `TSC`, and prints SKIP if neither exists.

Demo retrieval is checked two ways. `REAL CODE` runs `rankSimilar`, `deriveRules`, `assertHistoryEvent` and the voter's estimates from `actor/src/logic` and `agent/retrieval.ts`, with no LLM, and prints SKIP if they cannot be loaded. `DEMO RETRIEVAL` runs a reference `similar()` written from `TASK1.MD` under 6 scorings, so a file does not depend on one normalization.

## What the fields mean

- Every event is a P-100 `speedPct` change. `proposalId` is `null` because these runs predate proposals.
- `upstreamSnapshot` is the state before the change: `feedM3h`, `headerBarg`, `feedTempC`.
- `effects` has 7 rows on the 4 other components in the same plant: TK-101 `levelPct` and `tempC`, LV-101 `positionPct`, E-101 `dutyKw`, TV-101 `positionPct`, `steamKgH` and `headerBarg`. There are no cross-plant rows, so plant-b/TV-101 has no row of its own in plant-a events.
- LV-101 `after` is the highest position in the 5-tick window and `ticksToSettle` is the tick it got there. Every other row is the value at tick 5.
- `incident` says only what the event's own rows show, the same way as `bridge/gen_history.ts`. A row at LV-101 80 or more reads `LV-101 reached 87.0%, past its 80% limit`. At 90 or more it adds `no control headroom`, and only a row at 100 says saturated. An alarm is claimed only if the level row reaches TK-101's 70% limit, which no row here does.

## Decisions worth checking against the real file

- **Temperature.** `TASK2.MD` says the dip is `0.05 x step`, which gives 0.75 °C for 50 to 65. `CLAUDE.MD` says about 2 °C. The file treats 0.05 as what is left at tick 5 and leaves the 2-4 °C peak to the physics summary, which also meets the `TASK2.MD` test that temperature is back within 1 °C by then.
- **Overshoot.** It scales with the step, `0.115 x step`, so 50 to 65 lands on 66.7 and 50 to 85 on 89, the demo's numbers. At speed 80 and above it stays in the summary's +3 to +5 range, and LV-101 is held to 85-91 for speeds 80-87.
- **Feed temperature.** Steam and duty scale by `(75 - feedTempC) / 50`, from the energy balance. This is not in `TASK2.MD`.
- **Header pressure.** TV-101 opens 3.6 points per bar of header loss. This is derived, not given: the fit implies an equal-percentage slope of 3.65-4.1 per unit of travel, and the header is about 7 bar absolute.

## Where model output disagreed with these decisions

`compare-history.ts` shows this file is off in two places against model output from `bridge/gen_history.ts` and from Person 2's separately built model. No demo vote changed. Trust model output over this file on these points:

- `tempC` rows from both models are the trough, about 71.2-71.5 °C after a step to 85. This file reads 73.2 °C, so the residual reading above is not what the models report.
- LV-101 overshoot at 80-87 averages +4.4 points here, against +3.4 from the bridge model and +1.9 from Person 2's.

The two models disagree on `headerBarg`: its rows move in the bridge file, as they do here, and stay flat in Person 2's.

## Keeping the demo retrievable

`similar()` returns 5 events, so the anchors in `gen-history.mjs` are deliberately thin around 85. Only 84 and 86 sit near it, then the incidents at 88 and 89, so 3 of the 5 nearest carry the incident. A third event inside 82-87 near the design point pushes an incident out. The validator catches that.

Plant-b stops at speed 74. LV-101 stays under 80 there, and 74 sits just outside the actor's relevance band for a proposal at 85 (15% of the 70-point range, so +/-10.5). `similar()` then returns nothing and the insufficient-history path can fire. Plant-b events at 75-79 would meet `TASK2.MD` but close that path, and the validator flags them.

`TV-101 headerBarg` is the only row a cross-plant voter can read, so every event must carry it.

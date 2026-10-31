# Bridge handoff (Person 2)

Two simulated TK-101 plants on one steam header, running live on `127.0.0.1:7300`, plus the seed history and the P&ID. TypeScript on Bun, no dependencies. `bridge/fallback.ts` is not in use and was not written, because the live sim is stable.

| File | Job |
|---|---|
| `tank_model.ts` | The model: states `h` and `T`, three PI loops, RK4, shared header, effect rows. Used by the two files below. |
| `live_sim.ts` | The HTTP service. Steps both plants in real time. |
| `gen_history.ts` | Writes `shared/history.json` by stepping the same model. |
| `run-wsl.sh` | Starts `live_sim.ts` inside WSL. |
| `tests/` | `model.test.ts` (no server), `live.test.ts` (real server, real time, fake glue), `measure_live.ts` (the table below). |
| `NOTICE.md` | Credit for the model design. |
| `web/public/pid-tk-101.svg` | P&ID, 1500x1000, `<g>` ids `P-100`, `TK-101`, `LV-101`, `E-101`, `TV-101`, transparent background. |

## Commands

Run it inside WSL, beside glue, actors and agents. WSL cannot reach a service on Windows `127.0.0.1`, and glue calls this one there. From PowerShell:

```powershell
wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/bridge/run-wsl.sh"
```

Ready line: `live sim on http://127.0.0.1:7300, 1 tick = 1000 ms = 18 scans = 180 simulated s`. Check it:

```bash
curl -s http://127.0.0.1:7300/health
```

Nothing is persisted. A restart comes back at the design point, so if it dies mid-demo, restart it and then reset through glue so the actors match.

Tests and history, from the repo root:

```bash
bun test bridge/tests/model.test.ts
bun test bridge/tests/live.test.ts --timeout 200000
bun run bridge/tests/measure_live.ts
bun run bridge/gen_history.ts
node actor/tests/fixtures-gen/validate-history.mjs shared/history.json
```

| Env | Default | Meaning |
|---|---|---|
| `BRIDGE_PORT` | `7300` | Port |
| `BRIDGE_HOST` | `127.0.0.1` | Bind address |
| `GLUE_URL` | `http://127.0.0.1:7200` | Where `/mirror` and `/observed` go |
| `BRIDGE_TICK_MS` | `1000` | Wall time per tick |
| `BRIDGE_PUSH_MIRROR` | on | `0` stops `/mirror` pushes, so glue polls `/snapshot` |

## Tick scaling

1 tick = 1 wall second = 18 controller scans of 10 s = 180 simulated seconds. Each scan runs 10 RK4 substeps of 1 s. The 5-tick observation window is 15 simulated minutes. Header pressure is recomputed before every scan, not every tick, because a once-a-tick step in pressure would put a sawtooth on steam flow.

## HTTP

| Route | Result |
|---|---|
| `GET /snapshot?plantId=plant-a` | `{componentId: metrics}` for 5 components. Without `plantId`, all 10. The tick is in the `x-bridge-tick` header. |
| `POST /setpoint {componentId, metric, value, proposalId}` | Applies the write. Returns `{ok, componentId, metric, value, applied, before, tick, proposalId, duplicate}`. |
| `POST /reset` | Both plants back to design, pending observations dropped. Returns `{ok, tick, snapshot}`. |
| `GET /health` | Tick, speeds, header, push counters. |
| `GET /writes` | The last 200 accepted writes. |

Sent to glue:

- `POST /mirror {componentId, metrics}` for all 10 components, every tick, 900 ms timeout. A batch is skipped if the last one is still in flight.
- `POST /observed {proposalId, effects}` 5 ticks after a write. Up to 4 attempts on a network error or 5xx. A 4xx is not retried.

Accepted writes: `P-100.speedPct` (0..100), `TK-101.levelPct` (5..95, sets `LIC-101.sp`), `TK-101.tempC` (30..95, sets `TIC-101.sp`). Anything else is a 400.

- `proposalId` is required. A repeat with the same values returns the first result with `duplicate: true`, and neither moves the plant nor starts a second observation. The same id with other values is a 409.
- POST needs no auth, but a request with a browser `Origin` header gets a 403, and `/setpoint` needs `application/json` (415 otherwise). Only glue should call this.

### Effect rows

Live `/observed` and `shared/history.json` come from the same function, `summarizeEffects`.

- 7 rows for the changed plant: `TK-101 levelPct, tempC`, `LV-101 positionPct`, `E-101 dutyKw`, `TV-101 positionPct, steamKgH, headerBarg`.
- `after` is the value at tick 5, except `LV-101 positionPct`, which is the furthest point reached in the direction of travel, so overshoot is not lost.
- `ticksToSettle` is the first tick from which the metric stays within 5 % of the move of `after`. A metric still moving reports 5. For `LV-101` it is the first tick inside that band.
- Live only: the other plant's `TV-101` rows that moved, normally `positionPct` and `headerBarg`. Its `steamKgH` stays put, because its controller holds it.
- P-100 has no row. It is the cause, and a row there would feed rule derivation.

## Measured numbers

Real `live_sim.ts` processes in WSL on Bun 1.4.4, at 1 tick = 1 s, stepped from the design point on plant-a and sampled every tick for 150 ticks (7.5 simulated hours). No late or dropped ticks. From `measure_live.ts`.

| Speed % | LV-101 steady % | LV-101 peak % (tick) | TV-101 % | Steam kg/h | Duty kW | Temp low °C (tick) | Dip °C | Back within 1 °C (tick) | Header barg | Plant-b TV-101 % |
|---|---|---|---|---|---|---|---|---|---|---|
| 50 | 49.95 | no step | 50.44 | 1532.9 | 898.5 | 75.00 | 0 | n/a | 6.000 | 50.44 |
| 65 | 64.94 | 66.53 (4) | 58.04 | 1979.0 | 1159.9 | 72.98 (3) | 2.02 | 8 | 5.777 | 51.29 |
| 85 | 84.91 | 88.11 (4) | 66.17 | 2573.7 | 1508.5 | 70.57 (3) | 4.43 | 13 | 5.480 | 52.48 |
| 100 | 99.90 | 100.00 (3) | 71.10 | 3000.0 | 1758.3 | 68.93 (3) | 6.07 | 15 | 5.267 | 53.36 |

At 100 the temperature settles at 74.67 °C: demand is 3020 kg/h and FIC-201 stops at 3000. Level peaks are 51.26 % at 65, 52.91 % at 85 and 54.12 % at 100, all at tick 2, and all return to 50 %.

### Against CLAUDE.MD

| CLAUDE.MD | Measured |
|---|---|
| LV-101 steady 64.9, 84.9, 99.9 | 64.94, 84.91, 99.90 |
| Overshoot +3 to +5 points, first ~10 minutes | **+1.6 at 65, +3.2 at 85**, peak at tick 4 (about 12 minutes) |
| Steam ~1,980, ~2,570, ~3,020 | 1,979, 2,574, 3,000 (demand 3,020, capped by the controller range) |
| Duty ~1,160, ~1,510 | 1,159.9, 1,508.5 |
| Dip ~2 °C, ~4 °C | 2.02, **4.43** |
| 15 → 26 m³/h: LV-101 ~87–90, dip to ~70.8 °C | 89.9, 70.5 (model test, no server) |
| 33 m³/h: LV-101 stuck at 100, 2.0 → 2.39 m in an hour | 100, 2.385 m (model test, no server) |
| Plant-a at 85 drops header 0.3–0.6 barg | 0.52 |

TV-101 runs above TASK2's linear fit (`0.36 × speed + 32.5` gives 55.9, 63.1, 68.5), because here the header falls as steam rises and the valve opens to make up for it.

## TASK2 test list

Against real `live_sim.ts`, fake glue. Windows Bun 1.3.14 and WSL Bun 1.4.4. The numbers are from the WSL run.

| Test | Result | Measured |
|---|---|---|
| 10 components, every tick, 60 s, no gaps | Pass | 60 of 60 ticks, 600 `/mirror` pushes, worst gap 1034 ms, 0 failed |
| 65: LV-101 settles 60–72 within 5 ticks | Pass | 66.38 at tick 5, peak 66.53 |
| 65: `tempC` back within 1 °C of 75 | **Not within 5 ticks** | 73.32 at tick 5, within 1 °C from tick 8 |
| 85: LV-101 ≥ 85 within 3 ticks | Pass | 83.39 at tick 2, 87.22 at tick 3 |
| 100: LV-101 = 100 and level rising | **Never both at once** | LV-101 at 100 from tick 3. Level rises to 54.12 % at tick 2, then falls |
| Plant-a at 85 lowers plant-b header, opens plant-b TV-101 | Pass | Header 6.000 → 5.484, TV-101 50.44 → 52.48 by tick 8 |
| History passes a zod check and every hard requirement | Pass | 300 of 300 on `historyEventSchema`, validator 51 passed, 0 failed |

Two lines do not hold as written, and `live.test.ts` asserts the measured behaviour instead of the literal line for both.

- **Temperature.** Recovery speed is set by the stated TIC-101 tuning (`ti` 900 s). The dip itself matches CLAUDE.MD, so there is nothing to retune without moving it. If the 1 °C line has to hold at tick 5 the tick would need to be longer. At 18 scans it does not.
- **Level at 100.** CLAUDE.MD's own numbers rule it out. LV-101 at 99.9 % passes 30 m³/h at 2.0 m, so with the valve at 100 % and the level above 2.0 m, outflow beats the feed and the level falls. It only climbs with the valve pinned when feed exceeds that capacity, which is the 33 m³/h case, and P-100 cannot reach that.

Beyond the list: `live.test.ts` also passes on reset, duplicate writes, a retry after a glue 500, bad writes refused, and a glue that stops answering `/mirror` (ticks keep running, pushes fail or skip, and recover when it answers again). The real glue client (`glue/bridge.ts`) and glue's body schemas were run once against a real `live_sim.ts`: snapshot, setpoint, reset, `/mirror` and `/observed` all fit, on a fake glue server.

## For `agent/physics.md`

Two sentences in the physics summary differ from the live plant. Suggested replacements:

- "with a transient overshoot of about +1.6 points at 65 and +3.2 points at 85 from a start at 50, peaking about 12 simulated minutes after the step."
- "From a start at 50, LV-101 touches 100 % above about 96.5 % pump speed. At 100 % it reaches 100 % by tick 3 and holds there until about tick 30, while the level, which peaked near 54 % at tick 2, falls back. TK-101 falls to 68.9 °C at tick 3, below its 70 °C minimum, and steam stops at 3,000 kg/h, so the temperature settles at 74.7 °C."

The dip at 85 is 4.4 °C, not 4 °C.

## Model constants

CLAUDE.MD gives the tuning, not the vessel. These are derived from its numbers, in `PARAMS` in `tank_model.ts`.

| Constant | Value | From |
|---|---|---|
| ρ·cp | 4183 kJ/m³K | Duty slope 17.43 kW per speed point at a 50 °C rise |
| Heat loss | 0.491 kW/K | Duty intercept 27 kW at 55 °C above ambient |
| Steam latent heat | 2110 kJ/kg | 1533 kg/h ↔ 898.5 kW |
| LV-101 capacity | 30 m³/h at 99.9 % and 2.0 m, flow ∝ position × √h | Steady positions |
| TV-101 | 10,000 kg/h fully open at 6 barg, rangeability 44 | 50.5 % at 1533 kg/h, slope of TASK2's fit |
| TV-101 pressure term | Flow ∝ absolute header pressure | **Our assumption.** CLAUDE.MD gives only the direction |
| Tank area | 3.2 m² | **Fitted.** Best compromise across the overshoot, the dips, the 33 m³/h climb and the tick limits. At 4 m² overshoot nears +4 points, but the peak moves out to tick 5 and the 33 m³/h climb stops at 2.37 m |
| FT-201 damping | 20 s on FIC-201's input | **Added by us, see below** |

## The temperature swing

TASK2 asked whether the 67–86 °C swing at high feed was real or a stepping bug. It is neither physics nor RK4. It is FIC-201 under a 10 s scan: steam follows the valve instantly, so the loop gain is `kc × flow × ln(rangeability)`, which passes the sampled stability limit of 0.92 at about 1,630 kg/h. Measured with no damping, after 4 simulated hours:

| Speed | Temperature °C | Steam kg/h | TV-101 % |
|---|---|---|---|
| 65 | 74.88–75.12 | 845–3,113 | 36.7–69.0 |
| 85 | 74.77–75.23 | 508–4,640 | 25.9–79.4 |
| 100 | 110.5–111.6 | 0–10,387 | 0–100 |

Steady to the printed decimals at 50, and at all four speeds with damping of 10 s or more. 5 s still swings at 100, so 20 s leaves a margin. The damping filters only what FIC-201 reads, so it adds no plant state, moves no steady state and leaves `FI-201` as the true flow.

## History

`shared/history.json`: 300 events, 180 plant-a, 120 plant-b, ids `hist-a-*` and `hist-b-*`, same bytes on every run. Starting speeds 30–90, header 5.23–6.50 barg, feed 21.1–29.0 °C.

Real model output: every number in `before`, `after`, `upstreamSnapshot` and `effects`.

Invented, and fictional by design: operators, approvers, dates, and the incident text.

- **Incident text.** TASK2 requires "LV-101 saturated at 100%, TK-101 high-level alarm LAH-101" on runs at 88–100. 18 events carry it, and only 4 of them show LV-101 at 100 in the row. The other 14 show the model's real 90.5–99.7. The model has no LAH-101 alarm, and the highest level in those rows is 52.9 %.
- **Chosen runs.** Anchor runs are placed so the demo retrieves what TASK2 asks for. Plant-a's only runs between 80 and 88 land on 81.5, 84 and 86, and each is a step big enough to peak at 85 or more. The rule "P-100 ≥ 80 → LV-101 ≥ 85" holds in this history, but not in the model at large: a small step from 78 to 82 peaks at 82.3.
- **30→70 and 35→71** are in because they really overshoot past 72.9 %, which is what keeps the counter on 65. The real `safeCandidates` and `bestCandidate` on this file pick 65, with LV-101 as a hand-built blocker and no model call.
- **Plant-b** stops at 74 so insufficient history can fire at 85.

## Not verified

Nothing here has run against glue's real server, the actors or the agents. Glue in `live.test.ts` is a fake.

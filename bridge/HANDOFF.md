# bridge/ HANDOFF (simulation)

Data/seed section: see [HANDOFF_DATA.md](HANDOFF_DATA.md). P&ID + fallback section: see [HANDOFF_PID.md](HANDOFF_PID.md).

## Run
```
python bridge/live_sim.py            # 127.0.0.1:7300, 1 tick per wall second
python bridge/live_sim.py --fast     # 1 tick every 0.05 s (tests/dev)
python -m unittest discover -s bridge/tests -p "test_bridge.py"   # ~1 s
python -m pytest bridge/tests -q                                  # all bridge tests, ~35 s (live HTTP e2e on 7310/7311)
SIM_LIVE_REALTIME=1 python -m pytest bridge/tests/test_sim_live.py -q -k realtime   # 60 s real-time mirror check (7312/7313)
```
Second instance without disturbing the demo: `GLUE_URL=http://127.0.0.1:7311 python bridge/live_sim.py --port 7310` (or `SIM_PORT=7310`).
CLI flags: `--fast` (0.05 s/tick), `--tick-seconds S` (overrides), `--port N`.
Env: `GLUE_URL` (default `http://127.0.0.1:7200`), `SIM_PORT` (7300), `SIM_TICK_S` (wall seconds per tick), `SIM_FAST=1`.
Glue pushes are best-effort on a background thread (mirrors coalesced per component, 0.3 s timeout, logged once per failure streak); the tick loop never blocks on glue.

## Tick scaling
Wall clock: 1 tick per wall second (default), 0.05 s with `--fast`/`SIM_FAST=1`, or `SIM_TICK_S`/`--tick-seconds`.
1 tick = 18 controller scans of 10 s = 180 simulated s (RK4, 1 s substeps). Header pressure
`clamp(6.0 - 0.0005 * (FI-201[a] + FI-201[b] - 3066), 4.5, 6.5)` is recomputed after every scan (gain 0.0005 kept: plant-a 50->85 drops the header 6.00 -> 5.52 barg after 5 ticks).

## Endpoints
- `GET /health` -> `{ok, tick, headerBarg, fast, plants}`
- `GET /snapshot[?plantId=plant-a]` -> `{"plant-a/P-100": {speedPct, feedM3h}, "plant-a/TK-101": {levelPct, tempC}, "plant-a/LV-101": {positionPct}, "plant-a/E-101": {dutyKw}, "plant-a/TV-101": {positionPct, steamKgH, headerBarg}, ...}` (10 components without plantId; 400 on unknown plant)
- `POST /setpoint {componentId, metric, value, proposalId}` -> `{proposalId, componentId, metric, value, previous, accepted:true, tick, at}`. Commandable: `P-100.speedPct` [20,100], `TK-101.levelPct` [20,70] (LIC-101 SP), `TK-101.tempC` [70,80] (TIC-101 SP). 400 on unknown component/metric, observed-only metric, or out of range. Idempotent on proposalId: a retry returns the original result and does not re-issue the command.
- `POST /reset` -> both plants to design SS (speed 50), clears results/observers/observations, tick=0.
- `GET /observed?proposalId=` -> 200 `{proposalId, effects[]}`, 202 `{pending:true, ticksRemaining}`, 404 unknown.
- Pushed to glue: `POST /mirror {componentId, metrics, lastTick, tick}` x10 every tick; `POST /observed {proposalId, effects:[{componentId, metric, before, after, ticksToSettle}]}` 5 ticks after each setpoint. `ticksToSettle` = first tick after which the metric stays within 5% of its total move of the tick-5 value.

## Real captured requests (instance on 127.0.0.1:7310, real-time, glue absent)
```
$ curl -s localhost:7310/health
{"ok": true, "tick": 2, "headerBarg": 5.999892503629847, "fast": false, "plants": ["plant-a", "plant-b"]}
$ curl -s "localhost:7310/snapshot?plantId=plant-a"
{"plant-a/P-100": {"speedPct": 50.0, "feedM3h": 15.0}, "plant-a/TK-101": {"levelPct": 50.0, "tempC": 75.00000366229138}, "plant-a/LV-101": {"positionPct": 49.93691957532115}, "plant-a/E-101": {"dutyKw": 898.3337083347592}, "plant-a/TV-101": {"positionPct": 50.143011153573546, "steamKgH": 1533.1074989201957, "headerBarg": 5.999892503629847}}
$ curl -s localhost:7310/snapshot
{"plant-a/P-100": {"speedPct": 50.0, "feedM3h": 15.0}, "plant-a/TK-101": {"levelPct": 50.0, "tempC": 75.00000366229138}, "plant-a/LV-101": {"positionPct": 49.93691957532115}, "plant-a/E-101": {"dutyKw": 898.3337083347592}, "plant-a/TV-101": {"positionPct": 50.143011153573546, "steamKgH": 1533.1074989201957, "headerBarg": 5.999892503629847}, "plant-b/P-100": {"speedPct": 50.0, "feedM3h": 15.0}, "plant-b/TK-101": {"levelPct": 50.0, "tempC": 75.00000366229138}, "plant-b/LV-101": {"positionPct": 49.93691957532115}, "plant-b/E-101": {"dutyKw": 898.3337083347592}, "plant-b/TV-101": {"positionPct": 50.143011153573546, "steamKgH": 1533.1074989201957, "headerBarg": 5.999892503629847}}
$ curl -s -X POST localhost:7310/setpoint -d {"componentId":"plant-a/P-100","metric":"speedPct","value":65,"proposalId":"demo-65"}
{"proposalId": "demo-65", "componentId": "plant-a/P-100", "metric": "speedPct", "value": 65.0, "previous": 50.0, "accepted": true, "tick": 3, "at": "2026-10-31T19:46:17.637116+00:00"}
$ (retry, same proposalId, value 85)
{"proposalId": "demo-65", "componentId": "plant-a/P-100", "metric": "speedPct", "value": 65.0, "previous": 50.0, "accepted": true, "tick": 3, "at": "2026-10-31T19:46:17.637116+00:00"}
$ curl -s "localhost:7310/observed?proposalId=demo-65"  (immediately)
{"proposalId": "demo-65", "pending": true, "ticksRemaining": 5}
$ curl -s "localhost:7310/observed?proposalId=demo-65"  (after 5 ticks)
{"proposalId": "demo-65", "effects": [{"componentId": "plant-a/P-100", "metric": "speedPct", "before": 50.0, "after": 65.0, "ticksToSettle": 1}, {"componentId": "plant-a/P-100", "metric": "feedM3h", "before": 15.0, "after": 19.5, "ticksToSettle": 1}, {"componentId": "plant-a/TK-101", "metric": "levelPct", "before": 50.0, "after": 50.61290924720261, "ticksToSettle": 5}, {"componentId": "plant-a/TK-101", "metric": "tempC", "before": 75.00000495084178, "after": 73.35130061788212, "ticksToSettle": 5}, {"componentId": "plant-a/LV-101", "metric": "positionPct", "before": 49.93691957532115, "after": 66.36709369467111, "ticksToSettle": 3}, {"componentId": "plant-a/E-101", "metric": "dutyKw", "before": 898.3335208844114, "after": 1153.756221004643, "ticksToSettle": 5}, {"componentId": "plant-a/TV-101", "metric": "positionPct", "before": 50.143005661530225, "after": 56.428411072156045, "ticksToSettle": 5}, {"componentId": "plant-a/TV-101", "metric": "steamKgH", "before": 1533.1071822092542, "after": 1966.1822175303885, "ticksToSettle": 5}, {"componentId": "plant-a/TV-101", "metric": "headerBarg", "before": 5.999892819292352, "after": 5.784159325340838, "ticksToSettle": 5}, {"componentId": "plant-b/TV-101", "metric": "positionPct", "before": 50.143005661530225, "after": 50.52531194234455, "ticksToSettle": 4}, {"componentId": "plant-b/TV-101", "metric": "steamKgH", "before": 1533.1071822092542, "after": 1531.3833221220038, "ticksToSettle": 5}, {"componentId": "plant-b/TV-101", "metric": "headerBarg", "before": 5.999892819292352, "after": 5.784159325340838, "ticksToSettle": 5}]}
$ curl -s "localhost:7310/observed?proposalId=nope"
{"error": "unknown proposalId 'nope'"} [HTTP 404]
$ 400 examples
-d {"componentId":"plant-a/P-999","metric":"speedPct","value":50,"proposalId":"x1"}
{"error": "unknown componentId 'plant-a/P-999'"} [HTTP 400]
-d {"componentId":"plant-a/LV-101","metric":"positionPct","value":50,"proposalId":"x2"}
{"error": "LV-101.positionPct is observed, not commandable"} [HTTP 400]
-d {"componentId":"plant-a/P-100","metric":"speedPct","value":120,"proposalId":"x3"}
{"error": "P-100.speedPct value must be a number in [20, 100]"} [HTTP 400]
$ curl -s -X POST localhost:7310/setpoint -d {"componentId":"plant-b/TK-101","metric":"tempC","value":77,"proposalId":"demo-temp"}
{"proposalId": "demo-temp", "componentId": "plant-b/TK-101", "metric": "tempC", "value": 77.0, "previous": 75.0, "accepted": true, "tick": 9, "at": "2026-10-31T19:46:23.997958+00:00"}
$ curl -s -X POST localhost:7310/reset
{"reset": true, "tick": 0, "snapshot": {"plant-a/P-100": {"speedPct": 50.0, "feedM3h": 15.0}, "plant-a/TK-101": {"levelPct": 50.0, "tempC": 75.0}, "plant-a/LV-101": {"positionPct": 49.93691957532115}, "plant-a/E-101": {"dutyKw": 898.3333333333331}, "plant-a/TV-101": {"positionPct": 50.14281771994589, "steamKgH": 1533.1079466773729, "headerBarg": 6.0}, "plant-b/P-100": {"speedPct": 50.0, "feedM3h": 15.0}, "plant-b/TK-101": {"levelPct": 50.0, "tempC": 75.0}, "plant-b/LV-101": {"positionPct": 49.93691957532115}, "plant-b/E-101": {"dutyKw": 898.3333333333331}, "plant-b/TV-101": {"positionPct": 50.14281771994589, "steamKgH": 1533.1079466773729, "headerBarg": 6.0}}}
```
Glue push bodies (captured by the test stub on 7311): `POST /mirror {"componentId":"plant-a/LV-101","metrics":{"positionPct":49.94},"lastTick":"2026-10-31T19:46:17Z","tick":3}` x10 per tick; `POST /observed` body is byte-identical to the `GET /observed` 200 body above.

## Measured steady state (single plant, header 6 barg, after 30 ticks; dip = min TI-101 after the step from 50)
| speed | LV-101 % (peak tick<=5) | TV-101 % | steam kg/h | duty kW | TI-101 min | level |
|---|---|---|---|---|---|---|
| 50 | 49.9 | 50.1 | 1533 | 898 | 75.00 | 2.00 m |
| 65 | ~65 (66.5) | 56.7 | 1979 | 1160 | 73.05 (dip 2.0) | 2.00 m |
| 85 | ~85 (88.1) | 63.4 | 2573 | 1508 | 70.68 (dip 4.3) | 2.00 m |
| 100 | 100 (saturated) | 67.2 | 3000 (FIC SP limit) | 1758 | 69.06, settles 74.6 | rising |
Temperature recovers to within 1 C of 75 about 8-10 ticks after the step (TIC-101 ti 900 s). These match the CLAUDE.MD physics summary. Re-measured 2026-10-31 on this branch (30 ticks, single plant): 50 -> LV 49.9 / TV 50.1 / 1533 kg/h / 898 kW / 75.00 C; 65 -> 64.9 (peak 66.5) / 56.7 / 1979 / 1160 / min 73.05; 85 -> 84.9 (peak 88.1) / 63.4 / 2573 / 1508 / min 70.68; 100 -> 100.0 / 67.2 / 3000 / 1758 / min 69.07.
**Note on 100 %:** LV-101 saturates (>= 99.9 % from tick 3) and the level climbs 50 -> 54.2 % in the first 2 ticks, but at exactly 30 m3/h the fully open valve still passes the whole feed, so the level then drifts back to 50 % (no sustained climb). Sustained rise only happens above the pump's 100 % limit (CLAUDE.MD's 33 m3/h case). Tracked as an xfail in `test_sim_live.py`.

## Temperature swing (67-86 C at feed >= 30 m3/h): finding
Not an RK4/stepping bug: the model follows a standard DCS scan loop. It is a loop-tuning instability: steam flow is quasi-steady, so FIC-201 sees a static gain ln(50)*W from the equal-percentage valve. With the original aggressive FIC tuning (kc 0.00015, ti 60 s) the per-scan loop gain kc*ln(R)*W exceeds 1 above ~1,700 kg/h, so the slave limit-cycles between valve stops (at 65 % steam already swung 1085-2872 kg/h; at 100 % TI-101 swung 67.6-86.1 C).
Fix: `TankPlant(fic_tuning="stable")` (default) uses FIC-201 kc 0.00003, ti 5 s, stable across 0-3000 kg/h. Steady states unchanged; transients now clean. `fic_tuning="aggressive"` restores the original fast tuning. Also fixed: `TankPlant(feed_m3h=..., header_barg=...)` now initialises the FIC SP/TIC output from the actual steady steam flow for that operating point (was always the design value).
**DATA: regenerate shared/history.json after merge** so TV-101 effects come from the stable tuning.

## Fallback
`bridge/fallback.ts` is NOT in use; live_sim is stable.

## Limitations
No noise, constant feed temp 25 C / ambient 20 C. Observations/idempotency are in memory (lost on restart). Single-process.

## Requirements checklist (TASK2.MD -> proof)
All in `bridge/tests/test_sim_live.py` (live server subprocess on 7310 + stub glue on 7311) unless noted.
| TASK2.MD item | Test | Result |
|---|---|---|
| Reader pushes /mirror for all 10 components every tick, 60 ticks no gaps | `test_reader_mirrors_10_components_60_ticks` (fast, 0.15 s/tick); `test_realtime_60s_no_gaps` (1 tick/s, 60 s, `SIM_LIVE_REALTIME=1`) | pass / pass |
| `GET /snapshot?plantId=` 5 components, without plantId 10; full metric mapping, sane ranges; feedM3h = 0.3 x speed | `test_snapshot_with_and_without_plant` | pass |
| P-100 -> 65: LV-101 60-72 within 5 ticks, TK-101 within 1 C of 75 | `test_setpoint_65` (+ `test_bridge.py`) | pass |
| Effects observer: 5 ticks, `/observed` + glue push with before/after/ticksToSettle | `test_setpoint_65`, `test_observed_pending_and_unknown` | pass |
| P-100 -> 85: LV-101 >= 85 within 3 ticks | `test_setpoint_85_and_shared_header` | pass |
| plant-a at 85 lowers plant-b headerBarg, plant-b TV-101 opens | `test_setpoint_85_and_shared_header` | pass |
| P-100 -> 100: LV-101 = 100 and level rising | `test_setpoint_100_saturates_level_rises` (saturates, level rises first 2 ticks); `test_setpoint_100_level_keeps_rising_while_saturated` | pass / xfail (model, see note) |
| Setpoint validation (400 unknown component/metric, observed-only, out of range, bad type, missing field); TK-101 level/temp SPs | `test_setpoint_400[*]`, `test_tank_setpoints_accepted` | pass |
| Idempotent retry on proposalId (identical body, no re-issue, one observation) | `test_idempotent_retry` | pass |
| `/reset` both plants to design SS | `test_reset_restores_design` | pass |
| history.json schema + hard requirements | `test_history_data.py`, `test_plants_data.py` | pass |


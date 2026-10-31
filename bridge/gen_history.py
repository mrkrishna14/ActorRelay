"""Generate deterministic synthetic events by stepping the live tank model."""
from __future__ import annotations

import json
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tank_model import TankPlant

ROOT = Path(__file__).resolve().parents[1]
OPS = ["Maya Chen", "Eli Brooks", "Noah Patel", "Sofia Reyes", "Avery Morgan", "Jordan Kim"]
ALARM = "LV-101 saturated at 100%, TK-101 high-level alarm LAH-101"


def _metrics(q: TankPlant) -> dict[str, dict[str, float]]:
    s = q.snapshot()
    return {
        "TK-101": {"levelPct": q.x[0] / 4 * 100, "tempC": s["TI-101"]},
        "LV-101": {"positionPct": q.u["LV-101"] * 100},
        "E-101": {"dutyKw": s["CALC-DUTY"]},
        "TV-101": {
            "positionPct": q.u["TV-101"] * 100,
            "steamKgH": s["FI-201"],
            "headerBarg": s["PI-201"],
        },
    }


SETTLE_HORIZON = 15  # ticks simulated after the step to measure settling


def settle_tick(series: list[float]) -> int:
    """First tick k such that every sample from k..horizon stays in band of the final value.

    series[0] is the pre-step value (tick 0); series[t] is the value after t ticks.
    Band = max(2 % of |final|, 0.5 units).
    """
    final = series[-1]
    band = max(0.02 * abs(final), 0.5)
    k = len(series) - 1
    while k > 0 and abs(series[k - 1] - final) <= band:
        k -= 1
    return k


def run_event(plant_id: str, index: int, speed: float, before_speed: float = 50.0,
              header: float = 6.0, feed_temp: float = 25.0) -> dict:
    """Precondition at the prior speed, step P-100, then simulate SETTLE_HORIZON ticks.

    before = metric at the step instant (after 144 preconditioning scans).
    after  = metric at tick 3 for LV-101 positionPct (the demo rule is a
             within-three-ticks observation) and at tick 5 for all others.
    ticksToSettle = settle_tick() over ticks 0..SETTLE_HORIZON.
    """
    q = TankPlant(feed_m3h=.3 * before_speed, header_barg=header)
    q.d["feed_temp"] = feed_temp
    q.set_speed(before_speed)
    for _ in range(18 * 8):
        q.scan()
    before_effects = _metrics(q)
    before_pump = q.speed_pct
    q.set_speed(speed)
    samples: dict[int, dict[str, dict[str, float]]] = {0: before_effects}
    for tick in range(1, SETTLE_HORIZON + 1):
        for _ in range(18):
            q.scan()
        samples[tick] = _metrics(q)

    effects = []
    for tag, metric_map in before_effects.items():
        for metric, initial in metric_map.items():
            sample_tick = 3 if tag == "LV-101" else 5
            series = [samples[t][tag][metric] for t in range(SETTLE_HORIZON + 1)]
            effects.append({
                "componentId": f"{plant_id}/{tag}",
                "metric": metric,
                "before": round(initial, 4),
                "after": round(samples[sample_tick][tag][metric], 4),
                "ticksToSettle": settle_tick(series),
            })

    stamp = datetime(2024, 1, 1, tzinfo=timezone.utc) + timedelta(days=index * 4 + (0 if plant_id == "plant-a" else 1))
    valve_at_tick_3 = next(row["after"] for row in effects
                           if row["componentId"].endswith("/LV-101") and row["metric"] == "positionPct")
    incident = ALARM if valve_at_tick_3 >= 99.9 else ("LV-101 no control headroom" if 80 <= speed <= 87 else None)
    approved = ["Shift Supervisor", "Process Safety"] if incident == ALARM else ["Shift Supervisor", "Board Operator"]
    return {
        "id": f"hist-{plant_id}-{index + 1:03d}",
        "at": stamp.isoformat().replace("+00:00", "Z"),
        "plantId": plant_id,
        "componentId": f"{plant_id}/P-100",
        "metric": "speedPct",
        "before": round(before_pump, 4),
        "after": float(speed),
        "upstreamSnapshot": {
            "feedM3h": round(.3 * before_pump, 4),
            "headerBarg": float(header),
            "feedTempC": float(feed_temp),
        },
        "effects": effects,
        "incident": incident,
        "approvedBy": approved,
        "operator": OPS[index % len(OPS)],
        "proposalId": None,
    }


def generate() -> list[dict]:
    rng = random.Random(20261031)
    # Plant A intentionally has dense coverage in each required retrieval band.
    speeds_a = (
        [100.0 for _ in range(8)] + [rng.uniform(88, 100) for _ in range(28)]
        + [rng.uniform(84, 87) for _ in range(44)]
        + [rng.uniform(60, 70) for _ in range(80)]
        + [rng.uniform(40, 59) for _ in range(40)]
    )
    speeds_b = [rng.uniform(40, 65) for _ in range(100)]
    rng.shuffle(speeds_a)
    rng.shuffle(speeds_b)

    events = []
    for plant_id, speeds in (("plant-a", speeds_a), ("plant-b", speeds_b)):
        for index, target in enumerate(speeds):
            before = rng.uniform(40, 70) if index else 50.0
            header = rng.uniform(5.3, 6.3)
            feed_temp = rng.uniform(22, 28)
            events.append(run_event(plant_id, index, target, before, header, feed_temp))

    out = ROOT / "shared" / "history.json"
    out.write_text(json.dumps(events, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(events)} events to {out}")
    return events


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    generate()

"""Reproducible loop-training fixtures from the actual coupled RK4 simulator.

These are simulated standalone experiments, not operator-approved live runs.
They supplement (and do not alter) the original pump history.
"""
import contextlib
import io
import json
from pathlib import Path
from live_sim import Simulator


def generate():
    events = []
    cases = [("TK-101", "levelPct", [45, 50, 55]), ("TK-101", "tempC", [74, 75, 76]),
             ("TV-101", "steamKgH", [1490, 1500, 1510, 1520, 1530, 1540, 1550, 1560, 1570])]
    for plant in ("plant-a", "plant-b"):
        for tag, metric, targets in cases:
            for target in targets:
                sim = Simulator(fast=True, push=False)
                before = sim.snapshot()
                cid = f"{plant}/{tag}"
                pid = f"seed-loop-{plant}-{metric}-{target}"
                with contextlib.redirect_stdout(io.StringIO()):
                    result = sim.command(cid, metric, target, pid)
                    for _ in range(15): sim.step()
                after = sim.snapshot()
                # Keep unchanged measurements too: the experiment also shows unaffected peers.
                effects = [{"componentId": key, "metric": name, "before": old,
                            "after": after[key][name], "ticksToSettle": 15}
                           for key, values in before.items() for name, old in values.items()
                           if name not in {"levelSetpointPct", "tempSetpointC", "steamSetpointKgH", "steamFlowLocal"}]
                events.append({"id": pid, "at": "2026-10-30T12:00:00Z", "plantId": plant,
                               "componentId": cid, "metric": metric, "before": result["previous"],
                               "after": target, "upstreamSnapshot": {"feedM3h": 15, "headerBarg": 6},
                               "effects": effects, "incident": None, "approvedBy": [],
                               "operator": "generated loop simulation fixture", "proposalId": pid})
    return events


if __name__ == "__main__":
    output = Path(__file__).resolve().parents[1] / "shared" / "loop-history.json"
    output.write_text(json.dumps(generate(), indent=2) + "\n")
    print(f"Wrote simulated loop experiments to {output}")

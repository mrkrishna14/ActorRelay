"""The plant/ implementation reproduces the recorded golden behaviour."""
import json
import statistics
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from tank_model import TankPlant  # noqa: E402

GOLDEN = json.loads((HERE / "golden_steady.json").read_text())


def close_steady(case, got, want, label):
    for tag, metrics in want.items():
        for metric, value in metrics.items():
            g = got[tag][metric]
            tol = 0.2 if metric == "tempC" else max(abs(value) * 0.005, 1e-6)
            case.assertLessEqual(abs(g - value), tol, f"{label} {tag}.{metric}: {g} vs {value}")


class TestGolden(unittest.TestCase):
    def test_steady_states(self):
        for speed, want in GOLDEN["steady"].items():
            q = TankPlant(); q.set_speed(float(speed))
            for _ in range(30): q.tick()
            close_steady(self, q.metrics(), want, f"speed {speed}")

    def test_step_trajectories(self):
        for name, traj in GOLDEN["steps"].items():
            q = TankPlant(); q.set_speed(float(name.split("to")[1]))
            for i, want in enumerate(traj):
                q.tick(); got = q.metrics()
                for tag, metrics in want.items():
                    for metric, value in metrics.items():
                        # 1.5 points for percentages/degC; scale-relative for kW, kg/h
                        tol = 1.5 if abs(value) < 200 else abs(value) * 0.015
                        self.assertLessEqual(abs(got[tag][metric] - value), tol,
                                             f"{name} tick {i + 1} {tag}.{metric}")

    def test_step_to_100_saturates_without_oscillation(self):
        q = TankPlant(); q.set_speed(100); start = q.x[0]
        steam, lv, level = [], [], []
        for _ in range(20):
            q.tick(); steam.append(q.metrics()["TV-101"]["steamKgH"])
            lv.append(q.u["LV-101"] * 100); level.append(q.x[0])
        self.assertEqual(max(lv), 100.0)          # pinned at the stop
        self.assertGreaterEqual(min(lv[2:]), 99.8)  # and stays there
        self.assertGreater(min(level), start)       # level rises above SP
        self.assertLess(statistics.pstdev(steam[-10:]), 20.0)


if __name__ == "__main__":
    unittest.main()

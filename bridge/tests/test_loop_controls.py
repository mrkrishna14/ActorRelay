import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tank_model import TankPlant
from live_sim import Simulator


class LoopControlTests(unittest.TestCase):
    def test_local_flow_is_auto_and_preserves_pv_until_model_advances(self):
        q = TankPlant()
        before = q.metrics()["TV-101"]["steamKgH"]
        q.set_steam_sp(1700)
        self.assertEqual(q.metrics()["TV-101"]["steamKgH"], before)
        self.assertEqual(q.metrics()["TV-101"]["steamSetpointKgH"], 1700)
        self.assertFalse(q.loops["FIC-201"].manual)
        for _ in range(5): q.tick()
        self.assertEqual(q.loops["FIC-201"].sp, 1700)
        self.assertLess(abs(q.metrics()["TV-101"]["steamKgH"] - 1700), 5)
        self.assertGreater(q.metrics()["TK-101"]["tempC"], 75)
        q.set_temperature_sp(75)
        self.assertEqual(q.metrics()["TV-101"]["steamFlowLocal"], 0)
        for _ in range(15): q.tick()
        self.assertLess(abs(q.metrics()["TK-101"]["tempC"] - 75), .5)

    def test_level_and_temperature_setpoints_drive_actual_model(self):
        q = TankPlant()
        q.set_level_sp(2.4)
        q.set_temperature_sp(76)
        self.assertEqual(q.metrics()["TK-101"]["levelPct"], 50)
        self.assertEqual(q.metrics()["TK-101"]["tempC"], 75)
        for _ in range(25): q.tick()
        self.assertAlmostEqual(q.metrics()["TK-101"]["levelPct"], 60, delta=.5)
        self.assertAlmostEqual(q.metrics()["TK-101"]["tempC"], 76, delta=.5)

    def test_simulator_loop_allowlist_and_distinct_targets(self):
        sim = Simulator(fast=True, push=False)
        result = sim.command("plant-a/TV-101", "steamKgH", 1530, "loop")
        self.assertTrue(result["accepted"])
        self.assertEqual(sim.snapshot()["plant-a/TV-101"]["steamSetpointKgH"], 1530)
        for value in (-1, 3001, float("nan")):
            with self.assertRaises(ValueError): sim.command("plant-a/TV-101", "steamKgH", value, f"bad{value}")


if __name__ == "__main__": unittest.main()

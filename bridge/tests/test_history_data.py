import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "bridge"))

from contract import HistoryEvent


ALARM = "LV-101 saturated at 100%, TK-101 high-level alarm LAH-101"


def read_events():
    return [HistoryEvent.model_validate(row) for row in json.loads((ROOT / "shared/history.json").read_text(encoding="utf-8"))]


def lv_effect(event):
    return next(effect for effect in event.effects if effect.componentId.endswith("/LV-101") and effect.metric == "positionPct")


class HistoryDataTests(unittest.TestCase):
    def test_history_validates_and_has_realistic_coverage(self):
        events = read_events()
        self.assertGreaterEqual(len(events), 280)
        self.assertLessEqual(len(events), 320)
        self.assertEqual(len({event.id for event in events}), len(events))
        for event in events:
            datetime.fromisoformat(event.at.replace("Z", "+00:00"))
            self.assertEqual(event.componentId, f"{event.plantId}/P-100")
            self.assertEqual({effect.componentId.rsplit("/", 1)[1] for effect in event.effects}, {"TK-101", "LV-101", "E-101", "TV-101"})
            for effect in event.effects:
                self.assertIn(effect.ticksToSettle, range(0, 16))
            self.assertEqual(event.upstreamSnapshot.keys(), {"feedM3h", "headerBarg", "feedTempC"})

        a = [event for event in events if event.plantId == "plant-a"]
        b = [event for event in events if event.plantId == "plant-b"]
        saturated = [event for event in a if 88 <= event.after <= 100 and event.incident == ALARM and lv_effect(event).after >= 90]
        supported = [event for event in a if 80 <= event.after <= 87 and 85 <= lv_effect(event).after <= 91]
        safe = [event for event in a if 60 <= event.after <= 70 and event.incident is None and 60 <= lv_effect(event).after <= 73]
        self.assertGreaterEqual(len(saturated), 3)
        self.assertGreaterEqual(len(supported), 3)
        self.assertGreaterEqual(len(safe), 5)
        self.assertFalse(any(event.after >= 80 for event in b))
        self.assertGreaterEqual(sum(40 <= event.after <= 65 for event in b), 20)

    def test_history_provenance_and_settling_are_sane(self):
        events = read_events()
        self.assertEqual(len({event.id for event in events}), len(events))
        lo = datetime(2024, 1, 1, tzinfo=timezone.utc)
        hi = datetime(2026, 12, 31, 23, 59, 59, tzinfo=timezone.utc)
        settles = set()
        for event in events:
            at = datetime.fromisoformat(event.at.replace("Z", "+00:00"))
            self.assertTrue(lo <= at <= hi, event.at)
            self.assertRegex(event.id, r"^hist-plant-[ab]-\d{3}$")
            self.assertTrue(event.approvedBy)
            self.assertTrue(all(isinstance(name, str) and name.strip() for name in event.approvedBy))
            self.assertTrue(event.proposalId is None or (isinstance(event.proposalId, str) and event.proposalId.strip()))
            self.assertTrue(event.operator is None or (isinstance(event.operator, str) and len(event.operator.split()) >= 2))
            for effect in event.effects:
                self.assertIsInstance(effect.ticksToSettle, int)
                self.assertGreaterEqual(effect.ticksToSettle, 0)
                self.assertLessEqual(effect.ticksToSettle, 15)
                settles.add(effect.ticksToSettle)
        self.assertGreater(len(settles), 1, "ticksToSettle must be measured, not constant")

    def test_settle_tick_definition(self):
        from gen_history import settle_tick

        self.assertEqual(settle_tick([10.0] * 16), 0)
        self.assertEqual(settle_tick([0.0, 50.0, 99.0] + [100.0] * 13), 2)
        self.assertEqual(settle_tick([0.0, 100.0, 50.0] + [100.0] * 13), 3)

    def test_history_generation_is_deterministic(self):
        from gen_history import generate

        output = ROOT / "shared/history.json"
        before = output.read_bytes()
        generate()
        self.assertEqual(output.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()

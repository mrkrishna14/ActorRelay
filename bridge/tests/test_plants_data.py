import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "bridge"))

from contract import CompanyState, PlantsSeed


class PlantsDataTests(unittest.TestCase):
    def test_plants_match_frozen_component_table_and_company_shape(self):
        data = json.loads((ROOT / "shared/plants.json").read_text(encoding="utf-8"))
        seed = PlantsSeed.model_validate(data)
        self.assertEqual([plant.id for plant in seed.plants], ["plant-a", "plant-b"])
        self.assertTrue(all(len(plant.components) == 5 for plant in seed.plants))
        expected = {
            "P-100": ("Feed pump", "feed-pump-A", "mechanic", "codex", {"speedPct": (20, 90, 95)}),
            "TK-101": ("Hydrolysis hold tank", "hold-tank-A", "process_engineer", "claude", {"levelPct": (20, 70, 80), "tempC": (70, 80, 90)}),
            "LV-101": ("Outlet level valve", "outlet-valve-A", "mechanic", "codex", {"positionPct": (10, 80, 90)}),
            "E-101": ("Steam coil", "steam-coil-A", "chemical_engineer", "claude", {"dutyKw": (300, 1600, 1800)}),
            "TV-101": ("Steam valve (FIC-201)", "steam-valve-A", "safety", "claude", {"positionPct": (5, 85, 95), "steamKgH": (0, 2700, 3000)}),
        }
        self.assertEqual(len(seed.components), 10)
        for component in seed.components:
            self.assertEqual(component.id, f"{component.plantId}/{component.tag}")
            name, model, role, vendor, limits = expected[component.tag]
            self.assertEqual((component.name, component.model, component.role, component.vendor), (name, model, role, vendor))
            self.assertEqual(component.marginPct, 10)
            self.assertEqual(component.status, "ok")
            self.assertTrue(component.lastTick.endswith("Z"))
            self.assertEqual(set(component.limits), set(limits))
            for metric, wanted in limits.items():
                limit = component.limits[metric]
                self.assertEqual((limit.min, limit.max, limit.critical), wanted)

        shared = seed.sharedResources
        self.assertEqual(len(shared), 1)
        self.assertEqual(shared[0].id, "steam-header-1")
        self.assertEqual(shared[0].components, ["plant-a/TV-101", "plant-b/TV-101"])
        company = CompanyState.model_validate({
            "plants": [plant.id for plant in seed.plants],
            "sharedResources": [item.model_dump() for item in shared],
            "rules": [], "crossPlantProposals": [], "audit": [],
        })
        self.assertEqual(company.plants, ["plant-a", "plant-b"])


if __name__ == "__main__":
    unittest.main()

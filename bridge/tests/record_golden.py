"""Record bridge/tests/golden_steady.json from the current TankPlant (run once)."""
import json, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from tank_model import TankPlant

def main():
    out = {"steady": {}, "steps": {}}
    for sp in (50, 65, 85, 100):
        q = TankPlant(); q.set_speed(sp)
        for _ in range(30): q.tick()
        out["steady"][str(sp)] = q.metrics()
    for sp in (85, 65):
        q = TankPlant(); q.set_speed(sp)
        traj = []
        for _ in range(10):
            q.tick(); traj.append(q.metrics())
        out["steps"][f"50to{sp}"] = traj
    (HERE / "golden_steady.json").write_text(json.dumps(out, indent=1))

if __name__ == "__main__":
    main()

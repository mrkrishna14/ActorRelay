"""TankPlant adapter around the TK-101 hold tank model in ``plant/``.

One ``scan()`` = one 10 s DCS scan, executed as a standard DCS scan loop: read signals once, step controllers in cascade order
(TIC-101 master writes the FIC-201 setpoint, then FIC-201 and LIC-101 move their
valves), then integrate 10 s with RK4 (1 s substeps) holding the valves.

Public interface (used by live_sim.py and gen_history.py; keep it stable):
``TankPlant(feed_m3h=15, header_barg=6, fic_tuning="stable")``, attributes
``unit, speed_pct, d, x, u, loops, sim_time``, methods ``set_speed``,
``set_temperature_sp``, ``set_level_sp``, ``set_header``, ``scan``, ``tick``,
``snapshot``, ``metrics``, ``reset``.

FIC-201 tuning note (see bridge/HANDOFF.md, "Temperature swing"): steam flow is
quasi-steady in this model, so the FIC-201 slave sees a pure static gain
``dW/dx = ln(R) * W`` from the equal-percentage valve. With the original aggressive
tuning (kc 0.00015 /(kg/h), ti 60 s) the discrete loop gain ``kc * ln(R) * W``
exceeds 1 once steam passes ~1,700 kg/h, which makes the slave loop unstable
scan-to-scan; it limit-cycles between the valve stops and drags TI-101 into a
67-86 degC swing at high feed. ``fic_tuning="stable"`` (default) uses
kc 0.00003, ti 5 s, which keeps the slave stable over its whole 0-3000 kg/h
range while leaving every steady state unchanged. ``"aggressive"`` keeps the
original fast tuning.
"""
from __future__ import annotations

import numpy as np

from plant.unit import DESIGN_INPUTS, FIC_TUNINGS, TK101

SCAN_S = 10.0          # controller scan, s
SUBSTEPS = 10          # RK4 substeps per scan (1 s each)
SCANS_PER_TICK = 18    # 1 live tick = 180 simulated seconds
FIC_SP_RANGE = 3000.0  # TIC-101 output 0..1 maps to FIC-201 SP 0..3000 kg/h
TANK_HEIGHT_M = 4.0


def speed_to_feed_m3h(speed_pct: float) -> float:
    return 0.3 * speed_pct


class TankPlant:
    def __init__(self, feed_m3h: float = 15.0, header_barg: float = 6.0,
                 fic_tuning: str = "stable", level_m: float = 2.0, temp_c: float = 75.0):
        if fic_tuning not in FIC_TUNINGS:
            raise ValueError(f"fic_tuning must be one of {sorted(FIC_TUNINGS)}")
        self.fic_tuning = fic_tuning
        self.unit = TK101()
        self.speed_pct = feed_m3h / .3
        self.d = {"feed_flow": feed_m3h / 3600, "feed_temp": DESIGN_INPUTS["feed_temp"],
                  "T_amb": DESIGN_INPUTS["T_amb"], "steam_header_P": header_barg}
        self.x = np.array([float(level_m), float(temp_c)])
        # Valve outputs that hold this exact operating point, then bumpless loops.
        self.u = self.unit.steady_inputs({"LI-101": level_m, "TI-101": temp_c}, self.d)
        self.loops = self.unit.build_loops(self.x, self.u, self.d, fic_tuning)
        self.loops["TIC-101"].sp = temp_c
        self.loops["LIC-101"].sp = level_m
        self.sim_time = 0.

    # -- commands ---------------------------------------------------------
    def set_speed(self, speed: float):
        self.speed_pct = float(speed)
        self.d["feed_flow"] = .3 * self.speed_pct / 3600

    def set_temperature_sp(self, value: float): self.loops["TIC-101"].sp = float(value)
    def set_level_sp(self, value: float): self.loops["LIC-101"].sp = float(value)
    def set_header(self, barg: float): self.d["steam_header_P"] = float(barg)

    # -- stepping ---------------------------------------------------------
    def scan(self):
        """One 10 s DCS scan: cascade controllers, then RK4 with valves held."""
        self.x = self.unit.scan(self.x, self.u, self.d, self.loops)
        self.sim_time += SCAN_S

    def tick(self, scans: int = SCANS_PER_TICK):
        for _ in range(scans): self.scan()

    # -- observables ------------------------------------------------------
    def snapshot(self):
        return self.unit.signals(self.sim_time, self.x, self.u, self.d)

    def metrics(self) -> dict[str, dict[str, float]]:
        """Metrics keyed by bare tag, exact TASK2 mapping."""
        s = self.snapshot()
        return {
            "P-100": {"speedPct": self.speed_pct, "feedM3h": speed_to_feed_m3h(self.speed_pct)},
            "TK-101": {"levelPct": s["LI-101"] / TANK_HEIGHT_M * 100, "tempC": s["TI-101"]},
            "LV-101": {"positionPct": self.u["LV-101"] * 100},
            "E-101": {"dutyKw": s["CALC-DUTY"]},
            "TV-101": {"positionPct": self.u["TV-101"] * 100, "steamKgH": s["FI-201"],
                       "headerBarg": s["PI-201"]},
        }

    def reset(self, speed: float | None = None):
        """Back to the design steady state (level 2.0 m, 75 degC, 15 m3/h, 6 barg).

        ``speed`` None keeps the old behaviour of re-applying the current pump
        speed after the reset; pass 50 for a full design reset.
        """
        keep = self.speed_pct if speed is None else speed
        self.__init__(feed_m3h=15., header_barg=6., fic_tuning=self.fic_tuning)
        self.set_speed(keep)

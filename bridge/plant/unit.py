"""TK-101 unit: TIC-101 -> FIC-201 temperature/steam cascade and LIC-101 level loop.
"""
from __future__ import annotations

import numpy as np

from . import hold_tank
from .controllers import LoopTuning, PIController

SCAN_S = 10.0
RK4_STEPS_PER_SCAN = 10
STEAM_SP_SPAN_KG_H = 3000.0   # TIC-101 output 0..1 -> FIC-201 SP 0..3000 kg/h

DESIGN_INPUTS = {"feed_flow": 15.0 / 3600.0, "feed_temp": 25.0, "T_amb": 20.0, "steam_header_P": 6.0}

TIC_TUNING = (0.045, 900.0)    # kc /degC, ti s
LIC_TUNING = (2.0, 600.0)      # kc /m, ti s (direct acting)
FIC_TUNINGS = {"aggressive": (0.00015, 60.0), "stable": (0.00003, 5.0)}


class TK101:
    """Process model for the hold tank; holds only its parameters."""

    def __init__(self, params: hold_tank.TankParams | None = None):
        self.params = params or hold_tank.TankParams()

    def derivatives(self, t, x, u, d, p=None):
        return hold_tank.rates(x, u, d, p or self.params)

    def signals(self, t, x, u, d, p=None):
        return hold_tank.measurements(x, u, d, p or self.params)

    def steady_inputs(self, targets, d, p=None):
        return hold_tank.holding_valves(targets["LI-101"], targets["TI-101"], d, p or self.params)

    def build_loops(self, x, u, d, fic: str = "stable") -> dict[str, PIController]:
        """Controllers initialised bumpless at the current operating point."""
        sig = self.signals(0.0, x, u, d)
        steam = sig["FI-201"]
        fkc, fti = FIC_TUNINGS[fic]
        return {
            "TIC-101": PIController(LoopTuning("TIC-101", *TIC_TUNING, sp=sig["TI-101"], reverse=True),
                                    output=steam / STEAM_SP_SPAN_KG_H),
            "FIC-201": PIController(LoopTuning("FIC-201", fkc, fti, sp=steam, reverse=True),
                                    output=u["TV-101"]),
            "LIC-101": PIController(LoopTuning("LIC-101", *LIC_TUNING, sp=sig["LI-101"], reverse=False),
                                    output=u["LV-101"]),
        }

    def scan(self, x, u, d, loops, steam_flow_local=False) -> np.ndarray:
        """One DCS scan: controllers in cascade order (``u`` updated in place), then integrate."""
        sig = self.signals(0.0, x, u, d)
        if not steam_flow_local:
            master = loops["TIC-101"].step(sig["TI-101"], SCAN_S)
            loops["FIC-201"].sp = master * STEAM_SP_SPAN_KG_H
        u["TV-101"] = loops["FIC-201"].step(sig["FI-201"], SCAN_S)
        u["LV-101"] = loops["LIC-101"].step(sig["LI-101"], SCAN_S)
        return hold_tank.rk4(x, u, d, self.params, SCAN_S / RK4_STEPS_PER_SCAN, RK4_STEPS_PER_SCAN)

"""Hold tank with a steam coil: level and temperature balances plus RK4 integration.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .steam import latent_heat_j_kg, saturation_temp_c
from .valves import equal_percentage, equal_percentage_travel

LEVEL_FLOOR_M = 1e-3


@dataclass
class TankParams:
    area_m2: float = 3.14
    height_m: float = 4.0
    density: float = 1000.0          # kg/m3
    heat_capacity: float = 4180.0    # J/kg/K
    outlet_cv: float = 0.0059        # m3/s per unit opening per sqrt(m)
    coil_ua: float = 72000.0         # W/K at full steam valve, clean coil
    steam_rangeability: float = 50.0
    design_steam_kg_s: float = 0.426
    loss_ua: float = 500.0           # W/K to ambient
    trap_subcool_k: float = 5.0
    flood_subcool_k: float = 40.0
    fouling: float = 1.0             # surviving fraction of clean UA
    flooded: float = 0.0             # coil fraction backed up with condensate
    blowthrough: float = 0.0         # fraction of design steam bypassing the coil
    leak_cv: float = 0.0             # m3/s per sqrt(m)
    purity_peak_c: float = 78.0
    purity_curve: float = 0.02


def coil_ua(opening: float, p: TankParams) -> float:
    return p.coil_ua * p.fouling * (1.0 - p.flooded) * equal_percentage(opening, p.steam_rangeability)


def coil_heat_w(temp_c: float, opening: float, header_barg: float, p: TankParams) -> float:
    """Coil heat into the liquid; zero when the liquid is hotter than the steam."""
    dt = saturation_temp_c(header_barg) - temp_c
    return coil_ua(opening, p) * dt if dt > 0.0 else 0.0


def outflow_m3s(level_m: float, opening: float, p: TankParams) -> float:
    return p.outlet_cv * max(opening, 0.0) * math.sqrt(max(level_m, LEVEL_FLOOR_M))


def rates(state, valves: dict, inputs: dict, p: TankParams) -> np.ndarray:
    """d[level, temp]/dt for valve openings ``valves`` and disturbances ``inputs``."""
    level = max(state[0], LEVEL_FLOOR_M)
    temp = state[1]
    vol = p.area_m2 * level
    q_in = inputs["feed_flow"]
    q_out = outflow_m3s(level, valves["LV-101"], p) + p.leak_cv * math.sqrt(level)
    heat = (coil_heat_w(temp, valves["TV-101"], inputs["steam_header_P"], p)
            - p.loss_ua * (temp - inputs["T_amb"]))
    d_level = (q_in - q_out) / p.area_m2
    d_temp = q_in * (inputs["feed_temp"] - temp) / vol + heat / (p.density * p.heat_capacity * vol)
    return np.array((d_level, d_temp))


def rk4(state, valves: dict, inputs: dict, p: TankParams, dt: float, steps: int) -> np.ndarray:
    """Integrate ``steps`` classic Runge-Kutta steps of ``dt`` with valves held."""
    x = np.asarray(state, dtype=float)
    for _ in range(steps):
        a = rates(x, valves, inputs, p)
        b = rates(x + 0.5 * dt * a, valves, inputs, p)
        c = rates(x + 0.5 * dt * b, valves, inputs, p)
        d = rates(x + dt * c, valves, inputs, p)
        x = x + dt / 6.0 * (a + 2.0 * b + 2.0 * c + d)
    return x


def measurements(state, valves: dict, inputs: dict, p: TankParams) -> dict[str, float]:
    """Instrument readings for the current state (DCS tag -> value)."""
    level, temp = float(state[0]), float(state[1])
    lvl = max(level, LEVEL_FLOOR_M)
    header = inputs["steam_header_P"]
    t_steam = saturation_temp_c(header)
    heat = coil_heat_w(temp, valves["TV-101"], header, p)
    steam_kg_s = heat / latent_heat_j_kg(t_steam) + p.blowthrough * p.design_steam_kg_s
    bypass = min(max(p.blowthrough, 0.0), 1.0)
    t_cond = t_steam - (p.trap_subcool_k + p.flood_subcool_k * p.flooded) * (1.0 - bypass)
    approach = max(t_steam - temp, 1e-6)
    q_in = inputs["feed_flow"]
    q_out = outflow_m3s(lvl, valves["LV-101"], p)
    return {
        "LI-101": level,
        "TI-101": temp,
        "FI-101": q_in * 3600.0,
        "FI-102": q_out * 3600.0,
        "TI-100": inputs["feed_temp"],
        "TI-102": temp,
        "PI-201": header,
        "FI-201": steam_kg_s * 3600.0,
        "TI-201": t_steam,
        "TI-202": t_cond,
        "TI-901": inputs["T_amb"],
        "CALC-DUTY": heat / 1000.0,
        "CALC-UA": heat / approach if valves["TV-101"] > 1e-6 else 0.0,
        "CALC-APPROACH": approach,
        "CALC-PURITY": 99.4 - p.purity_curve * (temp - p.purity_peak_c) ** 2,
        "CALC-MBAL": (q_in - q_out) * 3600.0,
        "VOLUME": p.area_m2 * lvl,
    }


def holding_valves(level_m: float, temp_c: float, inputs: dict, p: TankParams) -> dict[str, float]:
    """Valve openings that make (level_m, temp_c) an equilibrium."""
    q_in = inputs["feed_flow"]
    lv = q_in / (p.outlet_cv * math.sqrt(max(level_m, LEVEL_FLOOR_M)))
    approach = saturation_temp_c(inputs["steam_header_P"]) - temp_c
    if approach <= 0.0:
        raise ValueError("header saturation temperature must exceed the target temperature")
    duty = (p.density * p.heat_capacity * q_in * (temp_c - inputs["feed_temp"])
            + p.loss_ua * (temp_c - inputs["T_amb"]))
    frac = duty / (p.coil_ua * p.fouling * (1.0 - p.flooded) * approach)
    return {"LV-101": float(lv), "TV-101": float(equal_percentage_travel(frac, p.steam_rangeability))}

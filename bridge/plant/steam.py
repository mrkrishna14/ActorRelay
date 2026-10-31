"""Saturated steam correlations for a utility steam header.
"""
from __future__ import annotations

ATMOSPHERE_BAR = 1.013


def saturation_temp_c(header_barg: float) -> float:
    """Approximate saturation temperature (degC) from gauge pressure (bar).

    Quarter-power fit: T = 100 * P_abs ** 0.25.
    """
    absolute = max(header_barg + ATMOSPHERE_BAR, 1e-6)
    return 100.0 * absolute ** 0.25


def latent_heat_j_kg(sat_temp_c: float) -> float:
    """Latent heat of condensation (J/kg), linear in saturation temperature."""
    return 1000.0 * (2500.0 - 2.4 * sat_temp_c)

"""Control valve inherent characteristics (flow fraction versus travel).
"""
from __future__ import annotations

import math


def _travel(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def linear(travel: float) -> float:
    """Flow fraction equals clamped travel."""
    return _travel(travel)


def equal_percentage(travel: float, rangeability: float = 50.0) -> float:
    """Equal-percentage trim: f = R ** (x - 1)."""
    return rangeability ** (_travel(travel) - 1.0)


def equal_percentage_travel(flow_fraction: float, rangeability: float = 50.0) -> float:
    """Inverse of equal_percentage; the fraction is limited to [1/R, 1]."""
    frac = min(max(flow_fraction, 1.0 / rangeability), 1.0)
    return 1.0 + math.log(frac) / math.log(rangeability)

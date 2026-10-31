"""Positional PI controller with output clamping and conditional-integration anti-windup.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class LoopTuning:
    tag: str
    kc: float          # gain, output fraction per PV unit
    ti: float          # integral time, s
    sp: float          # initial setpoint, PV units
    reverse: bool      # True: output rises when PV is below SP (heating)
    out_lo: float = 0.0
    out_hi: float = 1.0


class PIController:
    """PI loop working in 0..1 output units.

    The integral term carries the bias. Integration freezes while the raw
    output sits past a limit and the error keeps pushing that way, and the
    integral is bounded to one span outside the output range. For a cascade,
    the caller writes the slave's ``sp`` from the master's output each scan.
    """

    def __init__(self, tuning: LoopTuning, output: float):
        self.tag = tuning.tag
        self.kc = float(tuning.kc)
        self.ti = float(tuning.ti)
        self.sp = float(tuning.sp)
        self.direction = 1.0 if tuning.reverse else -1.0
        self.lo, self.hi = float(tuning.out_lo), float(tuning.out_hi)
        self.out = min(max(float(output), self.lo), self.hi)
        self.integral = self.out
        self.manual = False

    def step(self, pv: float, dt: float) -> float:
        if self.manual:
            self.integral = self.out
            return self.out
        e = self.direction * (self.sp - pv)
        raw = self.kc * e + self.integral
        clamped = min(max(raw, self.lo), self.hi)
        winding_up = (raw > self.hi and e > 0.0) or (raw < self.lo and e < 0.0)
        if self.ti > 0.0 and not winding_up:
            self.integral += self.kc * e * dt / self.ti
            self.integral = min(max(self.integral, self.lo - 1.0), self.hi + 1.0)
        self.out = clamped
        return clamped

    @property
    def at_limit(self) -> bool:
        return self.out <= self.lo + 1e-9 or self.out >= self.hi - 1e-9

    def __repr__(self) -> str:
        return f"PIController({self.tag}, sp={self.sp:.4g}, out={self.out:.3f})"

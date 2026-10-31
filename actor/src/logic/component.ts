import type { CalibrationEntry, ComponentState, Limit } from "../../../shared/types.js"
import { CALIBRATION_CAP } from "../config.js"

export const MARGIN_MIN = 5
export const MARGIN_MAX = 25
const WINDOW = 5
const WIDEN_ABOVE = 0.1
const NARROW_BELOW = 0.03

export function computeStatus(metrics: Record<string, number>, limits: Record<string, Limit>): ComponentState["status"] {
    let status: ComponentState["status"] = "ok"
    for (const [metric, limit] of Object.entries(limits)) {
        if (!Object.hasOwn(metrics, metric)) continue
        const value = metrics[metric]
        if (value >= limit.critical) return "critical"
        if (value >= limit.max) status = "warning"
    }
    return status
}

export function clampMargin(pct: number): number {
    return Math.min(MARGIN_MAX, Math.max(MARGIN_MIN, pct))
}

function normalizedError(entry: CalibrationEntry, limits: Record<string, Limit>): number | null {
    if (!Object.hasOwn(limits, entry.metric)) return null
    const range = limits[entry.metric].max - limits[entry.metric].min
    return range > 0 ? entry.absError / range : null
}

export type CalibrationOutcome = { calibration: CalibrationEntry[]; marginPct: number; sinceAdjustment: number }

// Margin moves only on a full window of 5 limited entries since the last move, so one bad reading never shifts it.
// Errors are normalised per entry because a component's metrics have different ranges.
export function applyCalibration(input: {
    calibration: CalibrationEntry[]
    entry: CalibrationEntry
    limits: Record<string, Limit>
    marginPct: number
    sinceAdjustment: number
}): CalibrationOutcome {
    const { entry, limits, marginPct } = input
    const calibration = [...input.calibration, entry].slice(-CALIBRATION_CAP)
    if (normalizedError(entry, limits) === null) return { calibration, marginPct, sinceAdjustment: input.sinceAdjustment }

    const sinceAdjustment = input.sinceAdjustment + 1
    if (sinceAdjustment < WINDOW) return { calibration, marginPct, sinceAdjustment }

    const window = calibration
        .map(item => normalizedError(item, limits))
        .filter((error): error is number => error !== null)
        .slice(-WINDOW)
    const mean = window.reduce((sum, error) => sum + error, 0) / window.length

    const next = mean > WIDEN_ABOVE ? clampMargin(marginPct + 5) : mean < NARROW_BELOW ? clampMargin(marginPct - 2) : marginPct
    return next === marginPct ? { calibration, marginPct, sinceAdjustment } : { calibration, marginPct: next, sinceAdjustment: 0 }
}

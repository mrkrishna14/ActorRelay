// Test fixtures: the real plant definition plus a small history shaped like Person 2's
// shared/history.json requirements (TASK2). Replace with shared/history.json once it lands.
import plantsJson from "../../shared/plants.json" with { type: "json" }
import type { ComponentState, HistoryEvent, PlantId } from "../../shared/types.js"

type PlantsFile = {
    company: { plants: PlantId[]; sharedResources: { id: string; name: string; components: string[] }[] }
    plants: { id: PlantId; name: string; components: ComponentState[] }[]
}
/** shared/plants.json in either layout (flat `components` + `sharedResources`, or nested) → the nested seed shape. */
export function normalizePlants(raw: any): PlantsFile {
    if (Array.isArray(raw.components)) {
        const comps = raw.components as ComponentState[]
        return {
            company: { plants: raw.plants.map((p: { id: PlantId }) => p.id), sharedResources: raw.sharedResources ?? [] },
            plants: raw.plants.map((p: { id: PlantId; name: string }) => ({ id: p.id, name: p.name, components: comps.filter(c => c.plantId === p.id) })),
        }
    }
    return raw as PlantsFile
}
export const plants = normalizePlants(plantsJson)

export const plantSeed = (id: PlantId) => plants.plants.find(p => p.id === id)!

let n = 0
/** A P-100 speed change and its effects after 5 ticks; LV-101 settles near the pump speed. */
export function speedEvent(plantId: PlantId, before: number, after: number, opts: { lv?: number; incident?: string | null; at?: string } = {}): HistoryEvent {
    n += 1
    const lv = opts.lv ?? after
    return {
        id: `${plantId}-h${String(n).padStart(3, "0")}`,
        at: opts.at ?? new Date(Date.UTC(2025, 0, 1, 0, n)).toISOString(),
        plantId, componentId: `${plantId}/P-100`, metric: "speedPct", before, after,
        upstreamSnapshot: { feedM3h: 0.3 * before, headerBarg: 6.0, feedTempC: 25 },
        effects: [
            { componentId: `${plantId}/LV-101`, metric: "positionPct", before, after: lv, ticksToSettle: 3 },
            { componentId: `${plantId}/TV-101`, metric: "steamKgH", before: 29.7 * before + 48, after: 29.7 * after + 48, ticksToSettle: 4 },
            { componentId: `${plantId}/TK-101`, metric: "levelPct", before: 50, after: lv >= 100 ? 58 : 50, ticksToSettle: 5 },
        ],
        incident: opts.incident ?? null, approvedBy: ["agent:fixture"], operator: "fixture-operator", proposalId: null,
    }
}

export function fixtureHistory(): HistoryEvent[] {
    const sat = "LV-101 saturated at 100%, TK-101 high-level alarm LAH-101"
    return [
        // plant-a: unsafe runs (≥ 88) where LV-101 ≥ 90, with incidents
        speedEvent("plant-a", 50, 88, { lv: 92, incident: sat }),
        speedEvent("plant-a", 55, 95, { lv: 100, incident: sat }),
        speedEvent("plant-a", 60, 100, { lv: 100, incident: sat }),
        // plant-a: 80–87 runs where LV-101 is 85–91 (no headroom)
        speedEvent("plant-a", 50, 80, { lv: 85 }),
        speedEvent("plant-a", 55, 84, { lv: 88 }),
        speedEvent("plant-a", 50, 86, { lv: 90, incident: "LV-101 no control headroom" }),
        // plant-a: safe 60–70 runs
        speedEvent("plant-a", 50, 60, { lv: 61 }),
        speedEvent("plant-a", 50, 63, { lv: 64 }),
        speedEvent("plant-a", 55, 65, { lv: 67 }),
        speedEvent("plant-a", 50, 68, { lv: 70 }),
        speedEvent("plant-a", 60, 70, { lv: 72 }),
        // plant-b: never above 65
        speedEvent("plant-b", 50, 40, { lv: 41 }),
        speedEvent("plant-b", 45, 55, { lv: 56 }),
        speedEvent("plant-b", 50, 60, { lv: 61 }),
        speedEvent("plant-b", 55, 65, { lv: 66 }),
    ]
}

// A small history meeting the hard requirements in TASK2.MD, for use until shared/history.json lands.
import type { HistoryEvent, PlantId } from "../../../../shared/types";

const row = (plant: PlantId, tag: string, metric: string, before: number, after: number, ticksToSettle = 3) => ({
  componentId: `${plant}/${tag}`,
  metric,
  before,
  after,
  ticksToSettle,
});

function run(plant: PlantId, n: number, after: number, valve: number, incident: string | null = null): HistoryEvent {
  return {
    id: `${plant}-hist-${n}`,
    at: new Date(Date.UTC(2025, 0, n + 1)).toISOString(),
    plantId: plant,
    componentId: `${plant}/P-100`,
    metric: "speedPct",
    before: 50,
    after,
    upstreamSnapshot: { feedM3h: 15, headerBarg: 6, feedTempC: 25 },
    effects: [
      row(plant, "LV-101", "positionPct", 50, valve),
      row(plant, "TK-101", "tempC", 75, 73),
      row(plant, "TK-101", "levelPct", 50, after >= 96 ? 60 : 51),
      row(plant, "E-101", "dutyKw", 898, 17.43 * after + 27),
      row(plant, "TV-101", "positionPct", 50.5, 0.36 * after + 32.5),
      row(plant, "TV-101", "steamKgH", 1533, 29.7 * after + 48),
      row(plant, "TV-101", "headerBarg", 6, 6 - 0.0005 * 29.7 * (after - 50)),
    ],
    incident,
    approvedBy: [],
    operator: "fixture operator",
    proposalId: null,
  };
}

const SATURATED = "LV-101 saturated at 100%, TK-101 high-level alarm LAH-101";

export const historyFixture: HistoryEvent[] = [
  run("plant-a", 1, 88, 92, SATURATED),
  run("plant-a", 2, 95, 100, SATURATED),
  run("plant-a", 3, 100, 100, SATURATED),
  run("plant-a", 4, 80, 85),
  run("plant-a", 5, 83, 87),
  run("plant-a", 6, 85, 89, "LV-101 no control headroom"),
  run("plant-a", 7, 60, 62),
  run("plant-a", 8, 62, 64),
  run("plant-a", 9, 65, 67),
  run("plant-a", 10, 66, 69),
  run("plant-a", 11, 70, 73),
  run("plant-a", 12, 65, 66),
  run("plant-a", 13, 66, 68),
  run("plant-a", 14, 67, 70),
  run("plant-b", 1, 40, 41),
  run("plant-b", 2, 50, 51),
  run("plant-b", 3, 55, 56),
  run("plant-b", 4, 60, 62),
  run("plant-b", 5, 65, 67),
];

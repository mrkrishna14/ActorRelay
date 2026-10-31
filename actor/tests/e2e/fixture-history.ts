// TEST FIXTURE. shared/history.json is Person 2's and may not exist yet, so this builds a deterministic
// history from the same linear coefficients as fake-plant.ts, meeting the TASK2.MD hard requirements.
// loadHistory() prefers the real file and reports which one it used so the e2e table can label it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryEvent, PlantId } from "../../../shared/types.ts";

const SATURATED = "LV-101 saturated at 100%, TK-101 high-level alarm LAH-101";
const NO_HEADROOM = "LV-101 no control headroom";
const OPERATORS = ["R. Okafor", "M. Lindqvist", "S. Tanaka", "D. Moreau"];

const steam = (speed: number) => 29.7 * speed + 48;
const header = (a: number, b: number) => Math.min(6.5, Math.max(4.5, 6.0 - 0.0005 * (steam(a) + steam(b) - 3066)));
const r = (v: number) => Math.round(v * 100) / 100;

function event(plantId: PlantId, n: number, before: number, after: number, otherSpeed: number, incident: string | null): HistoryEvent {
  const lv = Math.min(100, after + (after > 95 ? 5 : 4));
  const levelAfter = after > 95 ? 60 + (after - 95) * 3 : 50;
  const day = String(1 + (n % 27)).padStart(2, "0");
  const month = String(1 + (n % 12)).padStart(2, "0");
  const year = 2024 + (n % 3);
  const c = (tag: string) => `${plantId}/${tag}`;
  return {
    id: `hist-${plantId}-${String(n).padStart(3, "0")}`,
    at: `${year}-${month}-${day}T0${n % 9}:15:00.000Z`,
    plantId,
    componentId: c("P-100"),
    metric: "speedPct",
    before,
    after,
    upstreamSnapshot: { feedM3h: r(0.3 * before), headerBarg: r(header(before, otherSpeed)), feedTempC: 25 },
    effects: [
      { componentId: c("LV-101"), metric: "positionPct", before, after: r(lv), ticksToSettle: 3 },
      { componentId: c("TK-101"), metric: "levelPct", before: 50, after: r(levelAfter), ticksToSettle: 5 },
      { componentId: c("TK-101"), metric: "tempC", before: 75, after: r(75 - 0.05 * Math.abs(after - before)), ticksToSettle: 4 },
      { componentId: c("E-101"), metric: "dutyKw", before: r(17.43 * before + 27), after: r(17.43 * after + 27), ticksToSettle: 4 },
      { componentId: c("TV-101"), metric: "steamKgH", before: r(steam(before)), after: r(steam(after)), ticksToSettle: 4 },
      { componentId: c("TV-101"), metric: "positionPct", before: r(0.36 * before + 32.5), after: r(0.36 * after + 32.5), ticksToSettle: 4 },
      { componentId: c("TV-101"), metric: "headerBarg", before: r(header(before, otherSpeed)), after: r(header(after, otherSpeed)), ticksToSettle: 4 },
    ],
    incident,
    approvedBy: [],
    operator: OPERATORS[n % OPERATORS.length]!,
    proposalId: null,
  };
}

export function buildFixtureHistory(): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  let n = 0;
  const add = (plantId: PlantId, before: number, after: number, other: number, incident: string | null) => {
    events.push(event(plantId, ++n, before, after, other, incident));
  };
  for (const after of [88, 91, 94, 97, 100]) add("plant-a", 50, after, 50, SATURATED);
  for (const after of [81, 83, 85, 86, 87]) add("plant-a", 50, after, 50, after >= 85 ? NO_HEADROOM : null);
  for (const after of [60, 62, 64, 65, 66, 68, 70]) add("plant-a", 50, after, 50, null);
  for (const after of [40, 45, 55, 58]) add("plant-a", 50, after, 50, null);
  for (const after of [40, 45, 50, 55, 60, 62, 64, 65]) add("plant-b", 50, after, 50, null);
  return events;
}

export function loadHistory(repoRoot: string): { history: HistoryEvent[]; source: string } {
  for (const file of [join("shared", "history.json"), join("actor", "tests", "fixtures-gen", "history.json")]) {
    const path = join(repoRoot, file);
    if (existsSync(path)) return { history: JSON.parse(readFileSync(path, "utf8")) as HistoryEvent[], source: file.replaceAll("\\", "/") };
  }
  return { history: buildFixtureHistory(), source: "fixture" };
}

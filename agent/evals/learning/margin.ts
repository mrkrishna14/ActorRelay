// Bootstraps margin drift from measured calibration errors through the real applyCalibration. No LLM calls.
//   bun run agent/evals/learning/margin.ts agent/evals/learning/out/<run>.json [executions]
// TK-101 force-no's every proposal once its margin reaches 12, because the tempC threshold falls below the 75 C setpoint.
import { readFileSync } from "node:fs";
import type { CalibrationEntry, ComponentId } from "../../../shared/types.ts";
import { applyCalibration } from "../../../actor/src/logic/component.ts";
import { rng, World } from "./world.ts";

const path = process.argv[2];
const executions = Number(process.argv[3] ?? 10);
const trials = 5000;
const { rows } = JSON.parse(readFileSync(path, "utf8"));
const world = new World(1, 65, "fixture");
const r = rng(7);

for (const id of ["plant-a/TK-101", "plant-a/LV-101", "plant-a/TV-101", "plant-a/E-101"] as ComponentId[]) {
  const c = world.components.get(id)!;
  // One sample per execution: the set of entries this component produced in one measured run.
  const samples: CalibrationEntry[][] = rows.map((row: any) => row.a.calibration.filter((e: any) => e.component === id));
  const outcomes = new Map<number, number>();
  let widened = 0;
  for (let t = 0; t < trials; t++) {
    let state = { calibration: [] as CalibrationEntry[], marginPct: c.marginPct, sinceAdjustment: 0 };
    let peak = c.marginPct;
    for (let e = 0; e < executions; e++) {
      for (const entry of samples[Math.floor(r() * samples.length)]) {
        state = applyCalibration({ ...state, entry, limits: c.limits });
        peak = Math.max(peak, state.marginPct);
      }
    }
    outcomes.set(state.marginPct, (outcomes.get(state.marginPct) ?? 0) + 1);
    if (peak >= 12) widened++;
  }
  const dist = [...outcomes].sort((a, b) => a[0] - b[0]).map(([m, n]) => `${m}: ${((100 * n) / trials).toFixed(1)}%`).join(", ");
  console.log(`${id} after ${executions} executions, margin ${dist}; reached 12 or more in ${((100 * widened) / trials).toFixed(1)}%`);
}

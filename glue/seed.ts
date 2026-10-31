// Reads the seed files for POST /reset. The real history wins as soon as shared/history.json exists; until then the
// stand-in loads with a label that reaches the dashboard, so a stand-in run is never shown as the real thing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { HistoryEvent } from "../shared/types";
import { historyEventSchema, plantsFileSchema, type PlantsFile } from "./schemas";

export const REAL_HISTORY = "shared/history.json";
export const STAND_IN_HISTORY = "actor/tests/fixtures-gen/history.json";
export const STAND_IN_LABEL = "Stand-in history: linear fit from test fixtures, not generated from the tank model";

export type SeedInfo = { historySource: string; standIn: boolean; label: string | null; events: number };
export type Seed = { plantsFile: PlantsFile; history: HistoryEvent[]; info: SeedInfo };

export function historyPath(repoRoot: string): { path: string; source: string; standIn: boolean } {
  const real = join(repoRoot, REAL_HISTORY);
  if (existsSync(real)) return { path: real, source: REAL_HISTORY, standIn: false };
  return { path: join(repoRoot, STAND_IN_HISTORY), source: STAND_IN_HISTORY, standIn: true };
}

export function loadSeed(repoRoot: string): Seed {
  const plantsFile = plantsFileSchema.parse(JSON.parse(readFileSync(join(repoRoot, "shared", "plants.json"), "utf8")));
  const { path, source, standIn } = historyPath(repoRoot);
  const history = z.array(historyEventSchema).parse(JSON.parse(readFileSync(path, "utf8")));
  return { plantsFile, history, info: { historySource: source, standIn, label: standIn ? STAND_IN_LABEL : null, events: history.length } };
}

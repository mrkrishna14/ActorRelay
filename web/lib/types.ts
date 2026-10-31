// Every shape the dashboard renders comes from the frozen contract. Type-only import: nothing from shared/ reaches the bundle.
export type {
  AuditEntry,
  CalibrationEntry,
  CompanyState,
  ComponentId,
  ComponentState,
  HistoryEvent,
  LearnedRule,
  Limit,
  PlantId,
  PlantState,
  Proposal,
  Vote,
} from "../../shared/types";

import type { CalibrationEntry, ComponentState } from "../../shared/types";

/** CLAUDE.MD: `Component` emits ComponentState plus its calibration record. */
export type ComponentView = ComponentState & { calibration?: CalibrationEntry[] };

export type View = "plant-a" | "plant-b" | "company";

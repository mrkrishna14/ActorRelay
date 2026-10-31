import type { CSSProperties } from "react";
import type { ComponentTag, PlantId } from "./types";

/**
 * One identity color per equipment agent, shared by chat, harness, 2D, and 3D.
 * `color` is for fills, outlines, and 3D materials. `ink` is the same hue dark
 * enough for text on a light surface; dark mode uses `color` for text.
 * Red and green stay reserved for no/blocked and yes/ok, so no agent uses them.
 */
export interface AgentColor { color: string; ink: string; name: string }

export const AGENT_COLORS: Record<PlantId, Record<ComponentTag, AgentColor>> = {
  "plant-a": {
    "P-100": { color: "#3B82F6", ink: "#1D4ED8", name: "Blue" },
    "TK-101": { color: "#14B8A6", ink: "#0F766E", name: "Teal" },
    "LV-101": { color: "#F59E0B", ink: "#B45309", name: "Amber" },
    "E-101": { color: "#D946EF", ink: "#A21CAF", name: "Magenta" },
    "TV-101": { color: "#8B5CF6", ink: "#6D28D9", name: "Violet" },
  },
  "plant-b": {
    "P-100": { color: "#38BDF8", ink: "#0369A1", name: "Sky" },
    "TK-101": { color: "#2DD4BF", ink: "#0F766E", name: "Aqua" },
    "LV-101": { color: "#FB923C", ink: "#C2410C", name: "Orange" },
    "E-101": { color: "#F472B6", ink: "#BE185D", name: "Pink" },
    "TV-101": { color: "#A78BFA", ink: "#5B21B6", name: "Lavender" },
  },
};

/** The human operator. Neutral, so "you" never reads as an equipment agent. */
export const OPERATOR_COLOR: AgentColor = { color: "#E5E7EB", ink: "#111827", name: "Operator" };

export function agentColor(plantId: PlantId | undefined, tag: ComponentTag | undefined): AgentColor | null {
  if (!plantId || !tag) return null;
  return AGENT_COLORS[plantId]?.[tag] ?? null;
}

/**
 * Inline CSS variables for an agent-colored element. Stylesheets read
 * `--agent-color` and `--agent-ink` (theme-aware text via themes or component CSS).
 */
export function agentColorStyle(plantId: PlantId | undefined, tag: ComponentTag | undefined): CSSProperties | undefined {
  const entry = agentColor(plantId, tag);
  if (!entry) return undefined;
  return { "--agent-color": entry.color, "--agent-ink": entry.ink } as CSSProperties;
}

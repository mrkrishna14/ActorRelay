import type { ComponentTag } from "./types";

export type ControlMetric = "speedPct" | "tempC" | "levelPct" | "steamKgH";
export interface ControlTarget {
  tag: ComponentTag;
  metric: ControlMetric;
  label: string;
  loop: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  setpointMetric?: string;
}

export const CONTROL_TARGETS: ControlTarget[] = [
  { tag: "P-100", metric: "speedPct", label: "Feed pump speed", loop: "P-100", unit: "%", min: 20, max: 90, step: 0.1 },
  { tag: "TK-101", metric: "tempC", label: "Tank temperature", loop: "TIC-101", unit: "°C", min: 70, max: 80, step: 0.1, setpointMetric: "tempSetpointC" },
  { tag: "TK-101", metric: "levelPct", label: "Tank level", loop: "LIC-101", unit: "%", min: 20, max: 70, step: 0.1, setpointMetric: "levelSetpointPct" },
  { tag: "TV-101", metric: "steamKgH", label: "Steam flow", loop: "FIC-201", unit: "kg/h", min: 0, max: 2700, step: 1, setpointMetric: "steamSetpointKgH" },
];

export function controlTarget(tag: ComponentTag, metric: string): ControlTarget | undefined {
  return CONTROL_TARGETS.find((target) => target.tag === tag && target.metric === metric);
}

export function parseControlRequest(text: string): { tag: ComponentTag; metric: ControlMetric; to: number } | null {
  const metric: ControlMetric = /\b(?:LIC-?101|level)\b/i.test(text) ? "levelPct"
    : /\b(?:FIC-?201|steam)\b/i.test(text) ? "steamKgH"
      : /\b(?:TIC-?101|temperature|temp)\b/i.test(text) ? "tempC" : "speedPct";
  const input = text.replace(/\b(?:P-100|TK-101|TV-101|LIC-?101|TIC-?101|FIC-?201)\b/gi, "");
  const numbers = input.match(/-?\d+(?:\.\d+)?/g);
  if (!numbers?.length) return null;
  const to = Number(numbers.at(-1));
  const target = CONTROL_TARGETS.find((item) => item.metric === metric)!;
  return Number.isFinite(to) ? { tag: target.tag, metric, to } : null;
}

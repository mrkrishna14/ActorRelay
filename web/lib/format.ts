// Display text for metrics and times. Units and labels only; no value is ever invented here.
const METRICS: Record<string, { label: string; unit: string; digits: number }> = {
  speedPct: { label: "Speed", unit: "%", digits: 1 },
  feedM3h: { label: "Feed", unit: "m³/h", digits: 1 },
  levelPct: { label: "Level", unit: "%", digits: 1 },
  tempC: { label: "Temperature", unit: "°C", digits: 1 },
  positionPct: { label: "Position", unit: "%", digits: 1 },
  dutyKw: { label: "Duty", unit: "kW", digits: 0 },
  steamKgH: { label: "Steam", unit: "kg/h", digits: 0 },
  headerBarg: { label: "Header", unit: "barg", digits: 2 },
};

export function metricLabel(metric: string): string {
  return METRICS[metric]?.label ?? metric;
}

export function metricUnit(metric: string): string {
  return METRICS[metric]?.unit ?? "";
}

export function formatNumber(metric: string, value: number): string {
  const digits = METRICS[metric]?.digits ?? 1;
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatMetric(metric: string, value: number): string {
  const unit = metricUnit(metric);
  return unit === "" ? formatNumber(metric, value) : `${formatNumber(metric, value)} ${unit}`;
}

/** Bars and proposals: "85 %" rather than "85.0 %" when the value is whole. */
export function formatTarget(metric: string, value: number): string {
  const unit = metricUnit(metric);
  const text = Number.isInteger(value) ? value.toLocaleString("en-US") : formatNumber(metric, value);
  return unit === "" ? text : `${text} ${unit}`;
}

export function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("en-GB", { hour12: false });
}

export function ageText(fromMs: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - fromMs) / 1000));
  if (seconds < 90) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

export function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown date";
  return date.toISOString().slice(0, 10);
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

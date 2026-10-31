import { metricLevel, refusalThreshold } from "@/lib/derive";
import { formatMetric, formatNumber, formatTarget, metricLabel } from "@/lib/format";
import type { ComponentView, Limit } from "@/lib/types";
import { Plate, statusTone, Word, type Tone } from "./ui";

const LEVEL_TONE: Record<string, Tone> = { ok: "ok", warning: "warn", critical: "bad" };
const ROLE_WORD: Record<ComponentView["role"], string> = {
  mechanic: "Mechanic",
  process_engineer: "Process engineer",
  chemical_engineer: "Chemical engineer",
  safety: "Safety",
};

function LimitBar({ metric, value, limit, marginPct }: { metric: string; value: number; limit: Limit; marginPct: number }) {
  const pad = (limit.critical - limit.min) * 0.22;
  const low = Math.min(limit.min - pad, value);
  const high = Math.max(limit.critical + pad, value);
  const at = (point: number) => `${((point - low) / (high - low)) * 100}%`;
  const threshold = refusalThreshold(limit, marginPct);
  const level = metricLevel(value, limit);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-ink-2">{metricLabel(metric)}</span>
        <span className="flex items-baseline gap-3">
          <span className="num text-xl font-medium">{formatMetric(metric, value)}</span>
          <Word tone={LEVEL_TONE[level] ?? "off"}>{level}</Word>
        </span>
      </div>
      <div className="relative mt-1 h-[12px] bg-lift">
        <i className="absolute inset-y-0 left-0 bg-[var(--tint-warn)]" style={{ width: at(limit.min) }} />
        <i className="absolute inset-y-0 bg-[var(--tint-warn)]" style={{ left: at(limit.max), right: `calc(100% - ${at(limit.critical)})` }} />
        <i className="absolute inset-y-0 right-0 bg-[var(--tint-bad)]" style={{ left: at(limit.critical) }} />
        <i className="absolute -inset-y-[3px] w-[2px] bg-warn" style={{ left: at(limit.min) }} />
        <i className="absolute -inset-y-[3px] w-[2px] bg-warn" style={{ left: at(limit.max) }} />
        <i className="absolute -inset-y-[3px] w-[2px] bg-bad" style={{ left: at(limit.critical) }} />
        <i className="absolute -inset-y-[5px] w-[4px] -translate-x-1/2 bg-ink shadow-[0_0_0_2px_var(--color-panel)]" style={{ left: at(value) }} />
      </div>
      <div className="relative mt-1 h-[24px] text-ink-3">
        <span className="num absolute -translate-x-1/2 whitespace-nowrap" style={{ left: at(limit.min) }}>
          min {limit.min}
        </span>
        <span className="num absolute -translate-x-full whitespace-nowrap" style={{ left: at(limit.max) }}>
          max {limit.max}
        </span>
        <span className="num absolute right-0 whitespace-nowrap">critical {limit.critical}</span>
      </div>
      <div className="flex justify-between text-ink-3">
        <span>Agent refuses past</span>
        <span className="num text-ink-2">{formatTarget(metric, Math.round(threshold * 10) / 10)}</span>
      </div>
    </div>
  );
}

export function ComponentPanel({ component }: { component: ComponentView | undefined }) {
  if (component === undefined) {
    return (
      <div className="flex min-h-0 flex-col">
        <Plate>Component</Plate>
        <div className="p-4 text-ink-3">No state from glue for this component.</div>
      </div>
    );
  }

  const limited = Object.keys(component.limits);
  const plain = Object.entries(component.metrics).filter(([metric]) => !limited.includes(metric));
  const calibration = [...(component.calibration ?? [])].slice(-5).reverse();

  return (
    <div className="flex min-h-0 flex-col">
      <Plate right={<Word tone={statusTone(component.status)}>{component.status}</Word>}>Component</Plate>
      <div className="scroll min-h-0 flex-1 px-4 pb-3 pt-2">
        <div className="flex items-baseline gap-3">
          <h2 className="num m-0 text-2xl font-semibold">{component.tag}</h2>
          <span className="truncate text-lg text-ink-2">{component.name}</span>
        </div>
        <div className="mb-2 flex justify-between text-ink-3">
          <span>{ROLE_WORD[component.role]} agent</span>
          <span className="num">{component.plantId}</span>
        </div>

        <div className="flex flex-col gap-3">
          {limited.map((metric) => {
            const value = component.metrics[metric];
            const limit = component.limits[metric];
            if (value === undefined || limit === undefined) return null;
            return <LimitBar key={metric} metric={metric} value={value} limit={limit} marginPct={component.marginPct} />;
          })}
        </div>

        {plain.map(([metric, value]) => (
          <div key={metric} className="mt-1 flex items-baseline justify-between">
            <span className="text-ink-2">{metricLabel(metric)}</span>
            <span className="num font-medium">{formatMetric(metric, value)}</span>
          </div>
        ))}

        <div className="mt-2 flex items-baseline justify-between border-t border-hairline pt-2">
          <span className="text-ink-2">Safety margin</span>
          <span className="num text-lg font-medium">{component.marginPct} %</span>
        </div>

        <div className="mt-2">
          <div className="plate mb-1">Calibration, last 5</div>
          {calibration.length === 0 ? (
            <div className="text-ink-3">No checked predictions yet.</div>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-left text-ink-3">
                  <th className="font-normal">Metric</th>
                  <th className="text-right font-normal">Predicted</th>
                  <th className="text-right font-normal">Observed</th>
                  <th className="text-right font-normal">Error</th>
                </tr>
              </thead>
              <tbody>
                {calibration.map((entry) => (
                  <tr key={`${entry.proposalId}-${entry.metric}`} className="border-t border-hairline">
                    <td className="text-ink-2">{metricLabel(entry.metric)}</td>
                    <td className="num text-right">{formatNumber(entry.metric, entry.predicted)}</td>
                    <td className="num text-right">{formatNumber(entry.metric, entry.observed)}</td>
                    <td className="num text-right">{formatNumber(entry.metric, entry.absError)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { plantOf, refusalThreshold } from "@/lib/derive";
import { formatMetric, formatNumber, metricLabel } from "@/lib/format";
import type { Sample } from "@/lib/store";
import type { AuditEntry, ComponentView } from "@/lib/types";

const WINDOW_MS = 120_000;
/** A hole in polling stays a hole in the line. Nothing is drawn across seconds the page did not see. */
const GAP_MS = 3500;
const PAD = { left: 16, right: 190, top: 28, bottom: 28 };

type Line = { value: number; text: string; color: string; dashed: boolean };

function linePath(samples: Sample[], x: (t: number) => number, y: (v: number) => number): string {
  let path = "";
  let previous: Sample | null = null;
  for (const sample of samples) {
    const joined = previous !== null && sample.t - previous.t <= GAP_MS;
    path += `${joined ? "L" : "M"}${x(sample.t).toFixed(1)} ${y(sample.v).toFixed(1)}`;
    previous = sample;
  }
  return path;
}

/** Spreads right-hand labels so 18px text never overlaps. */
function spreadLabels(lines: { y: number; line: Line }[], top: number, bottom: number) {
  const gap = 21;
  const sorted = [...lines].sort((a, b) => a.y - b.y).map((item) => ({ ...item, labelY: item.y }));
  sorted.forEach((item, index) => {
    const previous = sorted[index - 1];
    item.labelY = Math.max(item.labelY, previous ? previous.labelY + gap : top);
  });
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const item = sorted[index];
    const next = sorted[index + 1];
    if (item === undefined) continue;
    item.labelY = Math.min(item.labelY, next ? next.labelY - gap : bottom);
  }
  return sorted;
}

export function TimingChart({
  component,
  metric,
  metrics,
  onMetric,
  samples,
  audit,
  now,
}: {
  component: ComponentView | undefined;
  metric: string;
  metrics: string[];
  onMetric: (metric: string) => void;
  samples: Sample[];
  audit: AuditEntry[];
  now: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const read = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const inWindow = useMemo(() => samples.filter((sample) => now - sample.t <= WINDOW_MS), [samples, now]);
  const latest = inWindow[inWindow.length - 1];
  const limit = component?.limits[metric];

  const lines: Line[] = limit
    ? [
        { value: limit.critical, text: `critical ${limit.critical}`, color: "var(--color-bad)", dashed: false },
        { value: limit.max, text: `max ${limit.max}`, color: "var(--color-warn)", dashed: false },
        { value: limit.min, text: `min ${limit.min}`, color: "var(--color-warn)", dashed: false },
        {
          value: refusalThreshold(limit, component?.marginPct ?? 0),
          text: `refuses ${formatNumber(metric, refusalThreshold(limit, component?.marginPct ?? 0))}`,
          color: "var(--color-ice)",
          dashed: true,
        },
      ]
    : [];

  const { width, height } = size;
  const plotRight = width - PAD.right;
  const plotBottom = height - PAD.bottom;
  const values = [...inWindow.map((sample) => sample.v), ...lines.map((line) => line.value)];
  const lowest = values.length ? Math.min(...values) : 0;
  const highest = values.length ? Math.max(...values) : 1;
  const span = highest - lowest || Math.abs(highest) * 0.1 || 1;
  const low = lowest - span * 0.08;
  const high = highest + span * 0.08;
  const x = (t: number) => PAD.left + ((t - (now - WINDOW_MS)) / WINDOW_MS) * (plotRight - PAD.left);
  const y = (v: number) => plotBottom - ((v - low) / (high - low)) * (plotBottom - PAD.top);

  const labels = spreadLabels(lines.map((line) => ({ y: y(line.value), line })), PAD.top + 6, plotBottom - 2);

  const firstMarks = new Map<string, { at: number; word: string; color: string }>();
  if (component) {
    for (const entry of audit) {
      if (entry.plantId !== plantOf(component.id)) continue;
      const at = Date.parse(entry.at);
      if (now - at > WINDOW_MS) continue;
      const mark =
        entry.kind === "block"
          ? { word: "blocked", color: "var(--color-bad)" }
          : entry.kind === "veto"
            ? { word: "vetoed", color: "var(--color-bad)" }
            : entry.kind === "execute"
              ? { word: "executed", color: "var(--color-ok)" }
              : null;
      if (mark === null) continue;
      const key = `${entry.kind}|${entry.refId}`;
      const known = firstMarks.get(key);
      if (known === undefined || at < known.at) firstMarks.set(key, { at, ...mark });
    }
  }
  const marks = [...firstMarks.values()].sort((a, b) => a.at - b.at);

  const hovered = hover === null || inWindow.length === 0 ? null : inWindow.reduce((best, sample) => (Math.abs(x(sample.t) - hover) < Math.abs(x(best.t) - hover) ? sample : best));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[38px] shrink-0 items-center gap-4 border-b border-hairline px-4">
        <span className="plate whitespace-nowrap">Timing</span>
        <span className="num whitespace-nowrap font-medium">{component?.tag ?? "--"}</span>
        <div className="flex gap-1">
          {metrics.map((item) => (
            <button
              key={item}
              onClick={() => onMetric(item)}
              aria-pressed={item === metric}
              className={`h-[28px] whitespace-nowrap px-2 ${item === metric ? "bg-lift text-ink" : "text-ink-3 hover:text-ink"}`}
            >
              {metricLabel(item)}
            </button>
          ))}
        </div>
        <span className="ml-auto whitespace-nowrap text-ink-3">last 120 s, one sample a second</span>
        <span className="num min-w-[130px] whitespace-nowrap text-right text-lg font-medium">{latest ? formatMetric(metric, latest.v) : "--"}</span>
      </div>
      <div
        ref={box}
        className="relative min-h-0 flex-1"
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setHover(((event.clientX - rect.left) / rect.width) * width);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {width > 0 && height > 0 ? (
          <svg width={width} height={height} role="img" aria-label={`${metricLabel(metric)} over the last 120 seconds`} className="absolute inset-0">
            <line x1={PAD.left} x2={plotRight} y1={plotBottom} y2={plotBottom} stroke="var(--color-hairline)" />
            {[0, 30, 60, 90, 120].map((secondsAgo) => {
              const tick = PAD.left + ((WINDOW_MS - secondsAgo * 1000) / WINDOW_MS) * (plotRight - PAD.left);
              return (
                <g key={secondsAgo}>
                  <line x1={tick} x2={tick} y1={PAD.top} y2={plotBottom} stroke="var(--color-hairline)" strokeOpacity={0.5} />
                  <text x={tick} y={height - 6} textAnchor={secondsAgo === 120 ? "start" : secondsAgo === 0 ? "end" : "middle"} fill="var(--color-ink-3)" fontSize={18} fontFamily="var(--font-mono)">
                    {secondsAgo === 0 ? "now" : `−${secondsAgo} s`}
                  </text>
                </g>
              );
            })}

            {lines.map((line) => (
              <line key={line.text} x1={PAD.left} x2={plotRight} y1={y(line.value)} y2={y(line.value)} stroke={line.color} strokeWidth={1.25} strokeOpacity={0.85} strokeDasharray={line.dashed ? "7 6" : undefined} />
            ))}
            {labels.map(({ line, labelY, y: lineY }) => (
              <g key={line.text}>
                <line x1={plotRight} x2={plotRight + 12} y1={lineY} y2={labelY} stroke={line.color} strokeOpacity={0.6} />
                <text x={plotRight + 16} y={labelY + 6} fill={line.color} fontSize={18} fontFamily="var(--font-mono)">
                  {line.text}
                </text>
              </g>
            ))}

            {marks.map((mark, index) => {
              const markX = x(mark.at);
              const previous = marks[index - 1];
              const crowded = previous !== undefined && markX - x(previous.at) < 90;
              return (
                <g key={`${mark.word}-${mark.at}`}>
                  <line x1={markX} x2={markX} y1={PAD.top - 6} y2={plotBottom} stroke={mark.color} strokeWidth={1.5} />
                  {crowded ? null : (
                    <text x={markX + 6} y={20} fill={mark.color} fontSize={18} fontWeight={600}>
                      {mark.word}
                    </text>
                  )}
                </g>
              );
            })}

            <path d={linePath(inWindow, x, y)} fill="none" stroke="var(--color-ink)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {latest ? <circle cx={x(latest.t)} cy={y(latest.v)} r={4.5} fill="var(--color-ink)" stroke="var(--color-panel)" strokeWidth={2} /> : null}

            {hovered ? (
              <g>
                <line x1={x(hovered.t)} x2={x(hovered.t)} y1={PAD.top} y2={plotBottom} stroke="var(--color-ink-2)" />
                <circle cx={x(hovered.t)} cy={y(hovered.v)} r={5} fill="var(--color-ink)" stroke="var(--color-panel)" strokeWidth={2} />
              </g>
            ) : null}
          </svg>
        ) : null}

        {hovered ? (
          <div
            className="pointer-events-none absolute top-1 z-10 whitespace-nowrap border border-rule bg-raised px-2"
            style={{ left: Math.min(x(hovered.t) + 10, Math.max(0, plotRight - 200)) }}
          >
            <span className="num font-medium">{formatMetric(metric, hovered.v)}</span>
            <span className="text-ink-3"> {Math.round((now - hovered.t) / 1000)} s ago</span>
          </div>
        ) : null}

        {inWindow.length < 2 ? (
          <div className="absolute inset-0 flex items-center justify-center text-ink-3">Recording from the moment this page opened</div>
        ) : null}
      </div>
    </div>
  );
}

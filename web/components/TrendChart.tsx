"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Pause, Play } from "@phosphor-icons/react";
import type { TrendChartProps } from "../lib/types";
import "./plant-views.css";

export default function TrendChart({ points, threshold, label, unit = "%", paused, eventLabel, eventAt, onTogglePause }: TrendChartProps) {
  const id = useId().replaceAll(":", "");
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(880);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, entry.contentRect.width)));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const valid = points.filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value)).sort((a, b) => a.time - b.time);
  const height = 150, left = 46, right = 53, top = 16, bottom = 26;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const minT = valid[0]?.time ?? 0;
  const maxT = valid.at(-1)?.time ?? minT + 120;
  const maxValue = Math.max(100, ...(valid.map((point) => point.value)), threshold ?? 0);
  const yMax = Math.ceil(maxValue / 25) * 25;
  const x = (time: number) => left + ((time - minT) / (maxT - minT || 1)) * plotWidth;
  const y = (value: number) => top + plotHeight - (value / yMax) * plotHeight;
  const line = valid.map((point, i) => `${i ? "L" : "M"}${x(point.time).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
  const last = valid.at(-1);
  const divisions = width < 520 ? 2 : 6;
  const event = (() => {
    if (!eventLabel || typeof eventAt !== "number" || !Number.isFinite(eventAt) || eventAt < minT || eventAt > maxT || !valid.length) return null;
    const afterIndex = valid.findIndex((point) => point.time >= eventAt);
    const after = valid[afterIndex];
    const before = valid[Math.max(0, afterIndex - 1)];
    const fraction = (eventAt - before.time) / (after.time - before.time || 1);
    return { time: eventAt, value: before.value + (after.value - before.value) * fraction };
  })();
  const hovered = hover === null ? null : valid[Math.min(valid.length - 1, Math.max(0, hover))];
  const formatTime = (value: number) => {
    // Milliseconds are accepted for future service integration; demo points may be relative seconds.
    if (value > 1_000_000_000_000) return new Date(value).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (value > 1_000_000_000) return new Date(value * 1000).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return value === maxT ? "now" : `${Math.round(value - maxT)}s`;
  };

  return <div className="engineering-trend" ref={root}>
    <div className="trend-heading"><h3>{label}</h3><span>· last 120s</span>{onTogglePause && <button onClick={onTogglePause} aria-label={paused ? "Resume trend updates" : "Pause trend updates"}>{paused ? <Play size={12} /> : <Pause size={12} />}{paused ? "Paused" : "Pause"}</button>}</div>
    {valid.length ? <svg className="trend-plot" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${label}. Latest value ${last?.value.toFixed(1)}${unit}.${threshold !== undefined ? ` Safety threshold ${threshold}${unit}.` : ""}`} onPointerLeave={() => setHover(null)} onPointerMove={(event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const localX = ((event.clientX - rect.left) / rect.width) * width;
      setHover(Math.round(((localX - left) / plotWidth) * (valid.length - 1)));
    }}>
      <defs><linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#e8e8e8" stopOpacity=".045" /><stop offset="1" stopColor="#e8e8e8" stopOpacity="0" /></linearGradient><clipPath id={`${id}-clip`}><rect x={left} y={top} width={plotWidth} height={plotHeight} /></clipPath></defs>
      {[0, 1, 2, 3, 4].map((i) => <g key={i}><path d={`M${left} ${y(i * yMax / 4)} H${width - right}`} stroke="#2c2c2c" strokeWidth=".7" /><text x={left - 9} y={y(i * yMax / 4) + 3} textAnchor="end">{i * yMax / 4}</text></g>)}
      {Array.from({ length: divisions + 1 }, (_, i) => <g key={i}><path d={`M${left + i * plotWidth / divisions} ${top} V${height - bottom}`} stroke="#2c2c2c" strokeWidth=".6" /><text x={left + i * plotWidth / divisions} y={height - 8} textAnchor="middle">{formatTime(minT + i * (maxT - minT) / divisions)}</text></g>)}
      <path d={`M${left} ${top} V${height - bottom} H${width - right}`} stroke="#727272" fill="none" strokeWidth=".8" />
      {threshold !== undefined && <g><path d={`M${left} ${y(threshold)} H${width - right}`} stroke="#bdbdbd" strokeDasharray="4 4" strokeWidth="1" /><text x={width - right - 5} y={Math.min(height - bottom - 7, Math.max(top + 22, y(threshold) + 14))} textAnchor="end" className="trend-callout">{threshold}{unit} safety threshold</text></g>}
      <g clipPath={`url(#${id}-clip)`}><path d={`${line} L${x(last!.time)} ${height - bottom} L${left} ${height - bottom} Z`} fill={`url(#${id}-area)`} /><path d={line} fill="none" stroke="#e7e7e7" strokeWidth="1.65" strokeLinejoin="round" strokeLinecap="round" /></g>
      {event && <g><path d={`M${x(event.time)} ${top} V${height - bottom}`} stroke="#a1a1a1" strokeDasharray="3 3" /><circle cx={x(event.time)} cy={top} r="3.2" fill="#eee" /><circle cx={x(event.time)} cy={y(event.value)} r="3.2" fill="#eee" /><text x={Math.min(x(event.time) + 9, width - right - 125)} y={top + 3} className="trend-callout">{eventLabel}</text></g>}
      <text x={width - right + 9} y={y(last!.value) + 4} className="trend-final-value">{last!.value.toFixed(0)}{unit}</text>
      {hovered && <g><path d={`M${x(hovered.time)} ${top} V${height - bottom}`} stroke="#7b7b7b" strokeDasharray="2 3" /><circle cx={x(hovered.time)} cy={y(hovered.value)} r="3.5" fill="#fff" /><rect x={Math.min(width - 120, Math.max(left, x(hovered.time) - 34))} y={Math.max(top + 17, y(hovered.value) - 31)} width="78" height="21" rx="3" fill="#282828" stroke="#565656" /><text x={Math.min(width - 120, Math.max(left, x(hovered.time) - 34)) + 39} y={Math.max(top + 17, y(hovered.value) - 31) + 14} textAnchor="middle" className="trend-callout">{hovered.value.toFixed(1)}{unit}</text></g>}
    </svg> : <div className="trend-empty">No metric samples available</div>}
  </div>;
}

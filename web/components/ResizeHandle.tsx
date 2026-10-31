"use client";

import type { KeyboardEvent, PointerEvent } from "react";
import type { ResizeKind } from "../lib/use-panel-layout";
import "./panel-resize.css";

interface Props {
  kind: ResizeKind;
  label: string;
  onPointerDown: (kind: ResizeKind, event: PointerEvent<HTMLElement>) => void;
  onResizeBy: (kind: ResizeKind, delta: number) => void;
  value?: number;
  min?: number;
  max?: number;
  onReset?: () => void;
}

const bounds = { sidebar: { min: 170, max: 360 }, chat: { min: 280, max: 620 }, chart: { min: 100, max: 450 } };

export default function ResizeHandle({ kind, label, onPointerDown, onResizeBy, value, min, max, onReset }: Props) {
  const horizontal = kind === "chart";
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 24 : 8;
    let delta: number | null = null;
    if (horizontal && event.key === "ArrowUp") delta = step;
    if (horizontal && event.key === "ArrowDown") delta = -step;
    if (!horizontal && event.key === "ArrowRight") delta = kind === "chat" ? -step : step;
    if (!horizontal && event.key === "ArrowLeft") delta = kind === "chat" ? step : -step;
    if (event.key === "Home") { event.preventDefault(); if (onReset) onReset(); else onResizeBy(kind, -10_000); return; }
    if (event.key === "End") delta = 10_000;
    if (delta == null) return;
    event.preventDefault();
    onResizeBy(kind, delta);
  };
  return <div className={`panel-resize-handle panel-resize-${kind}`} role="separator" tabIndex={0}
    aria-label={label} aria-orientation={horizontal ? "horizontal" : "vertical"}
    aria-valuemin={min ?? bounds[kind].min} aria-valuemax={max ?? bounds[kind].max} aria-valuenow={Math.round(value ?? min ?? bounds[kind].min)}
    aria-valuetext={`${Math.round(value ?? min ?? bounds[kind].min)} pixels`}
    title={`${label}. Drag or use arrow keys. Shift for larger steps.${onReset ? " Double-click or Home to reset layout." : ""}`}
    onPointerDown={(event) => onPointerDown(kind, event)} onKeyDown={handleKeyDown} onDoubleClick={onReset}>
    <span className="panel-resize-grip" aria-hidden="true" />
  </div>;
}

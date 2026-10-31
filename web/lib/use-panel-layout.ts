"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export type ResizeKind = "sidebar" | "chat" | "chart";
interface PanelLayout { sidebarWidth: number; chatWidth: number; chartHeight: number }
interface Viewport { width: number; height: number }
interface ResizeBounds { min: number; max: number }

const INITIAL: PanelLayout = { sidebarWidth: 256, chatWidth: 424, chartHeight: 207 };
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
// Main chrome (~187), agent context (60), app header (58), divider (7), and a 200 px plant viewport.
const CHART_RESERVED_HEIGHT = 187 + 60 + 58 + 7 + 200;

export function panelResizeBounds(layout: PanelLayout, viewport: Viewport): Record<ResizeKind, ResizeBounds> {
  const hasSidebar = viewport.width > 940;
  const desktop = viewport.width > 760;
  return {
    sidebar: { min: 170, max: hasSidebar ? Math.max(170, Math.min(360, viewport.width - layout.chatWidth - 360 - 48)) : 360 },
    chat: { min: 280, max: desktop ? Math.max(280, Math.min(620, viewport.width - (hasSidebar ? layout.sidebarWidth : 0) - 360 - 48)) : 620 },
    chart: { min: 100, max: Math.max(100, Math.min(450, viewport.height - CHART_RESERVED_HEIGHT)) },
  };
}

export function fitPanelLayout(layout: PanelLayout, viewport: Viewport): PanelLayout {
  let sidebarWidth = clamp(layout.sidebarWidth, 170, 360);
  const hasSidebar = viewport.width > 940;
  const desktop = viewport.width > 760;
  const chatMax = desktop ? Math.min(620, viewport.width - (hasSidebar ? sidebarWidth : 0) - 360 - 48) : 620;
  const chatWidth = clamp(layout.chatWidth, 280, chatMax);
  if (hasSidebar) sidebarWidth = clamp(sidebarWidth, 170, Math.min(360, viewport.width - chatWidth - 360 - 48));
  const chartHeight = clamp(layout.chartHeight, 100, panelResizeBounds(layout, viewport).chart.max);
  return { sidebarWidth, chatWidth, chartHeight };
}

function defaults(viewport: Viewport): PanelLayout {
  return fitPanelLayout({ sidebarWidth: Math.min(272, viewport.width * 0.16), chatWidth: Math.min(480, Math.max(320, viewport.width * 0.265)), chartHeight: 207 }, viewport);
}

export function usePanelLayout() {
  const [layout, setLayout] = useState<PanelLayout>(INITIAL);
  const [isDragging, setIsDragging] = useState(false);
  const layoutRef = useRef(layout);
  const viewportRef = useRef<Viewport>({ width: 1280, height: 800 });
  const initializedRef = useRef(false);
  const finishDragRef = useRef<(() => void) | null>(null);

  const applyLayout = useCallback((next: PanelLayout) => {
    const fitted = fitPanelLayout(next, viewportRef.current);
    layoutRef.current = fitted;
    setLayout(fitted);
  }, []);

  useEffect(() => {
    const measure = () => {
      viewportRef.current = { width: window.innerWidth, height: window.innerHeight };
      applyLayout(initializedRef.current ? layoutRef.current : defaults(viewportRef.current));
      initializedRef.current = true;
    };
    measure();
    window.addEventListener("resize", measure);
    return () => { window.removeEventListener("resize", measure); finishDragRef.current?.(); };
  }, [applyLayout]);

  const resetLayout = useCallback(() => {
    finishDragRef.current?.();
    applyLayout(defaults(viewportRef.current));
  }, [applyLayout]);

  const resizeBy = useCallback((kind: ResizeKind, delta: number) => {
    if (!Number.isFinite(delta)) return;
    const current = layoutRef.current;
    applyLayout({ ...current, ...(kind === "sidebar" ? { sidebarWidth: current.sidebarWidth + delta } : kind === "chat" ? { chatWidth: current.chatWidth + delta } : { chartHeight: current.chartHeight + delta }) });
  }, [applyLayout]);

  const startResize = useCallback((kind: ResizeKind, event: ReactPointerEvent<HTMLElement>) => {
    if (event.isPrimary === false) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    finishDragRef.current?.();
    const initial = { ...layoutRef.current };
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const handle = event.currentTarget;
    handle.focus({ preventScroll: true });
    const body = document.body;
    const oldCursor = body.style.cursor;
    const oldSelect = body.style.userSelect;
    const oldWebkitSelect = body.style.getPropertyValue("-webkit-user-select");
    const alreadyResizing = body.classList.contains("panel-resizing");
    const oldKind = body.dataset.panelResize;
    body.style.cursor = kind === "chart" ? "row-resize" : "col-resize";
    body.style.userSelect = "none";
    body.style.setProperty("-webkit-user-select", "none");
    body.classList.add("panel-resizing");
    body.dataset.panelResize = kind;
    setIsDragging(true);
    try { handle.setPointerCapture(pointerId); } catch { /* Window listeners still cover unsupported pointer capture. */ }

    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      if (pointer.cancelable) pointer.preventDefault();
      const dx = pointer.clientX - startX;
      const dy = pointer.clientY - startY;
      applyLayout({ ...initial, ...(kind === "sidebar" ? { sidebarWidth: initial.sidebarWidth + dx } : kind === "chat" ? { chatWidth: initial.chatWidth - dx } : { chartHeight: initial.chartHeight - dy }) });
    };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("blur", finish);
      window.removeEventListener("keydown", escape, true);
      try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId); } catch { /* The handle may have unmounted. */ }
      body.style.cursor = oldCursor;
      body.style.userSelect = oldSelect;
      if (oldWebkitSelect) body.style.setProperty("-webkit-user-select", oldWebkitSelect); else body.style.removeProperty("-webkit-user-select");
      if (!alreadyResizing) body.classList.remove("panel-resizing");
      if (oldKind == null) delete body.dataset.panelResize; else body.dataset.panelResize = oldKind;
      if (finishDragRef.current === finish) finishDragRef.current = null;
      setIsDragging(false);
    };
    const end = (pointer: PointerEvent) => { if (pointer.pointerId === pointerId) finish(); };
    const escape = (keyboard: KeyboardEvent) => { if (keyboard.key === "Escape") { keyboard.preventDefault(); finish(); } };
    finishDragRef.current = finish;
    window.addEventListener("pointermove", move, { capture: true, passive: false });
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("blur", finish);
    window.addEventListener("keydown", escape, true);
  }, [applyLayout]);

  return { ...layout, bounds: panelResizeBounds(layout, viewportRef.current), resetLayout, startResize, resizeBy, isDragging };
}

export default usePanelLayout;

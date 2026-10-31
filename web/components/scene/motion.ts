"use client";

import { createContext, useContext, useEffect, useState } from "react";

/** True when scene animation should advance; false freezes every animated part in place. */
export const SceneMotionContext = createContext(true);
export const useSceneMotion = () => useContext(SceneMotionContext);

/** Clamp frame deltas so a resumed tab or slow frame never teleports moving parts. */
export const stepOf = (animate: boolean, delta: number) => animate ? Math.min(delta, .1) : 0;

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function usePageVisible() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

export function metricOf(components: { tag: string; metrics: Record<string, number> }[], tag: string, key: string, fallback: number) {
  const value = components.find((item) => item.tag === tag)?.metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

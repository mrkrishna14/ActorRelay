"use client";

// One poller for the whole page. Glue is read once a second for both plants; every panel renders from this snapshot.
// There is no mock path: with glue down the snapshot holds no live data and the page says so.
import { useEffect, useSyncExternalStore } from "react";
import { ContractError, type GlueMeta, type StateBody } from "./contract";
import { fetchState, GlueError } from "./glue";
import { PLANT_IDS } from "./derive";
import type { CompanyState, ComponentView, PlantId, PlantState } from "./types";

export const POLL_MS = 1000;
export const REQUEST_TIMEOUT_MS = 20000;
/** Consecutive failed polls before the page leaves the plant views. */
export const FAILURES_TO_DISCONNECT = 3;
/** The timing chart shows 120 s; keep a little more so the left edge stays filled. */
export const SERIES_WINDOW_MS = 125_000;

export type Conn = "connecting" | "live" | "reconnecting" | "disconnected";

export type Sample = { t: number; v: number };

export type Snapshot = {
  conn: Conn;
  /** Set when glue answered but the body does not match shared/types.ts. */
  contractError: string | null;
  lastError: string | null;
  failures: number;
  lastOkAt: number | null;
  plants: Partial<Record<PlantId, PlantState>>;
  company: CompanyState | null;
  components: Record<string, ComponentView>;
  meta: GlueMeta | null;
  /** `${componentId}|${metric}` to samples, oldest first, recorded by this browser since the page opened. */
  series: Record<string, Sample[]>;
  /** Wall time each plant's tick last advanced, from this browser's clock. */
  tickAdvancedAt: Partial<Record<PlantId, number>>;
};

const initial: Snapshot = {
  conn: "connecting",
  contractError: null,
  lastError: null,
  failures: 0,
  lastOkAt: null,
  plants: {},
  company: null,
  components: {},
  meta: null,
  series: {},
  tickAdvancedAt: {},
};

export function seriesKey(componentId: string, metric: string): string {
  return `${componentId}|${metric}`;
}

export function appendSamples(
  series: Record<string, Sample[]>,
  components: Iterable<ComponentView>,
  now: number,
): Record<string, Sample[]> {
  const next: Record<string, Sample[]> = { ...series };
  for (const component of components) {
    for (const [metric, value] of Object.entries(component.metrics)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const key = seriesKey(component.id, metric);
      const kept = (next[key] ?? []).filter((sample) => now - sample.t <= SERIES_WINDOW_MS);
      kept.push({ t: now, v: value });
      next[key] = kept;
    }
  }
  return next;
}

function describe(error: unknown): string {
  if (error instanceof GlueError) return `HTTP ${error.status} from ${error.path}: ${error.message}`;
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return `no answer within ${REQUEST_TIMEOUT_MS / 1000} s`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

class GlueStore {
  private snapshot: Snapshot = initial;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = 0;
  private generation = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => initial;

  private publish(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  start() {
    this.running += 1;
    if (this.running === 1) void this.poll();
  }

  stop() {
    this.running -= 1;
    if (this.running === 0) {
      this.generation += 1;
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** After an operator action: read now instead of waiting for the next second. */
  refresh() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      void this.poll();
    }
  }

  private apply(bodies: StateBody[]) {
    const now = Date.now();
    const plants: Partial<Record<PlantId, PlantState>> = {};
    const components: Record<string, ComponentView> = {};
    const tickAdvancedAt = { ...this.snapshot.tickAdvancedAt };
    let company: CompanyState | null = null;
    let meta: GlueMeta | null = null;
    for (const body of bodies) {
      plants[body.plant.id] = body.plant;
      company = body.company;
      meta = body.meta;
      for (const component of body.components) components[component.id] = component;
      if (this.snapshot.plants[body.plant.id]?.tick !== body.plant.tick) tickAdvancedAt[body.plant.id] = now;
    }
    this.publish({
      conn: "live",
      contractError: null,
      lastError: null,
      failures: 0,
      lastOkAt: now,
      plants,
      company,
      components,
      meta,
      series: appendSamples(this.snapshot.series, Object.values(components), now),
      tickAdvancedAt,
    });
  }

  private fail(error: unknown) {
    const failures = this.snapshot.failures + 1;
    const hasData = this.snapshot.lastOkAt !== null;
    const conn: Conn = !hasData || failures >= FAILURES_TO_DISCONNECT ? "disconnected" : "reconnecting";
    this.publish({
      conn,
      failures,
      lastError: describe(error),
      contractError: error instanceof ContractError ? error.message : null,
    });
  }

  private async poll() {
    const generation = this.generation;
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const bodies = await Promise.all(PLANT_IDS.map((plantId) => fetchState(plantId, controller.signal)));
      if (generation === this.generation) this.apply(bodies);
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    } finally {
      clearTimeout(timeout);
    }
    if (generation !== this.generation) return;
    const wait = Math.max(0, POLL_MS - (Date.now() - started));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, wait);
  }
}

export const glueStore = new GlueStore();

export function useGlue(): Snapshot {
  const snapshot = useSyncExternalStore(glueStore.subscribe, glueStore.getSnapshot, glueStore.getServerSnapshot);
  useEffect(() => {
    glueStore.start();
    return () => glueStore.stop();
  }, []);
  return snapshot;
}

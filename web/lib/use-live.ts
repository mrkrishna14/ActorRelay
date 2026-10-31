"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DemoState } from "./demo";
import { fetchGlue, GLUE_URL, liveApi, toDemoState } from "./live";

export type LiveStatus = "connecting" | "live" | "offline";

/** Polls the integration service once a second; the dashboard falls back to demo data until it answers in live mode. */
export function useLive(): { state: DemoState | null; status: LiveStatus; error: string | null; api: ReturnType<typeof liveApi> } {
  const [state, setState] = useState<DemoState | null>(null);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const api = useMemo(() => liveApi(GLUE_URL), []);
  const prev = useRef<DemoState | null>(null);
  const failures = useRef(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), 2500);
      try {
        const [a, b] = await Promise.all([fetchGlue(GLUE_URL, "plant-a", controller.signal), fetchGlue(GLUE_URL, "plant-b", controller.signal)]);
        if (stopped) return;
        if (a.mode === "live" && b.mode === "live") {
          const next = toDemoState(a, b, prev.current, Date.now());
          prev.current = next;
          failures.current = 0;
          setState(next);
          setStatus("live");
          setError(null);
        } else {
          failures.current += 1;
          setStatus(failures.current >= 3 ? "offline" : "connecting");
          setError(`Integration service is in ${a.mode || b.mode || "unknown"} mode, not live`);
        }
      } catch (caught) {
        if (stopped) return;
        failures.current += 1;
        setError(caught instanceof Error ? caught.message : String(caught));
        if (failures.current >= 3) setStatus("offline");
      } finally {
        clearTimeout(abort);
        if (!stopped) timer = setTimeout(poll, 1000);
      }
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, []);

  return { state, status, error, api };
}

"use client";

import dynamic from "next/dynamic";
import { useCallback, useState, type ComponentProps, type ReactNode } from "react";
import { PidStage } from "./PidStage";

const Plant3D = dynamic(() => import("./Plant3D").then((module) => module.Plant3D), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center bg-lift text-xl text-ink-2">Loading the 3D plant</div>,
});

const TABS = [
  ["3d", "3D plant"],
  ["pid", "Process diagram"],
  ["hood", "Under the hood"],
] as const;

type Tab = (typeof TABS)[number][0];

/** Three views of one plant: the hall, the engineering diagram, and the systems running it. */
export function Stage({ hood, ...props }: ComponentProps<typeof PidStage> & { hood: ReactNode }) {
  const [view, setView] = useState<Tab>("3d");
  const [noWebGl, setNoWebGl] = useState(false);
  const onUnavailable = useCallback(() => setNoWebGl(true), []);
  const shown = noWebGl && view === "3d" ? "pid" : view;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-1 border-b border-hairline bg-panel px-4 pt-2 text-lg">
        {TABS.filter(([key]) => key !== "3d" || !noWebGl).map(([key, label]) => (
          <button key={key} onClick={() => setView(key)} className={`rounded-t-md border-b-[3px] px-4 py-1 font-semibold ${shown === key ? "border-ice text-ink" : "border-transparent text-ink-3 hover:text-ink"}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="relative min-h-0 flex-1">
        {shown === "3d" ? <Plant3D {...props} onUnavailable={onUnavailable} /> : shown === "pid" ? <PidStage {...props} caption={null} /> : hood}
      </div>
    </div>
  );
}

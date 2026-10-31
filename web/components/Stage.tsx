"use client";

import dynamic from "next/dynamic";
import { useCallback, useState, type ComponentProps } from "react";
import { PidStage } from "./PidStage";

const Plant3D = dynamic(() => import("./Plant3D").then((module) => module.Plant3D), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center bg-[#05090f] text-xl text-ink-2">Loading the 3D plant</div>,
});

/** The plant in 3D by default, the engineering P&ID one click away, and the P&ID alone if WebGL is unavailable. */
export function Stage(props: ComponentProps<typeof PidStage>) {
  const [view, setView] = useState<"3d" | "pid">("3d");
  const [noWebGl, setNoWebGl] = useState(false);
  const onUnavailable = useCallback(() => setNoWebGl(true), []);
  const shown = noWebGl ? "pid" : view;

  return (
    <div className="relative h-full">
      {shown === "3d" ? <Plant3D {...props} onUnavailable={onUnavailable} /> : <PidStage {...props} />}
      {noWebGl ? null : (
        <div className="absolute bottom-3 right-3 z-30 flex border border-white/15 bg-[#071018]/85 backdrop-blur-md">
          {(["3d", "pid"] as const).map((option) => (
            <button key={option} onClick={() => setView(option)} className={`px-3 py-1 font-semibold ${shown === option ? "bg-ice text-[#04121c]" : "text-ink-2 hover:text-ink"}`}>
              {option === "3d" ? "3D plant" : "P&ID"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

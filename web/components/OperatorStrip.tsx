"use client";

import { useState } from "react";
import { awaitingObservation, hasOpenProposal } from "@/lib/derive";
import { GlueError, propose, reset } from "@/lib/glue";
import { glueStore } from "@/lib/store";
import { formatTarget } from "@/lib/format";
import type { ComponentView, PlantId, PlantState } from "@/lib/types";
import { Word } from "./ui";

const TARGET = 85;

type Outcome = { tone: "ok" | "warn"; text: string } | null;

function failureText(error: unknown): string {
  if (error instanceof GlueError) return `Glue refused (${error.status}): ${error.message}`;
  if (error instanceof Error) return `Glue did not answer: ${error.message}`;
  return String(error);
}

export function OperatorStrip({ plantId, plant, pump, live }: { plantId: PlantId; plant: PlantState | undefined; pump: ComponentView | undefined; live: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const open = hasOpenProposal(plant);

  async function run(name: string, action: () => Promise<unknown>, done: string) {
    setBusy(name);
    setOutcome(null);
    try {
      await action();
      setOutcome({ tone: "ok", text: done });
    } catch (error) {
      setOutcome({ tone: "warn", text: failureText(error) });
    } finally {
      setBusy(null);
      glueStore.refresh();
    }
  }

  const proposeTarget = (name: string, rationale: string) =>
    run(
      name,
      () => propose({ plantId, proposerComponentId: `${plantId}/P-100`, metric: "speedPct", to: TARGET, rationale }),
      `Proposal sent to ${plantId}. It still needs every vote.`,
    );

  const speed = pump?.metrics.speedPct;
  const disabled = !live || open || awaitingObservation(plant) || busy !== null;

  return (
    <div className="flex h-[66px] shrink-0 items-center gap-3 border-t border-rule bg-panel px-4">
      <button
        disabled={disabled}
        onClick={() => void proposeTarget("increase", "Operator request: increase throughput")}
        className="flex h-[48px] items-center gap-3 bg-ice px-5 text-lg font-semibold text-ground hover:brightness-110 disabled:bg-raised disabled:text-ink-3"
      >
        Increase throughput
        <span className="num font-medium">
          P-100 {speed === undefined ? "--" : Math.round(speed)} → {TARGET}
        </span>
      </button>
      <button
        disabled={disabled}
        onClick={() => void proposeTarget("force", "Operator force: run P-100 at 85% again")}
        className="h-[48px] border border-ice px-5 text-lg font-semibold text-ice hover:bg-[var(--tint-ice)] disabled:border-hairline disabled:text-ink-3"
      >
        Force P-100 → {formatTarget("speedPct", TARGET).replace(" ", "")}
      </button>

      <div className="min-w-0 flex-1 truncate px-2 text-ink-2">
        {outcome ? <Word tone={outcome.tone}>{outcome.text}</Word> : open ? "A proposal is open. Operator changes wait until it is decided." : null}
      </div>

      <button
        disabled={!live || busy !== null}
        onClick={() => void run("reset", () => reset(), "Reset sent. Actors reseeded, both plants back to design.")}
        className="h-[48px] border border-rule px-5 text-lg text-ink-2 hover:text-ink disabled:text-ink-3"
      >
        Reset demo
      </button>
    </div>
  );
}

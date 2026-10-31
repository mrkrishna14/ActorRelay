"use client";

import { useState } from "react";
import { byTime, tagOf, type Plants } from "@/lib/derive";
import { GlueError, veto } from "@/lib/glue";
import { glueStore } from "@/lib/store";
import type { ComponentView, PlantId, PlantState, Proposal, Vote } from "@/lib/types";

const PLAIN: Record<string, string> = {
  "P-100": "Feed pump",
  "TK-101": "Hold tank",
  "LV-101": "Outlet valve",
  "E-101": "Steam coil",
  "TV-101": "Steam valve",
};

export const plainName = (componentId: string) => PLAIN[tagOf(componentId)] ?? tagOf(componentId);

const STEPS = ["Proposed", "Agents vote", "Decision", "Executed", "Learned"];

function refusal(vote: Vote, components: Record<string, ComponentView>) {
  const limits = components[vote.componentId]?.limits ?? {};
  for (const [metric, value] of Object.entries(vote.predicted)) {
    const limit = limits[metric];
    if (limit === undefined || !Number.isFinite(value)) continue;
    const line = limit.critical * (1 - vote.marginPct / 100);
    if (value >= line) return { value: value.toFixed(0), line: line.toFixed(0) };
  }
  return null;
}

function tell(proposal: Proposal | undefined, plant: PlantState | undefined, components: Record<string, ComponentView>, now: number) {
  if (proposal === undefined) return { step: -1, line: "Every machine has an AI agent. No change happens until they all agree.", tone: "text-ink" };
  const change = `${proposal.from.toFixed(0)}% to ${proposal.to.toFixed(0)}%`;
  if (proposal.status === "voting") {
    return { step: 1, line: `${proposal.votes.length} of ${proposal.requiredVoters.length} machines have answered: pump ${change}?`, tone: "text-ink" };
  }
  if (proposal.status === "blocked") {
    const no = proposal.votes.find((vote) => vote.vote === "no" && vote.evidenceRuleIds.length > 0) ?? proposal.votes.find((vote) => vote.vote === "no");
    const why = no ? refusal(no, components) : null;
    if (no && why) return { step: 2, line: `Blocked. ${plainName(no.componentId)} refused: at ${proposal.to.toFixed(0)}% it would reach ${why.value}%, past its ${why.line}% limit.`, tone: "text-bad" };
    return { step: 2, line: no ? `Blocked. ${plainName(no.componentId)} refused pump ${change}.` : `Blocked: pump ${change}.`, tone: "text-bad" };
  }
  if (proposal.status === "veto_window") {
    const left = proposal.vetoDeadline ? Math.max(0, Math.ceil((Date.parse(proposal.vetoDeadline) - now) / 1000)) : 0;
    return { step: 2, line: `All machines agreed on pump ${change}. ${left}s for a human to veto.`, tone: "text-ink" };
  }
  if (proposal.status === "executed") {
    const seen = plant?.history.some((event) => event.proposalId === proposal.id);
    if (seen) return { step: 4, line: `Done: pump ${change}. The result is saved as memory for the next decision.`, tone: "text-ok" };
    return { step: 3, line: `Approved. The plant is moving: pump ${change}.`, tone: "text-ok" };
  }
  if (proposal.status === "vetoed") return { step: 2, line: `A human vetoed pump ${change}.`, tone: "text-bad" };
  return { step: 2, line: `No decision in time: pump ${change} expired.`, tone: "text-ink-2" };
}

/** The human's say. It sits on the main view because the window is only ten seconds long. */
function VetoButton({ proposalId }: { proposalId: string }) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  async function onVeto() {
    setBusy(true);
    setRefused(null);
    try {
      await veto(proposalId, "operator");
    } catch (error) {
      setRefused(error instanceof GlueError ? `Refused (${error.status}): ${error.message}` : String(error));
    } finally {
      setBusy(false);
      glueStore.refresh();
    }
  }

  return (
    <div className="flex items-center gap-3">
      {refused ? <span className="text-lg text-bad">{refused}</span> : null}
      <button disabled={busy} onClick={() => void onVeto()} className="rounded-md bg-bad px-6 py-1 text-lg font-bold text-white disabled:opacity-60">
        Veto
      </button>
    </div>
  );
}

export function StoryCard({ view, plants, components, now, details, onDetails, onTour, tour }: { view: PlantId; plants: Plants; components: Record<string, ComponentView>; now: number; details: boolean; onDetails: () => void; onTour: () => void; tour: boolean }) {
  const plant = plants[view];
  const proposal = plant ? byTime(plant.proposals).at(-1) : undefined;
  const { step, line, tone } = tell(proposal, plant, components, now);
  const votes = proposal?.requiredVoters.map((id) => ({ id, vote: proposal.votes.find((item) => item.componentId === id)?.vote ?? null })) ?? [];

  return (
    <div className="border-t border-hairline bg-panel px-6 py-4">
      <div className="flex items-start justify-between gap-6">
        <p className={`text-[26px] font-semibold leading-[34px] ${tone}`}>{line}</p>
        <div className="flex shrink-0 items-center gap-5">
          {proposal?.status === "veto_window" ? <VetoButton proposalId={proposal.id} /> : null}
          <button onClick={onDetails} className="text-lg font-semibold text-ice hover:underline">
            {details ? "Hide details" : "Why? See evidence"}
          </button>
          {tour ? null : (
            <button onClick={onTour} className="rounded-md bg-ice px-4 py-1 text-lg font-semibold text-white">
              Guided tour
            </button>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-6">
        <ol className="flex items-center gap-2 text-lg">
          {STEPS.map((label, index) => (
            <li key={label} className={`flex items-center gap-2 ${index <= step ? "font-semibold text-ink" : "text-ink-3"}`}>
              <span aria-hidden className={`size-3 rounded-full ${index <= step ? "bg-ice" : "bg-rule"}`} />
              {label}
              {index < STEPS.length - 1 ? <span aria-hidden className="mx-1 h-px w-6 bg-rule" /> : null}
            </li>
          ))}
        </ol>
        <ul className="flex flex-wrap justify-end gap-2 text-lg">
          {votes.map(({ id, vote }) => (
            <li key={id} className={`rounded-full border px-3 ${vote === "no" ? "border-bad text-bad" : vote === "yes" ? "border-ok text-ok" : "border-rule text-ink-2"}`}>
              {plainName(id)}
              {id.startsWith(view) ? "" : " (other plant)"}: {vote ?? "voting"}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

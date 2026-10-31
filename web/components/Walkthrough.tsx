"use client";

// A guided tour for a first-time viewer. Every step is worked out from real state and every button calls the real system:
// nothing here is scripted, so if a step stalls the tour stalls with it. Vote text is the agents' own recorded output.
import { useEffect, useRef, useState } from "react";
import { byTime, type Plants } from "@/lib/derive";
import { formatNumber } from "@/lib/format";
import { propose, reset } from "@/lib/glue";
import { glueStore } from "@/lib/store";
import type { ComponentView, PlantId, PlantState, Proposal, Vote } from "@/lib/types";
import { plainName } from "./StoryCard";

type Step = { title: string; say: string; inside: string; action?: { label: string; run: () => Promise<unknown> } };

type Line = { key: string; who: string; text: string; tone: "ask" | "yes" | "no" | "system"; tag?: string };

const roots = (plant: PlantState | undefined) => (plant ? byTime(plant.proposals).filter((proposal) => proposal.parentProposalId === null) : []);
const counterOf = (plant: PlantState | undefined, parent: Proposal | undefined) => (parent ? byTime(plant?.proposals ?? []).find((proposal) => proposal.parentProposalId === parent.id) : undefined);
const observed = (plant: PlantState | undefined, proposal: Proposal | undefined) => Boolean(proposal && plant?.history.some((event) => event.proposalId === proposal.id));

const ask = (plantId: PlantId, rationale: string) => propose({ plantId, proposerComponentId: `${plantId}/P-100`, metric: "speedPct", to: 85, rationale });

function voteLine(proposal: Proposal, vote: Vote, components: Record<string, ComponentView>): Line {
  const name = plainName(vote.componentId);
  const other = vote.componentId.split("/")[0] !== proposal.plantId;
  const limits = components[vote.componentId]?.limits ?? {};
  const metric = Object.keys(vote.predicted).find((key) => limits[key] !== undefined) ?? Object.keys(vote.predicted)[0];
  const value = metric === undefined ? undefined : vote.predicted[metric];
  const limit = metric === undefined ? undefined : limits[metric];
  const line = limit ? limit.critical * (1 - vote.marginPct / 100) : undefined;
  const reading = metric !== undefined && value !== undefined ? formatNumber(metric, value) : null;
  const memories = vote.evidenceEventIds.length;
  const reason = vote.reason.toLowerCase();
  const text =
    vote.vote === "no"
      ? `No. ${reading && line !== undefined && metric ? `I'd reach ${reading}, past my limit of ${formatNumber(metric, line)}.` : "This isn't safe for me."} I checked ${memories} past ${memories === 1 ? "run" : "runs"}.`
      : `Yes. ${reading ? `I expect ${reading}, which is safe.` : "That's safe for me."} I checked ${memories} past ${memories === 1 ? "run" : "runs"}.`;
  const tag = reason.includes("no model call") ? "decided from memory, no AI call" : reason.includes("gpt fallback") ? "GPT standing in for Claude" : undefined;
  return { key: `${proposal.id}-${vote.componentId}`, who: `${name}${other ? " (other plant)" : ""}`, text, tone: vote.vote, tag };
}

function conversation(plant: PlantState | undefined, components: Record<string, ComponentView>): Line[] {
  if (plant === undefined) return [];
  return byTime(plant.proposals).flatMap((proposal) => {
    const counter = proposal.parentProposalId !== null;
    const opening: Line = {
      key: proposal.id,
      who: counter ? "Feed pump" : "Operator",
      text: counter ? `That was refused. Could we try ${proposal.to.toFixed(0)}% instead?` : `Can we raise the pump to ${proposal.to.toFixed(0)}%?`,
      tone: "ask",
    };
    const lines = [opening, ...proposal.votes.map((vote) => voteLine(proposal, vote, components))];
    if (proposal.status === "blocked") lines.push({ key: `${proposal.id}-blocked`, who: "System", text: "Blocked: one no is enough.", tone: "system" });
    if (proposal.status === "executed") lines.push({ key: `${proposal.id}-done`, who: "System", text: "Everyone agreed, so the change went ahead.", tone: "system" });
    return lines;
  });
}

function stepFor(plants: Plants, now: number, tour: { onView: (view: PlantId) => void; onClose: () => void }): { number: number; step: Step } {
  const a = plants["plant-a"];
  const b = plants["plant-b"];
  const [first, repeat] = roots(a);
  const counter = counterOf(a, first);
  const bFirst = roots(b)[0];

  if (first === undefined) {
    return {
      number: 1,
      step: {
        title: "Meet the factory",
        say: "This is a simulated factory that heats liquid in a tank. Every machine has its own AI agent, like a specialist looking after that one machine. No setting changes until every connected machine agrees.",
        inside: "Each machine's memory lives in a Durable Actor, so nothing is forgotten, even after a crash.",
        action: { label: "Ask for more output", run: () => ask("plant-a", "Operator asks for more throughput. Shared steam header: the other plant votes too.") },
      },
    };
  }
  if (first.status === "voting") {
    return {
      number: 2,
      step: {
        title: "The machines are talking",
        say: "The operator asked to push the pump from 50% to 85%. That affects the whole line, so every connected machine is checking its own memory and answering. The steam valve in the other plant joins too, because both plants share one steam pipe.",
        inside: "The question and each answer travel between agents over Agent Relay.",
      },
    };
  }
  if (counter === undefined) {
    return {
      number: 3,
      step: {
        title: "One machine said no",
        say: "One no is enough to stop the change. The machine used its past runs to predict what would happen, and that prediction crossed its safety limit. Nothing in the factory moved. The pump's agent now looks for a safer number.",
        inside: "The safety limit is enforced in code, so an AI model can't talk its way past it.",
      },
    };
  }
  if (counter.status === "voting") {
    return {
      number: 4,
      step: {
        title: "They negotiate",
        say: `The pump's agent proposed ${counter.to.toFixed(0)}% instead. Every machine checks again. This is a real negotiation: the agents are working out what is safe, without a person in the middle.`,
        inside: "The counter-offer goes through the same vote as the first request.",
      },
    };
  }
  if (counter.status === "veto_window") {
    const left = counter.vetoDeadline ? Math.max(0, Math.ceil((Date.parse(counter.vetoDeadline) - now) / 1000)) : 0;
    return {
      number: 5,
      step: {
        title: `A human gets the last word: ${left}s`,
        say: "All the machines agreed. Before anything moves, a person gets ten seconds to veto. The AI recommends, and people stay in charge.",
        inside: "Only the plant's durable actor can release the change, once, after this window closes.",
      },
    };
  }
  if (!observed(a, counter)) {
    return {
      number: 6,
      step: {
        title: "The factory moves",
        say: `The change is going into the plant now. The pump is rising to ${counter.to.toFixed(0)}%, and the valve and steam follow on their own. Watch the numbers change on the machines.`,
        inside: "This is a running simulation of the tank's physics, not an animation.",
      },
    };
  }
  if (repeat === undefined) {
    return {
      number: 7,
      step: {
        title: "Every machine learns",
        say: "Each agent compared what it predicted with what really happened, and saved the result as a memory. Now let's ask for the risky 85% again and see if they remember.",
        inside: "Memories and prediction scores are stored durably in each machine's actor.",
        action: { label: "Ask for 85% again", run: () => ask("plant-a", "Operator asks for 85 again.") },
      },
    };
  }
  if (repeat.status !== "blocked") {
    return { number: 8, step: { title: "Asking again", say: "The same request is going out. The machines now have a fresh memory to check it against.", inside: "The newest run is retrieved first." } };
  }
  if (bFirst === undefined) {
    return {
      number: 8,
      step: {
        title: "It learned",
        say: "Refused again, and the outlet valve pointed to the run it just saw. Now the best part: Plant B is a separate factory that has never run this fast. Will it know what Plant A learned?",
        inside: "Plant A's lesson was promoted to a company rule, because Plant B has the same model of valve.",
        action: {
          label: "Try it in Plant B",
          run: async () => {
            tour.onView("plant-b");
            await ask("plant-b", "Operator asks Plant B for 85.");
          },
        },
      },
    };
  }
  if (bFirst.status === "voting") {
    return { number: 9, step: { title: "Plant B is deciding", say: "Plant B has never tried this. Its machines have no experience of their own here, so they look at what the whole company has learned.", inside: "The rule comes from the shared company actor." } };
  }
  return {
    number: 10,
    step: {
      title: "Plant B learned from Plant A",
      say: "Plant B refused a change it has never tried, using a lesson from a different plant. That's the whole idea: every machine has a voice, every change needs agreement, and every plant learns from every other.",
      inside: "Durable Actors are the memory. Agent Relay is the conversation.",
      action: { label: "Finish the tour", run: async () => tour.onClose() },
    },
  };
}

export function Walkthrough({ plants, components, view, now, onView, onClose }: { plants: Plants; components: Record<string, ComponentView>; view: PlantId; now: number; onView: (view: PlantId) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const current = stepFor(plants, now, { onView, onClose });
  const lines = conversation(plants[view], components);

  // The system runs at its own speed; the presenter moves through what has already happened with Next.
  const seen = useRef<{ number: number; step: Step }[]>([]);
  const [shown, setShown] = useState(0);
  const last = seen.current.at(-1);
  if (last === undefined || current.number > last.number) seen.current.push(current);
  else if (current.number < last.number) seen.current = [current];
  else seen.current[seen.current.length - 1] = current;
  const position = Math.min(shown, seen.current.length - 1);
  const atLatest = position === seen.current.length - 1;
  const { number, step } = seen.current[position] ?? current;

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [lines.length]);

  async function go(action: () => Promise<unknown>) {
    setBusy(true);
    setProblem(null);
    try {
      await action();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      glueStore.refresh();
    }
  }

  return (
    <aside className="flex min-h-0 flex-col border-l border-hairline bg-panel">
      <div className="border-b border-hairline p-5">
        <div className="flex items-center justify-between">
          <span className="text-lg font-semibold text-ice">Step {number} of 10</span>
          <button onClick={onClose} className="text-lg text-ink-3 hover:text-ink">
            Close tour
          </button>
        </div>
        <h2 className="mt-1 text-[30px] font-bold leading-[36px] text-ink">{step.title}</h2>
        <p className="mt-2 text-[19px] leading-[28px] text-ink-2">{step.say}</p>
        <p className="mt-2 text-lg leading-[25px] text-ink-3">{step.inside}</p>
        {problem ? <p className="mt-2 text-lg text-bad">That didn't go through: {problem}</p> : null}
        <div className="mt-3 flex gap-3">
          {!atLatest ? (
            <button onClick={() => setShown(position + 1)} className="rounded-md bg-ice px-5 py-2 text-lg font-semibold text-white">
              Next
            </button>
          ) : step.action ? (
            <button
              disabled={busy}
              onClick={() => {
                const action = step.action;
                if (action === undefined) return;
                setShown(seen.current.length);
                void go(action.run);
              }}
              className="rounded-md bg-ice px-5 py-2 text-lg font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Working…" : step.action.label}
            </button>
          ) : (
            <span className="py-2 text-lg font-medium text-ink-2">Happening live now…</span>
          )}
          <button
            disabled={busy}
            onClick={() => {
              seen.current = [];
              setShown(0);
              void go(() => reset());
            }}
            className="rounded-md border border-rule px-4 py-2 text-lg text-ink-2 hover:text-ink disabled:opacity-50"
          >
            Start over
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-5">
        <h3 className="text-lg font-semibold text-ink">What the agents are saying</h3>
        {lines.length === 0 ? <p className="mt-2 text-lg text-ink-3">Their conversation appears here as it happens.</p> : null}
        <ol ref={list} className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-auto pr-1">
          {lines.map((line) => (
            <li key={line.key} className={`rounded-lg border px-3 py-2 ${line.tone === "no" ? "border-bad bg-[var(--tint-bad)]" : line.tone === "yes" ? "border-hairline bg-raised" : line.tone === "ask" ? "border-ice bg-[var(--tint-ice)]" : "border-hairline bg-lift"}`}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-lg font-semibold text-ink">{line.who}</span>
                {line.tone === "yes" || line.tone === "no" ? <span className={`text-lg font-bold uppercase ${line.tone === "no" ? "text-bad" : "text-ok"}`}>{line.tone}</span> : null}
              </div>
              <p className="text-lg leading-[25px] text-ink-2">{line.text}</p>
              {line.tag ? <p className="text-lg text-ink-3">{line.tag}</p> : null}
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
}

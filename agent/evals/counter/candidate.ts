// SPEC-LITERAL STAND-INS, NOT THE SHIPPED AGENTS.
// They implement TASK1.MD deliverables 2 and 3 as written so model behaviour can be measured
// before agent/vote.ts and agent/counter.ts exist. Numbers from `--impl candidate` must be
// labelled as such and never reported as results for the real modules.
import { z } from "zod";
import type { ComponentState, HistoryEvent, LearnedRule, Proposal, Vote } from "../../../shared/types";
import { PHYSICS_SUMMARY, thresholdOf } from "./fixture";
import type { Llm } from "./llm";

const VoteReply = z.object({
  vote: z.enum(["yes", "no"]),
  reason: z.string().min(1),
  predicted: z.record(z.string(), z.number()),
});
const CounterReply = z.object({ to: z.number().finite(), rationale: z.string().min(1) });

export function parseJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(text.slice(start, end + 1));
}

function eventRows(events: HistoryEvent[], own: ComponentState): string {
  return events
    .map((e) => {
      const effects = e.effects
        .filter((row) => row.componentId === own.id)
        .map((row) => `${row.metric} ${row.before}->${row.after}`)
        .join(", ");
      return `${e.id}: ${e.metric} ${e.before}->${e.after} | ${effects || "no rows for this component"} | incident: ${e.incident ?? "none"}`;
    })
    .join("\n");
}

export async function castVote(proposal: Proposal, own: ComponentState, events: HistoryEvent[], rules: LearnedRule[], llm: Llm): Promise<Vote> {
  const system = [
    `You are agent:${own.id}, the ${own.role} for ${own.tag} (${own.name}) in a simulated plant.`,
    `Predict the effect of the proposed change on your own equipment from retrieved history and physics, then vote.`,
    `Physics: ${PHYSICS_SUMMARY}`,
    `Return ONLY JSON: {"vote":"yes"|"no","reason":string,"predicted":{"<own metric>":number}}.`,
    `predicted must hold your peak value for each metric in your limits.`,
  ].join("\n");
  const user = [
    `Proposal: ${proposal.proposerComponentId} ${proposal.metric} ${proposal.from} -> ${proposal.to}. ${proposal.rationale}`,
    `Own metrics: ${JSON.stringify(own.metrics)}`,
    `Own limits: ${JSON.stringify(own.limits)}`,
    `marginPct: ${own.marginPct}. Vote no if a predicted value reaches critical * (1 - marginPct/100).`,
    `Retrieved events (${events.length}):`,
    eventRows(events, own) || "none",
    `Rules: ${rules.map((r) => `${r.id}: ${r.text}`).join("; ") || "none"}`,
  ].join("\n");

  const ask = async () => VoteReply.parse(parseJson(await llm(system, user)));
  let reply;
  try {
    reply = await ask().catch(() => ask());
  } catch {
    reply = { vote: "no" as const, reason: "malformed prediction", predicted: {} };
  }

  let vote = reply.vote;
  let reason = reply.reason;
  const entries = Object.entries(reply.predicted);
  const nearCritical = entries.some(([metric, value]) => {
    const limit = own.limits[metric];
    return limit !== undefined && value >= limit.critical * 0.85;
  });
  if (events.length < 3 && nearCritical) {
    vote = "no";
    reason = `insufficient history: ${reason}`;
  }
  for (const [metric, value] of entries) {
    const threshold = thresholdOf(own, metric);
    if (threshold !== null && value >= threshold) {
      vote = "no";
      reason = `${metric} ${value} reaches threshold ${threshold}: ${reason}`;
    }
  }
  return {
    proposalId: proposal.id,
    componentId: own.id,
    agentId: `agent:${own.id}`,
    vote,
    reason,
    predicted: reply.predicted,
    marginPct: own.marginPct,
    evidenceEventIds: events.map((e) => e.id),
    evidenceRuleIds: rules.map((r) => r.id),
    similarCount: events.length,
  };
}

export type CounterInput = { chain: Proposal[]; proposer: ComponentState; voters: ComponentState[] };

export async function buildCounter({ chain, proposer, voters }: CounterInput, llm: Llm): Promise<{ to: number; rationale: string } | null> {
  const parent = chain[chain.length - 1]!;
  const blocking = chain.flatMap((p) => p.votes.filter((v) => v.vote === "no").map((v) => ({ to: p.to, v })));
  const thresholds = voters.flatMap((v) =>
    Object.keys(v.limits).map((metric) => `${v.id} ${metric}: threshold ${thresholdOf(v, metric)!.toFixed(1)} (critical ${v.limits[metric]!.critical}, margin ${v.marginPct}%)`),
  );
  const system = [
    `You are agent:${proposer.id}, the ${proposer.role} for ${proposer.tag} (${proposer.name}) in a simulated plant.`,
    `Your proposal was blocked. Offer a counter-proposal: a value between from and to that stays under every voter's threshold.`,
    `Physics: ${PHYSICS_SUMMARY}`,
    `Return ONLY JSON: {"to":number,"rationale":string}. The rationale cites the blocking votes.`,
  ].join("\n");
  const user = [
    `Blocked proposal: ${parent.metric} from ${parent.from} to ${parent.to}.`,
    `Blocking votes:`,
    ...blocking.map(({ to, v }) => `at ${to}: ${v.componentId} predicted ${JSON.stringify(v.predicted)}: ${v.reason}`),
    `Voter thresholds:`,
    ...thresholds,
    `Proposer limits: ${JSON.stringify(proposer.limits)}`,
  ].join("\n");
  const reply = CounterReply.parse(parseJson(await llm(system, user)));
  return reply;
}

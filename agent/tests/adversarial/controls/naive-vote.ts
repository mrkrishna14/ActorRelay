// CONTROL, NOT PRODUCT CODE. A literal reading of the vote steps in TASK1.MD, written by the adversarial suite so
// the tests can be shown to fail. `ADV_TARGET=naive bun test tests/adversarial` runs them against this.
// Every test this control fails is a hole a literal implementation of the spec would have.
import { z } from "zod";
import type { ComponentState, HistoryEvent, LearnedRule, Proposal, Vote } from "../../../../shared/types";

const Reply = z.object({
  vote: z.enum(["yes", "no"]),
  reason: z.string(),
  predicted: z.record(z.string(), z.number()),
  marginPct: z.number(),
  evidenceEventIds: z.array(z.string()),
  evidenceRuleIds: z.array(z.string()),
  similarCount: z.number(),
});

export type NaiveInput = {
  proposal: Proposal;
  own: ComponentState;
  events: HistoryEvent[];
  rules: LearnedRule[];
  llm: (prompt: string, attempt: number) => Promise<string>;
};

export async function naiveVote({ proposal, own, events, rules, llm }: NaiveInput): Promise<Vote> {
  const prompt = [
    `Proposal: ${JSON.stringify(proposal)}`,
    `Own state: ${JSON.stringify(own)}`,
    `Events: ${JSON.stringify(events)}`,
    `Rules: ${JSON.stringify(rules)}`,
    "Return ONLY JSON matching Vote.",
  ].join("\n");

  let parsed: z.infer<typeof Reply> | null = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    try {
      parsed = Reply.parse(JSON.parse(await llm(prompt, attempt)));
    } catch {
      parsed = null;
    }
  }

  const base = { proposalId: proposal.id, componentId: own.id, agentId: `agent:${own.id}`, marginPct: own.marginPct };
  const eventIds = new Set(events.map((e) => e.id));
  const ruleIds = new Set(rules.map((r) => r.id));
  if (!parsed) {
    return { ...base, vote: "no", reason: "malformed prediction", predicted: {}, evidenceEventIds: [], evidenceRuleIds: [], similarCount: events.length };
  }

  let vote = parsed.vote;
  let reason = parsed.reason;
  for (const [metric, value] of Object.entries(parsed.predicted)) {
    const limit = own.limits[metric];
    if (!limit) continue;
    if (events.length < 3 && value >= limit.critical * 0.85) {
      vote = "no";
      reason = "insufficient history";
    }
    if (value >= limit.critical * (1 - own.marginPct / 100)) vote = "no";
  }
  return {
    ...base,
    vote,
    reason,
    predicted: parsed.predicted,
    evidenceEventIds: parsed.evidenceEventIds.filter((id) => eventIds.has(id)),
    evidenceRuleIds: parsed.evidenceRuleIds.filter((id) => ruleIds.has(id)),
    similarCount: events.length,
  };
}

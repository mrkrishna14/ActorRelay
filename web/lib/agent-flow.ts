import type { ChatMessage, ComponentTag, Equipment, PlantId, Proposal } from "./types";

export interface AgentFlowLink {
  id: string;
  from: string;
  to: string;
  kind: "request" | "yes" | "no";
  channel: PlantId | "company";
  active: boolean;
  evidence: string[];
}

const ACTIVE_MS = 6000;

/** Review routes come from the proposing equipment contract; votes come from recorded decisions. */
export function agentFlowLinks(proposal: Proposal | null, components: Equipment[], messages: ChatMessage[], now: number): AgentFlowLink[] {
  if (!proposal) return [];
  const proposer = `${proposal.plantId}/${proposal.proposerTag ?? "P-100"}`;
  const reviewers = components.filter((component) =>
    component.id !== proposer && (component.plantId === proposal.plantId || component.tag === "TV-101"));
  return reviewers.map((reviewer) => {
    const vote = proposal.votes.find((item) => item.plantId === reviewer.plantId && item.tag === reviewer.tag);
    const message = vote ? messages.findLast((item) =>
      item.proposalId === proposal.id && item.plantId === reviewer.plantId && item.tag === reviewer.tag) : undefined;
    const at = vote ? message?.at : proposal.createdAt;
    const age = at === undefined ? Infinity : now - at;
    return {
      id: `${proposal.id}:${reviewer.id}`,
      from: vote ? reviewer.id : proposer,
      to: vote ? proposer : reviewer.id,
      kind: vote?.vote ?? "request",
      channel: reviewer.plantId === proposal.plantId ? proposal.plantId : "company",
      active: vote ? age >= 0 && age < ACTIVE_MS : proposal.status === "voting",
      evidence: vote?.evidence ?? [],
    };
  });
}

export const FLOW_TAGS: ComponentTag[] = ["P-100", "TK-101", "LV-101", "E-101", "TV-101"];

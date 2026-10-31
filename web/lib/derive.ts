// Pure reads over contract state. Everything the dashboard claims, including both captions, is decided here so it can be
// tested without a browser. No timers and no demo script: a caption shows only while the state it describes exists.
import type {
  AuditEntry,
  CompanyState,
  ComponentId,
  ComponentView,
  HistoryEvent,
  LearnedRule,
  Limit,
  PlantId,
  PlantState,
  Proposal,
  Vote,
} from "./types";

export const PLANT_IDS: PlantId[] = ["plant-a", "plant-b"];
export const PLANT_LABEL: Record<PlantId, string> = { "plant-a": "Plant A", "plant-b": "Plant B" };
export const TAGS = ["P-100", "TK-101", "LV-101", "E-101", "TV-101"] as const;
export type Tag = (typeof TAGS)[number];

export type Plants = Partial<Record<PlantId, PlantState>>;

export const otherPlant = (id: PlantId): PlantId => (id === "plant-a" ? "plant-b" : "plant-a");
export const tagOf = (id: ComponentId): string => id.split("/")[1] ?? id;
export const plantOf = (id: ComponentId): PlantId => id.split("/")[0] as PlantId;

const ms = (iso: string): number => Date.parse(iso);

// ---------------------------------------------------------------- limits

/** The value an agent refuses past: limit.critical minus the component's safety margin. */
export function refusalThreshold(limit: Limit, marginPct: number): number {
  return limit.critical * (1 - marginPct / 100);
}

export type MetricLevel = "ok" | "warning" | "critical";

export function metricLevel(value: number, limit: Limit): MetricLevel {
  if (value >= limit.critical) return "critical";
  if (value > limit.max || value < limit.min) return "warning";
  return "ok";
}

// ---------------------------------------------------------------- proposals

export const isOpen = (proposal: Proposal): boolean => proposal.status === "voting" || proposal.status === "veto_window";

export function byTime(proposals: Proposal[]): Proposal[] {
  return [...proposals].sort((a, b) => ms(a.at) - ms(b.at));
}

export function rootOf(proposal: Proposal, proposals: Proposal[]): Proposal {
  let current = proposal;
  const seen = new Set<string>([current.id]);
  while (current.parentProposalId !== null) {
    const parent = proposals.find((item) => item.id === current.parentProposalId);
    if (parent === undefined || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  return current;
}

export type ProposalNode = { proposal: Proposal; children: ProposalNode[] };

export function threadFrom(root: Proposal, proposals: Proposal[]): ProposalNode {
  const children = byTime(proposals.filter((item) => item.parentProposalId === root.id));
  return { proposal: root, children: children.map((child) => threadFrom(child, proposals)) };
}

/** The newest proposal's whole family: a blocked parent with its counters nested under it. */
export function latestThread(plant: PlantState): ProposalNode | null {
  const sorted = byTime(plant.proposals);
  const latest = sorted[sorted.length - 1];
  if (latest === undefined) return null;
  return threadFrom(rootOf(latest, plant.proposals), plant.proposals);
}

export function flatten(node: ProposalNode): Proposal[] {
  return [node.proposal, ...node.children.flatMap(flatten)];
}

export function voteOf(proposal: Proposal, componentId: ComponentId): Vote | undefined {
  return proposal.votes.find((vote) => vote.componentId === componentId);
}

export type VoterState = "voting" | "yes" | "no" | "no vote";

export function voterState(proposal: Proposal, componentId: ComponentId): VoterState {
  const vote = voteOf(proposal, componentId);
  if (vote !== undefined) return vote.vote;
  return isOpen(proposal) ? "voting" : "no vote";
}

export type Outline = { tag: string; state: VoterState; pulsing: boolean; proposalId: string; fromPlant: PlantId };

/**
 * Who is outlined on a plant's drawing: the voters on that plant's newest proposal, plus any local component a proposal
 * in the other plant needs a vote from (the shared steam header).
 */
export function outlinesFor(view: PlantId, plants: Plants): Map<string, Outline> {
  const outlines = new Map<string, Outline>();
  const collect = (proposal: Proposal, fromPlant: PlantId) => {
    for (const voter of proposal.requiredVoters) {
      if (plantOf(voter) !== view) continue;
      const state = voterState(proposal, voter);
      const open = isOpen(proposal);
      outlines.set(tagOf(voter), { tag: tagOf(voter), state, pulsing: open || state === "no", proposalId: proposal.id, fromPlant });
    }
  };

  const foreign = plants[otherPlant(view)];
  if (foreign !== undefined) byTime(foreign.proposals).filter(isOpen).forEach((proposal) => collect(proposal, foreign.id));

  const own = plants[view];
  const latest = own === undefined ? undefined : byTime(own.proposals).at(-1);
  if (own !== undefined && latest !== undefined && (isOpen(latest) || latest.status === "blocked")) collect(latest, own.id);
  return outlines;
}

/** The component asking, while its proposal is open on this plant. */
export function activeProposer(view: PlantId, plants: Plants): string | null {
  const open = plants[view]?.proposals.find(isOpen);
  return open === undefined ? null : tagOf(open.proposerComponentId);
}

export function hasOpenProposal(plant: PlantState | undefined): boolean {
  return plant !== undefined && plant.proposals.some(isOpen);
}

export function openCrossPlantProposals(plants: Plants): Proposal[] {
  return PLANT_IDS.flatMap((id) => plants[id]?.proposals ?? []).filter((proposal) => proposal.crossPlant && isOpen(proposal));
}

export function crossPlantFeed(company: CompanyState | null, plants: Plants): Proposal[] {
  if (company === null) return [];
  const all = PLANT_IDS.flatMap((id) => plants[id]?.proposals ?? []);
  const listed = company.crossPlantProposals.flatMap((id) => all.filter((proposal) => proposal.id === id));
  return byTime(listed).reverse();
}

// ---------------------------------------------------------------- evidence

export function findEvent(plants: Plants, eventId: string): HistoryEvent | undefined {
  for (const id of PLANT_IDS) {
    const event = plants[id]?.history.find((item) => item.id === eventId);
    if (event !== undefined) return event;
  }
  return undefined;
}

export function findRule(plants: Plants, company: CompanyState | null, ruleId: string): LearnedRule | undefined {
  const fromCompany = company?.rules.find((rule) => rule.id === ruleId);
  if (fromCompany !== undefined) return fromCompany;
  for (const id of PLANT_IDS) {
    const rule = plants[id]?.rules.find((item) => item.id === ruleId);
    if (rule !== undefined) return rule;
  }
  return undefined;
}

/**
 * An event is from this session only when an executed proposal this plant still holds produced it. Seeded history has
 * proposalId null, and reset clears proposals, so neither can pass.
 */
export function sessionEvent(plant: PlantState, eventId: string): HistoryEvent | undefined {
  const event = plant.history.find((item) => item.id === eventId);
  if (event === undefined || event.proposalId === null) return undefined;
  const source = plant.proposals.find((proposal) => proposal.id === event.proposalId);
  return source?.status === "executed" ? event : undefined;
}

export function isSessionEvent(plants: Plants, event: HistoryEvent): boolean {
  const plant = plants[event.plantId];
  return plant !== undefined && sessionEvent(plant, event.id) !== undefined;
}

/** Plants that hold at least one event supporting the rule. */
export function ruleSupportPlants(rule: LearnedRule, plants: Plants): PlantId[] {
  return PLANT_IDS.filter((id) => plants[id]?.history.some((event) => rule.supportEventIds.includes(event.id)));
}

const FIRST_LEARNED = /first learned in (plant-a|plant-b)/;

/**
 * Where the rule came from. Company writes the provenance into the text and nulls the rule's component ids, so the text is
 * the record. Glue trims /state history, so support events only stand in when the text carries no provenance.
 */
export function ruleSourcePlant(rule: LearnedRule, plants: Plants): PlantId | null {
  const match = FIRST_LEARNED.exec(rule.text);
  if (match !== null) return match[1] as PlantId;
  const support = ruleSupportPlants(rule, plants);
  return support.length === 1 ? (support[0] ?? null) : null;
}

export type RuleCitation = { plantId: PlantId; componentId: ComponentId; proposalId: string; vote: Vote["vote"] };

export function ruleCitations(rule: LearnedRule, plants: Plants): RuleCitation[] {
  return PLANT_IDS.flatMap((plantId) =>
    (plants[plantId]?.proposals ?? []).flatMap((proposal) =>
      proposal.votes
        .filter((vote) => vote.evidenceRuleIds.includes(rule.id))
        .map((vote) => ({ plantId, componentId: vote.componentId, proposalId: proposal.id, vote: vote.vote })),
    ),
  );
}

// ---------------------------------------------------------------- captions

export function blockedInMs(plant: PlantState, proposal: Proposal): number | null {
  const entry = plant.audit.find((item) => item.kind === "block" && item.refId === proposal.id);
  if (entry === undefined) return null;
  return ms(entry.at) - ms(proposal.at);
}

export type Caption =
  | {
      kind: "it-learned";
      text: "It learned.";
      proposal: Proposal;
      vote: Vote;
      event: HistoryEvent;
      evidenceNumber: number;
      blockedInMs: number | null;
      firstBlockedInMs: number | null;
    }
  | {
      kind: "plant-learned";
      text: string;
      proposal: Proposal;
      vote: Vote;
      rule: LearnedRule;
      learner: PlantId;
      source: PlantId;
    };

function blockedInThread(plant: PlantState): Proposal[] {
  const thread = latestThread(plant);
  return thread === null ? [] : flatten(thread).filter((proposal) => proposal.status === "blocked");
}

function refusals(proposal: Proposal, plantId: PlantId): Vote[] {
  return proposal.votes.filter((vote) => vote.vote === "no" && plantOf(vote.componentId) === plantId);
}

/** A block in the newest thread whose refusal cites a run executed earlier in this session. */
export function itLearned(plant: PlantState): Extract<Caption, { kind: "it-learned" }> | null {
  for (const proposal of blockedInThread(plant)) {
    for (const vote of refusals(proposal, plant.id)) {
      for (const [index, eventId] of vote.evidenceEventIds.entries()) {
        const event = sessionEvent(plant, eventId);
        if (event === undefined || ms(event.at) >= ms(proposal.at)) continue;
        const firstBlock = byTime(plant.proposals).find(
          (item) =>
            item.id !== proposal.id &&
            item.status === "blocked" &&
            item.proposerComponentId === proposal.proposerComponentId &&
            item.metric === proposal.metric &&
            item.to === proposal.to &&
            ms(item.at) < ms(proposal.at),
        );
        return {
          kind: "it-learned",
          text: "It learned.",
          proposal,
          vote,
          event,
          evidenceNumber: index + 1,
          blockedInMs: blockedInMs(plant, proposal),
          firstBlockedInMs: firstBlock === undefined ? null : blockedInMs(plant, firstBlock),
        };
      }
    }
  }
  return null;
}

/** A refusal in this plant's newest thread citing a company rule whose support is all from the other plant. */
export function plantLearned(
  view: PlantId,
  plants: Plants,
  company: CompanyState | null,
): Extract<Caption, { kind: "plant-learned" }> | null {
  const plant = plants[view];
  if (plant === undefined || company === null) return null;
  for (const proposal of blockedInThread(plant)) {
    for (const vote of refusals(proposal, view)) {
      for (const ruleId of vote.evidenceRuleIds) {
        const rule = company.rules.find((item) => item.id === ruleId && item.scope === "company");
        if (rule === undefined) continue;
        const source = ruleSourcePlant(rule, plants);
        if (source === null || source === view) continue;
        return {
          kind: "plant-learned",
          text: `${PLANT_LABEL[view]} learned from ${PLANT_LABEL[source]}.`,
          proposal,
          vote,
          rule,
          learner: view,
          source,
        };
      }
    }
  }
  return null;
}

export function captionFor(view: PlantId, plants: Plants, company: CompanyState | null): Caption | null {
  const plant = plants[view];
  if (plant === undefined) return null;
  return plantLearned(view, plants, company) ?? itLearned(plant);
}

// ---------------------------------------------------------------- plant health and events

const SEVERITY: Record<ComponentView["status"], number> = { ok: 0, warning: 1, critical: 2, offline: 3 };

export function plantHealth(plantId: PlantId, components: Record<string, ComponentView>): ComponentView["status"] | null {
  const own = Object.values(components).filter((component) => component.plantId === plantId);
  if (own.length === 0) return null;
  return own.reduce((worst, component) => (SEVERITY[component.status] > SEVERITY[worst] ? component.status : worst), "ok" as ComponentView["status"]);
}

export function headerBarg(components: Record<string, ComponentView>, resourceComponents: ComponentId[]): number | null {
  for (const id of resourceComponents) {
    const value = components[id]?.metrics.headerBarg;
    if (typeof value === "number") return value;
  }
  return null;
}

export function mergedAudit(plants: Plants, company: CompanyState | null): AuditEntry[] {
  const seen = new Set<string>();
  const merged: AuditEntry[] = [];
  const entries = [...PLANT_IDS.flatMap((id) => plants[id]?.audit ?? []), ...(company?.audit ?? [])];
  for (const entry of entries) {
    const key = `${entry.at}|${entry.kind}|${entry.refId}|${entry.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged.sort((a, b) => ms(b.at) - ms(a.at));
}

export type SimStatus = { word: "running" | "stalled" | "disconnected" | "starting"; tone: "ok" | "warn" | "off" };

export const STALL_MS = 5000;

export function simStatus(plant: PlantState | undefined, tickAdvancedAt: number | undefined, now: number): SimStatus {
  if (plant === undefined) return { word: "starting", tone: "off" };
  if (!plant.connected) return { word: "disconnected", tone: "warn" };
  if (tickAdvancedAt === undefined || now - tickAdvancedAt > STALL_MS) return { word: "stalled", tone: "warn" };
  return { word: "running", tone: "ok" };
}

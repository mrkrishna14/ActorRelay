// In-memory glue for tests, built from shared/*.json. Same surface as HttpGlue; similar() matches Plant.similar:
// k nearest with no distance cutoff. Seed history comes from shared/history.json, or the labelled stand-in until it lands.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CalibrationEntry, ComponentId, ComponentState, HistoryEvent, LearnedRule, PlantId, PlantState, Proposal, Vote } from "../../shared/types";
import type { ComponentView, Glue, SimilarQuery } from "../glue";
import type { ProposalInput } from "../schemas";

const root = join(import.meta.dir, "..", "..");
const realHistory = join(root, "shared", "history.json");
const standIn = join(root, "actor", "tests", "fixtures-gen", "history.json");

export const usingStandInHistory = !existsSync(realHistory);

export function seedHistory(): HistoryEvent[] {
  return JSON.parse(readFileSync(usingStandInHistory ? standIn : realHistory, "utf8"));
}

export function seedComponents(): ComponentState[] {
  const plants = JSON.parse(readFileSync(join(root, "shared", "plants.json"), "utf8")) as { plants: { components: ComponentState[] }[] };
  return plants.plants.flatMap((p) => p.components);
}

const upstreamRange: Record<string, number> = { feedM3h: 30, headerBarg: 2, feedTempC: 20 };

export class FakeGlue implements Glue {
  readonly components = new Map<ComponentId, ComponentView>();
  readonly history: HistoryEvent[];
  readonly plants: Record<PlantId, PlantState>;
  readonly rulesPosted: LearnedRule[] = [];
  readonly votes: Vote[] = [];
  readonly counters: { parentProposalId: string; proposal: ProposalInput }[] = [];
  readonly calibrations: { componentId: ComponentId; entry: CalibrationEntry }[] = [];
  readonly proposalsById = new Map<string, Proposal>();
  companyRules: LearnedRule[] = [];
  similarCalls = 0;

  constructor(history = seedHistory()) {
    for (const c of seedComponents()) this.components.set(c.id, structuredClone(c));
    this.history = history;
    const empty = (id: PlantId, name: string): PlantState => ({ id, name, components: [], proposals: [], history: [], rules: [], audit: [], tick: 0, connected: true });
    this.plants = { "plant-a": empty("plant-a", "Plant A"), "plant-b": empty("plant-b", "Plant B") };
    for (const c of this.components.values()) this.plants[c.plantId].components.push(c.id);
  }

  async component(id: ComponentId) {
    const found = this.components.get(id);
    if (!found) throw new Error(`no component ${id}`);
    return structuredClone(found);
  }

  async similar({ componentId, metric, to, upstreamSnapshot = {}, k }: SimilarQuery) {
    this.similarCalls++;
    const limit = this.components.get(componentId)?.limits[metric];
    const range = limit ? limit.max - limit.min : 1;
    const distance = (e: HistoryEvent) => {
      const keys = Object.keys(upstreamSnapshot).filter((key) => key in e.upstreamSnapshot);
      const upstream = keys.length ? keys.reduce((sum, key) => sum + Math.abs(upstreamSnapshot[key] - e.upstreamSnapshot[key]) / (upstreamRange[key] ?? 1), 0) / keys.length : 0;
      return Math.abs(e.after - to) / range + 0.5 * upstream;
    };
    return this.history
      .filter((e) => e.componentId === componentId && e.metric === metric)
      .sort((a, b) => distance(a) - distance(b))
      .slice(0, k);
  }

  async rules() {
    return structuredClone(this.companyRules);
  }

  async plant(plantId: PlantId) {
    return structuredClone({ ...this.plants[plantId], history: this.history.filter((e) => e.plantId === plantId) });
  }

  async calibration(componentId: ComponentId, entry: CalibrationEntry) {
    this.calibrations.push({ componentId, entry });
    const own = this.components.get(componentId);
    if (!own) throw new Error(`no component ${componentId}`);
    const entries = [...(own.calibration ?? []), entry].slice(-50);
    own.calibration = entries;
    const limit = own.limits[entry.metric];
    const window = entries.filter((e) => e.metric === entry.metric).slice(-5);
    if (!limit || window.length < 5) return;
    const mean = window.reduce((sum, e) => sum + e.absError, 0) / window.length;
    const range = limit.max - limit.min;
    if (mean > 0.1 * range) own.marginPct = Math.min(25, own.marginPct + 5);
    else if (mean < 0.03 * range) own.marginPct = Math.max(5, own.marginPct - 2);
  }

  async rule(rule: LearnedRule) {
    this.rulesPosted.push(rule);
    if (!this.companyRules.some((r) => r.id === rule.id)) this.companyRules.push({ ...rule, scope: "company" });
  }

  async vote(vote: Vote) {
    this.votes.push(vote);
  }

  async counter(parentProposalId: string, proposal: ProposalInput) {
    this.counters.push({ parentProposalId, proposal });
  }

  addProposal(proposal: Proposal) {
    this.plants[proposal.plantId].proposals.push(proposal);
    this.proposalsById.set(proposal.id, proposal);
  }
}

let counter = 0;

export function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  const plantId = overrides.plantId ?? "plant-a";
  const other = plantId === "plant-a" ? "plant-b" : "plant-a";
  return {
    id: `p-${++counter}`,
    at: new Date().toISOString(),
    plantId,
    proposerComponentId: `${plantId}/P-100`,
    proposerAgentId: `agent:${plantId}/P-100`,
    metric: "speedPct",
    from: 50,
    to: 85,
    rationale: "Increase throughput",
    requiredVoters: [`${plantId}/TK-101`, `${plantId}/LV-101`, `${plantId}/E-101`, `${plantId}/TV-101`, `${other}/TV-101`],
    votes: [],
    status: "voting",
    vetoDeadline: null,
    parentProposalId: null,
    crossPlant: true,
    ...overrides,
  };
}

/** The company rule from plant-a that plant-b cites. */
export function companyRule(overrides: Partial<LearnedRule> = {}): LearnedRule {
  return {
    id: "rule-plant-a-P-100-speedPct-ge-80-LV-101-positionPct-ge-85",
    scope: "company",
    model: "outlet-valve-A",
    text: "P-100 speedPct >= 80 -> LV-101 positionPct >= 85 within 3 ticks, seen 4 times",
    condition: { componentId: "plant-a/P-100", metric: "speedPct", op: ">=", value: 80 },
    consequence: { componentId: "plant-a/LV-101", metric: "positionPct", op: ">=", value: 85, withinTicks: 3 },
    supportEventIds: ["e1", "e2", "e3", "e4"],
    timesSeen: 4,
    createdAt: "2026-10-31T00:00:00.000Z",
    lastSeenAt: "2026-10-31T00:00:00.000Z",
    ...overrides,
  };
}

/** A safe live execution, as glue would publish it after P-100 reached 65. */
export function safeExecution(proposalId: string, plantId: PlantId = "plant-a"): HistoryEvent {
  const id = (tag: string) => `${plantId}/${tag}`;
  return {
    id: `live-${proposalId}`,
    at: new Date().toISOString(),
    plantId,
    componentId: id("P-100"),
    metric: "speedPct",
    before: 50,
    after: 65,
    upstreamSnapshot: { feedM3h: 15, headerBarg: 6 },
    effects: [
      { componentId: id("LV-101"), metric: "positionPct", before: 50, after: 67, ticksToSettle: 4 },
      { componentId: id("TK-101"), metric: "levelPct", before: 50, after: 50.2, ticksToSettle: 3 },
      { componentId: id("TK-101"), metric: "tempC", before: 75, after: 74.6, ticksToSettle: 4 },
      { componentId: id("E-101"), metric: "dutyKw", before: 898, after: 1160, ticksToSettle: 3 },
      { componentId: id("TV-101"), metric: "positionPct", before: 50.5, after: 56, ticksToSettle: 3 },
      { componentId: id("TV-101"), metric: "steamKgH", before: 1533, after: 1980, ticksToSettle: 3 },
      { componentId: id("TV-101"), metric: "headerBarg", before: 6, after: 5.78, ticksToSettle: 3 },
    ],
    incident: null,
    approvedBy: [],
    operator: null,
    proposalId,
  };
}

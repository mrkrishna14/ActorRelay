// Binds the actor attacks to a target. Default is the real actor code through bind-actors.ts. ADV_TARGET=naive runs
// the literal control below so the tests can be shown to fail. If the real actors are not there, tests skip.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import plants from "../../../shared/plants.json";
import type { ComponentState, HistoryEvent, LearnedRule, PlantState, Proposal, Vote } from "../../../shared/types";
import { SAFE_EVENTS, UNSAFE_EVENTS } from "./fixtures";

export type PlantApi = {
  propose(input: any): Promise<Proposal>;
  vote(v: any): Promise<Proposal>;
  veto(id: string, by: string): Promise<Proposal>;
  execute(id: string): Promise<unknown>;
  recordEvent(e: any): Promise<unknown>;
  promoteRule(r: any): Promise<unknown>;
  getState(): Promise<PlantState>;
  claimDispatch(id: string): Promise<{ dispatch: boolean; token?: string }>;
  reportDispatchFailure(id: string, reason: string): Promise<unknown>;
  getExecution(id: string): Promise<any>;
  loadSeed(plant: any, history: HistoryEvent[]): Promise<unknown>;
  similar(componentId: string, metric: string, to: any, snapshot: any, k?: any): Promise<HistoryEvent[]>;
};
export type ComponentApi = {
  getState(): Promise<ComponentState & { calibration: any[] }>;
  setMetric(metric: string, value: any, proposalId: string, token?: any): Promise<unknown>;
  mirror(metrics: any): Promise<unknown>;
  setMargin(pct: any): Promise<unknown>;
  addCalibration(e: any): Promise<unknown>;
  loadSeed(state: any): Promise<unknown>;
};
export type CompanyApi = { promoteRule(r: any): Promise<unknown>; getState(): Promise<any>; loadSeed?(c: any): Promise<unknown> };

export type World = {
  label: string;
  plant(id: string): PlantApi;
  component(id: string): ComponentApi;
  company(): CompanyApi;
  // Moves time forward and lets the sweep run. Real seconds on a live runtime, a fake clock on logic bindings.
  advance(ms: number): Promise<void>;
  // The token as seen at the glue boundary, which is the only place a legitimate caller gets it.
  tokenFor(proposalId: string): Promise<string | undefined> | string | undefined;
  close?(): Promise<void>;
};

export const SEED_HISTORY = (): HistoryEvent[] => [...SAFE_EVENTS(), ...UNSAFE_EVENTS()];

const here = dirname(fileURLToPath(import.meta.url));

async function bindReal(): Promise<(() => Promise<World>) | null> {
  if (!existsSync(join(here, "bind-actors.ts"))) return null;
  const mod = await import("./bind-actors");
  return mod.makeWorld;
}

// CONTROL, NOT PRODUCT CODE. Literal reading of the Plant and Component method lists. Never used against real runs.
export async function naiveWorld(): Promise<World> {
  let now = Date.parse("2026-10-31T12:00:00.000Z");
  const comps = new Map<string, ComponentState & { calibration: any[] }>();
  for (const c of plants.plants.flatMap((p) => p.components) as unknown as ComponentState[]) comps.set(c.id, { ...structuredClone(c), calibration: [] });
  const states: Record<string, PlantState> = {};
  for (const p of plants.plants) {
    states[p.id] = { id: p.id as any, name: p.name, components: p.components.map((c) => c.id), proposals: [], history: p.id === "plant-a" ? SEED_HISTORY() : [], rules: [], audit: [], tick: 0, connected: true };
  }
  const tokens = new Map<string, string>();
  let seq = 0;

  const voters = (proposer: string) => {
    const seen = new Set([proposer]);
    const queue = [proposer];
    while (queue.length) {
      const c = comps.get(queue.shift()!);
      for (const n of [...(c?.upstream ?? []), ...(c?.downstream ?? [])]) if (!seen.has(n)) (seen.add(n), queue.push(n));
    }
    seen.delete(proposer);
    const list = [...seen];
    if (list.some((v) => comps.get(v)?.sharedResources.length)) list.push(proposer.startsWith("plant-a") ? "plant-b/TV-101" : "plant-a/TV-101");
    return list;
  };

  const sweep = () => {
    for (const s of Object.values(states)) {
      for (const p of s.proposals) {
        if (p.status === "voting") {
          if (p.votes.some((v) => v.vote === "no")) p.status = "blocked";
          else if (p.votes.length === p.requiredVoters.length) (p.status = "veto_window"), (p.vetoDeadline = new Date(now + 10_000).toISOString());
          else if (now - Date.parse(p.at) > 30_000) p.status = "expired";
        } else if (p.status === "veto_window" && now >= Date.parse(p.vetoDeadline!)) {
          exec(p);
        }
      }
    }
  };
  const exec = (p: Proposal) => {
    p.status = "executed";
    tokens.set(p.id, p.id);
  };
  const find = (id: string) => {
    for (const s of Object.values(states)) {
      const p = s.proposals.find((x) => x.id === id);
      if (p) return p;
    }
    throw new Error("unknown_proposal");
  };

  const plant = (id: string): PlantApi => ({
    async propose(i) {
      const p: Proposal = { id: `${id}-p${++seq}`, at: new Date(now).toISOString(), plantId: id as any, proposerComponentId: i.proposerComponentId, proposerAgentId: `agent:${i.proposerComponentId}`, metric: i.metric, from: i.from ?? 50, to: i.to, rationale: i.rationale, requiredVoters: voters(i.proposerComponentId), votes: [], status: "voting", vetoDeadline: null, parentProposalId: i.parentProposalId ?? null, crossPlant: true, ...i };
      states[id].proposals.push(p);
      return p;
    },
    async vote(v) {
      const p = find(v.proposalId);
      if (p.votes.some((x) => x.componentId === v.componentId)) throw new Error("duplicate_vote");
      p.votes.push(v);
      return p;
    },
    async veto(pid) {
      const p = find(pid);
      p.status = "vetoed";
      return p;
    },
    async execute(pid) {
      exec(find(pid));
    },
    async recordEvent(e) {
      states[id].history.push(e);
    },
    async promoteRule(r) {
      states[id].rules.push(r);
    },
    async getState() {
      return states[id];
    },
    async claimDispatch() {
      return { dispatch: true };
    },
    async reportDispatchFailure() {},
    async getExecution(pid) {
      return { token: tokens.get(pid) };
    },
    async loadSeed() {},
    async similar() {
      return states[id].history.slice(0, 5);
    },
  });

  const component = (id: string): ComponentApi => ({
    async getState() {
      return comps.get(id)!;
    },
    async setMetric(metric, value, proposalId) {
      if (find(proposalId).status !== "executed") throw new Error("invalid_token");
      comps.get(id)!.metrics[metric] = value;
    },
    async mirror(metrics) {
      Object.assign(comps.get(id)!.metrics, metrics);
    },
    async setMargin(pct) {
      comps.get(id)!.marginPct = pct;
    },
    async addCalibration(e) {
      const c = comps.get(id)!;
      c.calibration.push(e);
      const last = c.calibration.slice(-5);
      const mean = last.reduce((s, x) => s + x.absError, 0) / last.length;
      if (last.length === 5 && mean < 2) c.marginPct = Math.max(5, c.marginPct - 2);
    },
    async loadSeed(state) {
      comps.set(id, { calibration: [], ...state });
    },
  });

  return {
    label: "naive control",
    plant,
    component,
    company: () => ({ promoteRule: async () => undefined, getState: async () => ({}) }),
    advance: async (ms) => {
      now += ms;
      sweep();
    },
    tokenFor: (pid) => tokens.get(pid),
  };
}

export const makeWorld: (() => Promise<World>) | null = process.env.ADV_TARGET === "naive" ? naiveWorld : await bindReal();

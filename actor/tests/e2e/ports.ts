// The seams between the fake glue and everything real. The e2e binds these to the real actor client and
// the real Relay publisher, and the table labels whichever implementation actually ran.
import type {
  CalibrationEntry, CompanyState, ComponentId, ComponentState, HistoryEvent, LearnedRule, PlantId, PlantState, Proposal, Vote,
} from "../../../shared/types.ts";

export type ComponentView = ComponentState & { calibration: CalibrationEntry[] };

export interface ComponentPort {
  getState(): Promise<ComponentView>;
  mirror(metrics: Record<string, number>): Promise<unknown>;
  setMetric(metric: string, value: number, proposalId: string, token?: string): Promise<unknown>;
  addCalibration(entry: CalibrationEntry): Promise<unknown>;
  setMargin(pct: number): Promise<unknown>;
  loadSeed(state: ComponentState): Promise<unknown>;
}

export interface PlantPort {
  getState(): Promise<PlantState>;
  loadSeed(plant: unknown, history: HistoryEvent[]): Promise<unknown>;
  propose(p: Record<string, unknown>): Promise<Proposal>;
  vote(v: Vote): Promise<Proposal>;
  veto(proposalId: string, by: string): Promise<Proposal>;
  execute(proposalId: string): Promise<unknown>;
  claimDispatch(proposalId: string): Promise<any>;
  reportDispatchFailure(proposalId: string, ...rest: unknown[]): Promise<unknown>;
  getExecution(proposalId: string): Promise<any>;
  recordEvent(e: Record<string, unknown>): Promise<any>;
  promoteRule(r: LearnedRule): Promise<any>;
  rulesFor(componentId?: string, model?: string): Promise<LearnedRule[]>;
  similar(componentId: ComponentId, metric: string, to: number, upstreamSnapshot: Record<string, number>, k?: number): Promise<HistoryEvent[]>;
  tick(): Promise<unknown>;
}

export interface CompanyPort {
  getState(): Promise<CompanyState>;
  loadSeed(c: unknown): Promise<unknown>;
  registerPlant(id: PlantId, models?: string[]): Promise<unknown>;
  requiredCrossPlantVoters(p: Record<string, unknown>): Promise<ComponentId[]>;
  promoteRule(r: LearnedRule): Promise<any>;
  recordAudit(a: unknown): Promise<unknown>;
}

export interface ActorPorts {
  label: string;
  isReal: boolean;
  component(id: ComponentId): ComponentPort;
  plant(id: PlantId): PlantPort;
  company(): CompanyPort;
}

export type RelayType = "proposal" | "executed" | "rule";

export interface Bus {
  label: string;
  isReal: boolean;
  publish(type: RelayType, payload: Record<string, unknown>, channels: string[]): Promise<void>;
}

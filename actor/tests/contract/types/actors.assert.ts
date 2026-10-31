// The actor classes against CLAUDE.MD's method list and the frozen types. Drift here fails tsc.
import type { CalibrationEntry, CompanyState, ComponentId, ComponentState, HistoryEvent, LearnedRule, PlantId, PlantState, Proposal, Vote } from "../../../../shared/types";
import type { Company, Component, Plant } from "../../../src/actor";
import type { EmittedComponent } from "../lib/schemas";
import type { Equal, Expect } from "../lib/typeassert";

type Result<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

export type ComponentChecks = [
  Expect<Equal<Parameters<Component["mirror"]>, [metrics: Record<string, number>]>>,
  // CLAUDE.MD lists three arguments. The fourth is the one-time token TASK1 requires.
  Expect<Equal<Parameters<Component["setMetric"]>, [metric: string, value: number, proposalId: string, token: string]>>,
  Expect<Equal<Parameters<Component["addCalibration"]>, [e: CalibrationEntry]>>,
  Expect<Equal<Parameters<Component["setMargin"]>, [pct: number]>>,
  Expect<Equal<Parameters<Component["loadSeed"]>, [state: ComponentState]>>,
  Expect<Equal<Result<Component["getState"]>, EmittedComponent>>,
  Expect<Equal<Result<Component["mirror"]>, EmittedComponent>>,
];

export type PlantChecks = [
  Expect<Equal<Parameters<Plant["vote"]>, [v: Vote]>>,
  Expect<Equal<Parameters<Plant["veto"]>, [proposalId: string, by: string]>>,
  Expect<Equal<Parameters<Plant["execute"]>, [proposalId: string]>>,
  Expect<Equal<Parameters<Plant["promoteRule"]>, [r: LearnedRule]>>,
  Expect<Equal<Parameters<Plant["tick"]>, []>>,
  Expect<Equal<Result<Plant["getState"]>, PlantState>>,
  Expect<Equal<Result<Plant["propose"]>, Proposal>>,
  Expect<Equal<Result<Plant["vote"]>, Proposal>>,
  Expect<Equal<Result<Plant["veto"]>, Proposal>>,
  Expect<Equal<Result<Plant["recordEvent"]>, HistoryEvent>>,
  Expect<Equal<Result<Plant["promoteRule"]>, LearnedRule>>,
  Expect<Equal<Result<Plant["similar"]>, HistoryEvent[]>>,
];

export type SimilarArguments = Expect<
  Equal<Parameters<Plant["similar"]>, [componentId: ComponentId, metric: string, to: number, upstreamSnapshot?: Record<string, number>, k?: number]>
>;

export type CompanyChecks = [
  Expect<Equal<Parameters<Company["requiredCrossPlantVoters"]>, [proposal: Proposal]>>,
  Expect<Equal<Parameters<Company["promoteRule"]>, [r: LearnedRule]>>,
  Expect<Equal<Parameters<Company["registerPlant"]>[0], PlantId>>,
  Expect<Equal<Result<Company["getState"]>, CompanyState>>,
  Expect<Equal<Result<Company["requiredCrossPlantVoters"]>, ComponentId[]>>,
];

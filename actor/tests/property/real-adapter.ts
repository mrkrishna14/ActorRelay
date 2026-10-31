// Binds the suites to the real code in actor/src: pure functions directly, and the real
// Plant, Company and Component classes for anything stateful. Those classes run on a fake
// in-memory actor base, so this exercises decision logic, NOT Terse persistence, alarms,
// mailboxes or crash recovery. Every run through here is labelled [real logic, fake runtime].
import { setSystemTime } from "bun:test";
import { FakeActor } from "./fake-runtime";
import {
  plantsJson,
  seedComponents,
  type CalibrationState,
  type ComponentState,
  type Engine,
  type HistoryEvent,
  type LearnedRule,
  type LifecycleState,
  type Limit,
  type Outcome,
  type RuleContext,
  type SimilarQuery,
} from "./harness";

// PROP_SRC points the suites at a patched copy of actor/src, for mutation runs.
export const SRC = process.env.PROP_SRC ?? "../../src";

export const actors = (await import(`${SRC}/actor`)) as any;
const { Plant, Company } = actors;
const { applyCalibration, clampMargin, computeStatus } = await import(`${SRC}/logic/component`);
const { reachableVoters } = await import(`${SRC}/logic/proposals`);
const { crossPlantVoters } = await import(`${SRC}/logic/rules`);
const { rankSimilar } = await import(`${SRC}/logic/similar`);
const { isFiniteNumber, normalizeCalibration } = await import(`${SRC}/logic/validate`);

// A company push runs outside the plant's call, so results are only final once it reports back.
async function pushed(plant: any) {
  for (let turn = 0; plant.companySyncing && turn < 2000; turn++) await Promise.resolve();
  if (plant.companySyncing) throw new Error("company push never reported back");
}

// A coded failure is a deliberate refusal. Anything else is a crash and must surface as one.
const CODED = /^[a-z_]+: /;
function refusal(error: unknown): { accepted: false; reason: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && CODED.test(message)) return { accepted: false, reason: message };
  throw error;
}

function topologyOf(components: ComponentState[]) {
  return Object.fromEntries(
    components.map(({ id, tag, model, limits, upstream, downstream, sharedResources }) => [
      id,
      { id, tag, model, limits, upstream, downstream, sharedResources },
    ]),
  );
}

const PLANT_A = seedComponents.filter((c) => c.plantId === "plant-a");

function baseFields(components: ComponentState[]) {
  return {
    seeded: true,
    registeredWithCompany: true,
    name: "Plant A",
    topology: topologyOf(components),
    components: components.map((c) => c.id),
    audit: [],
    history: [],
    rules: [],
    companyOutbox: [],
    liveEventIds: [],
    executions: {},
    tickCount: 0,
    connected: true,
  };
}

function plantFor(state: LifecycleState) {
  const plant = new Plant();
  plant.id = state.proposals[0]?.plantId ?? "plant-a";
  FakeActor.registry.set(`Plant:${plant.id}`, plant);
  const components = seedComponents.filter((c) => c.plantId === plant.id);
  const setpoints: Record<string, Record<string, number>> = {};
  for (const p of state.proposals) {
    setpoints[p.proposerComponentId] = { ...setpoints[p.proposerComponentId], [p.metric]: p.from };
  }
  Object.assign(plant, baseFields(components), {
    setpoints: state.setpoints ?? setpoints,
    executions: state.executions ?? {},
    proposals: state.proposals,
  });
  return plant;
}

const stateOf = (plant: any): LifecycleState => ({
  proposals: plant.proposals,
  setpoints: plant.setpoints,
  executions: plant.executions,
});

function resetCompany(models: Record<string, string[]>) {
  const company = (Company as any).get("company");
  Object.assign(company, {
    plants: ["plant-a", "plant-b"],
    sharedResources: plantsJson.company.sharedResources,
    rules: [],
    crossPlantProposals: [],
    audit: [],
    plantModels: models,
  });
  return company;
}

async function act<T>(nowMs: number, run: () => Promise<T>): Promise<T> {
  setSystemTime(new Date(nowMs));
  return run();
}

function similarRanges(q: SimilarQuery) {
  const pool = q.history.filter((e) => e.componentId === q.componentId && e.metric === q.metric);
  const spread = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
  const limitRange = q.limit ? q.limit.max - q.limit.min : 0;
  return {
    metricRange: limitRange > 0 ? limitRange : spread(pool.map((e) => e.after)) || 1,
    keyRange: (key: string) =>
      spread([
        q.upstreamSnapshot[key]!,
        ...pool.flatMap((e) => (key in e.upstreamSnapshot ? [e.upstreamSnapshot[key]!] : [])),
      ]),
  };
}

function resourcesOf(components: ComponentState[]) {
  const ids = [...new Set(components.flatMap((c) => c.sharedResources))];
  return ids.map((id) => ({
    id,
    name: id,
    components: components.filter((c) => c.sharedResources.includes(id)).map((c) => c.id),
  }));
}

export const engine: Engine = {
  name: "real logic, fake runtime",
  traits: {
    similarLive: { dropBeyond: 0.15 },
    calibrationFreshWindow: true,
    lateVetoWins: true,
    blockedRecordsLateVotes: true,
    staleExpires: true,
    failedDispatchExpires: true,
    ruleThresholdScan: true,
  },
  similarRanges,
  similar: (q) =>
    rankSimilar({
      history: q.history,
      componentId: q.componentId,
      metric: q.metric,
      to: q.to,
      upstreamSnapshot: q.upstreamSnapshot,
      k: q.k ?? 5,
      limit: q.limit,
      liveEventIds: q.history.filter((e) => e.proposalId !== null).map((e) => e.id),
    }),
  computeStatus,
  // The same two steps as Component.addCalibration.
  addCalibration(state, entry, limits: Record<string, Limit>): CalibrationState {
    const outcome = applyCalibration({
      calibration: state.calibration,
      entry: normalizeCalibration(entry),
      limits,
      marginPct: state.marginPct,
      sinceAdjustment: (state as { sinceAdjustment?: number }).sinceAdjustment ?? 0,
    });
    return outcome;
  },
  // The same two steps as Component.setMargin.
  setMargin(_current, pct) {
    if (!isFiniteNumber(pct)) throw new Error("invalid_margin: margin must be finite");
    return clampMargin(pct);
  },
  // The same composition as Plant.propose and Company.requiredCrossPlantVoters.
  requiredVoters(proposerId, components) {
    const plantId = proposerId.split("/")[0]!;
    const local = components.filter((c) => c.plantId === plantId);
    const voters = reachableVoters(proposerId, topologyOf(local), local.map((c) => c.id));
    const remote = crossPlantVoters({
      plantId,
      proposerComponentId: proposerId,
      requiredVoters: voters,
      sharedResources: resourcesOf(components),
    });
    return { requiredVoters: [...voters, ...remote], crossPlant: remote.length > 0 };
  },
  async vote(state, vote, nowMs): Promise<Outcome<LifecycleState>> {
    const plant = plantFor(state);
    try {
      await act(nowMs, () => plant.vote(vote));
      return { accepted: true, state: stateOf(plant) };
    } catch (error) {
      return refusal(error);
    }
  },
  async veto(state, id, by, nowMs): Promise<Outcome<LifecycleState>> {
    const plant = plantFor(state);
    try {
      await act(nowMs, () => plant.veto(id, by));
      return { accepted: true, state: stateOf(plant) };
    } catch (error) {
      return refusal(error);
    }
  },
  async sweep(state, nowMs) {
    const plant = plantFor(state);
    resetCompany({});
    await act(nowMs, () => plant.sweep());
    return stateOf(plant);
  },
  async execute(state, id, nowMs): Promise<Outcome<LifecycleState>> {
    const plant = plantFor(state);
    const known = Object.hasOwn(plant.executions, id);
    try {
      await act(nowMs, () => plant.execute(id));
      if (known) return { accepted: false, reason: "already accepted, no second dispatch" };
      return { accepted: true, state: stateOf(plant) };
    } catch (error) {
      return refusal(error);
    }
  },
  async promoteAfterEvent(history, rules, company, event, ctx, nowMs) {
    const plant = new Plant();
    plant.id = "plant-a";
    FakeActor.registry.set("Plant:plant-a", plant);
    Object.assign(plant, baseFields(ctx.components), { history, rules, proposals: [], setpoints: {} });
    const actor = resetCompany({
      "plant-a": [...new Set(ctx.components.map((c) => c.model))],
      "plant-b": [...new Set(ctx.otherPlantComponents.map((c) => c.model))],
    });
    actor.rules = company;
    try {
      await act(nowMs, () => plant.recordEvent(event));
      await pushed(plant);
    } catch (error) {
      refusal(error);
    }
    return { planted: plant.rules, company: actor.rules };
  },
  async submitRule(rule: LearnedRule, history: HistoryEvent[], ctx: RuleContext) {
    const plant = new Plant();
    plant.id = "plant-a";
    FakeActor.registry.set("Plant:plant-a", plant);
    Object.assign(plant, baseFields(ctx.components), { history, proposals: [], setpoints: {} });
    resetCompany({});
    try {
      await plant.promoteRule(rule);
      await pushed(plant);
      return true;
    } catch (error) {
      refusal(error);
      return false;
    }
  },
  async submitCompanyRule(rule: LearnedRule, ctx: RuleContext) {
    const actor = resetCompany({
      "plant-a": [...new Set(ctx.components.map((c) => c.model))],
      "plant-b": [...new Set(ctx.otherPlantComponents.map((c) => c.model))],
    });
    try {
      await actor.promoteRule(rule);
      return true;
    } catch (error) {
      refusal(error);
      return false;
    }
  },
};

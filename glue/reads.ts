// What glue last heard from the actors. A Plant is one serial mailbox, and every call on it costs about 50 ms before any
// queueing, so a page, five voters and a watcher reading it directly stall the votes and sweeps that matter. Reads are
// answered from the newest copy, the wake loop refreshes it once a second, and glue's own writes update it straight away.
import type { CalibrationEntry, CompanyState, ComponentId, ComponentState, HistoryEvent, LearnedRule, PlantId, PlantState, Proposal } from "../shared/types";
import { readWithRetry, type ActorPort } from "./actors";
import { COMPANY_ACTOR_ID, PLANT_IDS } from "./config";

export type ComponentView = ComponentState & { calibration: CalibrationEntry[] };

const HELD_TTL_MS = 1000;
/** Past this a copy is not served: a dead actor server must show as an error, not as a frozen plant. */
const HELD_MAX_AGE_MS = 5000;
const COMPONENT_FRESH_MS = 1500;
const COMPONENT_MAX_AGE_MS = 3000;
const NEWEST_EVENTS = 20;

class Held<T> {
  private latest: T | null = null;
  private at = 0;
  private loading: Promise<T> | null = null;
  private generation = 0;

  constructor(private readonly load: () => Promise<T>) {}

  refresh(): Promise<T> {
    if (this.loading) return this.loading;
    const generation = this.generation;
    const loading = readWithRetry(this.load)
      .then((value) => {
        if (generation === this.generation) {
          this.latest = value;
          this.at = Date.now();
        }
        return value;
      })
      .finally(() => {
        if (this.loading === loading) this.loading = null;
      });
    this.loading = loading;
    return loading;
  }

  get(): Promise<T> {
    const age = Date.now() - this.at;
    if (this.latest !== null && age < HELD_TTL_MS) return Promise.resolve(this.latest);
    const refreshing = this.refresh();
    if (this.latest !== null && age < HELD_MAX_AGE_MS) {
      refreshing.catch(() => undefined);
      return Promise.resolve(this.latest);
    }
    return refreshing;
  }

  update(change: (value: T) => T) {
    if (this.latest !== null) this.latest = change(this.latest);
  }

  /** The next read fetches a new copy, and serves this one meanwhile. */
  touch() {
    this.at = Math.min(this.at, Date.now() - HELD_TTL_MS);
  }

  clear() {
    this.generation += 1;
    this.latest = null;
    this.at = 0;
    this.loading = null;
  }
}

export class Reads {
  private readonly plants: Record<PlantId, Held<PlantState>>;
  private readonly companyState: Held<CompanyState>;
  private readonly components = new Map<ComponentId, { state: ComponentView; at: number }>();

  constructor(
    private readonly actors: ActorPort,
    private readonly componentIds: () => ComponentId[],
  ) {
    const heldPlant = (id: PlantId) => new Held(() => actors.call<PlantState>("Plant", id, "getState"));
    this.plants = Object.fromEntries(PLANT_IDS.map((id) => [id, heldPlant(id)])) as Record<PlantId, Held<PlantState>>;
    this.companyState = new Held(() => actors.call<CompanyState>("Company", COMPANY_ACTOR_ID, "getState"));
  }

  plant(id: PlantId) {
    return this.plants[id].get();
  }

  company() {
    return this.companyState.get();
  }

  /** The wake loop's call: always reaches the actor, which is what re-arms a Plant's alarms. */
  refreshPlant(id: PlantId) {
    return this.plants[id].refresh();
  }

  refreshCompany() {
    return this.companyState.refresh();
  }

  /** Same selection as Plant.rulesFor, on the held copies, so six voters' reads do not each hold the Plant open on Company. */
  async rules(plantId: PlantId, componentId: ComponentId, model?: string): Promise<LearnedRule[]> {
    const [plant, company] = await Promise.all([this.plant(plantId), this.company()]);
    const applies = (rule: LearnedRule) => rule.model === model || rule.condition.componentId === componentId || rule.consequence.componentId === componentId;
    return [...plant.rules.filter(applies), ...company.rules.filter((rule) => model === undefined || rule.model === model)];
  }

  /** Mirror, calibration and seed calls all return the new state, and every writer goes through glue. */
  remember(state: unknown) {
    const view = state as ComponentView | null;
    if (view?.id) this.components.set(view.id, { state: view, at: Date.now() });
  }

  private async readComponent(id: ComponentId): Promise<ComponentView> {
    const state = await readWithRetry(() => this.actors.call<ComponentView>("Component", id, "getState"));
    this.remember(state);
    return state;
  }

  private componentOlderThan(id: ComponentId, ageMs: number): ComponentView | Promise<ComponentView> {
    const known = this.components.get(id);
    return known && Date.now() - known.at < ageMs ? known.state : this.readComponent(id);
  }

  async component(id: ComponentId): Promise<ComponentView> {
    return this.componentOlderThan(id, COMPONENT_FRESH_MS);
  }

  componentViews(): Promise<ComponentView[]> {
    return Promise.all(this.componentIds().map((id) => this.componentOlderThan(id, COMPONENT_MAX_AGE_MS)));
  }

  /** A write answered with the new proposal, so the held copy can show it now instead of after the next refresh. */
  proposal(plantId: PlantId, proposal: Proposal) {
    this.plants[plantId].update((plant) => {
      const known = plant.proposals.some((item) => item.id === proposal.id);
      return { ...plant, proposals: known ? plant.proposals.map((item) => (item.id === proposal.id ? proposal : item)) : [...plant.proposals, proposal] };
    });
    this.plants[plantId].touch();
  }

  event(plantId: PlantId, event: HistoryEvent) {
    this.plants[plantId].update((plant) => (plant.history.some((item) => item.id === event.id) ? plant : { ...plant, history: [...plant.history, event] }));
    this.plants[plantId].touch();
  }

  touch(plantId: PlantId) {
    this.plants[plantId].touch();
    this.companyState.touch();
  }

  clear() {
    for (const id of PLANT_IDS) this.plants[id].clear();
    this.companyState.clear();
    this.components.clear();
  }
}

/** The page needs live runs and whatever a vote cites. The rest of the seed stays in the actor; `full=1` still returns it. */
export function compactPlant(plant: PlantState): PlantState {
  const cited = new Set(plant.proposals.flatMap((proposal) => proposal.votes.flatMap((vote) => vote.evidenceEventIds)));
  const newest = new Set(plant.history.slice(-NEWEST_EVENTS).map((event) => event.id));
  return { ...plant, history: plant.history.filter((event) => event.proposalId !== null || cited.has(event.id) || newest.has(event.id)) };
}

// Read-through to the actors, with just enough sharing that a page polling once a second and five voters reading at once
// do not queue in a Plant's mailbox. Component states come back on every mirror, so /state needs no extra actor calls.
import type { CalibrationEntry, CompanyState, ComponentId, ComponentState, LearnedRule, PlantId, PlantState } from "../shared/types";
import { readWithRetry, type ActorPort } from "./actors";
import { COMPANY_ACTOR_ID } from "./config";

export type ComponentView = ComponentState & { calibration: CalibrationEntry[] };

const PLANT_TTL_MS = 250;
const COMPANY_TTL_MS = 500;
const RULES_TTL_MS = 300;
const COMPONENT_FRESH_MS = 3000;
const NEWEST_EVENTS = 20;

type Entry = { value: Promise<unknown>; doneAt: number | null };

export class Reads {
  private readonly memo = new Map<string, Entry>();
  private readonly components = new Map<ComponentId, { state: ComponentView; at: number }>();

  constructor(
    private readonly actors: ActorPort,
    private readonly componentIds: () => ComponentId[],
  ) {}

  private shared<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.memo.get(key);
    if (hit && (hit.doneAt === null || Date.now() - hit.doneAt < ttlMs)) return hit.value as Promise<T>;
    const entry: Entry = { value: readWithRetry(load), doneAt: null };
    this.memo.set(key, entry);
    entry.value.then(
      () => (entry.doneAt = Date.now()),
      () => this.memo.get(key) === entry && this.memo.delete(key),
    );
    return entry.value as Promise<T>;
  }

  plant(id: PlantId): Promise<PlantState> {
    return this.shared(`plant|${id}`, PLANT_TTL_MS, () => this.actors.call<PlantState>("Plant", id, "getState"));
  }

  company(): Promise<CompanyState> {
    return this.shared("company", COMPANY_TTL_MS, () => this.actors.call<CompanyState>("Company", COMPANY_ACTOR_ID, "getState"));
  }

  rules(plantId: PlantId, componentId: ComponentId, model?: string): Promise<LearnedRule[]> {
    const args = model === undefined ? [componentId] : [componentId, model];
    return this.shared(`rules|${componentId}|${model}`, RULES_TTL_MS, () => this.actors.call<LearnedRule[]>("Plant", plantId, "rulesFor", args));
  }

  async component(id: ComponentId): Promise<ComponentView> {
    const state = await readWithRetry(() => this.actors.call<ComponentView>("Component", id, "getState"));
    this.remember(state);
    return state;
  }

  /** Mirror, calibration and seed calls all return the new state, and every writer goes through glue. */
  remember(state: unknown) {
    const view = state as ComponentView | null;
    if (view?.id) this.components.set(view.id, { state: view, at: Date.now() });
  }

  async componentViews(): Promise<ComponentView[]> {
    const now = Date.now();
    return Promise.all(
      this.componentIds().map((id) => {
        const known = this.components.get(id);
        return known && now - known.at < COMPONENT_FRESH_MS ? known.state : this.component(id);
      }),
    );
  }

  invalidate(plantId?: PlantId) {
    for (const key of this.memo.keys()) {
      if (plantId === undefined || key === `plant|${plantId}` || key.startsWith("rules|") || key === "company") this.memo.delete(key);
    }
  }

  clear() {
    this.memo.clear();
    this.components.clear();
  }
}

/** The page needs live runs and whatever a vote cites. The rest of the seed stays in the actor; `full=1` still returns it. */
export function compactPlant(plant: PlantState): PlantState {
  const cited = new Set(plant.proposals.flatMap((proposal) => proposal.votes.flatMap((vote) => vote.evidenceEventIds)));
  const newest = new Set(plant.history.slice(-NEWEST_EVENTS).map((event) => event.id));
  return { ...plant, history: plant.history.filter((event) => event.proposalId !== null || cited.has(event.id) || newest.has(event.id)) };
}

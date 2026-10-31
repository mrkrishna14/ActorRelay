// Seeds the real Plant, Company and Component classes inside a fake runtime World.
// Everything here is labelled [real logic, fake runtime]: see fake-runtime.ts for what that
// leaves out.
import { setSystemTime } from "bun:test";
import { FakeActor, World } from "./fake-runtime";
import { actors } from "./real-adapter";
import { clone, makeVote, plantsJson, T0, type ComponentState, type HistoryEvent, type Proposal } from "./harness";

const { Plant, Company, Component } = actors as any;

export const WORLD_RUNS = Number(process.env.PROP_WORLD_RUNS ?? 500);
export const COMPANY = "Company:company";

export const actorIdOf = (componentId: string) => componentId.replaceAll("/", ".");

type SeedOptions = {
  history?: HistoryEvent[];
  edit?: (component: ComponentState) => ComponentState;
  seedCompany?: boolean;
};

export class Stage {
  world = new World();
  now = T0;

  constructor() {
    FakeActor.world = this.world;
    setSystemTime(new Date(this.now));
  }

  advance(ms: number) {
    this.now += ms;
    setSystemTime(new Date(this.now));
  }

  // Company pushes run detached from the call that started them, so a step is only finished
  // when nothing is left moving. Held calls stay held.
  async idle() {
    const moving = () => this.world.inflight - this.world.parked.length > 0;
    for (let quiet = 0, turn = 0; quiet < 3; turn++) {
      if (turn > 5000) throw new Error("deadlock: the world never went quiet");
      await new Promise((next) => setImmediate(next));
      quiet = moving() ? 0 : quiet + 1;
    }
  }

  plant = (id: string) => Plant.get(id);
  company = () => Company.get("company");
  component = (id: string) => Component.get(actorIdOf(id));

  rawPlant = (id: string): any => this.world.instances.get(`Plant:${id}`);
  rawCompany = (): any => this.world.instances.get(COMPANY);
  rawComponent = (id: string): any => this.world.instances.get(`Component:${actorIdOf(id)}`);

  async seedPlant(id: string, { history = [], edit = (c) => c }: SeedOptions = {}) {
    const seed = clone(plantsJson.plants.find((p: { id: string }) => p.id === id));
    seed.components = seed.components.map(edit);
    await this.plant(id).loadSeed(seed, history.filter((e) => e.plantId === id));
    for (const component of seed.components) await this.component(component.id).loadSeed(component);
  }

  seedCompany() {
    return this.company().loadSeed(clone(plantsJson.company));
  }

  async seedAll(options: SeedOptions = {}) {
    await this.seedCompany();
    await this.seedPlant("plant-a", options);
    await this.seedPlant("plant-b", options);
    return this;
  }

  // Walks a proposal to accepted, the point where a dispatch can begin.
  async accepted(to = 65, plantId = "plant-a"): Promise<Proposal> {
    const plant = this.plant(plantId);
    const proposal = await plant.propose({
      proposerComponentId: `${plantId}/P-100`,
      metric: "speedPct",
      to,
      rationale: "generated",
    });
    for (const voter of proposal.requiredVoters) await plant.vote(makeVote(proposal.id, voter));
    await plant.sweep();
    this.advance(10_000);
    await plant.sweep();
    return proposal;
  }
}

export const leaveWorld = () => {
  FakeActor.world = null;
};

// Runs one generated case in its own World, and always leaves the world afterwards.
export async function onStage<T>(run: (stage: Stage) => Promise<T>): Promise<T> {
  const stage = new Stage();
  try {
    return await run(stage);
  } finally {
    leaveWorld();
  }
}

// Fails the case instead of hanging the suite if a mailbox ever deadlocks.
export async function settles<T>(work: Promise<T>, label: string, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadlock: ${label} did not settle`)), ms);
  });
  return Promise.race([work, watchdog]).finally(() => clearTimeout(timer));
}

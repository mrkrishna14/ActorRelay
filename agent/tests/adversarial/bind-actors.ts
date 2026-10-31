// Runs the REAL actor/src classes in-process. The Terse base class is a test stand-in: one FIFO queue per actor
// instance to match the mailbox, plain fields for @Persisted, a fake clock. Validation, state machines and token logic
// are the shipped code; durability and the wire are not exercised here. Label results "real actors on a stand-in runtime".
import { mock, setSystemTime } from "bun:test";
import plants from "../../../shared/plants.json";
import type { ComponentState } from "../../../shared/types";
// Type only: actor-world awaits this module at load, so a value import back would deadlock.
import type { World } from "./actor-world";
import { SEED_HISTORY } from "./fixtures";

type AnyActor = Record<string, any>;

const registry = new Map<string, { instance: AnyActor; queue: Promise<unknown> }>();

class Actor {
  id = "";
  alarm = {
    at: null as number | null,
    get() {
      return this.at;
    },
    set(at: number) {
      this.at = at;
    },
  };
  db = { transaction: async (fn: () => Promise<unknown>) => fn() };
  broadcast() {}

  // A remote handle: every method call waits its turn in that instance's queue, like the real mailbox.
  static get(id: string) {
    const key = `${this.name}:${id}`;
    let slot = registry.get(key);
    if (!slot) {
      const instance = new (this as any)() as AnyActor;
      instance.id = id;
      slot = { instance, queue: Promise.resolve() };
      registry.set(key, slot);
    }
    const held = slot;
    return new Proxy(
      {},
      {
        get: (_t, method: string) =>
          (...args: unknown[]) => {
            const run = held.queue.then(() => held.instance[method](...structuredCloneSafe(args)));
            held.queue = run.catch(() => undefined);
            return run;
          },
      },
    );
  }
}

// Calls cross a process boundary in production, so arguments and results must not share references.
function structuredCloneSafe<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

const noopDecorator = () => undefined;
mock.module("terse-sdk/actor", () => ({ Actor, Compute: () => noopDecorator, Emittable: noopDecorator, Ephemeral: noopDecorator, Persisted: noopDecorator }));

const { Plant, Component, Company } = (await import("../../../actor/src/actor")) as any;
const { componentActorId, COMPANY_ACTOR_ID } = (await import("../../../actor/src/ids")) as any;

// Plant posts to glue fire-and-forget; nothing is listening in these tests.
const realFetch = globalThis.fetch;

export async function makeWorld(): Promise<World> {
  registry.clear();
  let now = Date.parse("2026-10-31T12:00:00.000Z");
  setSystemTime(new Date(now));
  globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch;

  const company = Company.get(COMPANY_ACTOR_ID);
  await company.loadSeed({ plants: plants.company.plants, sharedResources: plants.company.sharedResources });
  for (const p of plants.plants) {
    await Plant.get(p.id).loadSeed(p, p.id === "plant-a" ? SEED_HISTORY() : []);
    for (const c of p.components as unknown as ComponentState[]) await Component.get(componentActorId(c.id)).loadSeed(c);
  }

  const tokens = new Map<string, string>();
  const plant = (id: string) => Plant.get(id);
  return {
    label: "real actors on a stand-in runtime",
    plant,
    component: (id) => Component.get(componentActorId(id)),
    company: () => company,
    advance: async (ms) => {
      now += ms;
      setSystemTime(new Date(now));
      // A cross-plant veto window needs a Company lease, which is granted between two sweeps.
      for (let pass = 0; pass < 2; pass++) {
        for (const p of plants.plants) await plant(p.id).sweep();
        await Bun.sleep(2);
      }
    },
    // Plays the one legitimate executor: the first claim is the only way a token ever leaves the Plant.
    tokenFor: async (proposalId) => {
      if (tokens.has(proposalId)) return tokens.get(proposalId);
      const claim = await plant(proposalId.startsWith("plant-b") ? "plant-b" : "plant-a").claimDispatch(proposalId).catch(() => null);
      if (claim?.dispatch) tokens.set(proposalId, claim.token);
      return tokens.get(proposalId);
    },
    close: async () => {
      globalThis.fetch = realFetch;
      setSystemTime();
    },
  };
}

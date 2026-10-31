// In-memory stand-in for the actor runtime, so the real actor classes run under bun test.
// With a World active it models what the decision logic relies on: one serial mailbox per
// actor, a wire copy of every argument and result, and calls that fail or hang.
// It does NOT model persistence, alarms, eviction or restarts; actor/tests/chaos covers those.
import { mock } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";

const noop = () => undefined;

// before: never delivered. after: applied, but the reply is lost. hang: never answers.
// hold: parked until release(), which models a slow or cold actor.
export type Fault = "before" | "after" | "hang" | "hold";
export type CallRecord = { from: string | null; to: string; method: string };

const currentActor = new AsyncLocalStorage<string>();

export class World {
  instances = new Map<string, FakeActor>();
  tails = new Map<string, Promise<unknown>>();
  calls: CallRecord[] = [];
  posts: { url: string; body: unknown }[] = [];
  fault: (target: string, method: string) => Fault | null = () => null;
  inflight = 0;
  parked: (() => void)[] = [];

  release() {
    const waiting = this.parked;
    this.parked = [];
    waiting.forEach((resume) => resume());
  }

  reference(key: string, instance: FakeActor) {
    return new Proxy(instance, {
      get: (target, property) => {
        const value = (target as any)[property];
        if (typeof value !== "function" || property === "constructor") return value;
        return (...args: unknown[]) => this.send(key, target, String(property), args);
      },
    });
  }

  send(key: string, instance: FakeActor, method: string, args: unknown[]) {
    this.calls.push({ from: currentActor.getStore() ?? null, to: key, method });
    const fault = this.fault(key, method);
    if (fault === "before") return Promise.reject(new Error(`network_down: ${key}.${method}`));
    if (fault === "hang") return new Promise(noop);
    const wire = structuredClone(args);
    const run = () => currentActor.run(key, () => (instance as any)[method](...wire));
    const arrived = fault === "hold" ? new Promise<void>((resume) => this.parked.push(resume)) : Promise.resolve();
    this.inflight += 1;
    const result = arrived.then(() => {
      const turn = (this.tails.get(key) ?? Promise.resolve()).then(run, run);
      this.tails.set(key, turn.catch(noop));
      return turn;
    });
    return result
      .then((value) => {
        if (fault === "after") throw new Error(`ack_lost: ${key}.${method}`);
        return value === undefined ? value : structuredClone(value);
      })
      .finally(() => {
        this.inflight -= 1;
      });
  }
}

// One durable slot, as in the real runtime. Null means lost; an overdue value stays set while
// its delivery waits behind other calls in the mailbox.
export class FakeAlarm {
  scheduled: number | null = null;
  sets = 0;
  get = () => this.scheduled;
  set = (ms: number) => {
    this.scheduled = ms;
    this.sets += 1;
  };
}

export class FakeActor {
  static registry = new Map<string, FakeActor>();
  static world: World | null = null;

  // No World: a plain shared instance, called directly. World: a mailbox reference.
  static get(this: new () => FakeActor, id: string) {
    const key = `${this.name}:${id}`;
    const world = FakeActor.world;
    const store = world ? world.instances : FakeActor.registry;
    let instance = store.get(key);
    if (!instance) {
      instance = new this();
      instance.id = id;
      store.set(key, instance);
    }
    return world ? world.reference(key, instance) : instance;
  }

  id = "";
  db = { transaction: async <T>(run: () => Promise<T>) => run() };
  alarm = new FakeAlarm();
  broadcast = noop;
}

mock.module("terse-sdk/actor", () => ({
  Actor: FakeActor,
  Persisted: noop,
  Emittable: noop,
  Ephemeral: noop,
  Interleave: noop,
  Compute: () => noop,
}));

globalThis.fetch = (async (url: string, init?: { body?: string }) => {
  FakeActor.world?.posts.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  return new Response("{}");
}) as unknown as typeof fetch;
AbortSignal.timeout = () => new AbortController().signal;

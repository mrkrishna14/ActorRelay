// A stand-in for terse-sdk/actor, so the real Component, Plant and Company classes run in this process.
// FAKE: no durability, no mailbox serialisation, no real alarms. It proves shapes and contract behaviour only;
// anything about persistence or concurrency has to be proven on the real runtime.
const instances = new Map<string, FakeActor>();
export const broadcasts: { actor: string; id: string; message: any }[] = [];

export const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

// Everything crossing an actor boundary goes through JSON, as it does on the wire.
function remote(instance: FakeActor): any {
  return new Proxy(
    {},
    {
      get: (_, name: string) =>
        async (...args: unknown[]) => clone(await (instance as any)[name](...clone(args))),
    },
  );
}

export class FakeActor {
  actorId = "";
  alarm = {
    at: null as number | null,
    get() {
      return this.at;
    },
    set(ms: number) {
      this.at = ms;
    },
    delete() {
      this.at = null;
    },
  };
  db = { transaction: async <T>(fn: () => Promise<T>) => fn() };

  get id() {
    return this.actorId;
  }

  broadcast(message: unknown) {
    broadcasts.push({ actor: this.constructor.name, id: this.actorId, message: clone(message) });
  }

  static get(this: new () => FakeActor, id: string) {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`illegal actor id: ${id}`); // the real runtime's rule
    const key = `${this.name}:${id}`;
    let instance = instances.get(key);
    if (!instance) {
      instance = new this();
      instance.actorId = id;
      instances.set(key, instance);
    }
    return remote(instance);
  }
}

export const resetFakeTerse = () => {
  instances.clear();
  broadcasts.length = 0;
};

const noop = () => undefined;
export const fakeModule = { Actor: FakeActor, Persisted: noop, Emittable: noop, Ephemeral: noop, Interleave: noop, Compute: () => noop };

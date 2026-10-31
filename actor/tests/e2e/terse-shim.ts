// IN-PROCESS STAND-IN FOR THE TERSE RUNTIME, not Terse. It lets the real classes in actor/src/actor.ts run
// before the runtime is installed: one serial mailbox per actor, one alarm per actor, and JSON on every
// call boundary, because that is the semantics the actors rely on. Nothing is durable here, so a pass on
// this shim says nothing about persistence or crash recovery, and the table labels it actors=in-process-shim.
type Ctor = new () => Actor;

class Mailbox {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

type Slot = { instance: Actor; mailbox: Mailbox };

const slots = new Map<string, Slot>();
let stopped = false;
const onTheWire = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

function slotFor(cls: Ctor, id: string): Slot {
  const key = `${cls.name}/${id}`;
  let slot = slots.get(key);
  if (!slot) {
    const instance = new cls();
    instance.bind(id);
    slot = { instance, mailbox: new Mailbox() };
    slots.set(key, slot);
  }
  return slot;
}

function deliver(cls: Ctor, id: string, method: string, args: unknown[]) {
  const slot = slotFor(cls, id);
  const wired = onTheWire(args);
  return slot.mailbox.run(async () => {
    const target = (slot.instance as unknown as Record<string, unknown>)[method];
    if (typeof target !== "function") throw new Error(`method_not_found: ${cls.name}.${method}`);
    return onTheWire(await target.apply(slot.instance, wired));
  });
}

class Alarm {
  private at: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly fire: () => void) {}

  get(): number | null {
    return this.at;
  }

  set(at: number): void {
    clearTimeout(this.timer);
    this.at = at;
    this.timer = setTimeout(() => {
      this.at = null;
      if (!stopped) this.fire();
    }, Math.max(0, at - Date.now()));
  }

  delete(): void {
    clearTimeout(this.timer);
    this.at = null;
  }
}

export class Actor {
  private actorId = "";
  alarm: Alarm;
  db = { transaction: async <T>(work: () => Promise<T>): Promise<T> => work() };

  constructor() {
    const cls = this.constructor as Ctor;
    this.alarm = new Alarm(() => {
      void deliver(cls, this.actorId, "onAlarm", []).catch(() => undefined);
    });
  }

  bind(id: string) {
    this.actorId = id;
  }

  get id(): string {
    return this.actorId;
  }

  broadcast(_message: unknown): void {}

  static get(id: string): any {
    const cls = this as unknown as Ctor;
    return new Proxy({}, {
      get: (_target, method: string) => (method === "then" ? undefined : (...args: unknown[]) => deliver(cls, id, method, args)),
    });
  }
}

export const Persisted = (..._args: unknown[]): void => undefined;
export const Emittable = (..._args: unknown[]): void => undefined;
export const Ephemeral = (..._args: unknown[]): void => undefined;
export const Compute = (..._options: unknown[]) => (..._args: unknown[]): void => undefined;

export function stopAllAlarms() {
  stopped = true;
}

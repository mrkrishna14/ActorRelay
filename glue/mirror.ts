// Live metrics from the simulator into the Component actors. The simulator pushes /mirror each tick; if the pushes stop,
// glue polls /snapshot instead. Per component only the newest reading waits, so a slow actor never builds a backlog.
import type { ComponentId, PlantId } from "../shared/types";
import type { ActorPort } from "./actors";
import type { BridgePort } from "./bridge";
import { PLANT_IDS } from "./config";

const MIRROR_TIMEOUT_MS = 2500;
/** Pushes this recent mean the simulator is driving and a poll would only repeat it. */
const PUSH_FRESH_MS = 2500;
const POLL_MIN_GAP_MS = 800;
export const SIM_FRESH_MS = 5000;

type Job = { metrics: Record<string, number>; resolve: (outcome: "sent" | "superseded") => void; reject: (error: unknown) => void };
type Slot = { busy: boolean; pending: Job | null };

export class MirrorPump {
  private readonly slots = new Map<ComponentId, Slot>();
  private lastPushAt = 0;
  private lastPollAt = 0;
  private polling = false;
  lastSimAt = 0;
  mirrored = 0;

  constructor(
    private readonly actors: ActorPort,
    private readonly bridge: BridgePort,
    private readonly onState: (state: unknown) => void,
  ) {}

  /** A /mirror from the simulator. */
  pushed(componentId: ComponentId, metrics: Record<string, number>) {
    this.lastPushAt = this.lastSimAt = Date.now();
    return this.send(componentId, metrics);
  }

  send(componentId: ComponentId, metrics: Record<string, number>): Promise<"sent" | "superseded"> {
    let slot = this.slots.get(componentId);
    if (!slot) this.slots.set(componentId, (slot = { busy: false, pending: null }));
    slot.pending?.resolve("superseded");
    const target = slot;
    return new Promise((resolve, reject) => {
      target.pending = { metrics, resolve, reject };
      if (!target.busy) void this.drain(componentId, target);
    });
  }

  private async drain(componentId: ComponentId, slot: Slot) {
    slot.busy = true;
    while (slot.pending) {
      const job = slot.pending;
      slot.pending = null;
      try {
        this.onState(await this.actors.call("Component", componentId, "mirror", [job.metrics], MIRROR_TIMEOUT_MS));
        this.mirrored += 1;
        job.resolve("sent");
      } catch (error) {
        job.reject(error);
      }
    }
    slot.busy = false;
  }

  /** Reads the simulator when it has stopped pushing. `force` is for the moment right after a reset. */
  async poll(force = false): Promise<void> {
    const now = Date.now();
    if (this.polling) return;
    if (!force && (now - this.lastPushAt < PUSH_FRESH_MS || now - this.lastPollAt < POLL_MIN_GAP_MS)) return;
    this.polling = true;
    this.lastPollAt = now;
    try {
      await Promise.all(PLANT_IDS.map((plantId: PlantId) => this.pollPlant(plantId)));
    } finally {
      this.polling = false;
    }
  }

  private async pollPlant(plantId: PlantId) {
    const snapshot = await this.bridge.snapshot(plantId).catch(() => null);
    if (!snapshot) return;
    this.lastSimAt = Date.now();
    // A refused mirror (not_seeded before the first reset) is expected and repeats next second.
    await Promise.all(Object.entries(snapshot).map(([id, metrics]) => this.send(id, metrics).catch(() => undefined)));
  }

  simulatorSeen(now = Date.now()) {
    return now - this.lastSimAt < SIM_FRESH_MS;
  }
}

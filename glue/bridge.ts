// HTTP client for the simulator on 7300. A /setpoint is sent at most once by the caller and is never retried here:
// after a timeout the write may have landed, so the only honest answer is "unknown".
import { z } from "zod";
import type { ComponentId, PlantId } from "../shared/types";
import { metricsSchema } from "./schemas";

export type SetpointBody = { componentId: ComponentId; metric: string; value: number; proposalId: string };
export type Snapshot = Record<ComponentId, Record<string, number>>;

export class SetpointFailed extends Error {
  /** True when the simulator refused, so the write certainly did not happen. */
  constructor(
    message: string,
    readonly refused: boolean,
  ) {
    super(message);
  }
}

export interface BridgePort {
  snapshot(plantId: PlantId): Promise<Snapshot>;
  setpoint(body: SetpointBody): Promise<{ applied: number | null }>;
  reset(): Promise<void>;
}

const SNAPSHOT_TIMEOUT_MS = 1500;
const SETPOINT_TIMEOUT_MS = 3000;
const RESET_TIMEOUT_MS = 5000;
const appliedSchema = z.object({ applied: z.number().finite().optional(), value: z.number().finite().optional() }).loose();

const COMPONENT_KEY = /^plant-[ab]\/[A-Z]+-\d+$/;

/** Keeps the component rows of a /snapshot reply and ignores anything else the simulator adds beside them. */
export function parseSnapshot(body: unknown, plantId: PlantId): Snapshot {
  const snapshot: Snapshot = {};
  for (const [key, value] of Object.entries((body ?? {}) as Record<string, unknown>)) {
    if (!COMPONENT_KEY.test(key) || !key.startsWith(`${plantId}/`)) continue;
    const metrics = metricsSchema.safeParse(value);
    if (metrics.success) snapshot[key] = metrics.data;
  }
  return snapshot;
}

export class HttpBridge implements BridgePort {
  constructor(private readonly url: string) {}

  async snapshot(plantId: PlantId): Promise<Snapshot> {
    const response = await fetch(`${this.url}/snapshot?plantId=${plantId}`, { signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`bridge /snapshot ${response.status}`);
    return parseSnapshot(await response.json(), plantId);
  }

  async setpoint(body: SetpointBody): Promise<{ applied: number | null }> {
    let response: Response;
    try {
      response = await fetch(`${this.url}/setpoint`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SETPOINT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new SetpointFailed(`no answer from the simulator: ${error instanceof Error ? error.message : error}`, false);
    }
    const text = await response.text();
    if (response.status >= 400 && response.status < 500) throw new SetpointFailed(`simulator refused ${response.status}: ${text.slice(0, 200)}`, true);
    if (!response.ok) throw new SetpointFailed(`simulator error ${response.status}: ${text.slice(0, 200)}`, false);
    let parsed: z.infer<typeof appliedSchema> = {};
    try {
      parsed = appliedSchema.parse(JSON.parse(text));
    } catch {
      // The write was accepted. An odd reply body does not change that, and the claimed value is what gets recorded.
    }
    return { applied: parsed.applied ?? parsed.value ?? null };
  }

  async reset(): Promise<void> {
    const response = await fetch(`${this.url}/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(RESET_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`bridge /reset ${response.status}`);
  }
}

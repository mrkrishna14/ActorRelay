// The one seam to the Terse runtime: the HTTP invoke route the generated client uses. Everything decided about a plant
// is decided inside an actor; this file only carries calls and sorts what comes back into refused and unavailable.
import type { ComponentId, PlantId } from "../shared/types";

export type ActorKind = "Component" | "Plant" | "Company";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ActorPort {
  call<T = unknown>(kind: ActorKind, id: string, method: string, args?: unknown[], timeoutMs?: number): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 4500;

// Actors refuse with "code: detail" (actor/src/logic/validate.ts). A timeout reaching another actor is no answer, not a refusal.
const REFUSAL = /\b([a-z]+(?:_[a-z]+)+): /;

export function refusalStatus(message: string): number {
  const code = REFUSAL.exec(message)?.[1];
  if (code === undefined || code === "actor_call_timeout") return 503;
  return code === "proposal_not_found" ? 404 : 409;
}

/** Terse actor ids allow only [A-Za-z0-9._-], so a ComponentId's slash becomes a dot. */
export const actorIdFor = (kind: ActorKind, id: string) => (kind === "Component" ? id.replaceAll("/", ".") : id);

export class TerseActors implements ActorPort {
  constructor(private readonly url: string) {}

  async call<T = unknown>(kind: ActorKind, id: string, method: string, args: unknown[] = [], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const target = `${kind}(${id}).${method}`;
    let status: number;
    let text: string;
    try {
      const response = await fetch(`${this.url}/v1/projects/local/actors/${kind}/${encodeURIComponent(actorIdFor(kind, id))}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ requestId: crypto.randomUUID(), method, args }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      throw new HttpError(503, `Terse did not answer ${target}: ${error instanceof Error ? error.message : error}`);
    }
    let reply: { outcome?: { type?: string; result?: T; message?: string; code?: string; reason?: string }; error?: { message?: string } } | null = null;
    try {
      reply = JSON.parse(text);
    } catch {
      // An unparsable body is not an outcome; it falls through to the 503 below.
    }
    const outcome = reply?.outcome;
    if (outcome?.type === "completed") return outcome.result as T;
    if (outcome?.type === "failed") {
      const message = String(outcome.message ?? outcome.code);
      throw new HttpError(refusalStatus(message), `${target}: ${message}`);
    }
    throw new HttpError(503, `Terse did not run ${target}: ${outcome?.reason ?? reply?.error?.message ?? `${status} ${text.slice(0, 200)}`}`);
  }
}

/** One retry after a short wait for reads only. A write is never repeated from here. */
export async function readWithRetry<T>(read: () => Promise<T>, waitMs = 150): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 503) throw error;
    await Bun.sleep(waitMs);
    return read();
  }
}

export function plantOfComponent(componentId: ComponentId): PlantId {
  return componentId.split("/")[0] as PlantId;
}

/** Cross-plant votes carry the voter's plant in componentId, so a proposal's plant comes from its own id. */
export function plantOfProposal(proposalId: string): PlantId {
  const match = /^(plant-[ab])-p\d+-/.exec(proposalId);
  if (match === null) throw new HttpError(404, `proposal_not_found: ${proposalId}`);
  return match[1] as PlantId;
}

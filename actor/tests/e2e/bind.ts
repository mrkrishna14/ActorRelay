// Binds the seams in ports.ts. Actors are reached over the Terse HTTP invoke route, which is also what
// the generated client calls. Component ids use a dot on the wire because "/" is illegal in an actor id.
import type { ActorPorts, Bus, CompanyPort, ComponentPort, PlantPort, RelayType } from "./ports.ts";
import type { PlantId } from "../../../shared/types.ts";

export class ActorCallError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

function invoker(baseUrl: string, project: string) {
  const base = baseUrl.replace(/\/$/, "");
  return async function invoke(cls: string, id: string, method: string, args: unknown[]): Promise<any> {
    const res = await fetch(`${base}/v1/projects/${project}/actors/${cls}/${encodeURIComponent(id)}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), method, args }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ActorCallError("bad_response", `${res.status} ${text.slice(0, 200)}`);
    }
    const outcome = body.outcome;
    if (outcome?.type === "completed") return outcome.result;
    if (outcome?.type === "failed") throw new ActorCallError(outcome.code ?? "failed", outcome.message ?? "");
    throw new ActorCallError("bad_response", `${res.status} ${text.slice(0, 200)}`);
  };
}

function proxy<T>(call: (method: string, args: unknown[]) => Promise<unknown>): T {
  return new Proxy({}, { get: (_t, method: string) => (...args: unknown[]) => call(method, args) }) as T;
}

export function terseActors(baseUrl: string, project = "local"): ActorPorts {
  const invoke = invoker(baseUrl, project);
  return {
    label: `real Terse at ${baseUrl}`,
    isReal: true,
    component: (id) => proxy<ComponentPort>((m, a) => invoke("Component", id.replace("/", "."), m, a)),
    plant: (id: PlantId) => proxy<PlantPort>((m, a) => invoke("Plant", id, m, a)),
    company: () => proxy<CompanyPort>((m, a) => invoke("Company", "company", m, a)),
  };
}

export function httpBus(publishUrl: string, isReal: boolean, label: string): Bus {
  return {
    label,
    isReal,
    async publish(type: RelayType, payload: Record<string, unknown>, channels: string[]) {
      const res = await fetch(publishUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, payload, channels }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`relay publish ${type} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
  };
}

// Records publications and delivers them to an in-process callback. Used only when Relay is not running,
// and the table then reads relay=in-process.
export function localBus(deliver: (type: RelayType, payload: Record<string, unknown>, channel: string) => Promise<void>): Bus {
  return {
    label: "in-process bus, no Relay",
    isReal: false,
    async publish(type, payload, channels) {
      await Promise.all(channels.map((c) => deliver(type, payload, c)));
    },
  };
}

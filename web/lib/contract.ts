// Glue responses are data, not trusted shape. A /state body that does not match shared/types.ts is reported
// as a contract error on screen; the dashboard never guesses a field or fills one in.
import type { CompanyState, ComponentView, PlantId, PlantState } from "./types";

/** Honesty labels glue adds beside the contract. Optional: the dashboard shows them when present and renders without them. */
export type GlueMeta = {
  mode: string | null;
  seedLabel: string | null;
  standIn: boolean;
};

export type StateBody = {
  plant: PlantState;
  company: CompanyState;
  components: ComponentView[];
  meta: GlueMeta;
};

export class ContractError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function must(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ContractError(message);
}

function assertPlant(value: unknown, plantId: PlantId): asserts value is PlantState {
  must(isRecord(value), "/state has no plant object");
  must(value.id === plantId, `/state?plantId=${plantId} returned plant ${String(value.id)}`);
  for (const key of ["components", "proposals", "history", "rules", "audit"] as const) {
    must(Array.isArray(value[key]), `plant.${key} is not an array`);
  }
  must(typeof value.name === "string", "plant.name is not a string");
  must(typeof value.tick === "number", "plant.tick is not a number");
  must(typeof value.connected === "boolean", "plant.connected is not a boolean");
}

function assertCompany(value: unknown): asserts value is CompanyState {
  must(isRecord(value), "/state has no company object");
  for (const key of ["plants", "sharedResources", "rules", "crossPlantProposals", "audit"] as const) {
    must(Array.isArray(value[key]), `company.${key} is not an array`);
  }
}

function assertComponent(value: unknown): asserts value is ComponentView {
  must(isRecord(value), "/state component is not an object");
  must(typeof value.id === "string", "component.id is not a string");
  must(typeof value.tag === "string", `component ${String(value.id)} has no tag`);
  must(isRecord(value.metrics), `component ${String(value.id)} has no metrics`);
  must(isRecord(value.limits), `component ${String(value.id)} has no limits`);
  must(typeof value.status === "string", `component ${String(value.id)} has no status`);
  must(typeof value.marginPct === "number", `component ${String(value.id)} has no marginPct`);
}

function componentList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return Object.values(value);
  throw new ContractError("/state has no components list");
}

function readMeta(body: Record<string, unknown>): GlueMeta {
  const seed = isRecord(body.seed) ? body.seed : {};
  return {
    mode: typeof body.mode === "string" ? body.mode : null,
    seedLabel: typeof seed.label === "string" ? seed.label : null,
    standIn: seed.standIn === true,
  };
}

export function parseStateBody(body: unknown, plantId: PlantId): StateBody {
  must(isRecord(body), "/state body is not an object");
  assertPlant(body.plant, plantId);
  assertCompany(body.company);
  const components = componentList(body.components);
  components.forEach((component) => assertComponent(component));
  return { plant: body.plant, company: body.company, components: components as ComponentView[], meta: readMeta(body) };
}

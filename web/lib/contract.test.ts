import { describe, expect, test } from "bun:test";
import { ContractError, parseStateBody } from "./contract";

const plant = { id: "plant-a", name: "Plant A", components: [], proposals: [], history: [], rules: [], audit: [], tick: 3, connected: true };
const company = { plants: ["plant-a", "plant-b"], sharedResources: [], rules: [], crossPlantProposals: [], audit: [] };
const component = { id: "plant-a/LV-101", tag: "LV-101", metrics: { positionPct: 50 }, limits: {}, status: "ok", marginPct: 10 };

describe("parseStateBody", () => {
  test("accepts the shape glue serves, list or record of components, and reads the honesty labels", () => {
    const parsed = parseStateBody({ mode: "live", plant, company, components: [component], seed: { label: "generated", standIn: false } }, "plant-a");
    expect(parsed.components).toHaveLength(1);
    expect(parsed.meta).toEqual({ mode: "live", seedLabel: "generated", standIn: false });
    expect(parseStateBody({ plant, company, components: { [component.id]: component } }, "plant-a").components).toHaveLength(1);
  });

  test("refuses a body that does not match the contract instead of guessing", () => {
    expect(() => parseStateBody({ company, components: [] }, "plant-a")).toThrow(ContractError);
    expect(() => parseStateBody({ plant: { ...plant, id: "plant-b" }, company, components: [] }, "plant-a")).toThrow(ContractError);
    expect(() => parseStateBody({ plant: { ...plant, audit: null }, company, components: [] }, "plant-a")).toThrow(/plant.audit/);
    expect(() => parseStateBody({ plant, company: {}, components: [] }, "plant-a")).toThrow(ContractError);
    expect(() => parseStateBody({ plant, company }, "plant-a")).toThrow(/components/);
    expect(() => parseStateBody({ plant, company, components: [{ id: "x" }] }, "plant-a")).toThrow(ContractError);
  });
});

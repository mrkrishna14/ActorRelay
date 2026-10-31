// The public surface of the actor classes, read from the source: methods against the docs, emitted fields against
// shared/types.ts. Static, so it runs without the Terse runtime. Nothing here depends on the fake.
import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { claudeMethods, readRepo, task1, task3Routes } from "./lib/docs";

const source = ts.createSourceFile("actor.ts", readRepo("actor/src/actor.ts"), ts.ScriptTarget.ESNext, true);
const classes = new Map<string, ts.ClassDeclaration>();
source.forEachChild((n) => {
  if (ts.isClassDeclaration(n) && n.name) classes.set(n.name.text, n);
});

const decorators = (m: ts.ClassElement) => (ts.canHaveDecorators(m) ? (ts.getDecorators(m) ?? []).map((d) => d.expression.getText()) : []);
const isPrivate = (m: ts.ClassElement) =>
  (m.name !== undefined && ts.isPrivateIdentifier(m.name)) || (ts.canHaveModifiers(m) && (ts.getModifiers(m) ?? []).some((x) => x.kind === ts.SyntaxKind.PrivateKeyword));

function publicMethods(name: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of classes.get(name)!.members) {
    if (ts.isMethodDeclaration(m) && !isPrivate(m)) out[m.name.getText()] = m.parameters.map((p) => p.name.getText());
  }
  return out;
}

const emitted = (name: string) =>
  classes.get(name)!.members.filter((m) => ts.isPropertyDeclaration(m) && decorators(m).includes("Emittable")).map((m) => m.name!.getText()).sort();

function typeKeys(name: string): string[] {
  const types = ts.createSourceFile("types.ts", readRepo("shared/types.ts"), ts.ScriptTarget.ESNext, true);
  let keys: string[] = [];
  types.forEachChild((n) => {
    if (ts.isTypeAliasDeclaration(n) && n.name.text === name && ts.isTypeLiteralNode(n.type)) keys = n.type.members.map((m) => m.name!.getText());
  });
  return keys.sort();
}

// Differences CLAUDE.MD does not list, each settled on the board. A new one must be added here on purpose.
const EXTRA_PARAMS: Record<string, string[]> = { "Component.setMetric": ["token"], "Company.registerPlant": ["models"] };
const INTERNAL = {
  Component: ["getState"],
  Plant: ["getState", "getExecution", "claimDispatch", "redeemToken", "reportDispatchFailure", "rulesFor", "setConnected", "recordAudit", "sweep", "onAlarm"],
  Company: ["getState", "modelExistsElsewhere", "addCrossPlantProposal"],
};

for (const actor of ["Component", "Plant", "Company"] as const) {
  describe(`${actor} methods`, () => {
    const doc = claudeMethods()[actor];
    const code = publicMethods(actor);
    for (const [method, params] of Object.entries(doc)) {
      test(`${method}(${params.join(", ")}) as CLAUDE.MD writes it`, () => {
        expect(code[method]).toEqual([...params, ...(EXTRA_PARAMS[`${actor}.${method}`] ?? [])]);
      });
    }
    test("TASK1 names every method CLAUDE.MD lists", () => {
      const t1 = task1();
      for (const method of Object.keys(doc)) expect(`${method}: ${t1.includes(`\`${method}`)}`).toBe(`${method}: true`);
    });
    test("nothing public beyond the docs and the known internal list", () => {
      const allowed = new Set([...Object.keys(doc), ...INTERNAL[actor]]);
      expect(Object.keys(code).filter((m) => !allowed.has(m))).toEqual([]);
    });
    test("every public method is async, so a generated client can call it", () => {
      for (const m of classes.get(actor)!.members) {
        if (!ts.isMethodDeclaration(m) || isPrivate(m)) continue;
        expect(`${m.name.getText()}: ${(ts.getModifiers(m) ?? []).some((x) => x.kind === ts.SyntaxKind.AsyncKeyword)}`).toBe(`${m.name.getText()}: true`);
      }
    });
  });
}

describe("emitted fields are the contract and nothing else", () => {
  test("Component: ComponentState plus calibration, less id", () => {
    expect(emitted("Component")).toEqual([...typeKeys("ComponentState").filter((k) => k !== "id"), "calibration"].sort());
  });
  test("Plant: PlantState, less id, with tick emitted as tickCount", () => {
    expect(emitted("Plant")).toEqual([...typeKeys("PlantState").filter((k) => k !== "id" && k !== "tick"), "tickCount"].sort());
  });
  test("Company: exactly CompanyState", () => {
    expect(emitted("Company")).toEqual(typeKeys("CompanyState"));
  });
  test("execution state, tokens and hashes are never emitted", () => {
    for (const name of ["Component", "Plant", "Company"]) {
      expect(emitted(name).filter((f) => /token|hash|execution|outbox|setpoint|topology/i.test(f))).toEqual([]);
    }
  });
  test("every persisted field that is not in the contract is private", () => {
    for (const name of ["Component", "Plant", "Company"]) {
      const contract = new Set(emitted(name));
      for (const m of classes.get(name)!.members) {
        if (!ts.isPropertyDeclaration(m) || !decorators(m).includes("Persisted") || contract.has(m.name.getText())) continue;
        expect(`${name}.${m.name.getText()}: ${isPrivate(m)}`).toBe(`${name}.${m.name.getText()}: true`);
      }
    }
  });
});

describe("the Plant's outbound calls", () => {
  const outbound = [...new Set([...readRepo("actor/src/actor.ts").matchAll(/postToGlue\("(\/[\w-]+)"/g)].map((m) => m[1]!))].sort();

  test("are the two routes TASK3 assigns to the Plant, and no others", () => {
    const assigned = task3Routes().filter((r) => r.caller.startsWith("Plant")).map((r) => r.path).sort();
    expect(outbound).toEqual(assigned);
    expect(outbound).toEqual(["/execute-callback", "/tick"]);
  });
});

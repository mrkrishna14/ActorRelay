// The real agent client over real HTTP against lib/spec-glue.ts, a FAKE that only enforces TASK3.MD's routes.
// agent/schemas.ts against shared/types.ts at runtime, to complement types/agent-schemas.assert.ts at compile time.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toJSONSchema } from "zod";
import { GlueError, HttpGlue } from "../../../agent/glue";
import * as agent from "../../../agent/schemas";
import { REPO_ROOT, task1 } from "./lib/docs";
import * as ex from "./lib/examples";
import { routeSchemas as glueSchemas } from "./lib/glue-spec";
import { startSpecGlue, type SpecGlue } from "./lib/spec-glue";
import * as strict from "./lib/schemas";

let real: SpecGlue;
let glue: HttpGlue;
const pump = (to: number, plantId = "plant-a") => ({ plantId, proposerComponentId: `${plantId}/P-100`, metric: "speedPct", to, rationale: "Contract test." });

beforeAll(() => {
  real = startSpecGlue();
  glue = new HttpGlue(real.url);
});
afterAll(() => real.stop());

describe("HttpGlue against the routes TASK3 defines", () => {
  test("component: encoded id, parsed response, calibration passes through", async () => {
    const c = await glue.component("plant-a/LV-101");
    expect(c.id).toBe("plant-a/LV-101");
    expect(c.calibration).toEqual([]);
  });
  test("component: an unknown id is an error, not an empty object", async () => {
    await expect(glue.component("plant-a/NOPE-1")).rejects.toBeInstanceOf(GlueError);
  });
  test("similar: GET with upstreamSnapshot in the query", async () => {
    const events = await glue.similar({ componentId: "plant-a/P-100", metric: "speedPct", to: 85, upstreamSnapshot: { feedM3h: 15, headerBarg: 6 }, k: 5 });
    expect(events.length).toBe(5);
    expect(events[0]!.after).toBe(85);
  });
  test("similar: k of 100, which counter.ts uses", async () => {
    await expect(glue.similar({ componentId: "plant-a/P-100", metric: "speedPct", to: 67.5, k: 100 })).resolves.toBeArray();
  });
  test("rules: bare array", async () => {
    await expect(glue.rules("plant-a/LV-101", "outlet-valve-A")).resolves.toEqual([]);
  });
  test("plant: reads plant out of the state envelope", async () => {
    const p = await glue.plant("plant-a");
    expect(p.id).toBe("plant-a");
    expect(p.components.length).toBe(5);
  });
  test("vote, cross-plant vote and duplicate", async () => {
    await glue.vote({ ...ex.vote, vote: "yes" });
    await glue.vote(ex.crossPlantVote);
    await expect(glue.vote({ ...ex.vote, vote: "yes" })).rejects.toMatchObject({ status: 409 });
  });
  test("counter: exactly the five fields", async () => {
    await glue.counter("plant-a-prop-1", agent.proposalInputSchema.parse(pump(65)));
  });
  test("calibration", async () => {
    await glue.calibration("plant-a/LV-101", ex.calibration);
    expect((await glue.component("plant-a/LV-101")).calibration).toEqual([ex.calibration]);
  });
  test("rule", async () => {
    await glue.rule(ex.rule);
    await expect(glue.rules("plant-a/LV-101", "outlet-valve-A")).resolves.toEqual([ex.rule]);
  });
  test("no call the client made was refused for its shape", () => {
    expect(real.calls.filter((c) => c.status === 400)).toEqual([]);
  });
});

describe("agent source calls only routes that exist", () => {
  const sources = readdirSync(join(REPO_ROOT, "agent")).filter((f) => f.endsWith(".ts"));
  const text = sources.map((f) => readFileSync(join(REPO_ROOT, "agent", f), "utf8"));

  test("every path HttpGlue requests is in TASK1's list and glue's table", () => {
    const client = readFileSync(join(REPO_ROOT, "agent", "glue.ts"), "utf8");
    const posted = [...client.matchAll(/this\.request\("(\/[\w-]+)", \{/g)].map((m) => m[1]!).sort();
    expect(posted).toEqual(["/calibration", "/counter", "/rule", "/vote"]);
    for (const path of posted) expect(glueSchemas[path]).toBeDefined();
    const fetched = [...client.matchAll(/this\.request\(`(\/\w+)/g)].map((m) => m[1]!).sort();
    expect(fetched).toEqual(["/component", "/rules", "/similar", "/state"]);
    for (const route of ["`/component/:id`", "`/similar`", "`/rules?componentId=&model=`", "`/calibration`", "`/rule`"]) expect(task1()).toContain(route);
  });
  test("no agent file writes to the simulator or calls setMetric", () => {
    for (const body of text) {
      expect(body).not.toContain("7300");
      expect(body).not.toContain("/setpoint");
      expect(body).not.toMatch(/\bsetMetric\(/);
    }
  });
  test("agent id format matches TASK1 and the actors", async () => {
    const { agentIdFor } = await import("../../src/ids");
    expect(agentIdFor("plant-a/LV-101")).toBe("agent:plant-a/LV-101");
    expect(text.some((body) => body.includes("agent:${componentId}"))).toBe(true);
  });
});

// Structure only: lengths and patterns may be tighter in one or the other, fields and enums may not differ.
function shape(schema: unknown): unknown {
  const walk = (node: any): any => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;
    const out: any = {};
    for (const key of ["type", "enum", "const", "anyOf", "oneOf", "items", "properties", "required"]) {
      if (node[key] !== undefined) out[key] = key === "required" ? [...node[key]].sort() : walk(node[key]);
    }
    if (node.additionalProperties && Object.keys(node.additionalProperties).length) out.additionalProperties = walk(node.additionalProperties);
    if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).sort().map(([k, v]) => [k, walk(v)]));
    return out;
  };
  return walk(toJSONSchema(schema as any, { io: "output", unrepresentable: "any" }));
}

describe("agent/schemas.ts is structurally shared/types.ts", () => {
  const pairs: [string, unknown, unknown][] = [
    ["Limit", agent.limitSchema, strict.LimitS],
    ["CalibrationEntry", agent.calibrationEntrySchema, strict.CalibrationEntryS],
    ["effect", agent.effectSchema, strict.EffectS],
    ["HistoryEvent", agent.historyEventSchema, strict.HistoryEventS],
    ["LearnedRule", agent.learnedRuleSchema, strict.LearnedRuleS],
    ["Vote", agent.voteSchema, strict.VoteS],
    ["Proposal", agent.proposalSchema, strict.ProposalS],
    ["AuditEntry", agent.auditEntrySchema, strict.AuditEntryS],
    ["PlantState", agent.plantStateSchema, strict.PlantStateS],
    ["CompanyState", agent.companyStateSchema, strict.CompanyStateS],
  ];
  for (const [name, mine, theirs] of pairs) {
    test(name, () => expect(shape(mine)).toEqual(shape(theirs)));
  }
  test("ComponentState, with calibration as the one optional addition", () => {
    const view = shape(agent.componentStateSchema) as any;
    const contract = shape(strict.EmittedComponentS) as any;
    expect(Object.keys(view.properties).sort()).toEqual(Object.keys(contract.properties).sort());
    expect(view.required).toEqual(contract.required.filter((k: string) => k !== "calibration"));
  });
  test("the canonical examples all parse", () => {
    agent.voteSchema.parse(ex.vote);
    agent.proposalSchema.parse(ex.proposal);
    agent.historyEventSchema.parse(ex.event);
    agent.learnedRuleSchema.parse(ex.rule);
    agent.calibrationEntrySchema.parse(ex.calibration);
    agent.plantStateSchema.parse(ex.plantState);
    agent.companyStateSchema.parse(ex.companyState);
    agent.componentStateSchema.parse(ex.emittedComponent);
  });
  test("a vote is strict, because glue's /vote is", () => {
    expect(agent.voteSchema.safeParse({ ...ex.vote, confidence: 1 }).success).toBe(false);
  });
  test("the counter input is strict, because glue's /counter is", () => {
    expect(agent.proposalInputSchema.safeParse({ ...pump(65), from: 50 }).success).toBe(false);
  });
});

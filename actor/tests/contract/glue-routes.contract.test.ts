// Every glue route against TASK3.MD and shared/types.ts. lib/glue-spec.ts is written from the doc, so this holds whatever
// glue is built to it. The actor and agent suites use the same spec, so all three stay on one definition.
import { describe, expect, test } from "bun:test";
import { task1, task3, task3Routes } from "./lib/docs";
import * as ex from "./lib/examples";
import { routeSchemas as glueSchemas } from "./lib/glue-spec";

describe("route list", () => {
  const docRoutes = task3Routes();
  const posts = docRoutes.filter((r) => r.method === "POST");
  const gets = docRoutes.filter((r) => r.method === "GET");

  test("TASK3 parses to the full route table", () => {
    expect(posts.map((r) => r.path)).toEqual([
      "/mirror", "/tick", "/propose", "/vote", "/counter", "/veto", "/execute-callback", "/observed", "/calibration", "/rule", "/reset",
    ]);
    expect(gets.map((r) => r.path)).toEqual(["/component/:id", "/similar", "/rules", "/state"]);
  });
  test("every POST in TASK3 has a validator and every validator is in TASK3", () => {
    expect(Object.keys(glueSchemas).sort()).toEqual(posts.map((r) => r.path).sort());
  });
  test("body keys in TASK3 are the keys the validators accept", () => {
    for (const r of posts.filter((p) => p.bodyKeys.length)) {
      const body = ex.routeBodies[r.path as keyof typeof ex.routeBodies] as Record<string, unknown>;
      expect(`${r.path}: ${Object.keys(body).sort()}`).toBe(`${r.path}: ${[...r.bodyKeys].sort()}`);
    }
  });
});

describe("canonical bodies are accepted", () => {
  for (const [path, body] of Object.entries(ex.routeBodies)) {
    test(`POST ${path}`, () => {
      const parsed = glueSchemas[path]!.safeParse(body);
      if (!parsed.success) console.error(path, parsed.error.issues);
      expect(parsed.success).toBe(true);
    });
  }
  test("a cross-plant vote is accepted as-is", () => {
    expect(glueSchemas["/vote"]!.safeParse({ vote: ex.crossPlantVote }).success).toBe(true);
  });
});

describe("near misses are rejected, so callers must not send them", () => {
  const rejected: [string, string, unknown][] = [
    ["/vote", "a bare Vote without the {vote} wrapper", ex.vote],
    ["/calibration", "a bare CalibrationEntry", ex.calibration],
    ["/rule", "a bare LearnedRule", ex.rule],
    ["/counter", "a full Proposal as proposal", { parentProposalId: "p", proposal: ex.proposal }],
    ["/counter", "from or proposerAgentId inside proposal", { parentProposalId: "p", proposal: { ...ex.routeBodies["/counter"].proposal, from: 50 } }],
    ["/counter", "a proposal missing plantId or metric", { parentProposalId: "p", proposal: { to: 65, rationale: "x" } }],
    ["/propose", "from", { ...ex.routeBodies["/propose"], from: 50 }],
    ["/propose", "proposerAgentId", { ...ex.routeBodies["/propose"], proposerAgentId: "agent:plant-a/P-100" }],
    ["/propose", "a proposer from the other plant", { ...ex.routeBodies["/propose"], plantId: "plant-b" }],
    ["/tick", "a plantId from the Plant alarm", { plantId: "plant-a" }],
    ["/execute-callback", "the one-time token", { proposalId: "p", token: "t" }],
    ["/veto", "a missing by", { proposalId: "p" }],
    ["/mirror", "a non-finite metric", { componentId: "plant-a/LV-101", metrics: { positionPct: Infinity } }],
    ["/vote", "extra fields on the vote", { vote: { ...ex.vote, confidence: 0.9 } }],
    ["/vote", "the short safe no from TASK1 step 5", { vote: { vote: "no", reason: "malformed prediction" } }],
    ["/vote", "an empty reason", { vote: { ...ex.vote, reason: "" } }],
    ["/vote", "a fractional similarCount", { vote: { ...ex.vote, similarCount: 2.5 } }],
  ];
  for (const [path, what, body] of rejected) {
    test(`POST ${path}: ${what}`, () => {
      expect(glueSchemas[path]!.safeParse(body).success).toBe(false);
    });
  }
});

describe("GET routes the agents read", () => {
  test("TASK1's /similar arguments are carried by TASK3's GET", () => {
    // TASK1 step 2 passes upstreamSnapshot and TASK3 only writes GET /similar?..., so the query string has to carry it.
    expect(task1()).toContain("{componentId: proposal.proposerComponentId, metric: proposal.metric, to: proposal.to, upstreamSnapshot, k: 5}");
    expect(task3()).toContain("GET /similar?...");
  });
  test("a ComponentId has to be encoded in /component/:id", () => {
    expect(`/component/${encodeURIComponent("plant-a/LV-101")}`).toBe("/component/plant-a%2FLV-101");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { fetchGlue, liveApi, toDemoState, type GlueState } from "./live";

// Trimmed from a real glue /state?plantId=plant-a response (live mode).
const tags = ["P-100", "TK-101", "LV-101", "E-101", "TV-101"] as const;
const roles = { "P-100": "mechanic", "TK-101": "process_engineer", "LV-101": "mechanic", "E-101": "chemical_engineer", "TV-101": "safety" } as const;
const vendors = { "P-100": "codex", "TK-101": "claude", "LV-101": "codex", "E-101": "claude", "TV-101": "claude" } as const;
const metricsFor = (tag: string, lv = 49.93691957532115) =>
  tag === "P-100" ? { speedPct: 50, feedM3h: 15 } : tag === "TK-101" ? { levelPct: 50, tempC: 75 } : tag === "LV-101" ? { positionPct: lv }
    : tag === "E-101" ? { dutyKw: 898.33 } : { positionPct: 50.14, steamKgH: 1533.1, headerBarg: 6 };
// Glue returns components in its own order; the adapter must reorder.
const components = (["plant-b", "plant-a"] as const).flatMap((plantId) => [...tags].reverse().map((tag) => ({
  calibration: [], downstream: [], id: `${plantId}/${tag}`, lastTick: "2026-10-31T20:47:19.406Z",
  limits: tag === "LV-101" ? { positionPct: { critical: 90, max: 80, min: 10 } } : {}, marginPct: 10,
  metrics: metricsFor(tag, plantId === "plant-a" ? 49.9 : 50.1), model: "m", name: `${tag} name`, plantId, role: roles[tag],
  sharedResources: tag === "TV-101" ? ["steam-header-1"] : [], status: "ok", tag, upstream: [], vendor: vendors[tag],
})));

const blockedVote = {
  agentId: "agent:plant-a/LV-101", componentId: "plant-a/LV-101",
  evidenceEventIds: ["hist-plant-a-200", "hist-plant-a-107"],
  evidenceRuleIds: ["company:P-100:speedPct>=80->LV-101:positionPct>="],
  marginPct: 10, predicted: { positionPct: 86.7 }, proposalId: "plant-a-p0001",
  reason: "[openai:gpt-6.1-sol] Predicted LV-101 positionPct is 86.7%, exceeding the 81% vote-no threshold.", similarCount: 5, vote: "no",
};
const crossVote = {
  agentId: "agent:plant-b/TV-101", componentId: "plant-b/TV-101", evidenceEventIds: [], evidenceRuleIds: [], marginPct: 10,
  predicted: { headerBarg: 5.48, positionPct: 51.5 }, proposalId: "plant-a-p0001", reason: "[openai:gpt-6.1-sol] Header drops slightly.", similarCount: 5, vote: "yes",
};
const history = [
  {
    after: 88, approvedBy: ["Shift Supervisor"], at: "2026-03-07T00:00:00Z", before: 50, componentId: "plant-a/P-100", metric: "speedPct",
    effects: [{ after: 91.2, before: 50, componentId: "plant-a/LV-101", metric: "positionPct", ticksToSettle: 3 }],
    id: "hist-plant-a-107", incident: "LV-101 no control headroom", operator: "Board Operator", plantId: "plant-a", proposalId: null, upstreamSnapshot: {},
  },
  {
    after: 65, approvedBy: [], at: "2026-03-09T00:00:00Z", before: 50, componentId: "plant-a/P-100", metric: "speedPct",
    effects: [{ after: 67.4833, before: 50, componentId: "plant-a/LV-101", metric: "positionPct", ticksToSettle: 1 }],
    id: "hist-plant-a-200", incident: null, operator: null, plantId: "plant-a", proposalId: null, upstreamSnapshot: {},
  },
];
const plantRule = {
  condition: { componentId: "plant-a/P-100", metric: "speedPct", op: ">=", value: 90 },
  consequence: { componentId: "plant-a/LV-101", metric: "positionPct", op: ">=", value: 92, withinTicks: 8 },
  createdAt: "2024-02-22T00:00:00Z", id: "rule:plant-a/P-100:speedPct>=90->plant-a/LV-101:positionPct>=", lastSeenAt: "2025-12-13T00:00:00Z",
  model: "outlet-valve-A", scope: "plant", supportEventIds: ["hist-plant-a-107"], text: "P-100 speedPct ≥ 90 → LV-101 positionPct ≥ 92 within 8 ticks, seen 9 times", timesSeen: 9,
};
const companyRule = { ...plantRule, id: "company:P-100:speedPct>=80->LV-101:positionPct>=", scope: "company", text: "Learned in plant-a: P-100 speedPct ≥ 80 → LV-101 positionPct ≥ 85", timesSeen: 12 };
const company = {
  audit: [{ at: "2026-10-31T20:39:21.800Z", by: "agent:plant-a/P-100", kind: "proposal", plantId: "company", refId: "plant-a-p0001", summary: "cross-plant proposal" }],
  crossPlantProposals: ["plant-a-p0001"], plants: ["plant-a", "plant-b"], rules: [companyRule], sharedResources: [],
};
const plantA = {
  id: "plant-a", name: "Plant A", components: tags.map((t) => `plant-a/${t}`), connected: true, tick: 42,
  history, rules: [plantRule],
  proposals: [
    {
      at: "2026-10-31T20:39:26.534Z", crossPlant: false, from: 50, id: "plant-a-p0002", metric: "speedPct", parentProposalId: "plant-a-p0001", plantId: "plant-a",
      proposerAgentId: "agent:plant-a/P-100", proposerComponentId: "plant-a/P-100", rationale: "Counter to plant-a-p0001", requiredVoters: [],
      status: "executed", to: 70, vetoDeadline: "2026-10-31T20:39:40.104Z", votes: [],
    },
    {
      at: "2026-10-31T20:39:21.753Z", crossPlant: true, from: 50, id: "plant-a-p0001", metric: "speedPct", parentProposalId: null, plantId: "plant-a",
      proposerAgentId: "agent:plant-a/P-100", proposerComponentId: "plant-a/P-100", rationale: "E2E throughput request",
      requiredVoters: ["plant-a/LV-101", "plant-b/TV-101"], status: "blocked", to: 85, vetoDeadline: null, votes: [blockedVote, crossVote],
    },
  ],
  audit: [
    { at: "2026-10-31T20:39:21.790Z", by: "agent:plant-a/P-100", kind: "proposal", plantId: "plant-a", refId: "plant-a-p0001", summary: "P-100 speedPct 50 → 85" },
    { at: "2026-10-31T20:39:25.260Z", by: "agent:plant-a/LV-101", kind: "vote", plantId: "plant-a", refId: "plant-a-p0001", summary: "LV-101 (plant-a/LV-101) votes no: ..." },
    { at: "2026-10-31T20:39:25.261Z", by: "plant", kind: "block", plantId: "plant-a", refId: "plant-a-p0001", summary: "blocked: LV-101: predicted past threshold" },
    { at: "2026-10-31T20:39:40.485Z", by: "plant", kind: "execute", plantId: "plant-a", refId: "plant-a-p0002", summary: "approved for dispatch: P-100 speedPct → 70" },
    { at: "2026-10-31T20:30:00.000Z", by: "plant", kind: "incident", plantId: "plant-a", refId: "hist-plant-a-107", summary: "LV-101 no control headroom" },
  ],
};
const plantB = { id: "plant-b", name: "Plant B", components: tags.map((t) => `plant-b/${t}`), connected: true, tick: 42, history: [], rules: [], proposals: [], audit: [] };
const stateA: GlueState = { plant: plantA, company, components, mode: "live", integrations: {} };
const stateB: GlueState = { plant: plantB, company, components, mode: "live", integrations: {} };
const NOW = Date.parse("2026-10-31T20:40:00Z");

describe("toDemoState", () => {
  const s = toDemoState(stateA, stateB, null, NOW);

  test("10 components, plant-a then plant-b, tags in dashboard order, human role labels", () => {
    expect(s.components.length).toBe(10);
    expect(s.components.map((c) => c.id).slice(0, 5)).toEqual(tags.map((t) => `plant-a/${t}`));
    expect(s.components[5]!.id).toBe("plant-b/P-100");
    expect(s.components.find((c) => c.id === "plant-a/TK-101")!.role).toBe("Process engineer");
    expect(s.components.find((c) => c.id === "plant-a/LV-101")!.vendor).toBe("codex");
    expect(s.components.find((c) => c.id === "plant-a/LV-101")!.limits!.positionPct!.critical).toBe(90);
  });

  test("proposals sorted by time; blocked votes keep tags, plants, predictions and evidence ids", () => {
    expect(s.proposals.map((p) => p.id)).toEqual(["plant-a-p0001", "plant-a-p0002"]);
    const blocked = s.proposals[0]!;
    expect(blocked.status).toBe("blocked");
    expect(blocked.createdAt).toBe(Date.parse("2026-10-31T20:39:21.753Z"));
    expect(blocked.vetoDeadline).toBeUndefined();
    const lv = blocked.votes.find((v) => v.tag === "LV-101")!;
    expect(lv).toMatchObject({ plantId: "plant-a", vote: "no", predicted: 86.7 });
    expect(lv.evidence).toEqual(["hist-plant-a-200", "hist-plant-a-107", "company:P-100:speedPct>=80->LV-101:positionPct>="]);
    expect(lv.reason.startsWith("[openai:")).toBe(true);
    const cross = blocked.votes.find((v) => v.plantId === "plant-b")!;
    expect(cross).toMatchObject({ tag: "TV-101", vote: "yes", predicted: 5.48 });
    const counter = s.proposals[1]!;
    expect(counter.parentId).toBe("plant-a-p0001");
    expect(counter.vetoDeadline).toBe(Date.parse("2026-10-31T20:39:40.104Z"));
  });

  test("history events and plant + company rules become evidence", () => {
    const event = s.evidence.find((e) => e.id === "hist-plant-a-107")!;
    expect(event).toMatchObject({ kind: "event", plantId: "plant-a", before: 50, after: 88, observed: 91.2 });
    expect(event.title).toContain("LV-101 no control headroom");
    const rules = s.evidence.filter((e) => e.kind === "rule");
    expect(rules.map((r) => r.id).sort()).toEqual([companyRule.id, plantRule.id].sort());
    expect(rules.find((r) => r.id === companyRule.id)!.summary).toContain("seen 12×");
    expect(rules.find((r) => r.id === plantRule.id)!.supportIds).toEqual(["hist-plant-a-107"]);
  });

  test("audit merges plants + company, sorted, linked to evidence where it exists", () => {
    expect(s.audit.length).toBe(plantA.audit.length + company.audit.length);
    expect(s.audit.map((a) => a.at)).toEqual([...s.audit.map((a) => a.at)].sort((x, y) => x - y));
    expect(s.audit.find((a) => a.text === "LV-101 no control headroom")!.evidenceId).toBe("hist-plant-a-107");
    expect(s.audit.some((a) => a.plantId === "company")).toBe(true);
  });

  test("chat: proposal, votes (cross-plant on company) and decisions, with stable ids and OpenAI label", () => {
    const ids = s.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const vote = s.messages.find((m) => m.id === "live-plant-a-p0001-vote-plant-a/LV-101")!;
    expect(vote).toMatchObject({ channel: "plant-a", sender: "LV-101", vendor: "OpenAI", proposalId: "plant-a-p0001" });
    expect(vote.text.startsWith("NO · [openai:")).toBe(true);
    expect(s.messages.find((m) => m.id === "live-plant-a-p0001-vote-plant-b/TV-101")!.channel).toBe("company");
    expect(s.messages.some((m) => m.kind === "system" && m.text.startsWith("blocked:"))).toBe(true);
    expect(toDemoState(stateA, stateB, s, NOW + 1000).messages.map((m) => m.id)).toEqual(ids);
  });

  test("trends append the LV-101 position and drop points older than 120 s", () => {
    expect(s.trends["plant-a"]).toEqual([{ time: NOW, value: 49.9 }]);
    expect(s.trends["plant-b"]).toEqual([{ time: NOW, value: 50.1 }]);
    const later = toDemoState(stateA, stateB, s, NOW + 1000);
    expect(later.trends["plant-a"]!.length).toBe(2);
    const muchLater = toDemoState(stateA, stateB, later, NOW + 121_500);
    expect(muchLater.trends["plant-a"]!.map((p) => p.time)).toEqual([NOW + 121_500]);
    let rolling = s;
    for (let i = 1; i <= 200; i++) rolling = toDemoState(stateA, stateB, rolling, NOW + i * 500);
    expect(rolling.trends["plant-a"]!.length).toBeLessThanOrEqual(121);
  });

  test("observation while the newest proposal is executed but not yet observed", () => {
    expect(s.observation).toEqual({ plantId: "plant-a", proposalId: "plant-a-p0002", from: 50, target: 70, startedAt: Date.parse("2026-10-31T20:39:26.534Z") });
    const observed = { ...plantA, history: [...history, { ...history[1], id: "observed:plant-a-p0002", proposalId: "plant-a-p0002", at: "2026-10-31T20:39:50Z" }] };
    expect(toDemoState({ ...stateA, plant: observed }, stateB, s, NOW).observation).toBeNull();
    expect(s.now).toBe(NOW);
    expect(s.paused).toBe(false);
  });
});

describe("glue calls", () => {
  const original = globalThis.fetch;
  afterEach(() => { globalThis.fetch = original; });
  const capture = () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return calls;
  };

  test("propose / veto / reset send glue's exact bodies", async () => {
    const calls = capture();
    const api = liveApi("http://glue.test/");
    await api.propose("plant-b", 85, "Increase throughput");
    await api.veto("plant-a-p0002");
    await api.reset();
    expect(calls.map((c) => c.url)).toEqual(["http://glue.test/propose", "http://glue.test/veto", "http://glue.test/reset"]);
    expect(calls.every((c) => c.init?.method === "POST")).toBe(true);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ plantId: "plant-b", proposerComponentId: "plant-b/P-100", metric: "speedPct", to: 85, rationale: "Increase throughput" });
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ proposalId: "plant-a-p0002", by: "operator" });
    expect(JSON.parse(String(calls[2]!.init!.body))).toEqual({});
  });

  test("fetchGlue reads /state for a plant; errors surface glue's message", async () => {
    const calls = capture();
    await fetchGlue("http://glue.test", "plant-a");
    expect(calls[0]!.url).toBe("http://glue.test/state?plantId=plant-a");
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Validation failed" }), { status: 400 })) as unknown as typeof fetch;
    await expect(liveApi("http://glue.test").propose("plant-a", 200)).rejects.toThrow("Validation failed");
  });
});

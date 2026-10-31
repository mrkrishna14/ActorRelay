// Real Glue routes over Request objects, with fake actors, simulator and Relay (tests/fakes.ts).
import { describe, expect, test } from "bun:test";
import { refusalStatus } from "../actors";
import { compactPlant } from "../reads";
import { STAND_IN_LABEL } from "../seed";
import { build, makeEvent, makeProposal, makeRule, makeVote, PROPOSAL_ID, tempRepo } from "./fakes";

const proposeBody = { plantId: "plant-a", proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 85, rationale: "Raise throughput." };
const entry = { at: "2026-10-31T20:00:00.000Z", proposalId: PROPOSAL_ID, metric: "positionPct", predicted: 66, observed: 67, absError: 1 };

describe("what a request must look like", () => {
  const nearMisses: [string, string, unknown][] = [
    ["/vote", "a bare Vote", makeVote()],
    ["/vote", "an extra field", { vote: { ...makeVote(), confidence: 0.9 } }],
    ["/vote", "an empty reason", { vote: makeVote({ reason: "" }) }],
    ["/vote", "a fractional similarCount", { vote: makeVote({ similarCount: 2.5 }) }],
    ["/calibration", "a bare entry", entry],
    ["/rule", "a bare rule", makeRule()],
    ["/counter", "a full Proposal", { parentProposalId: "p", proposal: makeProposal() }],
    ["/counter", "from inside proposal", { parentProposalId: "p", proposal: { ...proposeBody, from: 50 } }],
    ["/propose", "from", { ...proposeBody, from: 50 }],
    ["/propose", "proposerAgentId", { ...proposeBody, proposerAgentId: "agent:plant-a/P-100" }],
    ["/propose", "a proposer from the other plant", { ...proposeBody, plantId: "plant-b" }],
    ["/tick", "a plantId", { plantId: "plant-a" }],
    ["/execute-callback", "a token", { proposalId: "p", token: "t" }],
    ["/veto", "a missing by", { proposalId: "p" }],
    ["/mirror", "a null metric", { componentId: "plant-a/LV-101", metrics: { positionPct: null } }],
    ["/observed", "a negative ticksToSettle", { proposalId: "p", effects: [{ componentId: "plant-a/LV-101", metric: "x", before: 1, after: 2, ticksToSettle: -1 }] }],
    ["/reset", "a body", { force: true }],
  ];
  for (const [path, what, body] of nearMisses) {
    test(`POST ${path} refuses ${what} with 400 and calls no actor`, async () => {
      const { post, actors } = build();
      expect((await post(path, body)).status).toBe(400);
      expect(actors.calls).toEqual([]);
    });
  }

  test("an unknown route is 404", async () => {
    const { post, get } = build();
    expect((await post("/propse", {})).status).toBe(404);
    expect((await get("/nothing")).status).toBe(404);
  });

  test("a body that is not JSON is 400", async () => {
    const { glue } = build();
    const response = await glue.handle(new Request("http://glue/vote", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }));
    expect(response.status).toBe(400);
  });

  test("text/plain is refused before the body is read, so a cross-site form post reaches nothing", async () => {
    const { glue, actors } = build();
    const response = await glue.handle(new Request("http://glue/vote", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ vote: makeVote() }) }));
    expect(response.status).toBe(415);
    expect(actors.calls).toEqual([]);
  });

  test("a foreign Origin is refused and a loopback one gets CORS headers", async () => {
    const { post, get, glue } = build();
    expect((await post("/propose", proposeBody, { origin: "https://evil.example" })).status).toBe(403);
    expect((await get("/health", { origin: "https://evil.example" })).status).toBe(403);
    const ok = await get("/health", { origin: "http://localhost:3000" });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const preflight = await glue.handle(new Request("http://glue/propose", { method: "OPTIONS", headers: { origin: "http://127.0.0.1:3000" } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("content-type");
  });

  test("an actor refusal is 409, an unknown proposal 404, and no answer 503", () => {
    expect(refusalStatus("duplicate_vote: plant-a/LV-101 already voted")).toBe(409);
    expect(refusalStatus("Error: stale_proposal: p is expired")).toBe(409);
    expect(refusalStatus("proposal_not_found: p")).toBe(404);
    expect(refusalStatus("actor_call_timeout: Plant.redeemToken")).toBe(503);
    expect(refusalStatus("Cannot read properties of undefined")).toBe(503);
  });
});

describe("reads the agents and the dashboard use", () => {
  test("/component decodes %2F and maps the id through the actor call", async () => {
    const { get, actors } = build();
    const body = (await (await get("/component/plant-a%2FLV-101")).json()) as { id: string };
    expect(body.id).toBe("plant-a/LV-101");
    expect(actors.named("getState")[0]).toMatchObject({ kind: "Component", id: "plant-a/LV-101" });
    expect((await get("/component/plant-a%2FXX-1")).status).toBe(404);
  });

  test("/similar turns the query strings agent/glue.ts sends into real values", async () => {
    const { get, actors } = build();
    const query = new URLSearchParams({ componentId: "plant-a/P-100", metric: "speedPct", to: "85", k: "5", upstreamSnapshot: JSON.stringify({ feedM3h: 15 }) });
    const response = await get(`/similar?${query}`);
    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
    expect(actors.named("similar")[0]).toMatchObject({ kind: "Plant", id: "plant-a", args: ["plant-a/P-100", "speedPct", 85, { feedM3h: 15 }, 5] });
  });

  test("/similar refuses a snapshot that is not JSON or not numbers", async () => {
    const { get } = build();
    const base = { componentId: "plant-a/P-100", metric: "speedPct", to: "85" };
    expect((await get(`/similar?${new URLSearchParams({ ...base, upstreamSnapshot: "{" })}`)).status).toBe(400);
    expect((await get(`/similar?${new URLSearchParams({ ...base, upstreamSnapshot: '{"a":"b"}' })}`)).status).toBe(400);
    expect((await get(`/similar?${new URLSearchParams({ ...base, to: "x" })}`)).status).toBe(400);
  });

  test("/rules selects like Plant.rulesFor: the component's or model's rules, then the company's for that model", async () => {
    const { get, actors } = build();
    const own = makeRule({ id: "own", model: "other", consequence: { componentId: "plant-b/LV-101", metric: "positionPct", op: ">=", value: 85, withinTicks: 3 } });
    const byModel = makeRule({ id: "model", model: "outlet-valve-A", condition: { componentId: "plant-b/P-100", metric: "speedPct", op: ">=", value: 80 } });
    const elsewhere = makeRule({ id: "elsewhere", model: "steam-coil-A" });
    actors.handlers["Plant.getState"] = (id) => ({ ...actors.plant(id as "plant-a"), rules: [own, byModel, elsewhere] });
    actors.handlers["Company.getState"] = () => ({ plants: [], sharedResources: [], rules: [makeRule({ id: "company", scope: "company" }), makeRule({ id: "company-other", scope: "company", model: "steam-coil-A" })], crossPlantProposals: [], audit: [] });
    const body = (await (await get("/rules?componentId=plant-b/LV-101&model=outlet-valve-A")).json()) as { id: string }[];
    expect(body.map((rule) => rule.id)).toEqual(["own", "model", "company"]);
    expect((await get("/rules")).status).toBe(400);
  });

  test("/state has plant, all ten components, company, mode and the seed label", async () => {
    const root = tempRepo(false);
    const { get } = build({ repoRoot: root });
    const body = (await (await get("/state?plantId=plant-b")).json()) as any;
    expect(Object.keys(body).sort()).toEqual(["company", "components", "mode", "plant", "seed", "services"]);
    expect(body.plant.id).toBe("plant-b");
    expect(body.components).toHaveLength(10);
    expect(body.seed).toMatchObject({ standIn: true, label: STAND_IN_LABEL });
    expect((await get("/state?plantId=plant-c")).status).toBe(400);
  });

  test("/state keeps live runs, cited events and the newest few, and full=1 keeps everything", async () => {
    const { get, actors } = build();
    const seedEvents = Array.from({ length: 100 }, (_, i) => makeEvent({ id: `seed-${i}` }));
    const live = makeEvent({ id: "live-1", proposalId: "x" });
    const proposal = makeProposal({ votes: [makeVote({ evidenceEventIds: ["seed-3"] })] });
    actors.handlers["Plant.getState"] = (id) => ({ ...actors.plant(id as "plant-a"), proposals: [proposal], history: [...seedEvents, live] });
    const compact = (await (await get("/state?plantId=plant-a")).json()) as any;
    const ids = compact.plant.history.map((event: { id: string }) => event.id);
    expect(ids).toContain("seed-3");
    expect(ids).toContain("live-1");
    expect(ids).not.toContain("seed-10");
    expect(ids.length).toBe(21);
    actors.calls = [];
    await Bun.sleep(300);
    const full = (await (await get("/state?plantId=plant-a&full=1")).json()) as any;
    expect(full.plant.history).toHaveLength(101);
  });

  test("compaction never drops the fields agent/glue.ts validates", () => {
    const plant = { id: "plant-a", name: "A", components: [], proposals: [], history: [makeEvent()], rules: [makeRule()], audit: [], tick: 3, connected: true } as const;
    expect(Object.keys(compactPlant(plant as never)).sort()).toEqual(Object.keys(plant).sort());
  });

  test("glue's own write shows on the next read, without waiting for a refresh", async () => {
    const { post, get } = build();
    await get("/state?plantId=plant-a");
    await post("/veto", { proposalId: PROPOSAL_ID, by: "operator" });
    const body = (await (await get("/state?plantId=plant-a")).json()) as any;
    expect(body.plant.proposals[0].status).toBe("vetoed");
  });

  test("a read queued before a write cannot hide that write, or a voter would see no proposal and refuse it", async () => {
    const { post, get, glue, actors } = build();
    const empty = { ...actors.plant("plant-a"), proposals: [] };
    actors.handlers["Plant.getState"] = () => empty;
    await glue.wake();
    await Bun.sleep(1050);
    const queued: (() => void)[] = [];
    actors.handlers["Plant.getState"] = () => new Promise((resolve) => queued.push(() => resolve(empty)));
    const waking = glue.wake();
    await Bun.sleep(5);
    await post("/propose", proposeBody);
    queued.forEach((finish) => finish());
    await waking;
    const body = (await (await get("/state?plantId=plant-a")).json()) as any;
    expect(body.plant.proposals.map((p: { id: string }) => p.id)).toEqual([PROPOSAL_ID]);
  });

  test("readers share one Plant read, so a page adds no load to the mailbox", async () => {
    const { get, actors } = build();
    await Promise.all(Array.from({ length: 20 }, () => get("/state?plantId=plant-a")));
    await get("/state?plantId=plant-a");
    expect(actors.named("getState").filter((call) => call.kind === "Plant")).toHaveLength(1);
  });

  test("a copy that stopped refreshing is an error, not a frozen plant", async () => {
    const { get, actors } = build();
    const { HttpError } = await import("../actors");
    await get("/state?plantId=plant-a");
    actors.handlers["Plant.getState"] = () => {
      throw new HttpError(503, "connection refused");
    };
    const realNow = Date.now;
    Date.now = () => realNow() + 6000;
    try {
      expect((await get("/state?plantId=plant-a")).status).toBe(503);
    } finally {
      Date.now = realNow;
    }
  });

  test("/component answers from the newest mirror when it is fresh", async () => {
    const { post, get, actors } = build();
    await post("/mirror", { componentId: "plant-a/LV-101", metrics: { positionPct: 51 } });
    actors.calls = [];
    await get("/component/plant-a%2FLV-101");
    expect(actors.named("getState")).toEqual([]);
  });
});

describe("proposals and votes", () => {
  test("/propose goes to Plant.propose, then to the plant channel and company when cross-plant", async () => {
    const { post, relay, actors } = build();
    const response = await post("/propose", proposeBody);
    expect(response.status).toBe(200);
    expect(actors.named("propose")[0]).toMatchObject({ kind: "Plant", id: "plant-a", args: [proposeBody] });
    expect(relay.sent).toHaveLength(1);
    expect(relay.sent[0]).toMatchObject({ type: "proposal", channels: ["plant-a", "company"] });
    expect(relay.sent[0]?.payload.proposal.id).toBe(PROPOSAL_ID);
  });

  test("a proposal that is not cross-plant stays on its plant channel", async () => {
    const { post, relay, actors } = build();
    actors.handlers["Plant.propose"] = () => makeProposal({ status: "voting", crossPlant: false });
    await post("/propose", proposeBody);
    expect(relay.sent[0]?.channels).toEqual(["plant-a"]);
  });

  test("a refusal from the actor reaches the caller and publishes nothing", async () => {
    const { post, relay, actors } = build();
    const { HttpError } = await import("../actors");
    actors.handlers["Plant.propose"] = () => {
      throw new HttpError(409, "out_of_limits: speedPct 99 is outside 20..95");
    };
    expect((await post("/propose", proposeBody)).status).toBe(409);
    expect(relay.sent).toEqual([]);
  });

  test("/counter passes the parent and publishes the new proposal", async () => {
    const { post, relay, actors } = build();
    const proposal = { ...proposeBody, to: 65 };
    await post("/counter", { parentProposalId: "plant-a-p00000-aaaa", proposal });
    expect(actors.named("propose")[0]?.args).toEqual([{ ...proposal, parentProposalId: "plant-a-p00000-aaaa" }]);
    expect(relay.sent[0]?.type).toBe("proposal");
  });

  test("a cross-plant vote goes to the proposal's plant, not the voter's", async () => {
    const { post, actors } = build();
    const vote = makeVote({ componentId: "plant-b/TV-101", agentId: "agent:plant-b/TV-101", vote: "yes" });
    expect((await post("/vote", { vote })).status).toBe(200);
    expect(actors.named("vote")[0]).toMatchObject({ kind: "Plant", id: "plant-a" });
  });

  test("the same vote twice reaches the actor once", async () => {
    const { post, actors } = build();
    const vote = makeVote();
    expect((await post("/vote", { vote })).status).toBe(200);
    expect((await post("/vote", { vote })).status).toBe(409);
    expect(actors.named("vote")).toHaveLength(1);
  });

  test("a vote that timed out is sent again, and a first try that landed late counts as done", async () => {
    const { post, actors } = build();
    const { HttpError } = await import("../actors");
    actors.handlers["Plant.vote"] = () => {
      if (actors.named("vote").length === 1) throw new HttpError(503, "Terse did not answer: timed out");
      throw new HttpError(409, "duplicate_vote: plant-a/LV-101 already voted");
    };
    expect((await post("/vote", { vote: makeVote() })).status).toBe(200);
    expect(actors.named("vote")).toHaveLength(2);
  });

  test("a yes can still be withdrawn with a no", async () => {
    const { post, actors } = build();
    await post("/vote", { vote: makeVote({ vote: "yes" }) });
    await post("/vote", { vote: makeVote({ vote: "no" }) });
    expect(actors.named("vote")).toHaveLength(2);
  });

  test("a vote the actors did not take can be sent again", async () => {
    const { post, actors } = build();
    const { HttpError } = await import("../actors");
    actors.handlers["Plant.vote"] = () => {
      throw new HttpError(503, "no answer");
    };
    expect((await post("/vote", { vote: makeVote() })).status).toBe(503);
    expect(actors.named("vote")).toHaveLength(3);
    actors.handlers["Plant.vote"] = () => makeProposal();
    expect((await post("/vote", { vote: makeVote() })).status).toBe(200);
  });

  test("a proposal id with no plant in it is 404", async () => {
    const { post } = build();
    expect((await post("/vote", { vote: makeVote({ proposalId: "nonsense" }) })).status).toBe(404);
  });

  test("/veto and /calibration forward to the right actor", async () => {
    const { post, actors } = build();
    await post("/veto", { proposalId: PROPOSAL_ID, by: "operator" });
    expect(actors.named("veto")[0]).toMatchObject({ id: "plant-a", args: [PROPOSAL_ID, "operator"] });
    expect((await post("/calibration", { componentId: "plant-a/LV-101", entry })).status).toBe(200);
    expect(actors.named("addCalibration")[0]).toMatchObject({ id: "plant-a/LV-101", args: [entry] });
  });
});

describe("rules", () => {
  test("/rule promotes in the rule's plant and posts on company", async () => {
    const { post, relay, actors } = build();
    const rule = makeRule({ condition: { componentId: "plant-b/P-100", metric: "speedPct", op: ">=", value: 80 } });
    expect((await post("/rule", { rule })).status).toBe(200);
    expect(actors.named("promoteRule")[0]).toMatchObject({ id: "plant-b" });
    expect(relay.sent[0]).toMatchObject({ type: "rule", channels: ["company"] });
  });

  test("a rule naming no component finds its plant from the events it cites", async () => {
    const { post, actors } = build();
    actors.handlers["Plant.getState"] = (id) => ({ ...actors.plant(id as "plant-a"), history: id === "plant-b" ? [makeEvent({ id: "event-1", plantId: "plant-b" })] : [] });
    const rule = makeRule({ condition: { componentId: null, metric: "speedPct", op: ">=", value: 80 }, consequence: { componentId: null, metric: "positionPct", op: ">=", value: 85, withinTicks: 3 } });
    await post("/rule", { rule });
    expect(actors.named("promoteRule")[0]?.id).toBe("plant-b");
  });

  test("company rules are announced once per version", async () => {
    const { glue, relay, actors } = build();
    let rule = makeRule({ id: "company-rule:x", scope: "company", condition: { componentId: null, metric: "speedPct", op: ">=", value: 80 } });
    actors.handlers["Company.getState"] = () => ({ plants: [], sharedResources: [], rules: [rule], crossPlantProposals: [], audit: [] });
    await glue.wake();
    await Bun.sleep(550);
    await glue.wake();
    expect(relay.sent.filter((sent) => sent.type === "rule")).toHaveLength(1);
    rule = { ...rule, timesSeen: 4 };
    await Bun.sleep(550);
    await glue.wake();
    expect(relay.sent.filter((sent) => sent.type === "rule")).toHaveLength(2);
  });
});

describe("agents on Relay", () => {
  const text = (type: string, payload: unknown) => JSON.stringify({ type, payload });

  test("a vote from its own component's identity reaches the Plant", async () => {
    const { glue, actors } = build();
    await glue.onRelayMessage({ text: text("vote", { vote: makeVote() }), sender: "agent:plant-a/LV-101", channel: "plant-a" });
    expect(actors.named("vote")).toHaveLength(1);
  });

  test("a vote from another identity is refused", async () => {
    const { glue, actors, lines } = build();
    await glue.onRelayMessage({ text: text("vote", { vote: makeVote() }), sender: "agent:plant-a/E-101", channel: "plant-a" });
    expect(actors.named("vote")).toEqual([]);
    expect(lines.join()).toContain("refused");
  });

  test("a counter must come from the proposer's identity", async () => {
    const { glue, actors } = build();
    const payload = { parentProposalId: PROPOSAL_ID, proposal: { ...proposeBody, to: 65 } };
    await glue.onRelayMessage({ text: text("counter", payload), sender: "agent:plant-a/LV-101", channel: "plant-a" });
    expect(actors.named("propose")).toEqual([]);
    await glue.onRelayMessage({ text: text("counter", payload), sender: "agent:plant-a/P-100", channel: "plant-a" });
    expect(actors.named("propose")).toHaveLength(1);
  });

  test("anything that is not a valid message is dropped without throwing", async () => {
    const { glue, actors } = build();
    await glue.onRelayMessage({ text: "not json", sender: "agent:plant-a/LV-101", channel: "plant-a" });
    await glue.onRelayMessage({ text: text("vote", { vote: { vote: "no" } }), sender: "agent:plant-a/LV-101", channel: "plant-a" });
    await glue.onRelayMessage({ text: text("proposal", {}), sender: "agent:plant-a/LV-101", channel: "plant-a" });
    await glue.onRelayMessage({ text: "null", sender: "agent:plant-a/LV-101", channel: "plant-a" });
    expect(actors.calls).toEqual([]);
  });
});

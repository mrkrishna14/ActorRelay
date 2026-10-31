// The whole agent reaction to Relay messages, without Relay. The transport is a list; the model is scripted.
import { describe, expect, test } from "bun:test";
import { AgentRuntime } from "../runtime";
import type { WireMessage } from "../schemas";
import { agentName, decodeEnvelope, encodeEnvelope } from "../wire";
import { FakeGlue, makeProposal, safeExecution } from "./fake-glue";
import { ScriptedLlm } from "./scripted-llm";

const allComponents = (glue: FakeGlue) => [...glue.components.keys()];

function setup(glue = new FakeGlue()) {
  const posted: { message: WireMessage; channel: string; from: string }[] = [];
  const llm = new ScriptedLlm((request) => {
    const asks = (metric: string) => request.user.includes(`predict: ${metric}`);
    if (asks("positionPct, steamKgH")) return JSON.stringify({ vote: "yes", reason: "ok", predicted: { positionPct: 60, steamKgH: 2000, headerBarg: 5.6 } });
    if (asks("levelPct")) return JSON.stringify({ vote: "yes", reason: "ok", predicted: { levelPct: 50, tempC: 73 } });
    if (asks("dutyKw")) return JSON.stringify({ vote: "yes", reason: "ok", predicted: { dutyKw: 1200 } });
    return JSON.stringify({ vote: "yes", reason: "ok", predicted: { positionPct: 66 } });
  });
  const runtime = new AgentRuntime({ glue, llm, owned: allComponents(glue), log: () => undefined, pollMs: 5, post: async (message, channel, from) => void posted.push({ message, channel, from }) });
  return { glue, runtime, posted };
}

const votesIn = (posted: { message: WireMessage }[]) => posted.flatMap((p) => (p.message.type === "vote" ? [p.message.vote] : []));

describe("proposal handling", () => {
  test("each required voter votes once, cross-plant on company, and duplicates are ignored", async () => {
    const { runtime, posted, glue } = setup();
    const proposal = makeProposal({ to: 65 });
    glue.addProposal(proposal);
    runtime.onMessage({ type: "proposal", proposal });
    runtime.onMessage({ type: "proposal", proposal });
    proposal.status = "executed";
    await runtime.drain();
    const voters = votesIn(posted).map((v) => v.componentId).sort();
    expect(voters).toEqual([...proposal.requiredVoters].sort());
    expect(posted.find((p) => p.from === "plant-b/TV-101")?.channel).toBe("company");
    expect(posted.find((p) => p.from === "plant-a/LV-101")?.channel).toBe("plant-a");
  });

  test("the proposer does not vote on itself", async () => {
    const { runtime, posted, glue } = setup();
    const proposal = makeProposal({ to: 65, requiredVoters: ["plant-a/P-100", "plant-a/LV-101"] });
    glue.addProposal(proposal);
    runtime.onMessage({ type: "proposal", proposal });
    proposal.status = "executed";
    await runtime.drain();
    expect(votesIn(posted).map((v) => v.componentId)).toEqual(["plant-a/LV-101"]);
  });

  test("stale and already-decided proposals get no vote", async () => {
    const { runtime, posted } = setup();
    runtime.onMessage({ type: "proposal", proposal: makeProposal({ to: 65, status: "blocked" }) });
    runtime.onMessage({ type: "proposal", proposal: makeProposal({ to: 65, at: new Date(Date.now() - 60_000).toISOString() }) });
    await runtime.drain();
    expect(posted).toHaveLength(0);
  });

  test("invalid relay payloads are dropped, including a vote-shaped order to write", async () => {
    const { runtime, posted, glue } = setup();
    runtime.onMessage({ type: "proposal", proposal: { id: "x" } });
    runtime.onMessage({ type: "setMetric", componentId: "plant-a/P-100", value: 100 });
    runtime.onMessage("garbage");
    await runtime.drain();
    expect(posted).toHaveLength(0);
    expect(glue.similarCalls).toBe(0);
  });

  test("all voters share one similar() call per proposal", async () => {
    const { runtime, glue } = setup();
    const proposal = makeProposal({ to: 65 });
    glue.addProposal(proposal);
    runtime.onMessage({ type: "proposal", proposal });
    proposal.status = "executed";
    await runtime.drain();
    expect(glue.similarCalls).toBe(1);
  });
});

describe("counter trigger", () => {
  test("the proposer notices its own block and posts a counter on the plant channel", async () => {
    const glue = new FakeGlue();
    const posted: { message: WireMessage; channel: string; from: string }[] = [];
    const llm = new ScriptedLlm((request) => (request.system.includes("Pick a safer target") ? JSON.stringify({ value: 65, rationale: "safe history" }) : JSON.stringify({ vote: "no", reason: "too high", predicted: { positionPct: 89 } })));
    const runtime = new AgentRuntime({ glue, llm, owned: ["plant-a/P-100", "plant-a/LV-101"], log: () => undefined, pollMs: 5, post: async (message, channel, from) => void posted.push({ message, channel, from }) });
    const proposal = makeProposal({ to: 85, requiredVoters: ["plant-a/LV-101"] });
    glue.addProposal(proposal);
    runtime.onMessage({ type: "proposal", proposal: structuredClone(proposal) });
    await Bun.sleep(100);
    const vote = votesIn(posted)[0];
    expect(vote.vote).toBe("no");
    proposal.votes = [vote];
    proposal.status = "blocked";
    await runtime.drain();
    const counter = posted.find((p) => p.message.type === "counter");
    expect(counter?.from).toBe("plant-a/P-100");
    expect(counter?.channel).toBe("plant-a");
    expect(counter?.message).toMatchObject({ type: "counter", parentProposalId: proposal.id, proposal: { to: 65 } });
  });
});

describe("executed handling", () => {
  test("learns once even though the message arrives on two channels", async () => {
    const { runtime, glue } = setup();
    const proposal = makeProposal({ id: "p-done", to: 65, status: "executed", requiredVoters: ["plant-a/LV-101"] });
    proposal.votes = [{ proposalId: "p-done", componentId: "plant-a/LV-101", agentId: "agent:plant-a/LV-101", vote: "yes", reason: "ok", predicted: { positionPct: 66 }, marginPct: 10, evidenceEventIds: [], evidenceRuleIds: [], similarCount: 5 }];
    glue.addProposal(proposal);
    const message = { type: "executed", proposalId: "p-done", event: safeExecution("p-done") };
    runtime.onMessage(message);
    runtime.onMessage(message);
    await runtime.drain();
    expect(glue.calibrations).toHaveLength(1);
  });
});

describe("relay envelope", () => {
  test("agents send glue's {type, payload} shape, which its strict /vote and /counter schemas accept", () => {
    const vote = { proposalId: "p", componentId: "plant-a/LV-101", agentId: agentName("plant-a/LV-101"), vote: "no" as const, reason: "r", predicted: {}, marginPct: 10, evidenceEventIds: [], evidenceRuleIds: [], similarCount: 0 };
    expect(JSON.parse(encodeEnvelope({ type: "vote", vote }))).toEqual({ type: "vote", payload: { vote } });
    const proposal = { plantId: "plant-a" as const, proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 65, rationale: "r" };
    expect(JSON.parse(encodeEnvelope({ type: "counter", parentProposalId: "p", proposal }))).toEqual({ type: "counter", payload: { parentProposalId: "p", proposal } });
  });

  test("glue's wrapped and bare payloads both decode", () => {
    const proposal = makeProposal();
    const event = safeExecution("p");
    expect(decodeEnvelope(JSON.stringify({ type: "proposal", payload: { proposal } }))).toMatchObject({ type: "proposal", proposal: { id: proposal.id } });
    expect(decodeEnvelope(JSON.stringify({ type: "proposal", payload: proposal }))).toMatchObject({ type: "proposal", proposal: { id: proposal.id } });
    expect(decodeEnvelope(JSON.stringify({ type: "executed", payload: { proposalId: "p", event } }))).toMatchObject({ type: "executed", proposalId: "p" });
    expect(decodeEnvelope(JSON.stringify({ type: "executed", payload: event }))).toMatchObject({ type: "executed", proposalId: "p" });
  });

  test("anything else decodes to nothing", () => {
    expect(decodeEnvelope("not json")).toBeNull();
    expect(decodeEnvelope(JSON.stringify({ type: "vote", payload: {} }))).toBeNull();
    expect(decodeEnvelope(JSON.stringify({ type: "proposal", payload: { id: "x" } }))).toBeNull();
  });
});

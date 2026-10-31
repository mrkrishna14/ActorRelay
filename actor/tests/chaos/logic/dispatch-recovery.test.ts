// REAL LOGIC, FAKE RUNTIME. The real Plant, Company and Component classes on ar-property's in-memory actor base, with
// no server. These replay the state a crash leaves behind, which the real runtime runs in scenarios/execute.ts proved
// reachable (c3b, c3f). They show what happens next, and how long it lasts, which is too slow to reach on the real
// runtime while each restart costs a rebuild. They say nothing about Terse persistence or recovery.
//   bun test logic/dispatch-recovery.test.ts           (in WSL: Windows Bun misruns the actor classes)
//   CHAOS_SRC=<dir> runs the same tests against a patched copy of actor/src.
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeActor } from "../../property/fake-runtime";

const SRC = process.env.CHAOS_SRC ?? "../../../src";
const { Company, Component, Plant } = (await import(`${SRC}/actor`)) as any;
const seed = JSON.parse(readFileSync(join(import.meta.dir, "../../../../shared/plants.json"), "utf8"));
const CLAIM_TIMEOUT_MS = 20_000;
const FROM = 50;
const VOTERS = ["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101", "plant-b/TV-101"];

let now = Date.parse("2026-10-31T13:00:00.000Z");
const advance = (ms: number) => setSystemTime(new Date((now += ms)));

/** Safe past runs near every target here, so a Plant that counts similar events itself still accepts these votes. */
function safeHistory(plantId: string) {
  return [58, 62, 66, 70, 74, 78].map((after, index) => ({
    id: `fixture-${plantId}-${index}`,
    at: new Date(now - 3_600_000 + index).toISOString(),
    plantId,
    componentId: `${plantId}/P-100`,
    metric: "speedPct",
    before: 50,
    after,
    upstreamSnapshot: {},
    effects: [{ componentId: `${plantId}/LV-101`, metric: "positionPct", before: 50, after, ticksToSettle: 3 }],
    incident: null,
    approvedBy: [],
    operator: null,
    proposalId: null,
  }));
}

function vote(proposal: any, componentId: string) {
  const component = seed.plants.flatMap((plant: any) => plant.components).find((item: any) => item.id === componentId);
  const predicted = Object.fromEntries(Object.keys(component.limits).map((metric) => [metric, component.metrics[metric]]));
  return { proposalId: proposal.id, componentId, agentId: `agent:${componentId}`, vote: "yes", reason: "fixture", predicted, marginPct: 10, evidenceEventIds: [], evidenceRuleIds: [], similarCount: 3 };
}

/** Propose, unanimous yes, veto window, deadline: what a live proposal goes through up to Plant.execute. */
async function approved(plant: any, to: number) {
  const proposal = await plant.propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to, rationale: "fixture" });
  for (const voter of VOTERS) await plant.vote(vote(proposal, voter));
  // A cross-plant proposal may wait a sweep or two for a lease that arrives outside the Plant's own call.
  for (let sweep = 0; sweep < 5 && (await statusOf(plant, proposal.id)) === "voting"; sweep++) {
    advance(2_000);
    await plant.sweep();
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(await statusOf(plant, proposal.id)).toBe("veto_window");
  advance(10_100);
  await plant.sweep();
  expect((await plant.getExecution(proposal.id))?.state).toBe("accepted");
  return proposal;
}

async function statusOf(plant: any, id: string) {
  return (await plant.getState()).proposals.find((item: any) => item.id === id).status;
}

/** The executor's path up to and including the simulator write. The acknowledgement back to the actors never happens. */
async function landedButUnacknowledged(plant: any, to: number) {
  const proposal = await approved(plant, to);
  const claim = await plant.claimDispatch(proposal.id, FROM);
  expect(claim.dispatch).toBe(true);
  return { proposal, claim, simulator: to };
}

/** Everything a dispatch does with the measured value glue reads from the simulator. */
async function tryToMove(plant: any, to: number, simulator: number) {
  const proposal = await approved(plant, to);
  const claim = await plant.claimDispatch(proposal.id, simulator);
  return { proposal, claim };
}

/** Consecutive changes, with a simulator that really moves and acknowledges whenever a dispatch goes ahead. */
async function moveRepeatedly(plant: any, targets: number[], simulator: number) {
  const outcomes: boolean[] = [];
  let measured = simulator;
  for (const to of targets) {
    const { proposal, claim } = await tryToMove(plant, to, measured);
    outcomes.push(claim.dispatch);
    if (!claim.dispatch) continue;
    measured = to;
    await Component.get("plant-a.P-100").setMetric("speedPct", to, proposal.id, claim.token);
  }
  return outcomes;
}

let plant: any;

beforeEach(async () => {
  setSystemTime(new Date(now));
  FakeActor.registry.clear();
  FakeActor.world = null;
  await Company.get("company").loadSeed({ ...seed.company, rules: [], crossPlantProposals: [], audit: [] });
  for (const item of seed.plants) await Plant.get(item.id).loadSeed(item, safeHistory(item.id));
  for (const item of seed.plants) for (const component of item.components) await Component.get(component.id.replaceAll("/", ".")).loadSeed(component);
  plant = Plant.get("plant-a");
});

afterEach(() => setSystemTime());

test("a lost acknowledgement must not block every later change to that metric", async () => {
  const { simulator } = await landedButUnacknowledged(plant, 65);
  advance(CLAIM_TIMEOUT_MS + 1_000); // What every server restart costs, since a rebuild outlasts the claim timeout.
  await plant.sweep();

  const outcomes = await moveRepeatedly(plant, [70, 72, 74], simulator);
  console.log(`[real logic, fake runtime] three later proposals, simulator at ${simulator}: dispatch ${JSON.stringify(outcomes)}`);
  expect(outcomes.slice(1)).toEqual([true, true]); // One failed attempt is how the measured value reaches Plant.
});

test("a setpoint that timed out but landed must not block later changes either, with no crash at all", async () => {
  // Glue reports failure on any setpoint error, including a timeout where the write may have landed.
  const { proposal, simulator } = await landedButUnacknowledged(plant, 65);
  await plant.reportDispatchFailure(proposal.id, "no answer from the simulator: timed out");
  const outcomes = await moveRepeatedly(plant, [70, 72, 74], simulator);
  console.log(`[real logic, fake runtime] after a timed out setpoint that landed: dispatch ${JSON.stringify(outcomes)}`);
  expect(outcomes.slice(1)).toEqual([true, true]);
});

test("an operator can command the plant back to the value the actors wrongly hold", async () => {
  const { simulator } = await landedButUnacknowledged(plant, 65);
  advance(CLAIM_TIMEOUT_MS + 1_000);
  await plant.sweep();
  await tryToMove(plant, 70, simulator); // One attempt is allowed to fail: that is how the measured value reaches Plant.
  const back = await plant.propose({ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: FROM, rationale: "fixture" }).then(
    () => "accepted",
    (error: Error) => error.message,
  );
  console.log(`[real logic, fake runtime] proposal back to ${FROM}, simulator at ${simulator}: ${back}`);
  expect(back).toBe("accepted");
});

test("a write that never landed recovers, so the simulator stays the source of truth either way", async () => {
  await landedButUnacknowledged(plant, 65);
  advance(CLAIM_TIMEOUT_MS + 1_000);
  await plant.sweep();
  const outcomes = await moveRepeatedly(plant, [70, 72, 74], FROM); // The executor died before writing: the simulator stayed at 50.
  console.log(`[real logic, fake runtime] after a claim that never reached the simulator: dispatch ${JSON.stringify(outcomes)}`);
  expect(outcomes.slice(1)).toEqual([true, true]);
});

test("a late acknowledgement after the claim timed out is accepted, because the token proves the dispatch", async () => {
  const { proposal, claim } = await landedButUnacknowledged(plant, 65);
  advance(CLAIM_TIMEOUT_MS + 1_000);
  await plant.sweep();
  const component = Component.get("plant-a.P-100");
  const outcome = await component.setMetric("speedPct", 65, proposal.id, claim.token).then(
    () => "accepted",
    (error: Error) => error.message,
  );
  console.log(`[real logic, fake runtime] late setMetric: ${outcome}`);
  expect(outcome).toBe("accepted");
  expect((await component.getState()).metrics.speedPct).toBe(65);
  expect(await statusOf(plant, proposal.id)).toBe("executed");
  expect((await plant.claimDispatch(proposal.id)).dispatch).toBe(false); // Recovery must never open a second dispatch.
  const replay = await component.setMetric("speedPct", 65, proposal.id, claim.token).then(() => "accepted", (error: Error) => error.message);
  expect(replay).toContain("token_already_used");
});

test("an observation for a command that landed is recorded after the claim timed out", async () => {
  const { proposal } = await landedButUnacknowledged(plant, 65);
  advance(CLAIM_TIMEOUT_MS + 1_000);
  await plant.sweep();
  const effects = [{ componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: 66, ticksToSettle: 3 }];
  const outcome = await plant.recordEvent({ proposalId: proposal.id, effects }).then(
    () => "recorded",
    (error: Error) => error.message,
  );
  console.log(`[real logic, fake runtime] late observation: ${outcome}`);
  expect(outcome).toBe("recorded");
});

// Crash points in the learning path: recordEvent, rule promotion, calibration, and the ack durability stream.
import { duplicates, COMPANY, type World } from "../lib/world";
import { sleep, until } from "../lib/server";
import type { Ctx, Scenario } from "../lib/scenario";
import { boot, crashAndRead, intoVetoWindow } from "./restart";

const OBSERVED = (to: number) => [{ componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: to + 7, ticksToSettle: 3 }];

/** An executed proposal at 85 is the third sighting of the seeded incident, so its event promotes a rule. */
async function executedAt85(ctx: Ctx, world: World): Promise<any> {
  const open = await intoVetoWindow(world, 85);
  await sleep(Math.max(0, Date.parse(open.vetoDeadline) - Date.now()));
  const done = await world.waitStatus("plant-a", open.id, ["executed"], 12_000);
  if (!done) throw new Error("proposal never executed");
  await until(() => world.setMetricResults.length > 0, 8_000);
  return done;
}

async function rulesSummary(world: World) {
  const durable = await world.durable();
  return {
    plant: durable.plants["plant-a"].rules.map((rule: any) => ({ id: rule.id, timesSeen: rule.timesSeen, support: rule.supportEventIds })),
    company: durable.company.rules.map((rule: any) => ({ id: rule.id, timesSeen: rule.timesSeen, support: rule.supportEventIds })),
    events: durable.plants["plant-a"].history.filter((event: any) => event.proposalId != null).map((event: any) => event.id),
  };
}

/** No two rules may describe the same condition and consequence, whatever their ids. */
function ruleSignature(rule: any): string {
  return JSON.stringify([rule.condition, rule.consequence, rule.model]);
}

function checkNoDuplicateRules(ctx: Ctx, label: string, durable: any) {
  ctx.equal(`${label}: plant rule signatures unique`, duplicates(durable.plants["plant-a"].rules.map(ruleSignature)), []);
  ctx.equal(`${label}: company rule signatures unique`, duplicates(durable.company.rules.map(ruleSignature)), []);
}

export const ackedEventThenKill: Scenario = {
  id: "c4a-acked-event-then-kill",
  title: "recordEvent and rule promotion acknowledged, kill -9, replay everything",
  run: async (ctx) => {
    const world = await boot(ctx);
    const done = await executedAt85(ctx, world);
    const event = await ctx.client.call("Plant", "plant-a", "recordEvent", [{ proposalId: done.id, effects: OBSERVED(85) }]);
    // Calibration must match a real observed vote, so this entry is the one a live agent would send.
    const voted = done.votes.find((item: any) => item.componentId === "plant-a/LV-101");
    const observed = OBSERVED(85)[0].after;
    await ctx.client.call("Component", "plant-a.LV-101", "addCalibration", [
      { at: new Date().toISOString(), proposalId: done.id, metric: "positionPct", predicted: voted.predicted.positionPct, observed, absError: Math.abs(voted.predicted.positionPct - observed) },
    ]);
    const before = await world.durable();
    ctx.equal("calibration entry acknowledged before the crash", before.components["plant-a/LV-101"].calibration.length, 1);
    ctx.check("rule promoted on the third sighting", before.plants["plant-a"].rules.length >= 1, await rulesSummary(world));
    await crashAndRead(ctx, "learned");
    const after = await world.durable();
    world.checkIntact(before, after, "learned");

    const replay = await ctx.client.invoke("Plant", "plant-a", "recordEvent", [{ proposalId: done.id, effects: OBSERVED(85) }]);
    ctx.check("replayed recordEvent returns the same event", replay.kind === "completed" && replay.result?.id === event.id, replay);
    if (before.plants["plant-a"].rules[0]) {
      const rule = before.plants["plant-a"].rules[0];
      const again = await ctx.client.invoke("Plant", "plant-a", "promoteRule", [rule]);
      ctx.note(`replayed promoteRule: ${JSON.stringify(again).slice(0, 200)}`);
    }
    const final = await world.durable();
    ctx.equal("one live event after replay", final.plants["plant-a"].history.filter((item: any) => item.proposalId === done.id).length, 1);
    ctx.equal("rule count unchanged by replay", final.plants["plant-a"].rules.length, before.plants["plant-a"].rules.length);
    ctx.equal("timesSeen unchanged by replay", final.plants["plant-a"].rules.map((rule: any) => rule.timesSeen), before.plants["plant-a"].rules.map((rule: any) => rule.timesSeen));
    ctx.equal("company timesSeen unchanged by replay", final.company.rules.map((rule: any) => rule.timesSeen), before.company.rules.map((rule: any) => rule.timesSeen));
    checkNoDuplicateRules(ctx, "after replay", final);
  },
};

export const killMidPromotion: Scenario = {
  id: "c4b-kill-mid-promotion",
  title: "kill -9 mid recordEvent with the Plant parked on a frozen Company host",
  run: async (ctx) => {
    const world = await boot(ctx);
    const done = await executedAt85(ctx, world);
    const company = await companyHost(world);
    ctx.check("found the Company host process", company != null, company);
    if (company == null) return;
    process.kill(company, "SIGSTOP");
    const inFlight = ctx.client.invoke("Plant", "plant-a", "recordEvent", [{ proposalId: done.id, effects: OBSERVED(85) }], 20_000);
    const parked = await Promise.race([inFlight.then(() => false), sleep(1_500).then(() => true)]);
    ctx.note(parked ? "recordEvent parked on Company, killing mid-call" : "recordEvent returned without waiting for Company");
    const timing = await ctx.crash("midpromo", "group"); // A frozen host cannot see its parent pipe close, so kill it too.
    const outcome = await inFlight;
    ctx.note(`in-flight recordEvent outcome: ${JSON.stringify(outcome).slice(0, 200)}`);
    await sleep(500);
    const afterCrash = await rulesSummary(world);
    ctx.note(`after restart: ${JSON.stringify(afterCrash)}`);
    ctx.check("event recorded at most once after the crash", afterCrash.events.length <= 1, afterCrash.events);

    // The caller saw no ack, so it retries. That retry must converge on one event and one rule everywhere.
    const retry = await ctx.client.invoke("Plant", "plant-a", "recordEvent", [{ proposalId: done.id, effects: OBSERVED(85) }]);
    ctx.check("retry after the crash succeeds", retry.kind === "completed", retry);
    const settled = await until(async () => (await rulesSummary(world)).company.length > 0, 8_000, 250);
    const final = await world.durable();
    ctx.equal("exactly one event after retry", final.plants["plant-a"].history.filter((item: any) => item.proposalId === done.id).length, 1);
    ctx.equal("exactly one plant rule", final.plants["plant-a"].rules.length, 1);
    ctx.check("company rule converges after retry", Boolean(settled), await rulesSummary(world));
    ctx.equal("exactly one company rule", final.company.rules.length, 1);
    checkNoDuplicateRules(ctx, "after retry", final);
    void timing;
  },
};

export const randomKillRecordEvent: Scenario = {
  id: "c4c-random-kill-record-event",
  title: "kill -9 at random microtiming during recordEvent, retry, repeated",
  run: async (ctx) => {
    const world = await boot(ctx);
    const rounds = Number(process.env.CHAOS_ROUNDS ?? 6);
    for (let round = 0; round < rounds; round++) {
      const done = await executedAt85Round(ctx, world, 80 + (round % 5));
      const inFlight = ctx.client.invoke("Plant", "plant-a", "recordEvent", [{ proposalId: done.id, effects: OBSERVED(done.to) }], 8_000);
      await sleep(Math.random() * 25);
      await crashAndRead(ctx, `event${round}`, round % 2 ? "group" : "runtime");
      const outcome = await inFlight;
      const present = (await world.plantState("plant-a")).history.filter((item: any) => item.proposalId === done.id).length;
      ctx.check(`round ${round}: acknowledged implies present`, outcome.kind !== "completed" || present === 1, { outcome: outcome.kind, present });
      const retry = await ctx.client.invoke("Plant", "plant-a", "recordEvent", [{ proposalId: done.id, effects: OBSERVED(done.to) }]);
      ctx.check(`round ${round}: retry succeeds`, retry.kind === "completed", retry);
      const state = await world.plantState("plant-a");
      ctx.equal(`round ${round}: exactly one event`, state.history.filter((item: any) => item.proposalId === done.id).length, 1);
      ctx.equal(`round ${round}: no duplicate rule`, duplicates(state.rules.map(ruleSignature)), []);
    }
  },
};

async function executedAt85Round(ctx: Ctx, world: World, to: number): Promise<any> {
  world.setMetricResults = [];
  const open = await intoVetoWindow(world, to);
  await sleep(Math.max(0, Date.parse(open.vetoDeadline) - Date.now()));
  const done = await world.waitStatus("plant-a", open.id, ["executed"], 12_000);
  if (!done) throw new Error(`proposal to ${to} never executed`);
  await until(() => world.setMetricResults.length > 0, 8_000);
  return done;
}

async function companyHost(world: World): Promise<number | null> {
  return await world.hostOf("Company", COMPANY);
}

export const ackStream: Scenario = {
  id: "c5-ack-stream",
  title: "full speed writers across actors, kill -9 at a random moment: every ack survives",
  run: async (ctx) => {
    const world = await boot(ctx);
    const COMPONENTS = ["plant-a.LV-101", "plant-a.TK-101", "plant-a.E-101", "plant-a.TV-101"];
    const lastAcked = new Map<string, number>(COMPONENTS.map((id) => [id, -1]));
    const ackedAudit: string[] = [];
    let unknownOutcomes = 0;
    let running = true;
    // One writer per actor, so the marker can only rise and the newest ack is exactly known.
    const writers = COMPONENTS.map(async (id) => {
      for (let seq = 0; running; seq++) {
        const outcome = await ctx.client.invoke("Component", id, "mirror", [{ chaosMarker: seq }], 5_000);
        if (outcome.kind === "completed") lastAcked.set(id, seq);
        else if (outcome.kind === "refused") break;
        else unknownOutcomes += 1;
      }
    });
    const auditor = (async () => {
      for (let seq = 0; running; seq++) {
        const refId = `stream-audit-${seq}`;
        const entry = { at: new Date().toISOString(), plantId: "plant-a", kind: "incident", refId, summary: "chaos ack stream", by: "chaos" };
        const outcome = await ctx.client.invoke("Plant", "plant-a", "recordAudit", [entry], 5_000);
        if (outcome.kind === "completed") ackedAudit.push(refId);
        else if (outcome.kind === "refused") break;
        else unknownOutcomes += 1;
      }
    })();
    await sleep(8_000 + Math.random() * 2_000);
    const timing = await ctx.crash("stream", "runtime");
    running = false;
    await Promise.all([...writers, auditor]);
    ctx.metric("stream.ackedMirrors", [...lastAcked.values()].reduce((sum, seq) => sum + seq + 1, 0));
    ctx.metric("stream.ackedAudit", ackedAudit.length);
    ctx.metric("stream.unknownOutcomes", unknownOutcomes);
    ctx.metric("stream.healthyAfterKillMs", timing.healthzMs);
    ctx.check("the stream acknowledged real volume before the kill", Math.min(...lastAcked.values()) >= 10 && ackedAudit.length >= 10, { lastAcked: [...lastAcked], audit: ackedAudit.length });
    for (const id of COMPONENTS) {
      const state = await ctx.client.call("Component", id, "getState");
      ctx.check(`${id} kept its newest acknowledged write`, (state.metrics.chaosMarker ?? -1) >= lastAcked.get(id)!, { held: state.metrics.chaosMarker, acked: lastAcked.get(id) });
    }
    const audits = new Set((await world.plantState("plant-a")).audit.map((entry: any) => entry.refId));
    // The log is capped at 300, and a write that came back unknown can still land, so only recent acks are asserted.
    ctx.equal("no recent acknowledged audit entry lost", ackedAudit.slice(-150).filter((id) => !audits.has(id)), []);
  },
};

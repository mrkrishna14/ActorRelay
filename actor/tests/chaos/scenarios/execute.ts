// Crash points between Plant.execute and the setpoint result. The asserted rule is at most one simulation
// command per proposal, and a proposal must not end up claiming success for a command that never reached the plant.
import type { GlueCall } from "../lib/fakeGlue";
import { sleep, until } from "../lib/server";
import type { Ctx, Scenario } from "../lib/scenario";
import { boot, crashAndRead, intoVetoWindow } from "./restart";

/** Promise that a hook parks on, so the harness can kill at that exact step. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let reachedResolve!: (call: GlueCall) => void;
  const reached = new Promise<GlueCall>((resolve) => (reachedResolve = resolve));
  return { open, reached, hook: async (call: GlueCall) => { reachedResolve(call); await opened; } };
}

async function waitDeadline(open: any): Promise<void> {
  await sleep(Math.max(0, Date.parse(open.vetoDeadline) - Date.now()));
}

async function execution(ctx: Ctx, plantId: string, proposalId: string): Promise<any> {
  const outcome = await ctx.client.invoke("Plant", plantId, "getExecution", [proposalId]);
  return outcome.kind === "completed" ? outcome.result : outcome;
}

const reachedWithin = (parked: ReturnType<typeof gate>, ms: number) => Promise.race([parked.reached, sleep(ms).then(() => null)]);

const CALLBACK_RETRIES_MS = 14_000; // Three attempts 4s apart, the last failing at +12s, plus one sweep.
const CLAIM_TIMEOUT_MS = 20_000;

export const killBeforeClaim: Scenario = {
  id: "c3a-kill-before-claim",
  title: "kill -9 with the first callback in flight at glue, before claimDispatch",
  run: async (ctx) => {
    const world = await boot(ctx);
    const open = await intoVetoWindow(world);
    let first = true;
    const parked = gate();
    ctx.glue.on("/execute-callback", {
      kind: "fn",
      fn: async (call) => {
        if (first) {
          first = false;
          await parked.hook(call); // Held then dropped: that executor died before acting.
          return Response.json({ dropped: true });
        }
        await world.onExecuteCallback(call);
        return Response.json({ ok: true });
      },
    });
    await waitDeadline(open);
    ctx.check("callback reached glue", Boolean(await reachedWithin(parked, 12_000)));
    await crashAndRead(ctx, "preclaim");
    parked.open();
    const done = await until(() => world.commandsFor(open.id).length > 0, CALLBACK_RETRIES_MS, 100);
    ctx.check("a re-sent callback completes the dispatch", Boolean(done), { callbacks: ctx.glue.count("/execute-callback") });
    await sleep(CALLBACK_RETRIES_MS);
    ctx.equal("exactly one simulation command", world.commandsFor(open.id).length, 1);
    ctx.equal("setMetric redeemed once", world.setMetricResults.filter((result) => result.ok).length, 1);
    ctx.equal("execution reached applied", (await execution(ctx, "plant-a", open.id))?.state, "applied");
  },
};

function killAfterClaim(id: string, mode: "runtime" | "group"): Scenario {
  return {
    id,
    title: `${mode} kill between claimDispatch and the setpoint, glue alive and about to send it`,
    run: async (ctx) => {
      const world = await boot(ctx);
      const parked = gate();
      world.hooks.beforeSetpoint = parked.hook;
      const open = await intoVetoWindow(world);
      await waitDeadline(open);
      ctx.check("reached the point between claim and setpoint", Boolean(await reachedWithin(parked, 12_000)));
      await crashAndRead(ctx, "postclaim", mode);
      // Retried callbacks cannot run for a claimed execution, so give the sweep a chance to misbehave.
      await sleep(6_000);
      parked.open(); // Glue survives the actor crash and carries on with its one claimed dispatch.
      await until(() => world.setMetricResults.length > 0, 8_000);
      await sleep(2_000);
      ctx.equal("exactly one simulation command", world.commandsFor(open.id).length, 1);
      ctx.equal("only one claim said dispatch", world.claims.filter((claim) => claim.dispatch === true).length, 1);
      ctx.check("setMetric redeemed", world.setMetricResults.some((result) => result.ok), world.setMetricResults);
      const component = await ctx.client.call("Component", "plant-a.P-100", "getState");
      ctx.equal("metric carries the new value", component.metrics.speedPct, open.to);
      ctx.equal("execution reached applied", (await execution(ctx, "plant-a", open.id))?.state, "applied");
    },
  };
}
export const killAtSetpointRuntime = killAfterClaim("c3b-kill-after-claim", "runtime");
export const killAtSetpointGroup = killAfterClaim("c3c-kill-after-claim-group", "group");

export const glueDiesAfterClaim: Scenario = {
  id: "c3d-glue-dies-after-claim",
  title: "actors and executor both die after claimDispatch: no setpoint was sent, does anything notice",
  run: async (ctx) => {
    const world = await boot(ctx);
    const parked = gate();
    world.hooks.beforeSetpoint = parked.hook;
    const open = await intoVetoWindow(world);
    await waitDeadline(open);
    ctx.check("reached the point between claim and setpoint", Boolean(await reachedWithin(parked, 12_000)));
    await crashAndRead(ctx, "lostclaim");
    world.hooks.beforeSetpoint = undefined;
    // The parked delivery never resumes: that executor is gone. Any later delivery is a new one.
    const settled = await world.waitStatus("plant-a", open.id, ["expired"], CLAIM_TIMEOUT_MS + 8_000);
    ctx.equal("no simulation command from a retry", world.sim.length, 0);
    const proposal = await world.proposal("plant-a", open.id);
    const record = await execution(ctx, "plant-a", open.id);
    const audit = (await world.plantState("plant-a")).audit.filter((entry: any) => entry.refId === open.id).map((entry: any) => `${entry.kind}: ${entry.summary}`);
    ctx.note(`final status=${proposal?.status} execution=${JSON.stringify(record)}`);
    ctx.note(`audit: ${JSON.stringify(audit)}`);
    ctx.check("the proposal did not stick as a silent success", Boolean(settled), { status: proposal?.status, state: record?.state });
    ctx.check("the lost dispatch is visible in the audit", audit.some((line: string) => /unknown|failed/i.test(line)), audit);
    const next = await ctx.client.invoke("Plant", "plant-a", "propose", [{ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 60, rationale: "chaos: after a lost dispatch" }]);
    ctx.check("a new proposal can open afterwards", next.kind === "completed", next);
    parked.open();
  },
};

/** The simulator took the command and only the acknowledgement is lost. `lateMs` is how long /observed takes. */
function ackLost(id: string, title: string, downMs: number, observedAfterRestartMs: number): Scenario {
  return {
    id,
    title,
    run: async (ctx) => {
      const world = await boot(ctx);
      const parked = gate();
      world.hooks.afterSetpoint = parked.hook;
      const open = await intoVetoWindow(world);
      await waitDeadline(open);
      ctx.check("reached the point after the setpoint", Boolean(await reachedWithin(parked, 12_000)));
      const kill = await ctx.server.kill9("runtime");
      parked.open(); // setMetric runs against a dead server, so the acknowledgement is lost.
      await until(() => world.setMetricResults.length > 0, 5_000);
      ctx.check("setMetric failed because the server was down", world.setMetricResults.every((result) => !result.ok), world.setMetricResults);
      if (downMs) await sleep(downMs);
      await ctx.server.start();
      await ctx.client.call("Plant", "plant-a", "getState", [], 30_000);
      ctx.metric("ackloss.firstPlantReadAfterKillMs", Date.now() - kill.atEpochMs);
      await sleep(observedAfterRestartMs);

      // The observed-effects path must still close the loop for a command the simulator really took.
      const observed = await ctx.client.invoke("Plant", "plant-a", "recordEvent", [
        { proposalId: open.id, effects: [{ componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: 66, ticksToSettle: 3 }] },
      ]);
      await sleep(CLAIM_TIMEOUT_MS + 3_000 - observedAfterRestartMs);
      ctx.equal("no second simulation command", world.commandsFor(open.id).length, 1);
      const proposal = await world.proposal("plant-a", open.id);
      const record = await execution(ctx, "plant-a", open.id);
      const plant = await ctx.client.invoke("Plant", "plant-a", "propose", [{ proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 60, rationale: "chaos: from must match the simulator" }]);
      ctx.note(`simulator is at ${open.to}. status=${proposal?.status} execution=${record?.state} failure=${record?.failure}`);
      ctx.note(`recordEvent: ${JSON.stringify(observed).slice(0, 220)}`);
      ctx.check("observed effects of a command the simulator took are recorded", observed.kind === "completed", observed);
      ctx.check("a command that landed does not read as expired", proposal?.status === "executed", proposal?.status);
      ctx.check(
        "next proposal starts from the value the simulator really holds",
        plant.kind === "completed" && plant.result.from === open.to,
        plant.kind === "completed" ? { from: plant.result.from, simulatorAt: open.to } : plant,
      );
    },
  };
}
export const ackLostPrompt = ackLost("c3e-ack-lost-observed-promptly", "kill -9 after the simulator took the command, /observed arrives 2s after restart", 0, 2_000);
export const ackLostLate = ackLost("c3f-ack-lost-observed-late", "kill -9 after the simulator took the command, down 25s so the claim times out first", 25_000, 2_000);

export const dispatchFailure: Scenario = {
  id: "c3g-dispatch-failure-then-kill",
  title: "simulator refuses the setpoint, kill -9, retries must not resend",
  run: async (ctx) => {
    const world = await boot(ctx);
    world.hooks.setpointFails = true;
    const open = await intoVetoWindow(world);
    await waitDeadline(open);
    await until(() => world.claims.length > 0, 12_000);
    await sleep(500);
    await crashAndRead(ctx, "refused");
    world.hooks.setpointFails = false;
    await sleep(CALLBACK_RETRIES_MS);
    ctx.equal("no simulation command after a refused dispatch", world.sim.length, 0);
    const proposal = await world.proposal("plant-a", open.id);
    const record = await execution(ctx, "plant-a", open.id);
    ctx.equal("proposal ends expired", proposal?.status, "expired");
    ctx.equal("execution ends failed", record?.state, "failed");
  },
};

export const randomKillAroundDeadline: Scenario = {
  id: "c3r-random-kill-around-deadline",
  title: "kill -9 at random offsets around the veto deadline, repeated: at most one command every time",
  run: async (ctx) => {
    const world = await boot(ctx);
    const rounds = Number(process.env.CHAOS_ROUNDS ?? 6);
    for (let round = 0; round < rounds; round++) {
      // Each round is a fresh proposal on the same durable state, which is the point of the loop.
      const target = 55 + round;
      const open = await intoVetoWindow(world, target);
      const offset = Math.floor(Math.random() * 3_000) - 500;
      await sleep(Math.max(0, Date.parse(open.vetoDeadline) + offset - Date.now()));
      await crashAndRead(ctx, `random${round}`, round % 2 ? "group" : "runtime");
      const settled = await until(() => world.commandsFor(open.id).length > 0, CALLBACK_RETRIES_MS + 6_000, 100);
      await sleep(3_000);
      const commands = world.commandsFor(open.id).length;
      const record = await execution(ctx, "plant-a", open.id);
      ctx.check(`round ${round} (offset ${offset}ms): at most one command`, commands <= 1, commands);
      ctx.check(`round ${round}: the approved change was dispatched`, Boolean(settled), { commands, state: record?.state, failure: record?.failure });
      await ctx.client.invoke("Plant", "plant-a", "recordEvent", [
        { proposalId: open.id, effects: [{ componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: target + 1, ticksToSettle: 3 }] },
      ]);
    }
  },
};

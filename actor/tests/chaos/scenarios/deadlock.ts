// Glue slow or down, and re-entrant calls, must not wedge the Plant mailbox. Every read below goes through the
// mailbox, so a wedge shows up as a slow or timed-out call rather than being inferred from code.
import type { Behaviour } from "../lib/fakeGlue";
import { sleep, until } from "../lib/server";
import type { Ctx, Scenario } from "../lib/scenario";
import { boot, crashAndRead, intoVetoWindow, VOTERS } from "./restart";
import { COMPANY } from "../lib/world";

const MAILBOX_BOUND_MS = 2_000; // Published glue fetch timeout is 1.5s; a call waiting on one tick stays under this.

/** Sample mailbox latency for `ms`, one read at a time, and fail on any read over the bound. */
async function probeMailbox(ctx: Ctx, label: string, ms: number, plantId = "plant-a"): Promise<void> {
  const samples: number[] = [];
  const failures: unknown[] = [];
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    const outcome = await ctx.client.invoke("Plant", plantId, "getState", [], 10_000);
    samples.push(outcome.ms);
    if (outcome.kind !== "completed") failures.push(outcome);
    await sleep(100);
  }
  samples.sort((a, b) => a - b);
  ctx.metric(`${label}.mailboxP50Ms`, samples[Math.floor(samples.length / 2)] ?? -1);
  ctx.metric(`${label}.mailboxMaxMs`, samples.at(-1) ?? -1);
  ctx.equal(`${label}: every mailbox read succeeded`, failures.length, 0);
  ctx.check(`${label}: mailbox stays under ${MAILBOX_BOUND_MS}ms`, (samples.at(-1) ?? Infinity) < MAILBOX_BOUND_MS, { max: samples.at(-1), n: samples.length });
}

async function ticksRunning(ctx: Ctx): Promise<void> {
  const ok = await ctx.glue.waitFor("/tick", 3, 8_000);
  ctx.check("ticks running before the fault", ok, ctx.glue.count("/tick"));
}

function tickFault(id: string, title: string, behaviour: Behaviour): Scenario {
  return {
    id,
    title,
    run: async (ctx) => {
      const world = await boot(ctx);
      await ticksRunning(ctx);
      ctx.glue.on("/tick", behaviour);
      const mark = (await world.plantState("plant-a")).tick;
      await probeMailbox(ctx, id, 8_000);
      const proposal = await world.propose("plant-a", 65);
      await world.castVotes(proposal, VOTERS);
      const open = await world.waitStatus("plant-a", proposal.id, ["veto_window"], 8_000);
      ctx.check("sweep still advances proposals during the fault", Boolean(open), open?.status);
      const tick = (await world.plantState("plant-a")).tick;
      ctx.check("tick counter advances during the fault", tick > mark, `${mark} -> ${tick}`);
      ctx.glue.on("/tick", { kind: "ok" });
      ctx.glue.releaseAll();
      const count = ctx.glue.count("/tick");
      ctx.check("ticks recover after the fault clears", await ctx.glue.waitFor("/tick", count + 2, 8_000));
    },
  };
}

export const tickHang = tickFault("d1-tick-hang", "glue never answers /tick", { kind: "hang" });
export const tickSlow = tickFault("d2-tick-slow", "glue answers /tick after 3s", { kind: "delay", ms: 3_000 });
export const tickError = tickFault("d3-tick-500", "glue answers /tick with 500", { kind: "status", status: 500 });

export const tickDown: Scenario = {
  id: "d4-glue-down",
  title: "glue process down during ticks, then back",
  run: async (ctx) => {
    const world = await boot(ctx);
    await ticksRunning(ctx);
    await ctx.glue.stop();
    await probeMailbox(ctx, "down", 8_000);
    const proposal = await world.propose("plant-a", 65);
    await world.castVotes(proposal, VOTERS);
    const open = await world.waitStatus("plant-a", proposal.id, ["veto_window"], 8_000);
    ctx.check("sweep still advances proposals with glue down", Boolean(open), open?.status);
    const count = ctx.glue.count("/tick");
    ctx.glue.start();
    ctx.check("ticks reach glue again once it is back", await ctx.glue.waitFor("/tick", count + 2, 8_000));
  },
};

export const executeHang: Scenario = {
  id: "d5-execute-hang",
  title: "glue never answers /execute-callback: Plant stays live and the retries are bounded",
  run: async (ctx) => {
    const world = await boot(ctx);
    ctx.glue.on("/execute-callback", { kind: "hang" });
    const open = await intoVetoWindow(world);
    await sleep(Math.max(0, Date.parse(open.vetoDeadline) - Date.now()));
    ctx.check("callback attempted", await ctx.glue.waitFor("/execute-callback", 1, 10_000));
    await probeMailbox(ctx, "execHang", 16_000);
    const proposal = await world.proposal("plant-a", open.id);
    const attempts = ctx.glue.count("/execute-callback");
    ctx.metric("execHang.attempts", attempts);
    ctx.check("attempts are bounded", attempts <= 4, attempts);
    ctx.note(`status after retries: ${proposal?.status}`);
    await sleep(6_000);
    ctx.equal("no further attempts", ctx.glue.count("/execute-callback"), attempts);
    ctx.equal("nothing dispatched", world.sim.length, 0);
    const other = await world.propose("plant-a", 60).then(
      (created) => ({ ok: true, id: created.id }),
      (error) => ({ ok: false, error: String(error?.message ?? error) }),
    );
    ctx.note(`new proposal after the hung dispatch: ${JSON.stringify(other)}`);
    ctx.check("a new proposal is not blocked forever by the hung one", other.ok === true, other);
  },
};

export const executeDownThenBack: Scenario = {
  id: "d6-execute-glue-down-then-back",
  title: "glue down when the callback fires, back before retries run out: dispatched exactly once",
  run: async (ctx) => {
    const world = await boot(ctx);
    const open = await intoVetoWindow(world);
    await ctx.glue.stop();
    await sleep(Math.max(0, Date.parse(open.vetoDeadline) - Date.now()) + 3_000);
    await probeMailbox(ctx, "execDown", 3_000);
    ctx.glue.start();
    await until(() => world.commandsFor(open.id).length > 0, 14_000);
    ctx.equal("exactly one simulation command", world.commandsFor(open.id).length, 1);
    await sleep(9_000);
    ctx.equal("still one simulation command", world.commandsFor(open.id).length, 1);
  },
};

export const executeDownForever: Scenario = {
  id: "d7-execute-glue-down-past-retries",
  title: "glue down past every retry: the proposal must not read as a success",
  run: async (ctx) => {
    const world = await boot(ctx);
    const open = await intoVetoWindow(world);
    await ctx.glue.stop();
    await sleep(Math.max(0, Date.parse(open.vetoDeadline) - Date.now()) + 18_000);
    await probeMailbox(ctx, "execLost", 2_000);
    const proposal = await world.proposal("plant-a", open.id);
    const outcome = await ctx.client.invoke("Plant", "plant-a", "getExecution", [open.id]);
    ctx.note(`status=${proposal?.status} execution=${JSON.stringify(outcome).slice(0, 400)}`);
    const count = ctx.glue.count("/execute-callback");
    ctx.glue.start();
    await sleep(8_000);
    ctx.note(`callbacks after glue came back: ${ctx.glue.count("/execute-callback") - count}`);
    ctx.check("nothing sent twice", world.commandsFor(open.id).length <= 1, world.commandsFor(open.id).length);
    const record = await ctx.client.invoke("Plant", "plant-a", "getExecution", [open.id]);
    ctx.check(
      "an undelivered execution is reported as undelivered",
      /fail|unknown|undelivered|abandon|lost|timeout/i.test(JSON.stringify(record)) || world.commandsFor(open.id).length === 1,
      record,
    );
  },
};

export const reentrantTick: Scenario = {
  id: "d8-reentrant-tick",
  title: "glue calls back into Plant while handling /tick, like real glue forwarding into the actor adapter",
  run: async (ctx) => {
    const world = await boot(ctx);
    await ticksRunning(ctx);
    const latencies: number[] = [];
    ctx.glue.on("/tick", {
      kind: "fn",
      fn: async (call) => {
        const plantId = (call.body as any)?.plantId ?? "plant-a";
        const outcome = await ctx.client.invoke("Plant", plantId, "getState", [], 8_000); // Real glue's adapter timeout.
        latencies.push(outcome.ms);
        return Response.json({ ok: outcome.kind === "completed" });
      },
    });
    await probeMailbox(ctx, "reentrant", 8_000);
    ctx.check("re-entrant calls were exercised", latencies.length >= 3, latencies.length);
    ctx.check("no re-entrant call hit the 8s timeout", latencies.every((ms) => ms < 7_500), { max: Math.max(...latencies, 0) });
    if (latencies.length) ctx.metric("reentrant.callbackMaxMs", Math.max(...latencies));
  },
};

export const killDuringHang: Scenario = {
  id: "d9-kill-during-hung-glue",
  title: "kill -9 with glue hung on tick and execute: nothing wedged after restart",
  run: async (ctx) => {
    const world = await boot(ctx);
    await ticksRunning(ctx);
    const open = await intoVetoWindow(world);
    ctx.glue.on("/tick", { kind: "hang" });
    ctx.glue.on("/execute-callback", { kind: "hang" });
    await sleep(Math.max(0, Date.parse(open.vetoDeadline) - Date.now()));
    await ctx.glue.waitFor("/execute-callback", 1, 10_000);
    await crashAndRead(ctx, "hang");
    await probeMailbox(ctx, "hang", 5_000);
    world.installGlue();
    ctx.glue.releaseAll();
    await until(() => world.commandsFor(open.id).length > 0, 18_000);
    await sleep(6_000);
    ctx.check("at most one simulation command", world.commandsFor(open.id).length <= 1, world.commandsFor(open.id).length);
    ctx.check("the proposal did not stick", (await world.proposal("plant-a", open.id))?.status !== "veto_window");
  },
};

export const companyFrozen: Scenario = {
  id: "d10-company-frozen",
  title: "Company host frozen (SIGSTOP): does the Plant mailbox wedge on the cross-actor call",
  run: async (ctx) => {
    const world = await boot(ctx);
    await sleep(11_000);
    await ctx.client.call("Plant", "plant-a", "getState");
    const company = await world.hostOf("Company", COMPANY);
    ctx.check("found the Company host process", company != null, company);
    if (company == null) return;
    process.kill(company, "SIGSTOP");
    try {
      const inFlight = ctx.client.invoke("Plant", "plant-a", "propose", [
        { proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 65, rationale: "chaos: company frozen" },
      ], 12_000);
      await sleep(500);
      await probeMailbox(ctx, "frozen", 6_000);
      ctx.note(`propose with Company frozen: ${JSON.stringify(await inFlight).slice(0, 300)}`);
    } finally {
      process.kill(company, "SIGCONT");
    }
    await sleep(1_000);
    await probeMailbox(ctx, "thawed", 2_000);
  },
};

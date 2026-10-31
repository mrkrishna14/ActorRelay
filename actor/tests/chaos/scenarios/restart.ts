// Crash points in the proposal lifecycle up to execution: alarms, voting, the veto window.
import { hostPid, sleep, until } from "../lib/server";
import type { Ctx, Scenario } from "../lib/scenario";
import { World } from "../lib/world";

export const VOTERS = ["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101", "plant-b/TV-101"];

export async function boot(ctx: Ctx): Promise<World> {
  const world = new World(ctx);
  world.installGlue();
  const started = performance.now();
  await world.seedAll();
  ctx.metric("seedMs", performance.now() - started);
  return world;
}

/** Restart, then time the first read through the Plant mailbox from the moment of the kill. */
export async function crashAndRead(ctx: Ctx, label: string, mode: "runtime" | "group" = "runtime", downMs = 0) {
  const timing = await ctx.crash(label, mode, downMs);
  await ctx.client.call("Plant", "plant-a", "getState", [], 30_000);
  timing.firstCallMs = Date.now() - timing.kill.atEpochMs;
  ctx.metric(`${label}.firstPlantReadAfterKillMs`, timing.firstCallMs);
  ctx.metric(`${label}.healthyAfterKillMs`, timing.healthzMs);
  return timing;
}

/** Reach veto_window with five yes votes. Returns the proposal as reported by the Plant. */
export async function intoVetoWindow(world: World, to = 65): Promise<any> {
  const proposal = await world.propose("plant-a", to);
  await world.castVotes(proposal, VOTERS);
  const open = await world.waitStatus("plant-a", proposal.id, ["veto_window"], 8_000);
  if (!open) throw new Error(`proposal ${proposal.id} never reached veto_window`);
  return open;
}

export const alarmRearm: Scenario = {
  id: "c0-alarm-rearm",
  title: "kill -9 while idle: do tick and sweep alarms come back, and who has to call what",
  run: async (ctx) => {
    const world = await boot(ctx);
    // The first tick may need a kick after a fresh seed; that is measured here, not assumed.
    const ticking = await ctx.glue.waitFor("/tick", 4, 8_000);
    ctx.check("ticks reach glue before the crash", ticking, { ticks: ctx.glue.count("/tick") });
    const before = await world.durable();
    const timing = await ctx.crash("idle", "runtime");
    // Silence first: nothing may touch either Plant until the tick has had its chance to come back alone.
    const a = world.checkTickResumes("idle", "plant-a", before.plants["plant-a"].tick, timing.kill.atEpochMs);
    const b = world.checkTickResumes("idle", "plant-b", before.plants["plant-b"].tick, timing.kill.atEpochMs);
    await Promise.all([a, b]);
    world.checkIntact(before, await world.durable(), "idle");
  },
};

export const votingRestart: Scenario = {
  id: "c1-voting-restart",
  title: "kill -9 during voting after 2 of 5 acknowledged votes, then finish voting",
  run: async (ctx) => {
    const world = await boot(ctx);
    const proposal = await world.propose("plant-a", 65);
    ctx.equal("five required voters", [...proposal.requiredVoters].sort(), [...VOTERS].sort());
    await world.castVotes(proposal, VOTERS.slice(0, 2));
    const before = await world.durable();
    await crashAndRead(ctx, "voting");
    const after = await world.durable();
    world.checkIntact(before, after, "voting");
    const restored = after.plants["plant-a"].proposals.find((item: any) => item.id === proposal.id);
    ctx.equal("status still voting", restored?.status, "voting");
    ctx.equal("exactly the 2 acknowledged votes", restored?.votes.length, 2);

    const replay = await ctx.client.invoke("Plant", "plant-a", "vote", [world.vote(proposal, VOTERS[0])]);
    ctx.check("replayed vote rejected after restart", replay.kind === "failed" && /duplicate_vote/.test(replay.message), replay);

    await world.castVotes(proposal, VOTERS.slice(2));
    const open = await world.waitStatus("plant-a", proposal.id, ["veto_window"], 8_000);
    ctx.check("reaches veto_window after restart", Boolean(open), open?.status);
    const done = await world.waitStatus("plant-a", proposal.id, ["executed"], 16_000);
    ctx.check("executes after restart", Boolean(done), done?.status);
    await until(() => world.sim.length > 0, 8_000);
    ctx.equal("exactly one simulation command", world.commandsFor(proposal.id).length, 1);
  },
};

export const votingExpiredDown: Scenario = {
  id: "c1b-voting-expiry-while-down",
  title: "kill -9 during voting, stay down past the 30s vote expiry",
  run: async (ctx) => {
    const world = await boot(ctx);
    const proposal = await world.propose("plant-a", 65);
    await world.castVotes(proposal, VOTERS.slice(0, 2));
    await crashAndRead(ctx, "expiry", "runtime", 32_000);
    const started = performance.now();
    const expired = await world.waitStatus("plant-a", proposal.id, ["expired"], 12_000);
    ctx.check("proposal expires instead of sticking in voting", Boolean(expired), expired?.status);
    ctx.metric("expiry.expiredAfterRestartMs", performance.now() - started);
    ctx.equal("no simulation command", world.sim.length, 0);
    const late = await ctx.client.invoke("Plant", "plant-a", "vote", [world.vote(proposal, VOTERS[2])]);
    ctx.check("late vote rejected", late.kind === "failed", late);
  },
};

export const vetoRestartBeforeDeadline: Scenario = {
  id: "c2a-veto-restart-before-deadline",
  title: "kill -9 3s into the veto window, back up before the deadline: fires once, not early",
  run: async (ctx) => {
    const world = await boot(ctx);
    const open = await intoVetoWindow(world);
    const deadline = Date.parse(open.vetoDeadline);
    const before = await world.durable();
    await sleep(3_000);
    await crashAndRead(ctx, "veto");
    const after = await world.durable();
    world.checkIntact(before, after, "veto");
    const restored = after.plants["plant-a"].proposals.find((item: any) => item.id === open.id);
    ctx.equal("deadline unchanged", restored?.vetoDeadline, open.vetoDeadline);
    ctx.check("window still open after restart", restored?.status === "veto_window" && Date.now() < deadline, { status: restored?.status, msLeft: deadline - Date.now() });

    const done = await world.waitStatus("plant-a", open.id, ["executed"], Math.max(0, deadline - Date.now()) + 12_000);
    ctx.check("deadline fires after restart", Boolean(done), done?.status);
    await until(() => world.sim.length > 0, 8_000);
    await sleep(9_000); // Long enough for every published callback retry.
    ctx.equal("exactly one simulation command", world.commandsFor(open.id).length, 1);
    const first = ctx.glue.of("/execute-callback")[0];
    ctx.check("not fired before the deadline", Boolean(first) && first.atEpochMs >= deadline, first ? { earlyByMs: deadline - first.atEpochMs } : "no callback");
    if (first) ctx.metric("veto.firedAfterDeadlineMs", first.atEpochMs - deadline);
    const state = await world.plantState("plant-a");
    const executes = state.audit.filter((entry: any) => entry.kind === "execute" && entry.refId === open.id);
    ctx.equal("one execute audit entry", executes.length, 1);
  },
};

export const vetoDownPastDeadline: Scenario = {
  id: "c2b-veto-down-past-deadline",
  title: "kill -9 in the veto window, stay down past the deadline: what happens to the human veto",
  run: async (ctx) => {
    const world = await boot(ctx);
    const open = await intoVetoWindow(world);
    const deadline = Date.parse(open.vetoDeadline);
    const killAt = Date.now();
    const downMs = Math.max(0, deadline - killAt) + 3_000;
    await crashAndRead(ctx, "lateveto", "runtime", downMs);
    const restartedAt = Date.now();
    const final = await world.waitStatus("plant-a", open.id, ["executed", "expired", "vetoed"], 15_000);
    const held = await world.proposal("plant-a", open.id);
    ctx.note(`after restart status=${held?.status} vetoDeadline=${held?.vetoDeadline} (was ${open.vetoDeadline})`);
    ctx.check("window does not stay open forever", Boolean(final) || Date.parse(held?.vetoDeadline) > restartedAt, held?.status);
    await until(() => world.sim.length > 0, 8_000);
    ctx.check("at most one simulation command", world.commandsFor(open.id).length <= 1, world.commandsFor(open.id).length);
    const firstCommand = world.commandsFor(open.id)[0];
    const humanMs = firstCommand ? firstCommand.atEpochMs - restartedAt : null;
    if (humanMs != null) ctx.metric("lateveto.commandAfterRestartMs", humanMs);
    ctx.check(
      "operator gets a live veto window after the outage (a lapsed window must not execute unseen)",
      firstCommand == null || humanMs! >= 5_000,
      firstCommand ? `simulation command ${humanMs}ms after restart` : "no command sent",
    );
  },
};

export const vetoThenKill: Scenario = {
  id: "c2c-veto-then-kill",
  title: "veto acknowledged, kill -9 at once: the veto holds through the deadline",
  run: async (ctx) => {
    const world = await boot(ctx);
    const open = await intoVetoWindow(world);
    await ctx.client.call("Plant", "plant-a", "veto", [open.id, "chaos-operator"]);
    await crashAndRead(ctx, "vetoed", "runtime");
    const restored = await world.proposal("plant-a", open.id);
    ctx.equal("status vetoed after restart", restored?.status, "vetoed");
    await sleep(Math.max(0, Date.parse(open.vetoDeadline) - Date.now()) + 5_000);
    ctx.equal("still vetoed after the deadline", (await world.proposal("plant-a", open.id))?.status, "vetoed");
    ctx.equal("no callback sent", ctx.glue.count("/execute-callback"), 0);
    ctx.equal("no simulation command", world.sim.length, 0);
  },
};

export const killHostOnly: Scenario = {
  id: "h1-kill-plant-host",
  title: "kill -9 of only the Plant's host process: the runtime stays up, so no rebuild and no alarm loss",
  run: async (ctx) => {
    const world = await boot(ctx);
    await ctx.glue.waitFor("/tick", 4, 8_000);
    const kill = () => {
      const pid = hostPid(ctx.server.pgid, "Plant", "plant-a");
      ctx.check("found the Plant host", pid != null, pid);
      process.kill(pid!, "SIGKILL");
      return performance.now();
    };

    // Silent: nothing may call the Plant, so only the alarm can bring it back.
    const tickBefore = (await world.plantState("plant-a")).tick;
    kill();
    await sleep(4_000);
    const tickAfter = (await world.plantState("plant-a")).tick;
    ctx.check("alarm brings the Plant back with no outside call", tickAfter > tickBefore, `${tickBefore} -> ${tickAfter}`);

    const proposal = await world.propose("plant-a", 65);
    await world.castVotes(proposal, VOTERS.slice(0, 2));
    const before = await world.durable();
    const killed = kill();
    const answered = await until(async () => {
      const outcome = await ctx.client.invoke("Plant", "plant-a", "getState", [], 5_000);
      return outcome.kind === "completed" ? outcome : undefined;
    }, 30_000, 10);
    ctx.metric("hostkill.firstReadAfterKillMs", performance.now() - killed);
    ctx.check("Plant answers after its host was killed", Boolean(answered));
    world.checkIntact(before, await world.durable(), "hostkill");

    await world.castVotes(proposal, VOTERS.slice(2));
    const open = await world.waitStatus("plant-a", proposal.id, ["veto_window"], 8_000);
    ctx.check("reaches veto_window", Boolean(open), open?.status);
    await sleep(3_000);
    kill();
    const done = await world.waitStatus("plant-a", proposal.id, ["executed"], 16_000);
    ctx.check("deadline fires after the host was killed in the window", Boolean(done), done?.status);
    await until(() => world.sim.length > 0, 8_000);
    await sleep(5_000);
    ctx.equal("exactly one simulation command", world.commandsFor(proposal.id).length, 1);
  },
};

export const crashLoop: Scenario = {
  id: "c6-crash-loop",
  title: "five kills across one proposal's life: still one execution",
  run: async (ctx) => {
    const world = await boot(ctx);
    const proposal = await world.propose("plant-a", 65);
    await crashAndRead(ctx, "loop1");
    await world.castVotes(proposal, VOTERS.slice(0, 2));
    await crashAndRead(ctx, "loop2", "group");
    await world.castVotes(proposal, VOTERS.slice(2));
    await crashAndRead(ctx, "loop3");
    const open = await world.waitStatus("plant-a", proposal.id, ["veto_window"], 8_000);
    ctx.check("reaches veto_window across crashes", Boolean(open), open?.status);
    await crashAndRead(ctx, "loop4", "group");
    await sleep(2_000);
    await crashAndRead(ctx, "loop5");
    const done = await world.waitStatus("plant-a", proposal.id, ["executed"], 20_000);
    ctx.check("executes across crashes", Boolean(done), done?.status);
    await until(() => world.sim.length > 0, 10_000);
    await sleep(9_000);
    ctx.equal("exactly one simulation command", world.commandsFor(proposal.id).length, 1);
    const state = await world.plantState("plant-a");
    ctx.equal("one execute audit entry", state.audit.filter((entry: any) => entry.kind === "execute" && entry.refId === proposal.id).length, 1);
  },
};

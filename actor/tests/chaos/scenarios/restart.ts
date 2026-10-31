// Crash points in the proposal lifecycle up to execution: alarms, voting, the veto window.
import { probeMailbox } from "../lib/mailbox";
import { hostPid, sleep, until } from "../lib/server";
import type { Ctx, Scenario } from "../lib/scenario";
import { World } from "../lib/world";

export const VOTERS = ["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101", "plant-b/TV-101"];
// Match the constants of the snapshot under test: prepare.sh stretched raises them in that copy.
export const VOTE_TIMEOUT_MS = Number(process.env.CHAOS_VOTE_TIMEOUT_MS ?? 30_000);
export const VETO_WINDOW_MS = Number(process.env.CHAOS_VETO_WINDOW_MS ?? 10_000);

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
  const unavailableBefore = ctx.client.unavailableResponses;
  await ctx.client.call("Plant", "plant-a", "getState", [], 30_000);
  timing.firstCallMs = Date.now() - timing.kill.atEpochMs;
  ctx.metric(`${label}.firstPlantReadAfterKillMs`, timing.firstCallMs);
  ctx.metric(`${label}.unavailableResponses`, ctx.client.unavailableResponses - unavailableBefore);
  ctx.metric(`${label}.healthyAfterKillMs`, timing.healthzMs);
  return timing;
}

/** Reach veto_window with five yes votes. Returns the proposal as reported by the Plant. */
export async function intoVetoWindow(world: World, to = 65): Promise<any> {
  const proposal = await world.propose("plant-a", to);
  await world.castVotes(proposal, VOTERS);
  const open = await world.waitStatus("plant-a", proposal.id, ["veto_window"], 15_000);
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

    // Tick rate on a quiet server, from arrivals at glue. Two plants share the route, so divide by two.
    const mark = ctx.glue.count("/tick");
    const markAt = performance.now();
    await sleep(6_000);
    const hz = (ctx.glue.count("/tick") - mark) / 2 / ((performance.now() - markAt) / 1_000);
    ctx.metric("ticksPerSecondPerPlant", hz);
    ctx.check("tick rate is about 1 per second", hz > 0.6 && hz < 1.5, hz);

    const timing = await ctx.crash("idle", "runtime");
    const restartedAt = Date.now();
    const lateTicks = ctx.glue.of("/tick").filter((call) => call.atEpochMs > timing.kill.atEpochMs).length;
    ctx.metric("idle.ticksBetweenKillAndRestart", lateTicks);
    ctx.metric("idle.healthyAfterKillMs", timing.healthzMs);
    // Silence first: nothing may touch either Plant until the tick has had its chance to come back alone.
    await Promise.all([
      world.checkTickResumes("idle", "plant-a", restartedAt),
      world.checkTickResumes("idle", "plant-b", restartedAt),
    ]);
    world.checkIntact(before, await world.durable(), "idle");
    await probeMailbox(ctx, "postRestart", 5_000);
  },
};

/** /tick arrivals in consecutive 5s buckets, with nothing calling any actor, so only alarms can produce them. */
async function tickBuckets(ctx: Ctx, buckets: number): Promise<number[]> {
  const counts: number[] = [];
  for (let bucket = 0; bucket < buckets; bucket++) {
    const from = ctx.glue.count("/tick");
    await sleep(5_000);
    counts.push(ctx.glue.count("/tick") - from);
  }
  return counts;
}

export const silentTicks: Scenario = {
  id: "c0b-silent-ticks",
  title: "no crash and no callers at all: does the alarm chain keep ticking through long silence",
  run: async (ctx) => {
    await boot(ctx);
    await ctx.glue.waitFor("/tick", 4, 8_000);
    const quiet = await tickBuckets(ctx, 16);
    ctx.note(`/tick arrivals per 5s with no callers, both Plants: ${JSON.stringify(quiet)}`);
    ctx.check("ticks never stop in 80s of silence", quiet.every((count) => count > 0), quiet);
  },
};

export const silentAfterHostKill: Scenario = {
  id: "c0c-silent-after-host-kill",
  title: "kill plant-a's host and stay silent for two minutes: how long can ticks stop, and do they come back",
  run: async (ctx) => {
    await boot(ctx);
    await ctx.glue.waitFor("/tick", 4, 8_000);
    const before = await tickBuckets(ctx, 2);
    const pid = hostPid(ctx.server.pgid, "Plant", "plant-a");
    ctx.check("found the Plant host", pid != null, pid);
    const killedAt = Date.now();
    process.kill(pid!, "SIGKILL");
    const after = await tickBuckets(ctx, 24);
    const times = ctx.glue.of("/tick").filter((call) => call.atEpochMs > killedAt).map((call) => call.atEpochMs);
    const gaps = times.slice(1).map((at, index) => ({ startedAfterKillMs: times[index] - killedAt, ms: at - times[index] }));
    const widest = gaps.reduce((best, gap) => (gap.ms > best.ms ? gap : best), { startedAfterKillMs: 0, ms: 0 });
    ctx.metric("hostkill.widestTickGapMs", widest.ms);
    ctx.metric("hostkill.widestTickGapStartedAfterKillMs", widest.startedAfterKillMs);
    ctx.note(`/tick arrivals per 5s before ${JSON.stringify(before)}, after killing plant-a's host ${JSON.stringify(after)}`);
    ctx.note(`widest gap ${widest.ms}ms, starting ${widest.startedAfterKillMs}ms after the kill`);
    ctx.check("ticks come back by themselves after any gap", after.slice(-2).every((count) => count > 0), after);
    ctx.check("no tick gap reaches 15s", widest.ms < 15_000, widest);
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
    const before = await world.durablePlant();
    await crashAndRead(ctx, "voting");
    const after = await world.durablePlant();
    world.checkIntact(before, after, "voting");
    const restored = after.plants["plant-a"].proposals.find((item: any) => item.id === proposal.id);
    ctx.equal("exactly the 2 acknowledged votes", restored?.votes.length, 2);
    const replay = await ctx.client.invoke("Plant", "plant-a", "vote", [world.vote(proposal, VOTERS[0])]);
    ctx.check("replayed vote rejected after restart", replay.kind === "failed" && /duplicate_vote/.test(replay.message), replay);

    const elapsed = Date.now() - Date.parse(proposal.at);
    if (elapsed >= VOTE_TIMEOUT_MS) {
      ctx.note(`restart outlasted the vote window: ${elapsed}ms since propose, window ${VOTE_TIMEOUT_MS}ms`);
      const expired = await world.waitStatus("plant-a", proposal.id, ["expired"], 12_000);
      ctx.check("proposal expires rather than sticking in voting", Boolean(expired), restored?.status);
      ctx.equal("no simulation command", world.sim.length, 0);
      return;
    }
    ctx.equal("status still voting", restored?.status, "voting");
    await world.castVotes(proposal, VOTERS.slice(2));
    const open = await world.waitStatus("plant-a", proposal.id, ["veto_window"], 15_000);
    ctx.check("reaches veto_window after restart", Boolean(open), open?.status);
    const done = await world.waitStatus("plant-a", proposal.id, ["executed"], VETO_WINDOW_MS + 12_000);
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
    const before = await world.durablePlant();
    await sleep(3_000);
    const timing = await crashAndRead(ctx, "veto");
    ctx.metric("veto.killBeforeDeadlineMs", deadline - timing.kill.atEpochMs);
    const after = await world.durablePlant();
    world.checkIntact(before, after, "veto");
    const restored = after.plants["plant-a"].proposals.find((item: any) => item.id === open.id);
    ctx.equal("deadline unchanged", restored?.vetoDeadline, open.vetoDeadline);
    if (Date.now() >= deadline) ctx.note(`restart outlasted the veto window by ${Date.now() - deadline}ms`);
    else ctx.check("window still open after restart", restored?.status === "veto_window", { status: restored?.status, msLeft: deadline - Date.now() });

    const done = await world.waitStatus("plant-a", open.id, ["executed"], Math.max(0, deadline - Date.now()) + 12_000);
    ctx.check("deadline fires after restart", Boolean(done), done?.status);
    await until(() => world.sim.length > 0, 8_000);
    await sleep(9_000); // Long enough for every published callback retry.
    ctx.equal("exactly one simulation command", world.commandsFor(open.id).length, 1);
    const first = ctx.glue.of("/execute-callback")[0];
    ctx.check("not fired before the deadline", Boolean(first) && first.atEpochMs >= deadline, first ? { earlyByMs: deadline - first.atEpochMs } : "no callback");
    if (first) ctx.metric("veto.firedAfterDeadlineMs", first.atEpochMs - deadline);
    const state = await world.plantState("plant-a");
    const accepted = state.audit.filter((entry: any) => entry.kind === "execute" && entry.refId === open.id && /^Accepted/.test(entry.summary));
    ctx.equal("accepted once in the audit", accepted.length, 1);
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
    const final = await world.waitStatus("plant-a", open.id, ["executed", "expired", "vetoed"], 25_000);
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

export const vetoReopened: Scenario = {
  id: "c2d-veto-in-reopened-window",
  title: "deadline lapses in an outage, then an operator vetoes in the reopened window: nothing is sent",
  run: async (ctx) => {
    const world = await boot(ctx);
    const open = await intoVetoWindow(world);
    await crashAndRead(ctx, "reopen", "runtime", Math.max(0, Date.parse(open.vetoDeadline) - Date.now()) + 1_000);
    const reopened = await until(async () => {
      const current = await world.proposal("plant-a", open.id);
      return current?.status === "veto_window" && current.vetoDeadline !== open.vetoDeadline ? current : undefined;
    }, 10_000, 100);
    ctx.check("the lapsed window reopened with a new deadline", Boolean(reopened), { was: open.vetoDeadline, now: reopened?.vetoDeadline });
    if (!reopened) return;
    const audit = (await world.plantState("plant-a")).audit.filter((entry: any) => entry.refId === open.id).map((entry: any) => entry.summary);
    ctx.check("the reopening is in the audit", audit.some((line: string) => /reopened/i.test(line)), audit);
    await ctx.client.call("Plant", "plant-a", "veto", [open.id, "chaos-operator"]);
    await sleep(Math.max(0, Date.parse(reopened.vetoDeadline) - Date.now()) + 5_000);
    ctx.equal("the veto holds past the new deadline", (await world.proposal("plant-a", open.id))?.status, "vetoed");
    ctx.equal("no callback sent", ctx.glue.count("/execute-callback"), 0);
    ctx.equal("no simulation command", world.sim.length, 0);
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

/** A read that lands on a dying host fails at once, and the runtime then answers 503 until its lease drains. */
async function readThroughHostDeath(ctx: Ctx): Promise<void> {
  const up = await until(async () => (await ctx.client.invoke("Plant", "plant-a", "getState", [], 5_000)).kind === "completed", 60_000, 50);
  if (!up) throw new Error("Plant never answered after its host was killed");
}

export const killHostOnly: Scenario = {
  id: "h1-kill-plant-host",
  title: "kill -9 of only the Plant's host process: the runtime stays up, so no rebuild, but the old lease must drain",
  run: async (ctx) => {
    const world = await boot(ctx);
    await ctx.glue.waitFor("/tick", 4, 8_000);
    const kill = () => {
      const pid = hostPid(ctx.server.pgid, "Plant", "plant-a");
      ctx.check("found the Plant host", pid != null, pid);
      process.kill(pid!, "SIGKILL");
      return performance.now();
    };

    // Silent past the lease: nothing may call the Plant, so only its alarm can bring it back. The live counter dies with
    // the host and /tick carries no plant id, so the evidence is the arrival rate against this baseline for both Plants.
    const baselineFrom = ctx.glue.count("/tick");
    await sleep(5_000);
    const baseline = (ctx.glue.count("/tick") - baselineFrom) / 5;
    const silentAt = Date.now();
    const silentKill = kill();
    await sleep(45_000);
    const late = ctx.glue.of("/tick").filter((call) => call.atEpochMs > silentAt + 40_000).length / 5;
    ctx.metric("hostkill.ticksPerSecondBefore", baseline);
    ctx.metric("hostkill.ticksPerSecondAfterSilence", late);
    ctx.note(`after a host kill and 45s of silence: ${late} /tick arrivals a second against ${baseline} before; ${late >= baseline * 0.75 ? "the alarm brought the Plant back alone" : "the alarm did not bring the Plant back alone"}`);
    await readThroughHostDeath(ctx);
    ctx.metric("hostkill.silentRecoveryReadMs", performance.now() - silentKill);
    const resumedFrom = ctx.glue.count("/tick");
    await sleep(5_000);
    const resumed = (ctx.glue.count("/tick") - resumedFrom) / 5;
    ctx.metric("hostkill.ticksPerSecondAfterRead", resumed);
    ctx.check("one read restarts the tick after a host kill", resumed >= baseline * 0.75, { baseline, resumed });

    const proposal = await world.propose("plant-a", 65);
    await world.castVotes(proposal, VOTERS.slice(0, 2));
    const before = await world.durablePlant();
    const killed = kill();
    await readThroughHostDeath(ctx);
    ctx.metric("hostkill.firstReadAfterKillMs", performance.now() - killed);
    world.checkIntact(before, await world.durablePlant(), "hostkill");

    // The drain outlasts the vote window, so the veto window part needs a proposal of its own.
    await world.waitStatus("plant-a", proposal.id, ["expired"], 10_000);
    const open = await intoVetoWindow(world, 66);
    await sleep(3_000);
    kill();
    const done = await world.waitStatus("plant-a", open.id, ["executed"], 75_000);
    ctx.check("the proposal still executes after its host died in the veto window", Boolean(done), done?.status);
    await until(() => world.sim.length > 0, 8_000);
    await sleep(5_000);
    ctx.equal("exactly one simulation command", world.commandsFor(open.id).length, 1);
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
    const open = await world.waitStatus("plant-a", proposal.id, ["veto_window"], 15_000);
    ctx.check("reaches veto_window across crashes", Boolean(open), open?.status);
    await crashAndRead(ctx, "loop4", "group");
    await sleep(2_000);
    await crashAndRead(ctx, "loop5");
    const done = await world.waitStatus("plant-a", proposal.id, ["executed"], VETO_WINDOW_MS + 20_000);
    const state = await world.plantState("plant-a");
    const final = state.proposals.find((item: any) => item.id === proposal.id);
    ctx.note(`final status=${final?.status} votes=${final?.votes.length} deadline=${final?.vetoDeadline}`);
    ctx.note(`audit: ${JSON.stringify(state.audit.filter((entry: any) => entry.refId === proposal.id && entry.kind !== "vote").map((entry: any) => entry.summary))}`);
    ctx.check("executes across crashes", Boolean(done), done?.status);
    await until(() => world.sim.length > 0, 10_000);
    await sleep(9_000);
    ctx.equal("exactly one simulation command", world.commandsFor(proposal.id).length, 1);
    const audit = (await world.plantState("plant-a")).audit;
    ctx.equal("accepted once in the audit", audit.filter((entry: any) => entry.kind === "execute" && entry.refId === proposal.id && /^Accepted/.test(entry.summary)).length, 1);
  },
};

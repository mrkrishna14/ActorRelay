// Runtime-level facts, measured on a throwaway actor so a failure here cannot be blamed on ActorRelay code.
import { hostPid, sleep, until } from "../lib/server";
import type { Scenario } from "../lib/scenario";

const P = "probe-1";

export const probeScenarios: Scenario[] = [
  {
    id: "p1-durability-and-alarm",
    title: "acknowledged writes and a running alarm across kill -9 of the real server",
    run: async (ctx) => {
      const { client } = ctx;
      const coldStart = performance.now();
      await client.call("Probe", P, "quick");
      ctx.metric("coldFirstCallMs", performance.now() - coldStart);
      const seen = await client.call("Probe", P, "read");
      ctx.equal("GLUE_URL env reaches the actor", seen.glueUrl, ctx.glue.url);
      // Guards ar-actors' server: on a second port, actor-to-actor calls must not land on 7100.
      ctx.equal("hosts are told this server's URL, not 7100", seen.controlPlaneUrl, ctx.server.url);
      const other = await client.call("Probe", P, "askOther", ["probe-other"]);
      ctx.check("actor-to-actor call works on this port", typeof other?.count === "number", other);
      ctx.check("each actor has its own host process", other.pid !== seen.pid, { self: seen.pid, other: other.pid });
      const host = hostPid(ctx.server.pgid, "Probe", P);
      ctx.equal("host lookup finds the right process", host, seen.pid);

      await client.call("Probe", P, "arm", [300]);
      const fired = await until(async () => (await client.call("Probe", P, "read")).alarmFires >= 3, 6_000, 100);
      ctx.check("alarm fires before the crash", Boolean(fired));

      const acked: string[] = [];
      for (let index = 0; index < 50; index++) {
        const mark = `ack-${index}`;
        await client.call("Probe", P, "write", [mark]);
        acked.push(mark);
      }
      const before = await client.call("Probe", P, "read");
      const timing = await ctx.crash("probe", "runtime");
      const started = performance.now();
      const after = await client.call("Probe", P, "read", [], 30_000);
      ctx.metric("probe.coldReadAfterRestartMs", performance.now() - started);
      ctx.metric("probe.healthyAfterKillMs", timing.healthzMs);
      ctx.check("all 50 acknowledged writes survive", acked.every((mark) => after.marks.includes(mark)), { before: before.count, after: after.count });
      ctx.check("persisted alarm config survives", after.alarmEveryMs === 300, after);
      ctx.note(`alarm.get() after restart: ${after.alarm}; fires before ${before.alarmFires}, after ${after.alarmFires}`);

      const firesAtRestart = after.alarmFires;
      await sleep(4_000);
      const later = await client.call("Probe", P, "read");
      const resumed = later.alarmFires > firesAtRestart;
      ctx.note(`RUNTIME FACT: alarm ${resumed ? "DID" : "did NOT"} fire on its own within 4s of restart (${firesAtRestart} -> ${later.alarmFires}); alarm.get()=${later.alarm}`);
      ctx.check("alarm resumes with no re-arm", resumed, { firesAtRestart, later: later.alarmFires, alarm: later.alarm });

      await client.call("Probe", P, "arm", [300]);
      const rearmed = await until(async () => (await client.call("Probe", P, "read")).alarmFires > later.alarmFires + 2, 5_000, 100);
      ctx.check("explicit re-arm restores the alarm", Boolean(rearmed));
    },
  },
  {
    id: "p2-in-flight-outcome",
    title: "what a caller sees when the server dies mid-call, and whether a host outlives the runtime",
    run: async (ctx) => {
      const { client, glue } = ctx;
      glue.on("/step-one", { kind: "hold" });
      glue.on("/step-two", { kind: "ok" });
      const inFlight = client.invoke("Probe", P, "twoStep", [glue.url], 20_000);
      ctx.check("call reached step one", await glue.waitFor("/step-one", 1, 15_000));

      const kill = await ctx.server.kill9("runtime");
      ctx.note(`host gone ${kill.hostsGoneMs?.toFixed(0)}ms after runtime kill; survivors ${JSON.stringify(kill.survivors)}`);
      const outcome = await inFlight;
      ctx.note(`RUNTIME FACT: in-flight caller saw ${JSON.stringify(outcome)}`);
      glue.releaseAll();
      await sleep(1_500);
      ctx.equal("a killed runtime's host sends nothing further", glue.count("/step-two"), 0);

      await ctx.server.start();
      const state = await client.call("Probe", P, "read", [], 30_000);
      ctx.check("nothing past the crash point was recorded", !state.marks.includes("after-step-one"), state.marks);
      await sleep(3_000);
      ctx.equal("the call is not replayed after restart", glue.count("/step-one"), 1);
    },
  },
  {
    id: "p3-mailbox-held-by-fetch",
    title: "a method awaiting fetch closes the mailbox, and a held call blocks reads",
    run: async (ctx) => {
      const { client, glue } = ctx;
      glue.on("/held", { kind: "hold" });
      await client.call("Probe", P, "quick");
      const held = client.invoke("Probe", P, "heldFetch", [glue.url], 15_000);
      await glue.waitFor("/held", 1, 10_000);
      const blocked = await client.invoke("Probe", P, "quick", [], 3_000);
      ctx.note(`RUNTIME FACT: read during a held fetch: ${blocked.kind} after ${blocked.ms.toFixed(0)}ms`);
      ctx.check("mailbox is closed during an awaited fetch", blocked.kind === "timeout", blocked);
      glue.releaseAll();
      await held;
      ctx.equal("mailbox reopens after the fetch returns", (await client.invoke("Probe", P, "quick")).kind, "completed");
    },
  },
  {
    id: "p4-group-kill-restart-times",
    title: "ten kill and restart cycles, half literal kill -9 and half whole group, for recovery timing",
    run: async (ctx) => {
      const { client } = ctx;
      await client.call("Probe", P, "write", ["start"]);
      let count = 1;
      for (let round = 0; round < 10; round++) {
        const mode = round % 2 ? "group" : "runtime";
        const timing = await ctx.crash(`cycle${round}`, mode);
        const started = performance.now();
        const state = await client.call("Probe", P, "read", [], 30_000);
        ctx.metric(`cycle${round}.${mode}.healthyMs`, timing.healthzMs);
        ctx.metric(`cycle${round}.${mode}.coldReadMs`, performance.now() - started);
        ctx.check(`cycle ${round}: count intact`, state.count === count, state.count);
        count = await client.call("Probe", P, "write", [`cycle-${round}`]);
      }
    },
  },
];

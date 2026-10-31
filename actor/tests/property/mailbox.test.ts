import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, iso, makeEvent, makeVote, plantComponents, T0 } from "./harness";
import { SRC } from "./real-adapter";
import { isReal } from "./target";
import { COMPANY, onStage, settles, type Stage, WORLD_RUNS } from "./world";

const PUMP = "plant-a/P-100";

// Calls may only flow down this order. Anything else could close a mailbox cycle.
const RANK: Record<string, number> = { Component: 0, Plant: 1, Company: 2 };
const kind = (key: string) => key.split(":")[0]!;

type Call = (stage: Stage, proposalId: string) => Promise<unknown>;

const CALLS: [string, Call][] = [
  ["vote", (s, id) => s.plant("plant-a").vote(makeVote(id, "plant-a/LV-101"))],
  ["vote again", (s, id) => s.plant("plant-a").vote(makeVote(id, "plant-a/LV-101"))],
  ["veto", (s, id) => s.plant("plant-a").veto(id, "operator")],
  ["sweep", (s) => s.plant("plant-a").sweep()],
  ["tick", (s) => s.plant("plant-a").tick()],
  ["sweep plant-b", (s) => s.plant("plant-b").sweep()],
  ["similar", (s) => s.plant("plant-a").similar(PUMP, "speedPct", 85, {}, 5)],
  ["rulesFor", (s) => s.plant("plant-a").rulesFor("plant-a/LV-101", "outlet-valve-A")],
  ["getState", (s) => s.plant("plant-a").getState()],
  ["execute", (s, id) => s.plant("plant-a").execute(id)],
  ["claim", (s, id) => s.plant("plant-a").claimDispatch(id, 50)],
  ["setMetric", (s, id) => s.component(PUMP).setMetric("speedPct", 65, id, "not-the-token")],
  ["mirror", (s) => s.component("plant-a/TK-101").mirror({ levelPct: 51 })],
  ["calibration", (s, id) => s.component("plant-a/LV-101").addCalibration({ at: new Date().toISOString(), proposalId: id, metric: "positionPct", predicted: 66, observed: 67, absError: 1 })],
  ["margin", (s) => s.component("plant-a/LV-101").setMargin(12)],
  ["event", (s) => s.observe("plant-a", `e${Math.random()}`, 85, [])],
  ["propose", (s) => s.plant("plant-a").propose({ proposerComponentId: "plant-a/LV-101", metric: "positionPct", to: 60, rationale: "generated" })],
  ["company state", (s) => s.company().getState()],
];

// Calls that pass the seeded check. Plain reads such as similar and rulesFor do not re-arm.
const ENTRY_POINTS = ["vote", "veto", "sweep", "tick", "getState", "execute", "claim", "event", "propose"];

const batchArb = fc.array(fc.constantFrom(...CALLS), { minLength: 1, maxLength: 12 });

// Three seeded unsafe runs, so the plant starts with a rule to push and Company is in play.
const SEEDED_RULE = [0, 1, 2].map((i) =>
  makeEvent(
    `seed${i}`,
    PUMP,
    "speedPct",
    85,
    [{ componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: 95, ticksToSettle: 3 }],
    { at: iso(T0 - 1000 + i) },
  ),
);

async function opened(stage: Stage, history = SEEDED_RULE.slice(0, 0)) {
  await stage.seedAll({ history });
  const proposal = await stage.plant("plant-a").propose({
    proposerComponentId: PUMP,
    metric: "speedPct",
    to: 65,
    rationale: "generated",
  });
  return proposal.id as string;
}

describe.skipIf(!isReal)("mailboxes [real logic, fake runtime]", () => {
  let quiet: ReturnType<typeof spyOn>;
  beforeAll(() => {
    quiet = spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(() => quiet.mockRestore());

  test("any batch of concurrent calls settles, with calls only flowing down", async () => {
    await check(
      fc.asyncProperty(batchArb, async (batch) => {
        await onStage(async (stage) => {
          const id = await opened(stage, SEEDED_RULE);
          const calls = batch.map(([, call]) => call(stage, id).catch(() => undefined));
          await settles(Promise.all(calls), batch.map(([name]) => name).join(", "));
          await stage.idle();
          // Force one full push, so the Plant and Company paths always run in this case.
          for (const plant of ["plant-b", "plant-a"]) {
            await settles(stage.plant(plant).sweep(), `${plant} sweep`);
            await stage.idle();
          }
          expect(stage.world.calls.some((c) => c.to === COMPANY && c.method === "promoteRule")).toBe(true);
          for (const { from, to, method } of stage.world.calls) {
            if (from === null) continue;
            // All fire-and-forget from outside the plant's own turn, so they cannot deadlock it.
            if (from === to && ["setConnected", "ackCompanySync", "grantLease"].includes(method)) continue;
            if (RANK[kind(to)]! <= RANK[kind(from)]!) throw new Error(`upward call ${from} -> ${to}.${method}`);
          }
        });
      }),
      WORLD_RUNS,
    );
  });

  test("no actor class even refers to one above it", () => {
    const source = readFileSync(join(import.meta.dir, SRC, "actor.ts"), "utf8");
    const body = (name: string) => {
      const start = source.indexOf(`export class ${name} `);
      const next = source.indexOf("export class ", start + 1);
      return source.slice(start, next === -1 ? undefined : next);
    };
    expect(body("Company")).not.toMatch(/\b(Plant|Component)\.get\(/);
    expect(body("Plant")).not.toMatch(/\bComponent\.get\(/);
  });

  test("concurrent claims dispatch exactly once", async () => {
    await check(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (n) => {
        await onStage(async (stage) => {
          await stage.seedAll();
          const { id } = await stage.accepted(65);
          const claims = await Promise.all(Array.from({ length: n }, () => stage.plant("plant-a").claimDispatch(id)));
          expect(claims.filter((c) => c.dispatch).length).toBe(1);
        });
      }),
      100,
    );
  });

  test("concurrent votes from one voter record one vote", async () => {
    await check(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), fc.constantFrom<"yes" | "no">("yes", "no"), async (n, vote) => {
        await onStage(async (stage) => {
          const id = await opened(stage);
          const votes = Array.from({ length: n }, () =>
            stage.plant("plant-a").vote(makeVote(id, "plant-a/LV-101", vote)).then(() => true, () => false),
          );
          expect((await Promise.all(votes)).filter(Boolean).length).toBe(1);
          expect(stage.rawPlant("plant-a").proposals[0].votes.length).toBe(1);
        });
      }),
      100,
    );
  });

  test("a veto racing the sweep at the deadline never leaves both outcomes", async () => {
    await check(
      fc.asyncProperty(fc.boolean(), async (vetoFirst) => {
        await onStage(async (stage) => {
          await stage.seedAll();
          const { id } = await stage.windowOpen();
          const plant = stage.plant("plant-a");
          stage.advance(10_000);
          const veto = () => plant.veto(id, "operator").then(() => true, () => false);
          const sweep = () => plant.sweep().then(() => false);
          const results = vetoFirst ? [await Promise.all([veto(), sweep()])] : [await Promise.all([sweep(), veto()])];
          const vetoed = results[0]!.some(Boolean);
          const status = stage.rawPlant("plant-a").proposals[0].status;
          expect(status).toBe(vetoed ? "vetoed" : "executed");
          expect(Boolean(stage.rawPlant("plant-a").executions[id])).toBe(!vetoed);
        });
      }),
      20,
    );
  });

  test("with Company down an open window still executes, and propose fails closed", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      await stage.windowOpen();
      stage.world.fault = (target) => (target === COMPANY ? "before" : null);
      const plant = stage.plant("plant-a");
      stage.advance(10_000);
      await stage.sweep();
      expect(stage.rawPlant("plant-a").proposals[0].status).toBe("executed");
      const before = stage.rawPlant("plant-a").proposals.length;
      await expect(plant.propose({ proposerComponentId: PUMP, metric: "speedPct", to: 70, rationale: "generated" })).rejects.toThrow();
      expect(stage.rawPlant("plant-a").proposals.length).toBe(before);
    });
  });

  test("a vote citing a rule fails closed while Company cannot confirm it", async () => {
    await onStage(async (stage) => {
      const id = await opened(stage);
      stage.world.fault = (target) => (target === COMPANY ? "before" : null);
      const vote = { ...makeVote(id, "plant-a/LV-101"), evidenceRuleIds: ["company-rule:unknown"] };
      await expect(stage.plant("plant-a").vote(vote)).rejects.toThrow();
      expect(stage.rawPlant("plant-a").proposals[0].votes).toEqual([]);
    });
  });

  test("a slow Company never holds a plant's ticks, sweeps or votes", async () => {
    await check(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (rounds) => {
        await onStage(async (stage) => {
          const id = await opened(stage);
          stage.world.fault = (target) => (target === COMPANY ? "hold" : null);
          const plant = stage.plant("plant-a");
          for (let i = 0; i < rounds; i++) {
            await settles(plant.tick(), "tick", 1000);
            await settles(plant.sweep(), "sweep", 1000);
          }
          await settles(plant.vote(makeVote(id, "plant-a/LV-101")), "vote", 1000);
          await settles(stage.observe("plant-a", "e0", 85, []), "recordEvent", 1000);
          stage.world.fault = () => null;
          stage.world.release();
          await stage.idle();
        });
      }),
      50,
    );
  });

  test.skipIf(process.env.PROP_SKIP_SLOW === "1")("a hung Company fails propose closed, then the mailbox reopens", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      stage.world.fault = (target) => (target === COMPANY ? "hang" : null);
      const plant = stage.plant("plant-a");
      const propose = plant.propose({ proposerComponentId: PUMP, metric: "speedPct", to: 70, rationale: "generated" });
      await expect(settles(propose, "propose", 12_000)).rejects.toThrow("actor_call_timeout");
      expect((await settles(plant.getState(), "getState after hang")).proposals).toEqual([]);
    });
  }, 20_000);

  test("a cached company rule id does not outlive a Company reseed", async () => {
    await onStage(async (stage) => {
      const id = await opened(stage);
      const rule = { id: "company-rule:known" };
      stage.rawCompany().rules = [rule];
      const plant = stage.plant("plant-a");
      await plant.vote({ ...makeVote(id, "plant-a/LV-101"), evidenceRuleIds: [rule.id] });
      await stage.seedCompany();
      const vote = { ...makeVote(id, "plant-a/E-101"), evidenceRuleIds: [rule.id] };
      await expect(plant.vote(vote)).rejects.toThrow("invalid_vote");
    });
  });

  test("calls under load never touch an overdue alarm, so they add no deliveries", async () => {
    await check(
      fc.asyncProperty(batchArb, fc.integer({ min: 0, max: 30_000 }), async (batch, overdueBy) => {
        await onStage(async (stage) => {
          const id = await opened(stage);
          const { alarm } = stage.rawPlant("plant-a");
          alarm.scheduled = stage.now - overdueBy;
          alarm.sets = 0;
          const scheduled = alarm.scheduled;
          const calls = batch.map(([, call]) => call(stage, id).catch(() => undefined));
          await settles(Promise.all(calls), "calls while overdue");
          await stage.idle();
          expect(alarm.sets).toBe(0);
          expect(alarm.scheduled).toBe(scheduled);
        });
      }),
      WORLD_RUNS,
    );
  });

  test("a lost alarm is re-armed by the next call into the plant", async () => {
    await check(
      fc.asyncProperty(fc.constantFrom(...CALLS.filter(([name]) => ENTRY_POINTS.includes(name))), async ([, call]) => {
        await onStage(async (stage) => {
          const id = await opened(stage);
          // A restart loses the alarm and every ephemeral field, including the once-per-activation check.
          const raw = stage.rawPlant("plant-a");
          raw.alarm.scheduled = null;
          raw.alarmChecked = false;
          await call(stage, id).catch(() => undefined);
          expect(raw.alarm.scheduled).toBe(stage.now + 1000);
        });
      }),
      100,
    );
  });

  test("a repeated delivery ticks once and leaves the alarm armed", async () => {
    await check(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), fc.integer({ min: 0, max: 499 }), async (repeats, gap) => {
        await onStage(async (stage) => {
          await stage.seedAll();
          const plant = stage.plant("plant-a");
          for (let i = 0; i < repeats; i++) {
            await plant.onAlarm();
            stage.advance(Math.min(gap, Math.floor(499 / repeats)));
          }
          expect(stage.rawPlant("plant-a").tickCount).toBe(1);
          expect(stage.rawPlant("plant-a").alarm.scheduled).not.toBeNull();
        });
      }),
      100,
    );
  });

  test("deliveries half a tick or more apart all tick", async () => {
    await check(
      fc.asyncProperty(fc.array(fc.integer({ min: 500, max: 3000 }), { minLength: 1, maxLength: 8 }), async (gaps) => {
        await onStage(async (stage) => {
          await stage.seedAll();
          const plant = stage.plant("plant-a");
          await plant.onAlarm();
          for (const gap of gaps) {
            stage.advance(gap);
            await plant.onAlarm();
          }
          expect(stage.rawPlant("plant-a").tickCount).toBe(gaps.length + 1);
        });
      }),
      100,
    );
  });

  test("a tick that throws still leaves the alarm armed, and the next delivery runs", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      const raw = stage.rawPlant("plant-a");
      const tick = raw.tick;
      raw.tick = async () => {
        throw new Error("tick failed");
      };
      // A delivery uses up the slot, so only onAlarm itself can arm the next one.
      raw.alarm.scheduled = null;
      await stage.plant("plant-a").onAlarm();
      expect(raw.alarm.scheduled).toBe(stage.now + 1000);
      raw.tick = tick;
      stage.advance(1000);
      await stage.plant("plant-a").onAlarm();
      expect(raw.tickCount).toBe(1);
    });
  });

  test("every component has a live seed reference", () => {
    expect(plantComponents("plant-a").length).toBe(5);
  });
});

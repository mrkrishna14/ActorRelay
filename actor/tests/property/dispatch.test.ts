import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { check, makeEvent } from "./harness";
import { isReal } from "./target";
import { onStage, type Stage, WORLD_RUNS } from "./world";

const PUMP = "plant-a/P-100";
const LV = "plant-a/LV-101";
const FROM = 50;
const TO = 65;

const LEGAL: Record<string, string[]> = {
  accepted: ["accepted", "claimed", "failed"],
  claimed: ["claimed", "applied", "observed", "failed"],
  applied: ["applied", "observed"],
  observed: ["observed"],
  failed: ["failed"],
};

type Measured = "none" | "exact" | "near" | "far" | "nan" | "infinite";
type Op =
  | { kind: "claim"; measured: Measured }
  | { kind: "write"; token: "real" | "wrong"; value: "right" | "wrong"; metric: "right" | "wrong"; component: "right" | "wrong" }
  | { kind: "report" }
  | { kind: "observe" }
  | { kind: "sweep"; ms: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("claim" as const), measured: fc.constantFrom<Measured>("none", "none", "exact", "near", "far", "nan", "infinite") }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("write" as const), token: fc.constantFrom<"real" | "wrong">("real", "real", "wrong"), value: fc.constantFrom<"right" | "wrong">("right", "right", "wrong"), metric: fc.constantFrom<"right" | "wrong">("right", "right", "wrong"), component: fc.constantFrom<"right" | "wrong">("right", "right", "wrong") }) },
  { weight: 1, arbitrary: fc.constant<Op>({ kind: "report" }) },
  { weight: 2, arbitrary: fc.constant<Op>({ kind: "observe" }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("sweep" as const), ms: fc.constantFrom(0, 1000, 4000, 8000, 20000) }) },
);

const MEASURED: Record<Measured, number | undefined> = {
  none: undefined,
  exact: FROM,
  near: FROM + 0.005,
  far: FROM + 5,
  nan: Number.NaN,
  infinite: Infinity,
};

const observation = (proposalId: string) => ({
  proposalId,
  effects: [{ componentId: LV, metric: "positionPct", before: 50, after: 66, ticksToSettle: 3 }],
});

const executionOf = (stage: Stage, id: string) => stage.rawPlant("plant-a").executions[id];

async function attempt<T>(work: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/^[a-z_]+: /.test(message)) throw error;
    return { ok: false, message };
  }
}

describe.skipIf(!isReal)("dispatch [real logic, fake runtime]", () => {
  test("random dispatch schedules keep every invariant at every step", async () => {
    await check(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 16 }), async (ops) => {
        await onStage(async (stage) => {
          await stage.seedAll();
          const { id } = await stage.accepted(TO);
          const plant = stage.plant("plant-a");
          let token: string | null = null;
          let dispatches = 0;
          let writes = 0;

          for (const op of ops) {
            const before = structuredClone(executionOf(stage, id));
            const beforeEvents = stage.rawPlant("plant-a").history.length;
            switch (op.kind) {
              case "claim": {
                const out = await attempt(plant.claimDispatch(id, MEASURED[op.measured]));
                if (out.ok && (out.value as any).dispatch) {
                  dispatches += 1;
                  token = (out.value as any).token;
                  expect((out.value as any).value).toBe(TO);
                }
                break;
              }
              case "write": {
                const out = await attempt(
                  stage
                    .component(op.component === "right" ? PUMP : LV)
                    .setMetric(
                      op.metric === "right" ? "speedPct" : "feedM3h",
                      op.value === "right" ? TO : TO + 1,
                      id,
                      op.token === "real" && token ? token : "not-the-token",
                    ),
                );
                if (out.ok) {
                  writes += 1;
                  const exact = op.token === "real" && op.value === "right" && op.metric === "right" && op.component === "right";
                  if (!exact) throw new Error(`write accepted with ${JSON.stringify(op)}`);
                }
                break;
              }
              case "report":
                await attempt(plant.reportDispatchFailure(id, "simulator refused"));
                break;
              case "observe":
                await attempt(plant.recordEvent(observation(id)));
                break;
              case "sweep":
                stage.advance(op.ms);
                await plant.sweep();
                break;
            }

            const after = executionOf(stage, id);
            if (!LEGAL[before.state]!.includes(after.state)) {
              throw new Error(`execution ${before.state} -> ${after.state} on ${op.kind}`);
            }
            expect(dispatches).toBeLessThanOrEqual(1);
            expect(writes).toBeLessThanOrEqual(1);
            const events = stage.rawPlant("plant-a").history.filter((e: { proposalId: string | null }) => e.proposalId === id);
            expect(events.length).toBeLessThanOrEqual(1);
            if (events.length === 1 && before.state === "observed") {
              expect(stage.rawPlant("plant-a").history.length).toBe(beforeEvents);
            }

            const speed = stage.rawComponent(PUMP).metrics.speedPct;
            expect(speed).toBe(writes === 1 ? TO : FROM);
            const setpoint = stage.rawPlant("plant-a").setpoints[PUMP].speedPct;
            expect(setpoint).toBe(after.state === "failed" ? FROM : TO);
            if (after.state === "failed") expect(writes === 0 || before.state !== "applied").toBe(true);

            if (token) {
              const visible = JSON.stringify({
                proposals: stage.rawPlant("plant-a").proposals,
                audit: stage.rawPlant("plant-a").audit,
                executions: stage.rawPlant("plant-a").executions,
                tokenHashes: stage.rawPlant("plant-a").tokenHashes,
              });
              expect(visible).not.toContain(token);
            }
          }
        });
      }),
      WORLD_RUNS,
    );
  });

  test("a measured value dispatches only within tolerance of the proposal's from", async () => {
    await check(
      fc.asyncProperty(fc.constantFrom(0, 0.001, 0.0099, 0.0101, 0.5, 5, -0.0099, -0.0101, -5), async (delta) => {
        await onStage(async (stage) => {
          await stage.seedAll();
          const { id } = await stage.accepted(TO);
          const claim = await stage.plant("plant-a").claimDispatch(id, FROM + delta);
          const within = Math.abs(delta) <= 0.01;
          expect(claim.dispatch).toBe(within);
          expect(executionOf(stage, id).state).toBe(within ? "claimed" : "failed");
          expect(stage.rawPlant("plant-a").setpoints[PUMP].speedPct).toBe(within ? TO : FROM);
        });
      }),
      100,
    );
  });

  test("a non-finite measured value never dispatches", async () => {
    await check(
      fc.asyncProperty(fc.constantFrom(Number.NaN, Infinity, -Infinity), async (measured) => {
        await onStage(async (stage) => {
          await stage.seedAll();
          const { id } = await stage.accepted(TO);
          expect((await stage.plant("plant-a").claimDispatch(id, measured)).dispatch).toBe(false);
          expect(executionOf(stage, id).state).toBe("failed");
        });
      }),
      30,
    );
  });

  test("a token writes once, and only the exact approved write", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      const { id } = await stage.accepted(TO);
      const claim = await stage.plant("plant-a").claimDispatch(id);
      const component = stage.component(PUMP);
      expect((await attempt(component.setMetric("speedPct", TO + 1, id, claim.token))).ok).toBe(false);
      expect((await attempt(component.setMetric("speedPct", TO, id, "not-the-token"))).ok).toBe(false);
      expect((await attempt(component.setMetric("speedPct", TO, id, claim.token))).ok).toBe(true);
      expect((await attempt(component.setMetric("speedPct", TO, id, claim.token))).ok).toBe(false);
      expect(stage.rawComponent(PUMP).metrics.speedPct).toBe(TO);
    });
  });

  test("a claimed dispatch that timed out can no longer write", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      const { id } = await stage.accepted(TO);
      const claim = await stage.plant("plant-a").claimDispatch(id);
      stage.advance(20_000);
      await stage.plant("plant-a").sweep();
      expect(executionOf(stage, id).state).toBe("failed");
      expect((await attempt(stage.component(PUMP).setMetric("speedPct", TO, id, claim.token))).ok).toBe(false);
      expect(stage.rawComponent(PUMP).metrics.speedPct).toBe(FROM);
    });
  });

  test("an observation needs a dispatched command, and a retry records it once", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      const { id } = await stage.accepted(TO);
      const plant = stage.plant("plant-a");
      expect((await attempt(plant.recordEvent(observation(id)))).ok).toBe(false);
      const claim = await plant.claimDispatch(id);
      await stage.component(PUMP).setMetric("speedPct", TO, id, claim.token);
      const first = await plant.recordEvent(observation(id));
      const retry = await plant.recordEvent(observation(id));
      expect(retry).toEqual(first);
      expect(stage.rawPlant("plant-a").history.length).toBe(1);
      expect(executionOf(stage, id).state).toBe("observed");
    });
  });

  test("a repeated failure report changes nothing", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      const { id } = await stage.accepted(TO);
      const plant = stage.plant("plant-a");
      await plant.reportDispatchFailure(id, "simulator refused");
      const failedAt = executionOf(stage, id).failedAt;
      const audit = stage.rawPlant("plant-a").audit.length;
      stage.advance(1000);
      await attempt(plant.reportDispatchFailure(id, "simulator refused"));
      expect(executionOf(stage, id).failedAt).toBe(failedAt);
      expect(stage.rawPlant("plant-a").audit.length).toBe(audit);
    });
  });

  test("a late failure report cannot rewind a newer proposal's setpoint", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      const first = await stage.accepted(TO);
      const plant = stage.plant("plant-a");
      await plant.reportDispatchFailure(first.id, "simulator refused");
      expect(stage.rawPlant("plant-a").setpoints[PUMP].speedPct).toBe(FROM);
      const second = await stage.accepted(70);
      expect(stage.rawPlant("plant-a").setpoints[PUMP].speedPct).toBe(70);
      await attempt(plant.reportDispatchFailure(first.id, "retried report"));
      expect(stage.rawPlant("plant-a").setpoints[PUMP].speedPct).toBe(70);
      expect(executionOf(stage, second.id).state).toBe("accepted");
    });
  });

  test("the callback carries no token and is sent once per attempt", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      const { id } = await stage.accepted(TO);
      const sent = () => stage.world.posts.filter((p) => p.url.endsWith("/execute-callback"));
      await Bun.sleep(0);
      expect(sent().length).toBe(1);
      expect(JSON.stringify(sent()[0]!.body)).not.toContain("token");
      stage.advance(4000);
      await stage.plant("plant-a").sweep();
      await Bun.sleep(0);
      expect(sent().length).toBe(2);
      expect(executionOf(stage, id).attempts).toBe(2);
    });
  });
});

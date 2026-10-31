import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import { check, makeVote, type Proposal } from "./harness";
import { isReal } from "./target";
import { COMPANY, onStage, type Stage, WORLD_RUNS } from "./world";

const PLANTS = ["plant-a", "plant-b"];

const proposalsOf = (stage: Stage, plant: string): Proposal[] => stage.rawPlant(plant).proposals;
const windows = (stage: Stage) =>
  PLANTS.flatMap((plant) => proposalsOf(stage, plant)).filter((p) => p.status === "veto_window");
const leasesAtCompany = (stage: Stage) => stage.rawCompany().leases as Record<string, { proposalId: string }>;

type Step = { kind: "sweep"; plant: string } | { kind: "advance"; ms: number } | { kind: "veto"; plant: string };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("sweep" as const), plant: fc.constantFrom(...PLANTS) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("advance" as const), ms: fc.constantFrom(500, 2000, 4000, 10_000) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("veto" as const), plant: fc.constantFrom(...PLANTS) }) },
);

describe.skipIf(!isReal)("shared resource leases [real logic, fake runtime]", () => {
  let quiet: ReturnType<typeof spyOn>;
  beforeAll(() => {
    quiet = spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(() => quiet.mockRestore());

  test("two plants never hold veto windows on the shared resource, in any order", async () => {
    await check(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 24 }), fc.boolean(), async (steps, flip) => {
        await onStage(async (stage) => {
          await stage.seedAll();
          for (const plant of flip ? [...PLANTS].reverse() : PLANTS) await stage.unanimous(65, plant);
          for (const step of steps) {
            if (step.kind === "advance") stage.advance(step.ms);
            else if (step.kind === "sweep") await stage.sweep(step.plant);
            else await stage.plant(step.plant).veto(proposalsOf(stage, step.plant)[0]!.id, "operator").catch(() => undefined);
            await stage.idle();
            const open = windows(stage);
            if (open.length > 1) throw new Error(`both plants hold a window: ${open.map((p) => p.plantId).join(", ")}`);
          }
        });
      }),
      WORLD_RUNS,
    );
  });

  test("the second plant gets its window once the first plant's run is done", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      await stage.unanimous(65, "plant-a");
      await stage.unanimous(65, "plant-b");
      await stage.sweep("plant-a");
      await stage.sweep("plant-a");
      await stage.sweep("plant-b");
      await stage.sweep("plant-b");
      expect(proposalsOf(stage, "plant-a")[0]!.status).toBe("veto_window");
      expect(proposalsOf(stage, "plant-b")[0]!.status).toBe("voting");
      stage.advance(10_000);
      await stage.sweep("plant-a");
      expect(proposalsOf(stage, "plant-a")[0]!.status).toBe("executed");
      await stage.sweep("plant-b");
      await stage.sweep("plant-b");
      expect(proposalsOf(stage, "plant-b")[0]!.status).toBe("veto_window");
    });
  });

  test("no lease, no window: with Company down a unanimous proposal waits, then expires", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      await stage.unanimous();
      stage.world.fault = (target) => (target === COMPANY ? "before" : null);
      for (let elapsed = 0; elapsed < 58_000; elapsed += 2_000) {
        await stage.sweep();
        expect(proposalsOf(stage, "plant-a")[0]!.status).toBe("voting");
        stage.advance(2_000);
      }
      stage.advance(2_000);
      await stage.sweep();
      expect(proposalsOf(stage, "plant-a")[0]!.status).toBe("expired");
    });
  });

  test("a lease is released however its proposal ends", async () => {
    type Ending = "executed" | "vetoed" | "blocked";
    await check(
      fc.asyncProperty(fc.constantFrom<Ending>("executed", "vetoed", "blocked"), async (ending) => {
        await onStage(async (stage) => {
          await stage.seedAll();
          const { id, requiredVoters } = await stage.windowOpen();
          expect(Object.keys(leasesAtCompany(stage)).length).toBe(1);
          const plant = stage.plant("plant-a");
          if (ending === "executed") stage.advance(10_000);
          if (ending === "vetoed") await plant.veto(id, "operator");
          if (ending === "blocked") await plant.vote(makeVote(id, requiredVoters[0]!, "no"));
          await stage.sweep();
          expect(proposalsOf(stage, "plant-a")[0]!.status).toBe(ending);
          expect(leasesAtCompany(stage)).toEqual({});
          expect(stage.rawPlant("plant-a").leases).toEqual([]);
        });
      }),
      30,
    );
  });

  test("a lease granted to a proposal that has since ended is handed back", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      const { id, requiredVoters } = await stage.unanimous();
      stage.world.fault = (target, method) => (target === COMPANY && method === "acquireLease" ? "hold" : null);
      await stage.sweep();
      await stage.plant("plant-a").veto(id, "operator").catch(() => undefined);
      const raw = stage.rawPlant("plant-a");
      raw.proposals = raw.proposals.map((p: Proposal) => (p.id === id ? { ...p, status: "blocked" as const } : p));
      expect(requiredVoters.length).toBeGreaterThan(0);
      stage.world.fault = () => null;
      stage.world.release();
      await stage.idle();
      expect(raw.leases).toEqual([]);
      expect(leasesAtCompany(stage)).toEqual({});
    });
  });

  test("a lost release frees the resource once the lease expires", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      const { id } = await stage.windowOpen();
      stage.world.fault = (target, method) => (target === COMPANY && method === "releaseLease" ? "before" : null);
      await stage.plant("plant-a").veto(id, "operator");
      await stage.sweep();
      stage.world.fault = () => null;
      expect(Object.keys(leasesAtCompany(stage)).length).toBe(1);
      await stage.unanimous(65, "plant-b");
      await stage.sweep("plant-b");
      await stage.sweep("plant-b");
      expect(proposalsOf(stage, "plant-b")[0]!.status).toBe("voting");
      stage.advance(60_001);
      const { id: second } = await stage.unanimous(66, "plant-b");
      await stage.sweep("plant-b");
      await stage.sweep("plant-b");
      expect(proposalsOf(stage, "plant-b").find((p) => p.id === second)!.status).toBe("veto_window");
    });
  });

  test("a window that outlives its lease cannot share the resource", async () => {
    await onStage(async (stage) => {
      await stage.seedAll();
      await stage.windowOpen();
      // plant-a's alarm stalls past the lease TTL, so its window is still open but unleased.
      stage.advance(60_001);
      await stage.unanimous(65, "plant-b");
      await stage.sweep("plant-b");
      await stage.sweep("plant-b");
      await stage.sweep("plant-a");
      await stage.sweep("plant-b");
      expect(windows(stage).length).toBeLessThanOrEqual(1);
    });
  });
});

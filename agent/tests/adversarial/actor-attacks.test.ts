// Forged votes, direct writes and replayed tokens against the actors. The actors are the last line, so nothing here
// may rely on glue or the agents having behaved. Each attack must leave the proposal unexecuted and the metric intact.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Proposal, Vote } from "../../../shared/types";
import { makeWorld, type World } from "./actor-world";
import { RULE_85 } from "./fixtures";

// A failed test skips its own close(), and other files in this process need the real clock and fetch.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

const A = "plant-a";
const P100 = "plant-a/P-100";
const SWEEP = 2_500;
const VETO = 10_500;
const label = process.env.ADV_TARGET === "naive" ? "naive control" : "real actors";

const PREDICTED: Record<string, Record<string, number>> = {
  "plant-a/TK-101": { levelPct: 52, tempC: 73 },
  "plant-a/LV-101": { positionPct: 66 },
  "plant-a/E-101": { dutyKw: 1160 },
  "plant-a/TV-101": { positionPct: 62, steamKgH: 1980 },
  "plant-b/TV-101": { positionPct: 52, steamKgH: 1540 },
};
const yes = (proposalId: string, componentId: string, patch: Partial<Vote> = {}): Vote => ({
  proposalId,
  componentId,
  agentId: `agent:${componentId}`,
  vote: "yes",
  reason: "within limits on retrieved runs",
  predicted: PREDICTED[componentId] ?? {},
  marginPct: 10,
  evidenceEventIds: ["evt-65-a", "evt-65-b", "evt-64-c"],
  evidenceRuleIds: [],
  similarCount: 3,
  ...patch,
});

const rejects = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};
const statusOf = async (w: World, id: string) => (await w.plant(A).getState()).proposals.find((p) => p.id === id)?.status;
const speed = async (w: World) => (await w.component(P100).getState()).metrics.speedPct;
const fresh = (to = 65) => ({ proposerComponentId: P100, metric: "speedPct", to, rationale: "adversarial test" });
const open = (w: World, to = 65) => w.plant(A).propose(fresh(to));

async function allYes(w: World, p: Proposal) {
  for (const v of p.requiredVoters) await w.plant(A).vote(yes(p.id, v));
}
async function toVetoWindow(w: World, to = 65) {
  const p = await open(w, to);
  await allYes(w, p);
  await w.advance(SWEEP);
  expect(await statusOf(w, p.id)).toBe("veto_window");
  return p;
}
async function toExecuted(w: World, to = 65) {
  const p = await toVetoWindow(w, to);
  await w.advance(VETO);
  expect(await statusOf(w, p.id)).toBe("executed");
  return p;
}

// A `to` the actors accepted must still never execute after every voter says yes.
async function neverExecutes(w: World, input: any) {
  let p: Proposal;
  try {
    p = await w.plant(A).propose(input);
  } catch {
    return;
  }
  for (const v of p.requiredVoters ?? []) await rejects(() => w.plant(A).vote(yes(p.id, v)));
  await w.advance(SWEEP);
  await w.advance(VETO);
  await w.advance(SWEEP);
  expect(await statusOf(w, p.id)).not.toBe("executed");
  expect(await speed(w)).toBe(50);
}

describe.skipIf(!makeWorld)(`actor attacks [${label}]`, () => {
  const world = () => makeWorld!();

  test("control: the honest path reaches veto_window and then executes, so these tests can fail", async () => {
    const w = await world();
    await toExecuted(w);
    await w.close?.();
  });

  describe("propose", () => {
    test("caller-supplied control fields are ignored", async () => {
      const w = await world();
      const forged = { id: "evil", status: "veto_window", requiredVoters: [], votes: [yes("evil", "plant-a/LV-101")], vetoDeadline: "2000-01-01T00:00:00.000Z", crossPlant: false };
      let p: Proposal | null = null;
      try {
        p = await w.plant(A).propose({ ...fresh(), ...forged });
      } catch {
        await w.close?.();
        return;
      }
      expect(p.status).toBe("voting");
      expect(p.votes).toEqual([]);
      expect(p.requiredVoters.length).toBe(5);
      expect(p.crossPlant).toBe(true);
      expect(p.vetoDeadline).toBeNull();
      await w.close?.();
    });

    const badTo: [string, unknown][] = [
      ["past critical", 96],
      ["absurd", 1000],
      ["negative", -5],
      ["under min", 19],
      ["over max", 91],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["-Infinity", -Infinity],
      ["string", "85"],
      ["null", null],
      ["missing", undefined],
      ["object", { valueOf: 85 }],
    ];
    for (const [name, to] of badTo) {
      test(`to ${name} never executes`, async () => {
        const w = await world();
        await neverExecutes(w, { ...fresh(), to });
        await w.close?.();
      });
    }

    for (const metric of ["__proto__", "constructor", "toString", "hasOwnProperty", "speedPct ", "SPEEDPCT", "nope", "feedM3h", ""]) {
      test(`metric ${JSON.stringify(metric)} is refused`, async () => {
        const w = await world();
        expect(await rejects(() => w.plant(A).propose({ ...fresh(), metric }))).toBe(true);
        await w.close?.();
      });
    }

    for (const proposer of ["plant-a/NOPE", "plant-b/P-100", "", "__proto__", "plant-a/P-100/../TK-101"]) {
      test(`proposer ${JSON.stringify(proposer)} is refused on plant-a`, async () => {
        const w = await world();
        expect(await rejects(() => w.plant(A).propose({ ...fresh(), proposerComponentId: proposer }))).toBe(true);
        await w.close?.();
      });
    }

    test("`from` comes from the live metric, so a big step cannot pose as a small one", async () => {
      const w = await world();
      let p: Proposal | null = null;
      try {
        p = await w.plant(A).propose({ ...fresh(85), from: 84 });
      } catch {
        await w.close?.();
        return;
      }
      expect(p.from).toBe(50);
      await w.close?.();
    });

    test("proposerAgentId cannot name another agent", async () => {
      const w = await world();
      let p: Proposal | null = null;
      try {
        p = await w.plant(A).propose({ ...fresh(), proposerAgentId: "agent:plant-a/TK-101" });
      } catch {
        await w.close?.();
        return;
      }
      expect(p.proposerAgentId).toBe("agent:plant-a/P-100");
      await w.close?.();
    });

    test("a counter cannot go past the target it is countering", async () => {
      const w = await world();
      const parent = await open(w, 80);
      await w.plant(A).vote(yes(parent.id, "plant-a/LV-101", { vote: "no", predicted: { positionPct: 92 } }));
      await w.advance(SWEEP);
      expect(await rejects(() => w.plant(A).propose({ ...fresh(88), parentProposalId: parent.id }))).toBe(true);
      await w.close?.();
    });

    test("an unseeded Company cannot silently drop the cross-plant voter", async () => {
      const w = await world();
      if (!w.company().loadSeed) return;
      await w.company().loadSeed!({ plants: [], sharedResources: [] });
      let p: Proposal | null = null;
      try {
        p = await open(w);
      } catch {
        await w.close?.();
        return;
      }
      expect(p.requiredVoters).toContain("plant-b/TV-101");
      await w.close?.();
    });

    test("one shared valve cannot sit in two plants' veto windows at once", async () => {
      const w = await world();
      const a = await open(w, 65);
      const b = await w.plant("plant-b").propose({ proposerComponentId: "plant-b/P-100", metric: "speedPct", to: 65, rationale: "adversarial test" });
      await allYes(w, a);
      for (const v of b.requiredVoters) await w.plant("plant-b").vote({ ...yes(b.id, v), evidenceEventIds: [], agentId: "agent:" + v });
      await w.advance(SWEEP);
      const open2 = [(await w.plant(A).getState()).proposals[0].status, (await w.plant("plant-b").getState()).proposals[0].status];
      expect(open2.filter((s) => s === "veto_window").length).toBeLessThanOrEqual(1);
      await w.close?.();
    });

    test("a counter can only hang off a real blocked parent", async () => {
      const w = await world();
      expect(await rejects(() => w.plant(A).propose({ ...fresh(), parentProposalId: "no-such-parent" }))).toBe(true);
      await w.close?.();
    });
  });

  describe("forged votes", () => {
    const outsiders = ["plant-a/P-100", "plant-b/LV-101", "plant-b/P-100", "plant-a/NOPE", "", "__proto__"];
    for (const componentId of outsiders) {
      test(`vote from non-required ${JSON.stringify(componentId)} is rejected and does not count`, async () => {
        const w = await world();
        const p = await open(w);
        expect(await rejects(() => w.plant(A).vote(yes(p.id, componentId)))).toBe(true);
        // Four real yes votes plus the rejected one must not read as five.
        for (const v of p.requiredVoters.slice(0, 4)) await w.plant(A).vote(yes(p.id, v));
        await w.advance(SWEEP);
        expect(await statusOf(w, p.id)).toBe("voting");
        await w.close?.();
      });
    }

    test("agentId for another component is rejected", async () => {
      const w = await world();
      const p = await open(w);
      expect(await rejects(() => w.plant(A).vote(yes(p.id, "plant-a/LV-101", { agentId: "agent:plant-a/TK-101" })))).toBe(true);
      await w.close?.();
    });

    test("vote for another proposal id is rejected", async () => {
      const w = await world();
      await open(w);
      expect(await rejects(() => w.plant(A).vote(yes("no-such-proposal", "plant-a/LV-101")))).toBe(true);
      await w.close?.();
    });

    test("no then yes from one component cannot flip it", async () => {
      const w = await world();
      const p = await open(w);
      await w.plant(A).vote(yes(p.id, "plant-a/LV-101", { vote: "no", predicted: { positionPct: 92 }, reason: "past threshold" }));
      expect(await rejects(() => w.plant(A).vote(yes(p.id, "plant-a/LV-101")))).toBe(true);
      await w.close?.();
    });

    test("once blocked, the remaining yes votes cannot unblock it", async () => {
      const w = await world();
      const p = await open(w);
      await w.plant(A).vote(yes(p.id, "plant-a/LV-101", { vote: "no", predicted: { positionPct: 92 }, reason: "past threshold" }));
      await w.advance(SWEEP);
      expect(await statusOf(w, p.id)).toBe("blocked");
      for (const v of p.requiredVoters) await rejects(() => w.plant(A).vote(yes(p.id, v)));
      await w.advance(SWEEP);
      await w.advance(VETO);
      expect(await statusOf(w, p.id)).toBe("blocked");
      expect(await speed(w)).toBe(50);
      await w.close?.();
    });

    test("a cross-plant yes gets the same checks as a local one", async () => {
      const w = await world();
      const p = await open(w);
      const bad = yes(p.id, "plant-b/TV-101", { predicted: { positionPct: 1000, steamKgH: 99999 } });
      const rejected = await rejects(() => w.plant(A).vote(bad));
      if (!rejected) {
        for (const v of p.requiredVoters) if (v !== "plant-b/TV-101") await w.plant(A).vote(yes(p.id, v));
        await w.advance(SWEEP);
        expect(await statusOf(w, p.id)).not.toBe("veto_window");
      }
      await w.close?.();
    });

    const malformed: [string, Partial<Vote> | Record<string, unknown>][] = [
      ["vote YES", { vote: "YES" }],
      ["vote true", { vote: true }],
      ["predicted NaN", { predicted: { positionPct: NaN } }],
      ["predicted Infinity", { predicted: { positionPct: Infinity } }],
      ["predicted -Infinity", { predicted: { positionPct: -Infinity } }],
      ["predicted string", { predicted: { positionPct: "66" } }],
      ["predicted empty on a yes", { predicted: {} }],
      ["predicted past threshold on a yes", { predicted: { positionPct: 95 } }],
      ["predicted negative", { predicted: { positionPct: -5 } }],
      ["similarCount NaN", { similarCount: NaN }],
      ["similarCount negative", { similarCount: -1 }],
      ["invented evidence", { evidenceEventIds: ["evt-invented"] }],
      ["invented rule", { evidenceRuleIds: ["rule-invented"] }],
      ["marginPct 0", { marginPct: 0 }],
      ["marginPct NaN", { marginPct: NaN }],
      ["evidence not an array", { evidenceEventIds: "evt-65-a" }],
      ["no reason", { reason: "" }],
    ];
    for (const [name, patch] of malformed) {
      test(`malformed yes at the actor: ${name}`, async () => {
        const w = await world();
        const p = await open(w);
        const rejected = await rejects(() => w.plant(A).vote(yes(p.id, "plant-a/LV-101", patch as Partial<Vote>)));
        if (!rejected) {
          // If it was taken, it must not have been counted as a yes that leads to execution.
          for (const v of p.requiredVoters) if (v !== "plant-a/LV-101") await w.plant(A).vote(yes(p.id, v));
          await w.advance(SWEEP);
          expect(await statusOf(w, p.id)).not.toBe("veto_window");
        }
        await w.close?.();
      });
    }
  });

  describe("late no", () => {
    test("a required voter's no in the veto window stops execution", async () => {
      const w = await world();
      const p = await toVetoWindow(w);
      const noVote = yes(p.id, "plant-a/LV-101", { vote: "no", predicted: { positionPct: 92 }, reason: "new evidence" });
      await rejects(() => w.plant(A).vote(noVote));
      await w.advance(VETO);
      await w.advance(SWEEP);
      expect(await statusOf(w, p.id)).not.toBe("executed");
      expect(await speed(w)).toBe(50);
      await w.close?.();
    });

    test("a no between the last yes and the sweep blocks", async () => {
      const w = await world();
      const p = await open(w);
      for (const v of p.requiredVoters.slice(0, 4)) await w.plant(A).vote(yes(p.id, v));
      await w.plant(A).vote(yes(p.id, p.requiredVoters[4], { vote: "no", predicted: PREDICTED[p.requiredVoters[4]], reason: "no" }));
      await w.advance(SWEEP);
      expect(await statusOf(w, p.id)).toBe("blocked");
      await w.close?.();
    });

    test("a no after unanimity but before the sweep still stops it", async () => {
      const w = await world();
      const p = await open(w);
      await allYes(w, p);
      await rejects(() => w.plant(A).vote(yes(p.id, "plant-a/LV-101", { vote: "no", predicted: { positionPct: 92 }, reason: "changed its mind" })));
      await w.advance(SWEEP);
      await w.advance(VETO);
      await w.advance(SWEEP);
      expect(await statusOf(w, p.id)).not.toBe("executed");
      await w.close?.();
    });

    test("a no from a non-required component in the veto window changes nothing", async () => {
      const w = await world();
      const p = await toVetoWindow(w);
      expect(await rejects(() => w.plant(A).vote(yes(p.id, "plant-b/LV-101", { vote: "no", reason: "forged" })))).toBe(true);
      expect(await statusOf(w, p.id)).toBe("veto_window");
      await w.close?.();
    });

    test("a no after execution is rejected and leaves the proposal executed", async () => {
      const w = await world();
      const p = await toExecuted(w);
      expect(await rejects(() => w.plant(A).vote(yes(p.id, "plant-a/LV-101", { vote: "no", reason: "late" })))).toBe(true);
      expect(await statusOf(w, p.id)).toBe("executed");
      await w.close?.();
    });
  });

  describe("execute", () => {
    test("direct execute while voting is refused", async () => {
      const w = await world();
      const p = await open(w);
      expect(await rejects(() => w.plant(A).execute(p.id))).toBe(true);
      expect(await statusOf(w, p.id)).toBe("voting");
      await w.close?.();
    });

    test("direct execute of a blocked proposal is refused", async () => {
      const w = await world();
      const p = await open(w);
      await w.plant(A).vote(yes(p.id, "plant-a/LV-101", { vote: "no", predicted: { positionPct: 92 } }));
      await w.advance(SWEEP);
      expect(await rejects(() => w.plant(A).execute(p.id))).toBe(true);
      expect(await statusOf(w, p.id)).toBe("blocked");
      await w.close?.();
    });

    test("direct execute cannot skip the 10-second veto window", async () => {
      const w = await world();
      const p = await toVetoWindow(w);
      expect(await rejects(() => w.plant(A).execute(p.id))).toBe(true);
      expect(await statusOf(w, p.id)).toBe("veto_window");
      await w.close?.();
    });

    test("execute after a veto is refused", async () => {
      const w = await world();
      const p = await toVetoWindow(w);
      await w.plant(A).veto(p.id, "operator");
      expect(await rejects(() => w.plant(A).execute(p.id))).toBe(true);
      await w.advance(VETO);
      expect(await statusOf(w, p.id)).toBe("vetoed");
      await w.close?.();
    });

    test("veto after execution is rejected and does not rewrite history", async () => {
      const w = await world();
      const p = await toExecuted(w);
      expect(await rejects(() => w.plant(A).veto(p.id, "operator"))).toBe(true);
      expect(await statusOf(w, p.id)).toBe("executed");
      await w.close?.();
    });

    test("a second execute does not issue a second dispatch", async () => {
      const w = await world();
      const p = await toExecuted(w);
      await rejects(() => w.plant(A).execute(p.id));
      const first = await w.plant(A).claimDispatch(p.id);
      const second = await w.plant(A).claimDispatch(p.id).catch(() => ({ dispatch: false }));
      expect(first.dispatch).toBe(true);
      expect(second.dispatch).toBe(false);
      await w.close?.();
    });

    test("the live metric moving during the veto window stops a stale proposal", async () => {
      const w = await world();
      const p = await toVetoWindow(w);
      await w.component(P100).mirror({ speedPct: 80, feedM3h: 24 });
      await w.advance(VETO);
      await w.advance(SWEEP);
      expect(await statusOf(w, p.id)).not.toBe("executed");
      await w.close?.();
    });

    test("a voter going critical during the veto window stops execution", async () => {
      const w = await world();
      const p = await toVetoWindow(w);
      await w.component("plant-a/TK-101").mirror({ levelPct: 90, tempC: 75 });
      await w.advance(VETO);
      await w.advance(SWEEP);
      expect(await statusOf(w, p.id)).not.toBe("executed");
      await w.close?.();
    });
  });

  describe("setMetric and the one-time token", () => {
    const NO_TOKENS: [string, unknown][] = [["none", undefined], ["empty", ""], ["guess", "token"], ["null", null], ["object", {}]];
    for (const [name, token] of NO_TOKENS) {
      test(`no valid token (${name}), on an executed proposal`, async () => {
        const w = await world();
        const p = await toExecuted(w);
        expect(await rejects(() => w.component(P100).setMetric("speedPct", 94, p.id, token))).toBe(true);
        expect(await speed(w)).toBe(50);
        await w.close?.();
      });
    }

    test("the proposal id is not a token", async () => {
      const w = await world();
      const p = await toExecuted(w);
      expect(await rejects(() => w.component(P100).setMetric("speedPct", 94, p.id, p.id))).toBe(true);
      expect(await speed(w)).toBe(50);
      await w.close?.();
    });

    test("no token exists for a proposal that was never approved", async () => {
      const w = await world();
      const p = await open(w);
      expect(await rejects(() => w.component(P100).setMetric("speedPct", 94, p.id, p.id))).toBe(true);
      expect(await w.tokenFor(p.id)).toBeUndefined();
      await w.close?.();
    });

    test("a valid token cannot be replayed", async () => {
      const w = await world();
      const p = await toExecuted(w);
      const token = await w.tokenFor(p.id);
      expect(token).toBeTruthy();
      await w.component(P100).setMetric("speedPct", p.to, p.id, token);
      expect(await speed(w)).toBe(p.to);
      expect(await rejects(() => w.component(P100).setMetric("speedPct", p.to, p.id, token))).toBe(true);
      expect(await rejects(() => w.component(P100).setMetric("speedPct", 94, p.id, token))).toBe(true);
      expect(await speed(w)).toBe(p.to);
      await w.close?.();
    });

    const misuse: [string, string, string, number][] = [
      ["another value", P100, "speedPct", 94],
      ["another metric", P100, "feedM3h", 65],
      ["another component", "plant-a/LV-101", "positionPct", 65],
      ["another plant", "plant-b/P-100", "speedPct", 65],
    ];
    for (const [name, componentId, metric, value] of misuse) {
      test(`a valid token is bound: ${name}`, async () => {
        const w = await world();
        const p = await toExecuted(w);
        const before = (await w.component(componentId).getState()).metrics[metric];
        const token = await w.tokenFor(p.id);
        expect(await rejects(() => w.component(componentId).setMetric(metric, value, p.id, token))).toBe(true);
        expect((await w.component(componentId).getState()).metrics[metric]).toBe(before);
        await w.close?.();
      });
    }

    test("a token from one proposal does not open another", async () => {
      const w = await world();
      const first = await toExecuted(w);
      const token = await w.tokenFor(first.id);
      const second = await open(w, 70);
      expect(await rejects(() => w.component(P100).setMetric("speedPct", 70, second.id, token))).toBe(true);
      await w.close?.();
    });

    test("nobody can claim dispatch for a proposal that was not accepted", async () => {
      const w = await world();
      const p = await toVetoWindow(w);
      const claim = await w.plant(A).claimDispatch(p.id).catch(() => ({ dispatch: false }));
      expect(claim.dispatch).toBe(false);
      await w.close?.();
    });

    test("the token never appears in anything a client can read", async () => {
      const w = await world();
      const p = await toExecuted(w);
      const token = await w.tokenFor(p.id);
      expect(token).toBeTruthy();
      const readable = JSON.stringify([await w.plant(A).getState(), await w.plant("plant-b").getState(), await w.component(P100).getState(), await w.company().getState()]);
      expect(readable.includes(token!)).toBe(false);
      await w.close?.();
    });

    test("the token is not derived from the proposal id and is long enough", async () => {
      const w = await world();
      const p = await toExecuted(w);
      const token = (await w.tokenFor(p.id))!;
      expect(token.includes(p.id)).toBe(false);
      expect(token.length).toBeGreaterThanOrEqual(22);
      await w.close?.();
    });

    test("getExecution does not hand the token to any caller", async () => {
      const w = await world();
      const p = await toExecuted(w);
      const token = (await w.tokenFor(p.id))!;
      const seen = JSON.stringify((await w.plant(A).getExecution(p.id).catch(() => null)) ?? null);
      expect(seen.includes(token)).toBe(false);
      await w.close?.();
    });
  });

  describe("margin and calibration", () => {
    for (const pct of [-50, 0, 4.9, 26, 1000, NaN, Infinity, -Infinity, "10", null, undefined]) {
      test(`setMargin(${String(pct)}) leaves marginPct in 5..25`, async () => {
        const w = await world();
        await rejects(() => w.component("plant-a/LV-101").setMargin(pct));
        const m = (await w.component("plant-a/LV-101").getState()).marginPct;
        expect(Number.isFinite(m)).toBe(true);
        expect(m).toBeGreaterThanOrEqual(5);
        expect(m).toBeLessThanOrEqual(25);
        await w.close?.();
      });
    }

    const entry = (patch: Record<string, unknown>) => ({ at: "2026-10-31T12:00:00.000Z", proposalId: "plant-a-p1", metric: "positionPct", predicted: 66, observed: 66, absError: 0, ...patch });

    test("forged negative absError cannot lower the margin", async () => {
      const w = await world();
      const c = w.component("plant-a/LV-101");
      for (let i = 0; i < 5; i++) await rejects(() => c.addCalibration(entry({ predicted: 90, observed: 10, absError: -1000 })));
      expect((await c.getState()).marginPct).toBeGreaterThanOrEqual(10);
      await w.close?.();
    });

    test("absError of 0 with a real 80-point miss cannot lower the margin", async () => {
      const w = await world();
      const c = w.component("plant-a/LV-101");
      for (let i = 0; i < 5; i++) await rejects(() => c.addCalibration(entry({ predicted: 90, observed: 10, absError: 0 })));
      expect((await c.getState()).marginPct).toBeGreaterThanOrEqual(10);
      await w.close?.();
    });

    test("one calibration entry replayed cannot walk the margin down", async () => {
      const w = await world();
      const c = w.component("plant-a/LV-101");
      for (let i = 0; i < 15; i++) await rejects(() => c.addCalibration(entry({ predicted: 66, observed: 66, absError: 0 })));
      expect((await c.getState()).marginPct).toBeGreaterThanOrEqual(10);
      await w.close?.();
    });

    for (const absError of [NaN, Infinity, "1", null]) {
      test(`absError ${String(absError)} cannot stop the margin from widening`, async () => {
        const w = await world();
        const c = w.component("plant-a/LV-101");
        // A real 80-point miss with a junk absError: the stored error must be the true one and the margin must widen.
        for (let i = 0; i < 5; i++) await rejects(() => c.addCalibration(entry({ proposalId: `plant-a-p${i}`, predicted: 90, observed: 10, absError })));
        const state = await c.getState();
        for (const e of state.calibration) expect(Number.isFinite(e.absError) && e.absError >= 0).toBe(true);
        expect(state.marginPct).toBeGreaterThanOrEqual(10);
        await w.close?.();
      });
    }

    test("calibration for a metric the component does not have cannot lower the margin", async () => {
      const w = await world();
      const c = w.component("plant-a/LV-101");
      for (let i = 0; i < 5; i++) await rejects(() => c.addCalibration(entry({ metric: "__proto__" })));
      expect((await c.getState()).marginPct).toBeGreaterThanOrEqual(10);
      await w.close?.();
    });
  });

  describe("mirror", () => {
    for (const [name, metrics] of [["NaN", { speedPct: NaN }], ["Infinity", { speedPct: Infinity }], ["string", { speedPct: "85" }], ["null", { speedPct: null }]] as const) {
      test(`mirror(${name}) leaves the metric finite`, async () => {
        const w = await world();
        await rejects(() => w.component(P100).mirror(metrics));
        expect(Number.isFinite(await speed(w))).toBe(true);
        await w.close?.();
      });
    }

    test("mirror with a __proto__ key does not pollute anything", async () => {
      const w = await world();
      await rejects(() => w.component(P100).mirror(JSON.parse('{"__proto__":{"polluted":1},"speedPct":50}')));
      expect(({} as any).polluted).toBeUndefined();
      await w.close?.();
    });
  });

  describe("memory poisoning", () => {
    const forgedEvent = (patch: Record<string, unknown> = {}) => ({ proposalId: "no-such-proposal", effects: [{ componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: 40, ticksToSettle: 1 }], ...patch });

    test("recordEvent for an unknown proposal is refused", async () => {
      const w = await world();
      const before = (await w.plant(A).getState()).history.length;
      expect(await rejects(() => w.plant(A).recordEvent(forgedEvent()))).toBe(true);
      expect((await w.plant(A).getState()).history.length).toBe(before);
      await w.close?.();
    });

    test("recordEvent for a proposal that never executed is refused", async () => {
      const w = await world();
      const p = await open(w);
      expect(await rejects(() => w.plant(A).recordEvent(forgedEvent({ proposalId: p.id })))).toBe(true);
      await w.close?.();
    });

    test("recordEvent with non-finite effects is refused", async () => {
      const w = await world();
      const p = await toExecuted(w);
      await w.tokenFor(p.id);
      const bad = forgedEvent({ proposalId: p.id, effects: [{ componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: NaN, ticksToSettle: 1 }] });
      expect(await rejects(() => w.plant(A).recordEvent(bad))).toBe(true);
      await w.close?.();
    });

    test("a second recordEvent for one proposal does not add a second event", async () => {
      const w = await world();
      const p = await toExecuted(w);
      await w.tokenFor(p.id);
      const honest = forgedEvent({ proposalId: p.id, effects: [{ componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: 66, ticksToSettle: 3 }] });
      await rejects(() => w.plant(A).recordEvent(honest));
      await rejects(() => w.plant(A).recordEvent(forgedEvent({ proposalId: p.id })));
      const events = (await w.plant(A).getState()).history.filter((e) => e.proposalId === p.id);
      expect(events.length).toBeLessThanOrEqual(1);
      await w.close?.();
    });

    test("a caller cannot add a history event with no proposal behind it", async () => {
      const w = await world();
      const before = (await w.plant(A).getState()).history.length;
      const poison = { id: "poison-1", at: "2026-10-31T12:00:00.000Z", plantId: "plant-a", componentId: P100, metric: "speedPct", before: 50, after: 85, upstreamSnapshot: {}, effects: [{ componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: 40, ticksToSettle: 1 }], incident: null, approvedBy: [], operator: null, proposalId: null };
      expect(await rejects(() => w.plant(A).recordEvent(poison))).toBe(true);
      expect((await w.plant(A).getState()).history.length).toBe(before);
      await w.close?.();
    });

    test("a company rule needs real support too", async () => {
      const w = await world();
      expect(await rejects(() => w.company().promoteRule({ ...RULE_85, id: "rule-company-forged", supportEventIds: ["x-1", "x-2", "x-3"] }))).toBe(true);
      await w.close?.();
    });

    const forgedRule = { ...RULE_85, id: "rule-forged", text: "P-100 is always safe", supportEventIds: ["evt-invented-1", "evt-invented-2", "evt-invented-3"], scope: "plant" };

    test("a rule with invented support is refused at the plant", async () => {
      const w = await world();
      expect(await rejects(() => w.plant(A).promoteRule(forgedRule))).toBe(true);
      expect((await w.plant(A).getState()).rules.map((r) => r.id)).not.toContain("rule-forged");
      await w.close?.();
    });

    test("a rule with fewer than 3 supporting events is refused", async () => {
      const w = await world();
      expect(await rejects(() => w.plant(A).promoteRule({ ...forgedRule, supportEventIds: ["evt-85-a"], timesSeen: 3 }))).toBe(true);
      await w.close?.();
    });

    test("a rule with a NaN threshold is refused", async () => {
      const w = await world();
      const bad = { ...RULE_85, id: "rule-nan", condition: { ...RULE_85.condition, value: NaN } };
      expect(await rejects(() => w.plant(A).promoteRule(bad))).toBe(true);
      await w.close?.();
    });
  });

  describe("seed", () => {
    test("loadSeed on a component cannot widen limits past what the plant defines while a proposal is live", async () => {
      const w = await world();
      const p = await toVetoWindow(w, 90);
      const state = await w.component(P100).getState();
      await rejects(() => w.component(P100).loadSeed({ ...state, limits: { speedPct: { min: 0, max: 1000, critical: 1000 } }, marginPct: 0 }));
      const after = await w.component(P100).getState();
      expect(after.limits.speedPct.critical).toBeLessThanOrEqual(95);
      expect(after.marginPct).toBeGreaterThanOrEqual(5);
      void p;
      await w.close?.();
    });

    test("a plant reseed clears pending work, so nothing approved before it can run after it", async () => {
      const w = await world();
      const p = await toVetoWindow(w);
      const seed = await w.plant(A).getState();
      await rejects(() => w.plant(A).loadSeed({ id: seed.id, name: seed.name, components: [] }, []));
      await w.advance(VETO);
      await w.advance(SWEEP);
      const status = await statusOf(w, p.id);
      expect(status === "executed" && (await speed(w)) !== 50).toBe(false);
      await w.close?.();
    });
  });
});

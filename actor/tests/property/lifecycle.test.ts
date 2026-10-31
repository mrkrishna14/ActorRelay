import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  check,
  clone,
  iso,
  makeProposal,
  makeVote,
  T0,
  type LifecycleState,
  type Outcome,
  type Proposal,
} from "./harness";
import { engine, isReal } from "./target";

const VOTERS = ["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101", "plant-b/TV-101"];
const PROPOSERS: [string, string][] = [
  ["plant-a/P-100", "speedPct"],
  ["plant-a/LV-101", "positionPct"],
  ["plant-a/TV-101", "positionPct"],
];

const LEGAL: Record<Proposal["status"], Proposal["status"][]> = {
  voting: ["voting", "blocked", "veto_window", "expired"],
  // veto_window -> blocked is a voter withdrawing; -> expired is a refusal at dispatch.
  veto_window: ["veto_window", "vetoed", "executed", "blocked", "expired"],
  blocked: ["blocked"],
  vetoed: ["vetoed"],
  executed: ["executed"],
  expired: ["expired"],
};
const TERMINAL: Proposal["status"][] = ["blocked", "vetoed", "executed", "expired"];

type Op =
  | { kind: "vote"; p: number; voter: number; vote: "yes" | "no" }
  | { kind: "allYes"; p: number }
  | { kind: "veto"; p: number }
  | { kind: "execute"; p: number }
  | { kind: "sweep" }
  | { kind: "advance"; ms: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("vote" as const), p: fc.nat(3), voter: fc.nat(4), vote: fc.constantFrom<"yes" | "no">("yes", "yes", "yes", "no") }) },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("allYes" as const), p: fc.nat(3) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("veto" as const), p: fc.nat(3) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("execute" as const), p: fc.nat(3) }) },
  { weight: 5, arbitrary: fc.constant({ kind: "sweep" as const }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("advance" as const), ms: fc.constantFrom(1, 1000, 2000, 5000, 9999, 10000, 15000, 29999, 30000) }) },
);

const seedArb = fc
  .array(
    fc.record({
      proposer: fc.constantFrom(...PROPOSERS),
      voters: fc.integer({ min: 1, max: 5 }),
      offset: fc.nat(4),
      delay: fc.constantFrom(0, 1000, 8000),
    }),
    { minLength: 1, maxLength: 4 },
  )
  .map((rows) =>
    rows.map((r, i) => {
      const [proposer, metric] = r.proposer;
      // Rotated slices, so some pairs of proposals touch nothing in common.
      const pool = [...VOTERS.slice(r.offset), ...VOTERS.slice(0, r.offset)].filter((v) => v !== proposer);
      return makeProposal(`p${i}`, T0 + r.delay, proposer, pool.slice(0, r.voters), { metric });
    }),
  );

const allYes = (p: Proposal) =>
  p.requiredVoters.every((id) => p.votes.some((v) => v.componentId === id && v.vote === "yes"));
const anyNo = (p: Proposal) => p.votes.some((v) => v.vote === "no");
const missing = (p: Proposal) => p.requiredVoters.some((id) => !p.votes.some((v) => v.componentId === id));
const touched = (p: Proposal) => new Set([p.proposerComponentId, ...p.requiredVoters]);
const overlaps = (a: Proposal, b: Proposal) => [...touched(a)].some((c) => touched(b).has(c));

// `from` compared with the plant's setpoint; the reference keeps no setpoints.
function stale(state: LifecycleState, p: Proposal): boolean {
  if (!engine.traits.staleExpires || !state.setpoints) return false;
  const current = state.setpoints[p.proposerComponentId]?.[p.metric];
  return current === undefined || Math.abs(current - p.from) > 0.01;
}

function openWindowsOverlap(state: LifecycleState): string | null {
  const open = state.proposals.filter((p) => p.status === "veto_window");
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      if (overlaps(open[i]!, open[j]!)) return `${open[i]!.id} and ${open[j]!.id}`;
    }
  }
  return null;
}

function dispatchFailed(state: LifecycleState, id: string): boolean {
  return engine.traits.failedDispatchExpires && state.executions?.[id]?.state === "failed";
}

// Walks one schedule, checking every invariant after each operation.
async function walk(proposals: Proposal[], ops: Op[], tailMs = 0) {
  let state: LifecycleState = { proposals: clone(proposals) };
  let now = T0 + 9000; // All seeded proposals exist before the first operation.

  const apply = (label: string, next: LifecycleState, afterSweep: boolean) => {
    const heldBefore = state.proposals.filter((p) => p.status === "veto_window");
    for (const before of state.proposals) {
      const after = next.proposals.find((p) => p.id === before.id);
      if (!after) throw new Error(`${label}: ${before.id} vanished`);
      const failedDispatch = before.status === "executed" && after.status === "expired" && dispatchFailed(next, after.id);
      if (!failedDispatch && !LEGAL[before.status].includes(after.status)) {
        throw new Error(`${label}: illegal ${before.id} ${before.status} -> ${after.status}`);
      }
      if (TERMINAL.includes(before.status) && !failedDispatch) {
        const lateVotes = before.status === "blocked" && engine.traits.blockedRecordsLateVotes;
        if (lateVotes) expect({ ...after, votes: [] }).toEqual({ ...before, votes: [] });
        else expect(after).toEqual(before);
      }
      if (after.status === "expired" && before.status === "voting" && !missing(after) && !stale(state, after)) {
        throw new Error(`${label}: ${after.id} expired with no vote missing`);
      }
      if (after.status === "expired" && before.status === "veto_window" && !stale(state, after)) {
        throw new Error(`${label}: ${after.id} left the window expired while fresh`);
      }
      if (after.status === "blocked" && before.status === "veto_window" && !anyNo(after)) {
        throw new Error(`${label}: ${after.id} blocked in its window with no no`);
      }
      if (after.status === "executed" && before.status === "veto_window") {
        const deadline = Date.parse(before.vetoDeadline!);
        if (now < deadline) throw new Error(`${label}: ${after.id} executed ${deadline - now}ms early`);
      }
      if (after.status === "veto_window" && before.status === "voting") {
        if (!allYes(after)) throw new Error(`${label}: ${after.id} opened veto without unanimous yes`);
        if (after.vetoDeadline !== iso(now + 10_000)) {
          throw new Error(`${label}: ${after.id} deadline ${after.vetoDeadline}, want now+10s`);
        }
      }
      if (after.status === "vetoed" && before.status === "veto_window" && !engine.traits.lateVetoWins) {
        const deadline = Date.parse(before.vetoDeadline!);
        if (now >= deadline) throw new Error(`${label}: ${after.id} vetoed after deadline`);
      }
      for (const v of before.votes) {
        const kept = after.votes.find((x) => x.componentId === v.componentId);
        const withdrawn = before.status === "veto_window" && v.vote === "yes" && kept?.vote === "no";
        if (!withdrawn) expect(kept).toEqual(v);
      }
    }
    const overlap = openWindowsOverlap(next);
    if (overlap) throw new Error(`${label}: two veto windows: ${overlap}`);
    state = next;
    if (!afterSweep) return;
    for (const p of state.proposals) {
      if (p.status === "voting" && anyNo(p)) {
        throw new Error(`${label}: ${p.id} still voting with a no`);
      }
      if (p.status === "voting" && missing(p) && now - Date.parse(p.at) >= 30_000) {
        throw new Error(`${label}: ${p.id} still voting ${now - Date.parse(p.at)}ms in with votes missing`);
      }
      if (p.status === "voting" && allYes(p)) {
        // A window that closed during this sweep frees the waiter on the next one.
        const blocker = [...state.proposals, ...heldBefore].some(
          (o) => o.id !== p.id && o.status === "veto_window" && overlaps(o, p),
        );
        if (!blocker) throw new Error(`${label}: ${p.id} unanimous and unblocked but still voting`);
      }
      if (p.status === "veto_window" && now >= Date.parse(p.vetoDeadline!)) {
        throw new Error(`${label}: ${p.id} veto window survived its deadline`);
      }
    }
  };

  const applyOutcome = (label: string, outcome: Outcome<LifecycleState>) => {
    if (outcome.accepted) apply(label, outcome.state, false);
  };

  for (const op of ops) {
    const proposal = state.proposals[op.kind === "sweep" || op.kind === "advance" ? 0 : op.p % state.proposals.length]!;
    switch (op.kind) {
      case "vote": {
        const voter = VOTERS[op.voter]!;
        applyOutcome(`vote ${proposal.id} ${voter} ${op.vote}`, await engine.vote(state, makeVote(proposal.id, voter, op.vote), now));
        break;
      }
      case "allYes": {
        for (const voter of proposal.requiredVoters) {
          applyOutcome(`vote ${proposal.id} ${voter} yes`, await engine.vote(state, makeVote(proposal.id, voter, "yes"), now));
        }
        break;
      }
      case "veto":
        applyOutcome(`veto ${proposal.id}`, await engine.veto(state, proposal.id, "operator", now));
        break;
      case "execute":
        applyOutcome(`execute ${proposal.id}`, await engine.execute(state, proposal.id, now));
        break;
      case "sweep":
        apply(`sweep at +${now - T0}`, await engine.sweep(state, now), true);
        break;
      case "advance":
        now += op.ms;
        break;
    }
  }
  if (tailMs) {
    now += tailMs;
    apply("final sweep", await engine.sweep(state, now), true);
    now += tailMs;
    apply("final sweep", await engine.sweep(state, now), true);
  }
  return { state, now };
}

async function allVoted(state: LifecycleState, p: Proposal, nowMs: number) {
  let next = state;
  for (const voter of p.requiredVoters) {
    const out = await engine.vote(next, makeVote(p.id, voter, "yes"), nowMs);
    if (!out.accepted) throw new Error(out.reason);
    next = out.state;
  }
  return next;
}

const unanimous = (p: Proposal, nowMs = T0) => allVoted({ proposals: [p] }, p, nowMs);

const basic = (id = "p0", proposer = "plant-a/P-100", at = T0) =>
  makeProposal(id, at, proposer, VOTERS.filter((v) => v !== proposer));

describe(`lifecycle [${engine.name}]`, () => {
  test("random schedules keep every invariant at every step", async () => {
    await check(
      fc.asyncProperty(seedArb, fc.array(opArb, { maxLength: 40 }), async (proposals, ops) => {
        await walk(proposals, ops, 45_000);
      }),
    );
  });

  test("every proposal ends terminal once time runs out", async () => {
    await check(
      fc.asyncProperty(seedArb, fc.array(opArb, { maxLength: 25 }), async (proposals, ops) => {
        let { state, now } = await walk(proposals, ops);
        // Sweep to the end; a waiter takes its turn after the holder finishes.
        for (let i = 0; i < proposals.length * 2 + 2; i++) {
          now += 31_000;
          state = await engine.sweep(state, now);
        }
        for (const p of state.proposals) {
          expect(TERMINAL).toContain(p.status);
        }
      }),
      2000,
    );
  });

  test("any no blocks on the next sweep, whichever votes are in", async () => {
    await check(
      fc.asyncProperty(fc.nat(4), fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }), fc.constantFrom(0, 1, 29_999), async (no, others, dt) => {
        let state: LifecycleState = { proposals: [basic()] };
        const p = state.proposals[0]!;
        const order = p.requiredVoters.map((voter, i) => ({ voter, i })).sort((a, b) => Number(others[a.i]) - Number(others[b.i]));
        for (const { voter, i } of order) {
          if (i !== no && !others[i]) continue;
          const out = await engine.vote(state, makeVote(p.id, voter, i === no ? "no" : "yes"), T0);
          if (out.accepted) state = out.state;
        }
        expect((await engine.sweep(state, T0 + dt)).proposals[0]!.status).toBe("blocked");
      }),
    );
  });

  test("a no beats expiry when both apply", async () => {
    const out = await engine.vote({ proposals: [basic()] }, makeVote("p0", VOTERS[0]!, "no"), T0 + 1000);
    if (!out.accepted) throw new Error(out.reason);
    expect((await engine.sweep(out.state, T0 + 31_000)).proposals[0]!.status).toBe("blocked");
  });

  test("unanimous yes opens the veto window with deadline now + 10s, and only then", async () => {
    await check(
      fc.asyncProperty(fc.integer({ min: 0, max: 29_999 }), fc.integer({ min: 0, max: 4 }), async (dt, missingCount) => {
        const p = basic();
        const voters = p.requiredVoters.slice(missingCount);
        let state: LifecycleState = { proposals: [p] };
        for (const voter of voters) {
          const out = await engine.vote(state, makeVote(p.id, voter, "yes"), T0);
          if (out.accepted) state = out.state;
        }
        const swept = (await engine.sweep(state, T0 + dt)).proposals[0]!;
        if (missingCount === 0) {
          expect(swept.status).toBe("veto_window");
          expect(swept.vetoDeadline).toBe(iso(T0 + dt + 10_000));
        } else {
          expect(swept.status).toBe("voting");
          expect(swept.vetoDeadline).toBeNull();
        }
      }),
    );
  });

  test("a sweep arriving late still opens veto when no vote is missing", async () => {
    const state = await unanimous(basic(), T0 + 29_000);
    expect((await engine.sweep(state, T0 + 31_000)).proposals[0]!.status).toBe("veto_window");
  });

  test("missing votes expire at 30s, not before", async () => {
    await check(
      fc.asyncProperty(fc.integer({ min: 0, max: 60_000 }), fc.integer({ min: 0, max: 4 }), async (dt, voted) => {
        const p = basic();
        let state: LifecycleState = { proposals: [p] };
        for (const voter of p.requiredVoters.slice(0, voted)) {
          const out = await engine.vote(state, makeVote(p.id, voter, "yes"), T0);
          if (out.accepted) state = out.state;
        }
        const status = (await engine.sweep(state, T0 + dt)).proposals[0]!.status;
        expect(status).toBe(dt >= 30_000 ? "expired" : "voting");
      }),
    );
  });

  test("a vote arriving after 30s cannot resurrect the proposal", async () => {
    const p = basic();
    let state: LifecycleState = { proposals: [p] };
    for (const voter of p.requiredVoters.slice(0, 4)) {
      const out = await engine.vote(state, makeVote(p.id, voter, "yes"), T0);
      if (out.accepted) state = out.state;
    }
    const late = await engine.vote(state, makeVote(p.id, p.requiredVoters[4]!, "yes"), T0 + 30_001);
    const final = (await engine.sweep(late.accepted ? late.state : state, T0 + 30_002)).proposals[0]!;
    expect(final.status).toBe("expired");
  });

  test("only one of many proposals on a component holds the veto window, any order", async () => {
    await check(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        fc.array(fc.nat(100), { minLength: 6, maxLength: 6 }),
        async (n, ranks) => {
          const proposals = Array.from({ length: n }, (_, i) => basic(`p${i}`));
          let state: LifecycleState = { proposals };
          const order = proposals.map((_, i) => i).sort((a, b) => ranks[a]! - ranks[b]!);
          for (const i of order) {
            state = await allVoted(state, state.proposals[i]!, T0 + 1000);
            state = await engine.sweep(state, T0 + 1000);
            expect(state.proposals.filter((x) => x.status === "veto_window").length).toBe(1);
          }
        },
      ),
      1000,
    );
  });

  test("a waiter takes its turn after a veto", async () => {
    let state: LifecycleState = { proposals: [basic("p0"), basic("p1")] };
    state = await allVoted(state, state.proposals[0]!, T0);
    state = await allVoted(state, state.proposals[1]!, T0);
    state = await engine.sweep(state, T0 + 2000);
    expect(state.proposals.map((p) => p.status)).toEqual(["veto_window", "voting"]);
    const out = await engine.veto(state, "p0", "operator", T0 + 3000);
    if (!out.accepted) throw new Error(out.reason);
    state = await engine.sweep(out.state, T0 + 4000);
    expect(state.proposals.map((p) => p.status)).toEqual(["vetoed", "veto_window"]);
  });

  test("a waiter on the same metric never executes on a stale from", async () => {
    let state: LifecycleState = { proposals: [basic("p0"), basic("p1")] };
    state = await allVoted(state, state.proposals[0]!, T0);
    state = await allVoted(state, state.proposals[1]!, T0);
    state = await engine.sweep(state, T0 + 2000);
    state = await engine.sweep(state, T0 + 13_000);
    expect(state.proposals[0]!.status).toBe("executed");
    state = await engine.sweep(state, T0 + 15_000);
    if (engine.traits.staleExpires) expect(state.proposals[1]!.status).toBe("expired");
    else expect(state.proposals[1]!.status).toBe("veto_window");
  });

  test("execute never fires before the deadline, never twice", async () => {
    await check(
      fc.asyncProperty(fc.integer({ min: 0, max: 20_000 }), async (dt) => {
        const opened = await engine.sweep(await unanimous(basic()), T0);
        const deadline = Date.parse(opened.proposals[0]!.vetoDeadline!);
        const out = await engine.execute(opened, "p0", T0 + dt);
        expect(out.accepted).toBe(T0 + dt >= deadline);
        if (out.accepted) {
          expect(out.state.proposals[0]!.status).toBe("executed");
          expect((await engine.execute(out.state, "p0", T0 + dt + 1)).accepted).toBe(false);
        }
      }),
      2000,
    );
  });

  test("veto lands only while the window is open and nothing has executed", async () => {
    await check(
      fc.asyncProperty(fc.integer({ min: 0, max: 20_000 }), async (dt) => {
        const opened = await engine.sweep(await unanimous(basic()), T0);
        const out = await engine.veto(opened, "p0", "operator", T0 + dt);
        expect(out.accepted).toBe(engine.traits.lateVetoWins || dt < 10_000);
        if (out.accepted) expect(out.state.proposals[0]!.status).toBe("vetoed");
        expect((await engine.veto({ proposals: [basic()] }, "p0", "operator", T0 + dt)).accepted).toBe(false);
      }),
      2000,
    );
  });

  test("a vetoed proposal can never execute afterwards", async () => {
    const opened = await engine.sweep(await unanimous(basic()), T0);
    const out = await engine.veto(opened, "p0", "operator", T0 + 1000);
    if (!out.accepted) throw new Error(out.reason);
    expect((await engine.execute(out.state, "p0", T0 + 60_000)).accepted).toBe(false);
    const swept = await engine.sweep(out.state, T0 + 60_000);
    expect(swept.proposals[0]!.status).toBe("vetoed");
  });

  test.skipIf(!isReal)("an executed proposal stays executed when its dispatch never lands", async () => {
    let state = await engine.sweep(await unanimous(basic()), T0);
    state = await engine.sweep(state, T0 + 10_000);
    expect(state.proposals[0]!.status).toBe("executed");
    for (const dt of [14_000, 18_000, 22_000, 26_000, 40_000]) {
      state = await engine.sweep(state, T0 + dt);
    }
    expect(state.proposals[0]!.status).toBe("executed");
  });

  test.skipIf(!isReal)("two plants never hold veto windows touching one component", async () => {
    const localA = VOTERS.filter((v) => v.startsWith("plant-a/"));
    const localB = localA.map((v) => v.replace("plant-a/", "plant-b/"));
    const a = makeProposal("a0", T0, "plant-a/P-100", [...localA, "plant-b/TV-101"]);
    const b = makeProposal("b0", T0, "plant-b/P-100", [...localB, "plant-a/TV-101"]);
    const openA = await engine.sweep(await unanimous(a), T0 + 1000);
    const openB = await engine.sweep(await unanimous(b), T0 + 1000);
    const open = [...openA.proposals, ...openB.proposals].filter((p) => p.status === "veto_window");
    expect(open.length).toBe(2);
    expect(overlaps(open[0]!, open[1]!)).toBe(false);
  });

  test("terminal proposals refuse votes, vetoes and executes", async () => {
    await check(
      fc.asyncProperty(
        fc.constantFrom<Proposal["status"]>("blocked", "vetoed", "executed", "expired"),
        fc.constantFrom(...VOTERS),
        fc.constantFrom<"yes" | "no">("yes", "no"),
        fc.integer({ min: 0, max: 100_000 }),
        async (status, voter, vote, dt) => {
          const p = { ...basic(), status, vetoDeadline: iso(T0) };
          const state = { proposals: [p] };
          const now = T0 + dt;
          const voted = await engine.vote(state, makeVote("p0", voter, vote), now);
          if (status === "blocked" && engine.traits.blockedRecordsLateVotes) {
            if (voted.accepted) expect(voted.state.proposals[0]!.status).toBe("blocked");
          } else {
            expect(voted.accepted).toBe(false);
          }
          expect((await engine.veto(state, "p0", "operator", now)).accepted).toBe(false);
          expect((await engine.execute(state, "p0", now)).accepted).toBe(false);
          expect((await engine.sweep(state, now)).proposals[0]).toEqual(p);
        },
      ),
    );
  });

  test("unknown proposal ids are refused", async () => {
    const state = { proposals: [basic()] };
    expect((await engine.vote(state, makeVote("nope", VOTERS[0]!), T0)).accepted).toBe(false);
    expect((await engine.veto(state, "nope", "operator", T0)).accepted).toBe(false);
    expect((await engine.execute(state, "nope", T0)).accepted).toBe(false);
  });
});

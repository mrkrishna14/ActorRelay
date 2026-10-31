// Attacks on the real actors with no agents running. The votes here are forged by this test on purpose, so
// nothing in this file is evidence of agent reasoning. Direct actor calls carry only the actors layer in
// the table; anything that goes through the fake glue or fake plant is labelled with those layers too.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { step, type Ctx } from "./scenario.ts";
import { loadHistory } from "./fixture-history.ts";
import type { Layer } from "./report.ts";
import type { HistoryEvent, LearnedRule, PlantId, Proposal, Vote } from "../../../shared/types.ts";

const A: PlantId = "plant-a";
const B: PlantId = "plant-b";
const PUMP = `${A}/P-100`;
const LV = `${A}/LV-101`;
const ACTORS: Layer[] = ["actors"];
const THROUGH_FAKES: Layer[] = ["actors", "glue", "plant"];
const VOTERS = [`${A}/TK-101`, LV, `${A}/E-101`, `${A}/TV-101`, `${B}/TV-101`];
const repoRoot = join(import.meta.dir, "..", "..", "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const SAFE_PREDICTED: Record<string, Record<string, number>> = {
  "TK-101": { levelPct: 50, tempC: 74 },
  "LV-101": { positionPct: 66 },
  "E-101": { dutyKw: 1160 },
  "TV-101": { positionPct: 56, steamKgH: 1980, headerBarg: 5.8 },
};

export async function runAttacks(ctx: Ctx) {
  const { actors } = ctx;
  const seed = JSON.parse(readFileSync(join(repoRoot, "shared", "plants.json"), "utf8"));
  const { history } = loadHistory(repoRoot);
  const a = actors.plant(A);
  const b = actors.plant(B);
  const pump = actors.component(PUMP);

  async function post(path: string, body: unknown) {
    const res = await fetch(ctx.glueUrl + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text };
  }
  const writes = async (proposalId?: string) => {
    const all = (await (await fetch(`${ctx.plantUrl}/__fake/writes`)).json()) as { proposalId: string; value: number }[];
    return proposalId ? all.filter((w) => w.proposalId === proposalId) : all;
  };
  const glueLog = async () => (await (await fetch(`${ctx.glueUrl}/__fake/log`)).json()) as { route: string; status: number; body?: any; error?: string }[];
  const rejected = async (label: string, fn: () => Promise<unknown>, code?: RegExp): Promise<string> => {
    let result: unknown;
    try {
      result = await fn();
    } catch (e) {
      const msg = String(e);
      assert(!code || code.test(msg), `${label}: rejected with the wrong code: ${msg.slice(0, 160)}`);
      return msg;
    }
    throw new Error(`${label}: accepted, returned ${JSON.stringify(result)?.slice(0, 160)}`);
  };
  // Plant-a only, because the expiry run below is live on plant-b the whole time.
  const seedA = seed.plants.find((p: { id: string }) => p.id === A);
  const resetA = async () => {
    await Promise.all(seedA.components.map((c: never) => actors.component((c as { id: string }).id).loadSeed(c)));
    await a.loadSeed(seedA, history.filter((e) => e.plantId === A));
    await fetch(`${ctx.plantUrl}/reset`, { method: "POST" });
  };
  const propose = (to: number, extra: Record<string, unknown> = {}) =>
    a.propose({ proposerComponentId: PUMP, metric: "speedPct", to, rationale: "attack test", from: 50, ...extra });
  const statusOf = async (id: string, plant = a) => (await plant.getState()).proposals.find((p) => p.id === id)?.status;
  const proposalOf = async (id: string) => (await a.getState()).proposals.find((p) => p.id === id)!;
  const evidenceFor = async (to: number) => (await a.similar(PUMP, "speedPct", to, {}, 5)).map((e: HistoryEvent) => e.id);
  const forge = (p: Proposal, componentId: string, evidence: string[], over: Partial<Vote> = {}): Vote => ({
    proposalId: p.id, componentId, agentId: `agent:${componentId}`, vote: "yes", reason: "forged by the attack suite",
    predicted: SAFE_PREDICTED[componentId.split("/")[1]!]!, marginPct: 10, evidenceEventIds: evidence, evidenceRuleIds: [], similarCount: evidence.length, ...over,
  });
  const voteAll = async (p: Proposal, skip: string[] = []) => {
    const ev = await evidenceFor(p.to);
    for (const c of VOTERS) if (!skip.includes(c)) await a.vote(forge(p, c, ev));
  };
  // Real actors answer slower than the shim, so waits stretch by E2E_SLOW. No assertion changes with it.
  const slow = Number(process.env.E2E_SLOW ?? 1);
  const until = async (label: string, read: () => Promise<boolean>, ms: number) => {
    const end = Date.now() + ms * slow;
    while (Date.now() < end) {
      if (await read()) return;
      await sleep(100 * slow);
    }
    throw new Error(`timed out after ${ms * slow} ms: ${label}`);
  };
  const noWrite = async (id: string) => assert((await writes(id)).length === 0, `simulator write for ${id}`);

  await post("/reset", {});

  // Runs alongside everything else, on plant-b, because the 30 s expiry cannot be sped up from outside.
  const expiry = (async () => {
    const started = Date.now();
    const p = await b.propose({ proposerComponentId: `${B}/P-100`, metric: "speedPct", to: 60, rationale: "attack test: nobody votes", from: 50 });
    await until("expired", async () => (await statusOf(p.id, b)) === "expired", 36_000);
    const after = Date.now() - started;
    assert(after >= 28_000, `expired after only ${after} ms`);
    const late = await rejected("late vote", () => b.vote(forge(p, `${B}/LV-101`, [])));
    assert((await b.getState()).proposals.find((x) => x.id === p.id)!.votes.length === 0, "late vote landed");
    await noWrite(p.id);
    return `expired after ${after} ms; late vote: ${late.slice(0, 80)}`;
  })();

  await step(ctx, "A1", "propose ignores caller-set id, status, voters, votes, deadline", { layers: ACTORS }, async () => {
    const p = await propose(65, {
      id: "attacker-id", status: "veto_window", requiredVoters: [], votes: [{ componentId: LV, vote: "yes" }],
      vetoDeadline: new Date(0).toISOString(), crossPlant: false, at: new Date(0).toISOString(),
    });
    assert(p.id !== "attacker-id", "caller chose the id");
    assert(p.status === "voting", `status ${p.status}`);
    assert(p.votes.length === 0, "caller injected votes");
    assert(p.vetoDeadline === null, "caller set a deadline");
    assert(p.crossPlant === true && [...p.requiredVoters].sort().join() === [...VOTERS].sort().join(), `voters ${p.requiredVoters}`);
    await sleep(2500);
    assert((await statusOf(p.id)) === "voting", "moved without votes");
    return `server-assigned ${p.id}, ${p.requiredVoters.length} voters, still voting after a sweep`;
  });

  await step(ctx, "A2", "propose rejects bad targets, proposers and metrics", { layers: ACTORS }, async () => {
    await resetA();
    const cases: [string, Record<string, unknown>][] = [
      ["to null (NaN on the wire)", { to: null }],
      ["to string", { to: "85" }],
      ["to above physical range", { to: 200 }],
      ["to at or past critical", { to: 95 }],
      ["to negative", { to: -5 }],
      ["foreign proposer", { proposerComponentId: `${B}/P-100` }],
      ["unknown proposer", { proposerComponentId: `${A}/XX-999` }],
      ["__proto__ metric", { metric: "__proto__" }],
      ["constructor metric", { metric: "constructor" }],
      ["info-only metric", { metric: "feedM3h" }],
    ];
    const accepted: string[] = [];
    for (const [label, over] of cases) {
      try {
        await a.propose({ proposerComponentId: PUMP, metric: "speedPct", to: 65, rationale: "attack", from: 50, ...over });
        accepted.push(label);
      } catch {
        // rejected, which is the point
      }
    }
    assert(accepted.length === 0, `accepted: ${accepted.join("; ")}`);
    assert((await a.getState()).proposals.length === 0, "a rejected proposal stayed in state");
    return `${cases.length} bad proposals rejected, none in state`;
  });

  await step(ctx, "A3", "Invalid votes rejected at the actor", { layers: ACTORS }, async () => {
    await resetA();
    const p = await propose(65);
    const ev = await evidenceFor(65);
    const cases: [string, Vote][] = [
      ["unknown proposal", forge({ ...p, id: `${A}-p-unknown` }, LV, ev)],
      ["proposer votes for itself", forge(p, PUMP, ev, { predicted: { speedPct: 65 } })],
      ["not a required voter", forge(p, `${B}/LV-101`, ev)],
      ["spoofed agent id", forge(p, LV, ev, { agentId: `agent:${A}/E-101` })],
      ["vote word", forge(p, LV, ev, { vote: "maybe" as never })],
      ["vote boolean", forge(p, LV, ev, { vote: true as never })],
      ["vote uppercase", forge(p, LV, ev, { vote: "YES" as never })],
      ["empty predicted", forge(p, LV, ev, { predicted: {} })],
      ["null prediction (NaN on the wire)", forge(p, LV, ev, { predicted: { positionPct: null as never } })],
      ["invented evidence id", forge(p, LV, ["never-seen-event"])],
      ["negative similarCount", forge(p, LV, ev, { similarCount: -1 })],
      ["yes past the threshold", forge(p, LV, ev, { predicted: { positionPct: 89 } })],
      ["component id with another plant's voter", forge(p, `${B}/TK-101`, ev)],
    ];
    const accepted: string[] = [];
    for (const [label, v] of cases) {
      try {
        await a.vote(v);
        accepted.push(label);
      } catch {
        // rejected, which is the point
      }
    }
    const left = (await proposalOf(p.id)).votes.length;
    assert(accepted.length === 0, `accepted (${left} votes landed): ${accepted.join("; ")}`);
    assert(left === 0, `${left} invalid votes landed`);
    return `${cases.length} invalid votes rejected, 0 landed`;
  });

  await step(ctx, "A4", "Duplicate vote rejected, cannot flip", { layers: ACTORS }, async () => {
    await resetA();
    const p = await propose(65);
    const ev = await evidenceFor(65);
    await a.vote(forge(p, LV, ev));
    const same = await rejected("same vote twice", () => a.vote(forge(p, LV, ev)), /duplicate/);
    await rejected("flip yes to no", () => a.vote(forge(p, LV, ev, { vote: "no", predicted: { positionPct: 89 } })), /duplicate/);
    const after = await proposalOf(p.id);
    assert(after.votes.length === 1 && after.votes[0]!.vote === "yes", "duplicate changed the vote");
    return same.slice(0, 80);
  });

  await step(ctx, "A5", "Unanimous means every voter: 4 of 5 yes stays in voting", { layers: ACTORS }, async () => {
    await resetA();
    const p = await propose(65);
    await voteAll(p, [`${B}/TV-101`]);
    await sleep(2500);
    const s = await statusOf(p.id);
    assert(s === "voting", `status ${s} with 4 of 5 votes`);
    return "still voting after a sweep with the cross-plant vote missing";
  });

  await step(ctx, "A6", "No blocks, blocked is terminal, stale votes and execute refused", { layers: ACTORS }, async () => {
    await resetA();
    const p = await propose(85);
    const ev = await evidenceFor(85);
    await a.vote(forge(p, LV, ev, { vote: "no", predicted: { positionPct: 89 } }));
    await until("blocked", async () => (await statusOf(p.id)) === "blocked", 5000);
    // A late vote may be recorded so the dashboard shows it, but nothing may revive the proposal.
    for (const c of VOTERS.filter((x) => x !== LV)) await a.vote(forge(p, c, ev)).catch(() => undefined);
    await rejected("no changes its mind", () => a.vote(forge(p, LV, ev)), /duplicate/);
    await rejected("execute on blocked", () => a.execute(p.id));
    await rejected("veto on blocked", () => a.veto(p.id, "attacker"));
    await sleep(2500);
    assert((await statusOf(p.id)) === "blocked", "blocked proposal moved");
    await noWrite(p.id);
    return "blocked stayed blocked after yes votes from every other voter";
  });

  await step(ctx, "A7", "Unapproved writes rejected: execute early, setMetric without a token", { layers: ACTORS }, async () => {
    await resetA();
    const p = await propose(65);
    await rejected("execute while voting", () => a.execute(p.id));
    await rejected("setMetric no token", () => pump.setMetric("speedPct", 95, p.id));
    await rejected("setMetric forged token", () => pump.setMetric("speedPct", 95, p.id, "forged"), /token/);
    await rejected("setMetric token equal to proposal id", () => pump.setMetric("speedPct", 95, p.id, p.id), /token/);
    await rejected("setMetric unknown proposal", () => pump.setMetric("speedPct", 95, `${A}-p-unknown`, "forged"));
    await voteAll(p);
    await until("veto window", async () => (await statusOf(p.id)) === "veto_window", 5000);
    await rejected("execute inside the veto window", () => a.execute(p.id));
    await rejected("setMetric inside the veto window", () => pump.setMetric("speedPct", 65, p.id, "forged"), /token/);
    assert((await statusOf(p.id)) === "veto_window", "veto window was skipped");
    const speed = (await pump.getState()).metrics.speedPct;
    assert(speed === 50, `P-100 moved to ${speed}`);
    await noWrite(p.id);
    await a.veto(p.id, "attack suite cleanup");
    return "execute and setMetric refused before and during the veto window, P-100 unchanged";
  });

  await step(ctx, "A8", "Veto inside the window stops the write", { layers: THROUGH_FAKES }, async () => {
    await resetA();
    const p = await propose(65);
    await voteAll(p);
    await until("veto window", async () => (await statusOf(p.id)) === "veto_window", 5000);
    const vetoed = await a.veto(p.id, "operator");
    assert(vetoed.status === "vetoed", `status ${vetoed.status}`);
    await rejected("second veto", () => a.veto(p.id, "operator"));
    await sleep(13_000);
    assert((await statusOf(p.id)) === "vetoed", "vetoed proposal moved");
    await noWrite(p.id);
    assert((await a.getState()).audit.some((e) => e.kind === "veto" && e.refId === p.id), "no veto audit entry");
    return "vetoed in the window, nothing written 13 s later";
  });

  await step(ctx, "A9", "Execution retries never duplicate a simulation command", { strict: false, layers: THROUGH_FAKES }, async () => {
    await resetA();
    const p = await propose(65);
    await voteAll(p);
    await until("executed", async () => (await statusOf(p.id)) === "executed", 16_000);
    await until("write", async () => (await writes(p.id)).length >= 1, 8000);
    const { token } = (await (await fetch(`${ctx.glueUrl}/__fake/token?proposalId=${encodeURIComponent(p.id)}`)).json()) as { token: string | null };
    assert(token, "the actor issued no token");
    assert(!JSON.stringify(await a.getState()).includes(token), "the token leaks through Plant.getState");
    assert(!JSON.stringify(await pump.getState()).includes(token), "the token leaks through Component.getState");
    for (let i = 0; i < 3; i++) await post("/execute-callback", { proposalId: p.id });
    const replay = await rejected("exact token replay", () => pump.setMetric("speedPct", 65, p.id, token), /token_already_used/);
    await rejected("token on another value", () => pump.setMetric("speedPct", 90, p.id, token), /token/);
    const claim = await a.claimDispatch(p.id);
    assert(claim?.dispatch === false, `second claim returned ${JSON.stringify(claim)}`);
    await sleep(6000);
    const w = await writes(p.id);
    assert(w.length === 1, `${w.length} simulator writes for one proposal after replays and the actor's own retries`);
    const calls = (await glueLog()).filter((l) => l.route === "/execute-callback" && l.body?.proposalId === p.id).length;
    return `1 write from ${calls} callbacks, including 3 forced replays; replay said ${replay.slice(0, 60)}; token absent from state`;
  });

  await step(ctx, "A10", "Observed replay and poison rejected, one HistoryEvent", { layers: THROUGH_FAKES }, async () => {
    const p = (await a.getState()).proposals.find((x) => x.status === "executed");
    assert(p, "no executed proposal from A9");
    await until("event", async () => (await a.getState()).history.some((e) => e.proposalId === p.id), 12_000);
    const sent = (await (await fetch(`${ctx.plantUrl}/__fake/observed`)).json()) as { proposalId: string; effects: unknown[] }[];
    const obs = sent.find((o) => o.proposalId === p.id)!;
    for (let i = 0; i < 3; i++) await post("/observed", { proposalId: p.id, effects: obs.effects });
    const state = await a.getState();
    const events = state.history.filter((e) => e.proposalId === p.id);
    assert(events.length === 1, `${events.length} events after replay`);
    await rejected("event for unknown proposal", () => a.recordEvent({ proposalId: `${A}-p-unknown`, effects: [] }));
    const open = await propose(66, { from: 65 });
    await rejected("event for a proposal that never ran", () => a.recordEvent({ proposalId: open.id, effects: [] }));
    assert(!(await a.getState()).history.some((e) => e.proposalId === open.id), "unexecuted proposal entered history");
    return `one event ${events[0]!.id} after 3 replays; forged events rejected`;
  });

  await step(ctx, "A11", "Two proposals on one component: only one veto window, the other cannot go stale-execute", { layers: THROUGH_FAKES }, async () => {
    await resetA();
    const p1 = await propose(65);
    const p2 = await propose(60);
    await voteAll(p1);
    await voteAll(p2);
    await until("first in veto window", async () => {
      const s = await a.getState();
      return s.proposals.some((p) => p.status === "veto_window");
    }, 6000);
    await sleep(2500);
    const windows = (await a.getState()).proposals.filter((p) => p.status === "veto_window");
    assert(windows.length === 1, `${windows.length} proposals in the veto window at once`);
    await until("one executed", async () => (await a.getState()).proposals.some((p) => p.status === "executed"), 16_000);
    await sleep(14_000);
    const finalState = await a.getState();
    const executed = finalState.proposals.filter((p) => p.status === "executed");
    assert(executed.length === 1, `${executed.length} executed; statuses ${finalState.proposals.map((p) => p.status)}`);
    const all = await writes();
    const mine = all.filter((w) => w.proposalId === p1.id || w.proposalId === p2.id);
    assert(mine.length === 1, `${mine.length} writes: the second proposal's from went stale but it ran anyway`);
    const other = finalState.proposals.find((p) => p.status !== "executed")!;
    return `one executed; the other ended ${other.status}, one write`;
  });

  await step(ctx, "A12", "Stale from: live value moved during the window, execute refuses", { layers: THROUGH_FAKES }, async () => {
    await resetA();
    const p = await propose(65);
    await voteAll(p);
    await until("veto window", async () => (await statusOf(p.id)) === "veto_window", 5000);
    await fetch(`${ctx.plantUrl}/setpoint`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ componentId: PUMP, metric: "speedPct", value: 75, proposalId: "out-of-band-operator" }),
    });
    await sleep(14_000);
    const s = await proposalOf(p.id);
    await noWrite(p.id);
    assert(s.status !== "executed", "executed against a stale from");
    return `from 50 but live 75: ended ${s.status}, no write`;
  });

  await step(ctx, "A13", "Forged rules rejected through Plant, the only route to the company library", { layers: ACTORS }, async () => {
    await resetA();
    const now = new Date().toISOString();
    const forged: LearnedRule = {
      id: "rule-forged", scope: "plant", model: "outlet-valve-A", text: "P-100 speedPct >= 40 -> LV-101 positionPct >= 85",
      condition: { componentId: PUMP, metric: "speedPct", op: ">=", value: 40 },
      consequence: { componentId: LV, metric: "positionPct", op: ">=", value: 85, withinTicks: 3 },
      supportEventIds: ["never-seen-1", "never-seen-2", "never-seen-3"], timesSeen: 99, createdAt: now, lastSeenAt: now,
    };
    await rejected("invented support ids", () => a.promoteRule(forged));
    const safeRuns = (await a.getState()).history.filter((e) => e.after >= 60 && e.after <= 70).slice(0, 3).map((e) => e.id);
    assert(safeRuns.length === 3, "fixture has no safe runs");
    await rejected("real ids from safe runs that do not show the claim", () => a.promoteRule({ ...forged, id: "rule-forged-2", supportEventIds: safeRuns }));
    const [plant, company] = await Promise.all([a.getState(), actors.company().getState()]);
    assert(!plant.rules.some((r) => r.id.startsWith("rule-forged")), "forged rule entered the plant");
    assert(!company.rules.some((r) => r.supportEventIds.includes("never-seen-1") || r.supportEventIds.includes(safeRuns[0]!)), "forged rule reached the company library");
    return "invented ids and real ids that contradict the claim both rejected";
  });

  await step(ctx, "A14", "Calibration: forged absError ignored, five large errors raise margin to 15", { layers: ACTORS }, async () => {
    await resetA();
    const lv = actors.component(LV);
    const entry = (i: number, over = {}) => ({ at: new Date().toISOString(), proposalId: `${A}-p-cal-${i}`, metric: "positionPct", predicted: 50, observed: 62, absError: 12, ...over });
    await lv.addCalibration(entry(0, { absError: -1000 })).catch(() => undefined);
    await rejected("NaN observed", () => lv.addCalibration(entry(1, { observed: null })));
    for (let i = 2; i < 7; i++) await lv.addCalibration(entry(i));
    const s = await lv.getState();
    assert(s.marginPct === 15, `marginPct ${s.marginPct}`);
    assert(s.calibration.every((c) => c.absError === Math.abs(c.predicted - c.observed)), "stored absError does not match predicted and observed");
    await lv.setMargin(1000);
    const clamped = (await lv.getState()).marginPct;
    assert(clamped === 25, `setMargin(1000) left ${clamped}`);
    await rejected("setMargin null", () => lv.setMargin(null as never));
    return "margin 10 -> 15 after five 12-point errors; forged absError recomputed; margin stays in 5..25";
  });

  await step(ctx, "A16", "Reset clears pending work: no write after a reset inside the veto window", { layers: THROUGH_FAKES }, async () => {
    await resetA();
    const p = await propose(65);
    await voteAll(p);
    await until("veto window", async () => (await statusOf(p.id)) === "veto_window", 5000);
    await resetA();
    assert((await a.getState()).proposals.length === 0, "reset left the proposal in state");
    await sleep(13_000);
    await noWrite(p.id);
    await rejected("vote on a wiped proposal", () => a.vote(forge(p, LV, [])));
    return "pending change gone after reset, nothing written 13 s later";
  });

  await step(ctx, "A17", "Observation landing after a reset does not enter history", { layers: THROUGH_FAKES }, async () => {
    await resetA();
    const p = await propose(65);
    await voteAll(p);
    await until("write", async () => (await writes(p.id)).length >= 1, 16_000);
    await resetA();
    await sleep(6500);
    assert(!(await a.getState()).history.some((e) => e.proposalId === p.id), "a pre-reset observation entered the fresh history");
    return "late /observed for a wiped proposal left history alone";
  });

  await step(ctx, "A15", "Missing votes expire near 30 s, late votes rejected", { layers: ACTORS }, () => expiry);

  // Red team round 1 findings, kept as rows so each fix is re-checked by running it.
  await step(ctx, "A18", "Calibration for proposals that never ran cannot walk a margin down", { layers: ACTORS }, async () => {
    await resetA();
    const lv = actors.component(LV);
    for (let i = 0; i < 5; i++) {
      await lv.addCalibration({ at: new Date().toISOString(), proposalId: `${A}-p-forged-${i}`, metric: "positionPct", predicted: 50, observed: 50, absError: 0 }).catch(() => undefined);
    }
    const margin = (await lv.getState()).marginPct;
    assert(margin === 10, `margin moved to ${margin} on five entries for proposals that never ran`);
    return "margin stayed 10 after five forged perfect entries";
  });

  await step(ctx, "A19", "A fabricated run with no proposal cannot enter history", { layers: ACTORS }, async () => {
    await resetA();
    const forged = {
      id: "forged-run", at: new Date().toISOString(), plantId: A, componentId: PUMP, metric: "speedPct", before: 50, after: 85, upstreamSnapshot: {},
      effects: [{ componentId: LV, metric: "positionPct", before: 50, after: 60, ticksToSettle: 1 }], incident: null, approvedBy: [], operator: null, proposalId: null,
    };
    await a.recordEvent(forged).catch(() => undefined);
    assert(!(await a.getState()).history.some((e) => e.id === "forged-run"), "a run that never happened entered history");
    return "fabricated run rejected";
  });

  await step(ctx, "A20", "A vote cannot lower its own safety margin to pass", { layers: ACTORS }, async () => {
    await resetA();
    const p = await propose(85);
    const ev = await evidenceFor(85);
    await rejected("yes at 84 claiming margin 5 while the component holds 10", () => a.vote(forge(p, LV, ev, { predicted: { positionPct: 84 }, marginPct: 5 })));
    assert((await proposalOf(p.id)).votes.length === 0, "the vote landed");
    return "self-reported margin did not pass 84 against the real threshold of 81";
  });

  await step(ctx, "A21", "Two plants cannot hold veto windows on the shared TV-101s at once", { layers: ACTORS }, async () => {
    await resetA();
    await Promise.all(seed.plants.find((p: { id: string }) => p.id === B).components.map((c: never) => actors.component((c as { id: string }).id).loadSeed(c)));
    await b.loadSeed(seed.plants.find((p: { id: string }) => p.id === B), history.filter((e) => e.plantId === B));
    const pa = await propose(65);
    const pb = await b.propose({ proposerComponentId: `${B}/P-100`, metric: "speedPct", to: 60, rationale: "attack test: second plant", from: 50 });
    await voteAll(pa);
    const evB = (await b.similar(`${B}/P-100`, "speedPct", 60, {}, 5)).map((e: HistoryEvent) => e.id);
    for (const c of pb.requiredVoters) await b.vote(forge(pb, c, evB));
    await until("first window", async () => (await statusOf(pa.id)) === "veto_window" || (await statusOf(pb.id, b)) === "veto_window", 6000);
    await sleep(2500);
    const [sa, sb] = [await statusOf(pa.id), await statusOf(pb.id, b)];
    await a.veto(pa.id, "attack suite cleanup").catch(() => undefined);
    await b.veto(pb.id, "attack suite cleanup").catch(() => undefined);
    assert(!(sa === "veto_window" && sb === "veto_window"), "both plants are in veto_window with plant-a/TV-101 and plant-b/TV-101 on both voter lists");
    return `plant-a ${sa}, plant-b ${sb}`;
  });

  await post("/reset", {});
  void seed;
}

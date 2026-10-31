// Patches a copy of actor/src with one bug at a time and runs the suites that drive the real
// actor classes against it through PROP_SRC. Those suites have no reference to run on, so a mutant
// counts as caught only when a test that passes on the real code fails on the copy. Tests that
// are already red are open findings and prove nothing here. A survivor is a gap in the suites.
//
//   bun run mutants-real.ts [name-filter]
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Mutant = { name: string; file: string; from: string; to: string; also?: [string, string] };

const MUTANTS: Mutant[] = [
  {
    name: "claim-not-exclusive",
    file: "actor.ts",
    from: `if (execution.state !== "accepted") return { dispatch: false, proposalId, state: execution.state }`,
    to: ``,
  },
  { name: "measured-ignored", file: "actor.ts", from: `if (measured !== undefined) {`, to: `if (false) {` },
  {
    name: "measured-loose-tolerance",
    file: "actor.ts",
    from: `Math.abs(measured - proposal.from) > SETPOINT_TOLERANCE`,
    to: `Math.abs(measured - proposal.from) > 1`,
  },
  {
    name: "measured-nan-passes",
    file: "actor.ts",
    from: `!isFiniteNumber(measured) || Math.abs(measured - proposal.from) > SETPOINT_TOLERANCE`,
    to: `Math.abs(measured - proposal.from) > SETPOINT_TOLERANCE`,
  },
  {
    name: "token-not-bound-to-write",
    file: "actor.ts",
    from: `if (execution.componentId !== r.componentId || execution.metric !== r.metric || execution.value !== r.value) fail("invalid_token", "token is bound to another write")`,
    to: ``,
  },
  {
    name: "token-stored-raw",
    file: "actor.ts",
    from: `[proposalId]: hashToken(token) }`,
    to: `[proposalId]: token }`,
  },
  {
    name: "observe-without-dispatch",
    file: "actor.ts",
    from: `if (execution.state !== "claimed" && execution.state !== "applied" && execution.state !== "unknown") fail("not_dispatched", \`\${proposalId} is \${execution.state}\`)`,
    to: ``,
  },
  {
    name: "fail-after-applied",
    file: "actor.ts",
    from: `if (execution.state === "applied" || execution.state === "observed") fail("already_applied", proposalId)`,
    to: ``,
  },
  {
    name: "failure-keeps-setpoint",
    file: "actor.ts",
    from: `this.setpoints = this.#withSetpoint(proposal, settled ?? proposal.from)`,
    to: ``,
  },
  {
    name: "sweep-awaits-company",
    file: "actor.ts",
    from: `        await this.#followExecutions(now)
        this.#requestLeases(plan.needLease)`,
    to: `        await this.#followExecutions(now)
        await Company.get(COMPANY_ACTOR_ID).getState()
        this.#requestLeases(plan.needLease)`,
  },
  {
    name: "pushes-overlap",
    file: "actor.ts",
    from: `if (this.companySyncing || (this.registeredWithCompany && this.companyOutbox.length === 0)) return`,
    to: `if (this.registeredWithCompany && this.companyOutbox.length === 0) return`,
  },
  {
    name: "ack-ignores-new-sightings",
    file: "actor.ts",
    from: `this.companyOutbox.filter(rule => sent.get(rule.id) !== rule.timesSeen)`,
    to: `this.companyOutbox.filter(rule => !sent.has(rule.id))`,
  },
  {
    name: "failed-delivery-acked",
    file: "actor.ts",
    from: `await company.promoteRule(toCompanyRule(rule, plantId))`,
    to: `await company.promoteRule(toCompanyRule(rule, plantId)).catch(() => undefined)`,
  },
  {
    name: "model-check-dropped",
    file: "actor.ts",
    from: `if (rule.model === null || !(await company.modelExistsElsewhere(plantId, rule.model))) continue`,
    to: `if (rule.model === null) continue`,
  },
  {
    name: "company-calls-up",
    file: "actor.ts",
    from: `        assertRuleShape(r)
        const at = nowIso()
        const { rules, rule } = mergeCompanyRule(`,
    to: `        assertRuleShape(r)
        await Plant.get("plant-b").getState()
        const at = nowIso()
        const { rules, rule } = mergeCompanyRule(`,
  },
  {
    name: "propose-fails-open",
    file: "actor.ts",
    from: `const remote = await withTimeout(company.requiredCrossPlantVoters(draft), "Company.requiredCrossPlantVoters")`,
    to: `const remote = await withTimeout(company.requiredCrossPlantVoters(draft), "Company.requiredCrossPlantVoters").catch(() => [])`,
  },
  {
    name: "veto-any-status",
    file: "actor.ts",
    from: `if (proposal.status !== "veto_window") fail("veto_closed", \`\${proposalId} is \${proposal.status}\`)`,
    to: ``,
  },
  {
    name: "alarm-rearms-overdue",
    file: "actor.ts",
    from: `if (alarm.get() === null) alarm.set(Date.now() + TICK_MS)`,
    to: `{ const scheduled = alarm.get(); if (scheduled === null || scheduled <= Date.now()) alarm.set(Date.now() + TICK_MS) }`,
  },
  {
    name: "alarm-lost-stays-lost",
    file: "actor.ts",
    from: `if (alarm.get() === null) alarm.set(Date.now() + TICK_MS)`,
    to: ``,
  },
  {
    name: "duplicate-tick-runs",
    file: "actor.ts",
    from: `if (now - this.lastTickAt < TICK_MS / 2) return`,
    to: ``,
  },
  {
    name: "tick-dedupe-too-wide",
    file: "actor.ts",
    from: `if (now - this.lastTickAt < TICK_MS / 2) return`,
    to: `if (now - this.lastTickAt < TICK_MS * 2) return`,
  },
  {
    name: "alarm-armed-after-tick",
    file: "actor.ts",
    from: `        this.alarm.set(now + TICK_MS)
`,
    to: ``,
    also: [
      `            await this.tick()
        } catch`,
      `            await this.tick()
            this.alarm.set(now + TICK_MS)
        } catch`,
    ],
  },
  {
    name: "measured-does-not-heal",
    file: "actor.ts",
    from: `const settled = isFiniteNumber(measured) ? measured : undefined`,
    to: `const settled = undefined`,
  },
  {
    name: "unknown-reverts-setpoint",
    file: "actor.ts",
    from: `this.executions = { ...this.executions, [execution.proposalId]: { ...execution, state: "unknown", failure: "dispatch never confirmed" } }`,
    to: `this.executions = { ...this.executions, [execution.proposalId]: { ...execution, state: "unknown", failure: "dispatch never confirmed" } }
                    this.setpoints = { ...this.setpoints, [execution.componentId]: { ...this.setpoints[execution.componentId], [execution.metric]: 0 } }`,
  },
  {
    name: "unknown-cannot-settle",
    file: "actor.ts",
    from: `if (execution.state !== "claimed" && execution.state !== "unknown") fail("invalid_token", \`execution is \${execution.state}\`)`,
    to: `if (execution.state !== "claimed") fail("invalid_token", \`execution is \${execution.state}\`)`,
  },
  {
    name: "lease-not-required",
    file: "logic/proposals.ts",
    from: `const leaseMissing = leases !== undefined && proposal.crossPlant && !leases.includes(proposal.id)`,
    to: `const leaseMissing = false`,
  },
  {
    name: "lease-not-exclusive",
    file: "actor.ts",
    from: `if (heldElsewhere) return false`,
    to: ``,
  },
  {
    name: "lease-never-expires",
    file: "actor.ts",
    from: `return lease !== undefined && lease.proposalId !== proposalId && lease.expiresAt > now`,
    to: `return lease !== undefined && lease.proposalId !== proposalId`,
  },
  {
    name: "lease-never-released",
    file: "actor.ts",
    from: `for (const proposalId of done) void Company.get(COMPANY_ACTOR_ID).releaseLease(proposalId).catch(() => undefined)`,
    to: ``,
  },
  {
    name: "late-grant-kept",
    file: "actor.ts",
    from: `else if (!open) void Company.get(COMPANY_ACTOR_ID).releaseLease(proposalId).catch(() => undefined)`,
    to: ``,
  },
  {
    name: "waiter-never-expires",
    file: "logic/proposals.ts",
    from: `if (now - Date.parse(proposal.at) >= WAITING_TIMEOUT_MS) {`,
    to: `if (false) {`,
  },
  {
    name: "lapsed-window-executes",
    file: "logic/proposals.ts",
    from: `if (now - Date.parse(proposal.vetoDeadline) > VETO_LAPSE_MS) {`,
    to: `if (false) {`,
  },
  {
    name: "calibration-unbound",
    file: "actor.ts",
    from: `        assertMatchesRun(entry, facts)
`,
    to: ``,
    also: [
      `        assertMatchesRun(entry, this.runFacts)
`,
      ``,
    ],
  },
  {
    name: "calibration-any-voter",
    file: "actor.ts",
    from: `if (vote === undefined) fail("invalid_calibration", \`\${componentId} did not vote on \${entry.proposalId}\`)`,
    to: `if (vote === undefined) return { proposalId: entry.proposalId, predicted: { [entry.metric]: entry.predicted }, observed: {} }`,
  },
  {
    name: "calibration-replayable",
    file: "actor.ts",
    from: `if (this.calibration.some(item => item.proposalId === entry.proposalId && item.metric === entry.metric)) {`,
    to: `if (false) {`,
  },
  {
    name: "calibration-before-observed",
    file: "actor.ts",
    from: `if (proposal.status !== "executed" || event === undefined) fail("invalid_calibration", \`\${entry.proposalId} has no observed run\`)`,
    to: ``,
  },
  {
    name: "margin-not-reported",
    file: "actor.ts",
    from: `        this.marginPct = clampMargin(pct)
        this.#reportMargin()`,
    to: `        this.marginPct = clampMargin(pct)`,
  },
  {
    name: "vote-trusts-claimed-margin",
    file: "logic/proposals.ts",
    from: `const marginPct = Math.max(vote.marginPct, context?.marginPct ?? 0)`,
    to: `const marginPct = vote.marginPct`,
  },
  {
    name: "vote-trusts-similar-count",
    file: "logic/proposals.ts",
    from: `if (proposerLimit !== undefined && similarCount < MIN_SIMILAR && proposal.to >= proposerLimit.critical * 0.85) {`,
    to: `if (proposerLimit !== undefined && vote.similarCount < MIN_SIMILAR && proposal.to >= proposerLimit.critical * 0.85) {`,
  },
  {
    name: "rule-does-not-bind",
    file: "logic/proposals.ts",
    from: `if (binding !== undefined) return refused(\`learned rule \${binding.id} applies: \${binding.text}\`)`,
    to: ``,
  },
  {
    name: "no-waits-for-sweep",
    file: "actor.ts",
    from: `const refused = vote.vote === "no" && proposal.status === "voting"`,
    to: `const refused = false`,
  },
  {
    name: "duplicate-vote-allowed",
    file: "logic/proposals.ts",
    from: `if (existing !== undefined) fail("duplicate_vote", \`\${vote.componentId} already voted on \${proposal.id}\`)`,
    to: ``,
  },
];

const here = import.meta.dir;
const copy = join(here, ".mutants");
// PROP_SRC selects the code under test, so a run can target a committed snapshot.
const source = join(here, process.env.PROP_SRC ?? "../../src");
const SUITES = ["./outbox.test.ts", "./dispatch.test.ts", "./mailbox.test.ts", "./lease.test.ts", "./binding.test.ts", "./lifecycle.test.ts"];

function failing(env: Record<string, string> = {}) {
  const run = Bun.spawnSync([process.execPath, "test", "--timeout", "120000", ...SUITES], {
    cwd: here,
    env: { ...process.env, PROP_WORLD_RUNS: process.env.PROP_WORLD_RUNS ?? "60", PROP_RUNS: process.env.PROP_RUNS ?? "300", PROP_SKIP_SLOW: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = run.stdout.toString() + run.stderr.toString();
  const names = output
    .split("\n")
    .filter((line) => line.startsWith("(fail)"))
    .map((line) => line.replace(/\r$/, "").replace(/ \[[\d.]+ms\]$/, ""));
  return { names: new Set(names), ran: /Ran \d+ tests/.test(output) };
}

const filter = process.argv[2];
const baseline = failing();
if (!baseline.ran) throw new Error("the suites did not run on the real code");
console.log(`baseline: ${baseline.names.size} tests already red, ignored below`);

let survived = 0;
let skipped = 0;
const selected = MUTANTS.filter((m) => !filter || m.name.includes(filter));
for (const mutant of selected) {
  rmSync(copy, { recursive: true, force: true });
  cpSync(source, join(copy, "src"), { recursive: true });
  const path = join(copy, "src", mutant.file);
  const code = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  if (!code.includes(mutant.from)) {
    // The code moved: report it rather than count a mutant that never ran.
    console.log(`STALE    ${mutant.name}`);
    skipped += 1;
    continue;
  }
  if (mutant.also && !code.includes(mutant.also[0])) {
    console.log(`STALE    ${mutant.name}`);
    skipped += 1;
    continue;
  }
  let patched = code.replace(mutant.from, () => mutant.to);
  if (mutant.also) patched = patched.replace(mutant.also[0], () => mutant.also![1]);
  writeFileSync(path, patched);
  const result = failing({ PROP_SRC: "./.mutants/src" });
  const caught = [...result.names].filter((name) => !baseline.names.has(name));
  if (!result.ran) console.log(`caught   ${mutant.name} (the suites could not load it)`);
  else if (caught.length) console.log(`caught   ${mutant.name} by ${caught[0]!.replace(/^\(fail\) /, "")}`);
  else {
    console.log(`SURVIVED ${mutant.name}`);
    survived += 1;
  }
}
if (existsSync(copy)) rmSync(copy, { recursive: true, force: true });
console.log(`mutants run ${selected.length}: ${selected.length - survived - skipped} caught, ${survived} survived, ${skipped} stale`);
process.exit(survived === 0 ? 0 : 1);

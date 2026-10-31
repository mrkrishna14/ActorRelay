// The whole demo, headless, against whatever is running: real glue over HTTP, and through it the actors, the agents, Relay
// and the simulator. It asserts ranges from the state those services report, never canned text, and prints a pass/fail table.
//   GLUE_URL=http://127.0.0.1:7200 BRIDGE_URL=http://127.0.0.1:7300 bun run e2e.ts
// This is a destructive run: it starts with POST /reset. E2E_REPORT writes the table to a file as well.
import { writeFileSync } from "node:fs";
import type { CalibrationEntry, CompanyState, ComponentState, HistoryEvent, LearnedRule, PlantId, PlantState, Proposal, Vote } from "../shared/types";

const GLUE = (process.env.GLUE_URL ?? "http://127.0.0.1:7200").replace(/\/+$/, "");
const BRIDGE = (process.env.BRIDGE_URL ?? "http://127.0.0.1:7300").replace(/\/+$/, "");
const REPORT = process.env.E2E_REPORT;

type Verdict = "PASS" | "FAIL" | "GAP";
type Row = { step: string; check: string; verdict: Verdict; detail: string };
type StateBody = { mode: string; plant: PlantState; components: (ComponentState & { calibration: CalibrationEntry[] })[]; company: CompanyState; seed: { historySource: string; standIn: boolean; label: string | null; events: number }; services: Record<string, boolean> };

const rows: Row[] = [];
const started = new Date().toISOString();
const record = (step: string, check: string, pass: boolean, detail: string) => {
  rows.push({ step, check, verdict: pass ? "PASS" : "FAIL", detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${step} ${check}: ${detail}`);
  return pass;
};
const gap = (step: string, check: string, detail: string) => {
  rows.push({ step, check, verdict: "GAP", detail });
  console.log(`GAP  ${step} ${check}: ${detail}`);
};

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(GLUE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

const state = (plantId: PlantId, full = false) => request<StateBody>(`/state?plantId=${plantId}${full ? "&full=1" : ""}`);
const component = (id: string) => request<ComponentState & { calibration: CalibrationEntry[] }>(`/component/${encodeURIComponent(id)}`);
const propose = (plantId: PlantId, to: number) =>
  request<{ proposal: Proposal }>("/propose", { plantId, proposerComponentId: `${plantId}/P-100`, metric: "speedPct", to, rationale: "Operator asks for more throughput." }).then((reply) => reply.proposal);

/** Polls until `read` gives a value, and returns it with the wait. A failed read counts as not yet. */
async function until<T>(read: () => Promise<T | null | undefined | false>, timeoutMs: number, stepMs = 250): Promise<{ value: T | null; ms: number }> {
  const begin = Date.now();
  for (;;) {
    const value = await read().catch(() => null);
    if (value) return { value, ms: Date.now() - begin };
    if (Date.now() - begin >= timeoutMs) return { value: null, ms: Date.now() - begin };
    await Bun.sleep(stepMs);
  }
}

const proposalIn = (body: StateBody, id: string) => body.plant.proposals.find((p) => p.id === id);
const voteOf = (proposal: Proposal | undefined, componentId: string) => proposal?.votes.find((v) => v.componentId === componentId);
const describeVotes = (proposal: Proposal | undefined) => proposal?.votes.map((v) => `${v.componentId.split("/")[1]}${v.componentId.startsWith(proposal.plantId) ? "" : "(other plant)"}=${v.vote}`).join(", ") ?? "none";
const noReasons = (proposal: Proposal | undefined) => proposal?.votes.filter((v) => v.vote === "no").map((v) => `${v.componentId}: ${v.reason.slice(0, 200)}`).join(" | ") ?? "";

function rootOf(id: string, proposals: Proposal[]): string {
  let current = proposals.find((p) => p.id === id);
  while (current?.parentProposalId) current = proposals.find((p) => p.id === current?.parentProposalId);
  return current?.id ?? id;
}

function stackLine(health: Record<string, any>, simulator: string): string {
  return `glue ${GLUE}; actors ${health.services?.actors ? "up" : "DOWN"}; relay ${health.services?.relay ? "up" : "DOWN"}; simulator ${simulator}; history ${health.seed?.historySource}${health.seed?.standIn ? " (STAND-IN)" : ""}`;
}

async function simulatorKind(): Promise<string> {
  const response = await fetch(`${BRIDGE}/snapshot?plantId=plant-a`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  if (!response) return "UNREACHABLE";
  if (response.headers.get("x-actorrelay-fake")) return "FAKE (test stand-in)";
  return response.headers.get("x-bridge-tick") !== null ? "bridge/live_sim.ts" : "unknown";
}

/** Step 1. */
async function resetStep(): Promise<boolean> {
  const before = Date.now();
  const reply = await request<{ ok: boolean; seed: StateBody["seed"] }>("/reset", {});
  const seedDone = Date.now();
  const mirrored = await until(
    async () => {
      const body = await state("plant-a");
      const live = body.components.filter((c) => Date.parse(c.lastTick) >= before);
      return live.length === 10 ? body : null;
    },
    3000,
    100,
  );
  const ok = record("1", "10 components mirrored within 3 s", mirrored.value !== null, `${mirrored.ms} ms after the seed finished; seeding took ${seedDone - before} ms`);
  const [a, b] = await Promise.all([state("plant-a"), state("plant-b")]);
  record("1", "reset cleared proposals and audit", a.plant.proposals.length === 0 && b.plant.proposals.length === 0, `plant-a ${a.plant.proposals.length}, plant-b ${b.plant.proposals.length} proposals`);
  record("1", "seed history", reply.seed.events > 0, `${reply.seed.events} events from ${reply.seed.historySource}${reply.seed.standIn ? ` [${reply.seed.label}]` : ""}`);
  return ok;
}

/** Step 2. Returns the blocked proposal. */
async function blockStep(): Promise<Proposal | null> {
  const opened = Date.now();
  const proposal = await propose("plant-a", 85);
  record("2", "cross-plant voter required", proposal.crossPlant === true && proposal.requiredVoters.includes("plant-b/TV-101"), `crossPlant ${proposal.crossPlant}; voters ${proposal.requiredVoters.join(", ")}`);
  const settled = await until(
    async () => {
      const current = proposalIn(await state("plant-a"), proposal.id);
      return current?.status === "blocked" && voteOf(current, "plant-a/LV-101") ? current : null;
    },
    25_000,
  );
  const blocked = settled.value;
  record("2", "blocked within 25 s", blocked !== null, blocked ? `${Date.now() - opened} ms; ${describeVotes(blocked)}` : `not blocked: ${describeVotes(proposalIn(await state("plant-a"), proposal.id))}`);
  if (!blocked) return null;
  const valve = voteOf(blocked, "plant-a/LV-101") as Vote;
  const history = new Set((await state("plant-a", true)).plant.history.map((e) => e.id));
  const real = valve.evidenceEventIds.filter((id) => history.has(id));
  record("2", "LV-101 no with at least 3 evidence ids in actor history", valve.vote === "no" && real.length >= 3, `vote ${valve.vote}; ${real.length} of ${valve.evidenceEventIds.length} ids resolve; rules ${valve.evidenceRuleIds.length}`);
  record("2", "LV-101 predicted positionPct at least 81", (valve.predicted.positionPct ?? 0) >= 81, `predicted ${valve.predicted.positionPct}`);
  await Bun.sleep(1500);
  const late = proposalIn(await state("plant-a"), blocked.id);
  record("2", "cross-plant vote recorded from plant-b/TV-101", voteOf(late, "plant-b/TV-101") !== undefined, `${describeVotes(late)}`);
  return late ?? blocked;
}

/** Step 3. Returns the executed proposal and its event. */
async function counterStep(blocked: Proposal): Promise<{ proposal: Proposal; event: HistoryEvent } | null> {
  const family = async () => (await state("plant-a")).plant.proposals.filter((p, _, all) => p.id !== blocked.id && rootOf(p.id, all) === blocked.id);
  const first = await until(async () => (await family())[0], 30_000);
  record("3", "counter arrives from the proposer", first.value !== null, first.value ? `${first.ms} ms after the block; ${first.value.from} -> ${first.value.to}; ${first.value.rationale.slice(0, 160)}` : "no counter in 30 s");
  if (!first.value) return null;

  let sawVeto = false;
  const done = await until(
    async () => {
      const proposals = await family();
      sawVeto ||= proposals.some((p) => p.status === "veto_window");
      return proposals.find((p) => p.status === "executed");
    },
    75_000,
    200,
  );
  const proposals = await family();
  const executed = done.value;
  record("3", "a counter reaches executed", executed !== null, executed ? `${proposals.length} counter(s); ${executed.id} ${executed.from} -> ${executed.to}` : proposals.map((p) => `${p.to}: ${p.status}; ${describeVotes(p)}; ${noReasons(p)}`).join(" || "));
  if (!executed) return null;
  record("3", "counter target near 65", executed.to >= 60 && executed.to <= 70, `to ${executed.to}`);
  record("3", "all required voters yes", executed.requiredVoters.every((id) => voteOf(executed, id)?.vote === "yes"), describeVotes(executed));
  record("3", "veto window seen", sawVeto, sawVeto ? "status veto_window observed before executed" : "never observed in 200 ms polling");

  const recorded = await until(async () => (await state("plant-a")).plant.history.find((e) => e.proposalId === executed.id), 25_000);
  record("3", "observed event recorded", recorded.value !== null, recorded.value ? `${recorded.value.id}, ${recorded.value.effects.length} effects, ${recorded.ms} ms after executed` : "none in 25 s");
  if (!recorded.value) return null;
  const event = recorded.value;
  const row = event.effects.find((e) => e.componentId === "plant-a/LV-101" && e.metric === "positionPct");
  record("3", "LV-101 settles 60-72 in the observed effects", row !== undefined && row.after >= 60 && row.after <= 72, `after ${row?.after}, ${row?.ticksToSettle} ticks`);
  const live = await until(
    async () => {
      const value = (await component("plant-a/LV-101")).metrics.positionPct;
      return value !== undefined && value >= 60 && value <= 72 ? value : null;
    },
    10_000,
  );
  record("3", "LV-101 live reading within 60-72", live.value !== null, `live ${live.value ?? (await component("plant-a/LV-101")).metrics.positionPct}`);
  const speed = (await component("plant-a/P-100")).metrics.speedPct;
  record("3", "P-100 holds the claimed value", speed === executed.to, `speedPct ${speed}`);

  const health = await request<Record<string, any>>("/health");
  const published = (health.relay?.published ?? []).filter((p: { type: string; ref: string; ok: boolean }) => p.type === "executed" && p.ref === executed.id && p.ok).map((p: { channel: string }) => p.channel);
  record("3", "executed published on the plant channel and company", published.includes("plant-a") && published.includes("company"), `channels ${published.join(", ") || "none"}`);

  const writes = (health.dispatches ?? []).filter((d: { proposalId: string }) => d.proposalId === executed.id);
  const bridgeLog = (await fetch(`${BRIDGE}/writes`, { signal: AbortSignal.timeout(2000) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as { proposalId: string }[] | null;
  const onBridge = bridgeLog?.filter((w) => w.proposalId === executed.id).length;
  record("3", "exactly one simulator write", writes.length === 1 && (onBridge === undefined || onBridge === 1), `glue log ${writes.length}; simulator log ${onBridge ?? "not available"}`);

  const missing = async () => {
    const lists = await Promise.all(executed.requiredVoters.map(async (id) => ((await component(id)).calibration.some((c) => c.proposalId === executed.id) ? null : id)));
    return lists.filter((id): id is string => id !== null);
  };
  const calibrated = await until(async () => ((await missing()).length === 0 ? true : null), 20_000);
  record("3", "calibration entries exist for all voters", calibrated.value === true, calibrated.value ? `${executed.requiredVoters.length} voters in ${calibrated.ms} ms` : `missing ${(await missing()).join(", ")}`);
  return { proposal: executed, event };
}

/** Step 4. */
async function repeatStep(event: HistoryEvent) {
  const opened = Date.now();
  const proposal = await propose("plant-a", 85);
  const settled = await until(
    async () => {
      const current = proposalIn(await state("plant-a"), proposal.id);
      return current?.status === "blocked" ? current : null;
    },
    10_000,
    100,
  );
  const blockedMs = Date.now() - opened;
  record("4", "repeat 85 blocked within 10 s", settled.value !== null, `${blockedMs} ms; ${describeVotes(settled.value ?? proposalIn(await state("plant-a"), proposal.id))}`);
  record("4", "demo target: blocked under 5 s", settled.value !== null && blockedMs < 5000, `${blockedMs} ms`);
  const voted = await until(async () => voteOf(proposalIn(await state("plant-a"), proposal.id), "plant-a/LV-101"), 15_000);
  const valve = voted.value;
  record("4", "LV-101 evidenceEventIds[0] is the step 3 event", valve?.evidenceEventIds[0] === event.id && valve?.vote === "no", `vote ${valve?.vote}; first ${valve?.evidenceEventIds[0]}; expected ${event.id}`);
}

/** Step 5. Says which of the two grounds plant-b's valve gave. Only a cited company rule passes. */
async function plantBStep() {
  const before = await state("plant-b", true);
  const above = before.plant.history.filter((e) => e.metric === "speedPct" && e.after >= 80).length;
  const rule = await until(async () => (await state("plant-b")).company.rules.find((r) => r.scope === "company" && r.consequence.metric === "positionPct"), 10_000);
  record("5", "a company rule on the valve exists before the proposal", rule.value !== null, rule.value ? rule.value.text : "none in 10 s");
  const proposal = await propose("plant-b", 85);
  const settled = await until(
    async () => {
      const current = proposalIn(await state("plant-b"), proposal.id);
      return current?.status === "blocked" && voteOf(current, "plant-b/LV-101") ? current : null;
    },
    25_000,
  );
  record("5", "plant-b 85 blocked", settled.value !== null, settled.value ? describeVotes(settled.value) : `not blocked: ${describeVotes(proposalIn(await state("plant-b"), proposal.id))}`);
  if (!settled.value) return gap("5", "plant-b cites the company rule", "no plant-b valve vote to read");
  const valve = voteOf(settled.value, "plant-b/LV-101") as Vote;
  const { company } = await state("plant-b");
  const cited: LearnedRule[] = company.rules.filter((r) => r.scope === "company" && valve.evidenceRuleIds.includes(r.id));
  const fromA = cited.filter((r) => r.text.includes("plant-a"));
  const insufficient = /insufficient history/i.test(valve.reason);
  const grounds = fromA.length > 0 ? `company rule ${fromA[0]?.id}` : insufficient ? "insufficient history, rule not cited" : `other: ${valve.reason.slice(0, 160)}`;
  record("5", "plant-b LV-101 no citing plant-a's company rule", valve.vote === "no" && fromA.length > 0, `grounds: ${grounds}; plant-b events at 80 or above: ${above}`);
}

function table(simulator: string, health: Record<string, any>): string {
  const count = (verdict: Verdict) => rows.filter((row) => row.verdict === verdict).length;
  const cell = (text: string) => text.replace(/\|/g, "/").replace(/\s+/g, " ");
  return [
    `# ActorRelay e2e`,
    "",
    `Run ${started}. Stack: ${stackLine(health, simulator)}.`,
    "",
    `${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("GAP")} GAP.`,
    "",
    "| Step | Check | Verdict | Detail |",
    "|---|---|---|---|",
    ...rows.map((row) => `| ${row.step} | ${cell(row.check)} | ${row.verdict} | ${cell(row.detail)} |`),
    "",
  ].join("\n");
}

async function main() {
  const simulator = await simulatorKind();
  const health = await request<Record<string, any>>("/health");
  console.log(`Stack: ${stackLine(health, simulator)}`);

  const stages: [string, () => Promise<void>][] = [];
  let blocked: Proposal | null = null;
  let run: { proposal: Proposal; event: HistoryEvent } | null = null;
  stages.push(["1", async () => void (await resetStep())]);
  stages.push(["2", async () => void (blocked = await blockStep())]);
  stages.push(["3", async () => void (run = blocked ? await counterStep(blocked) : (gap("3", "counter", "step 2 did not block"), null))]);
  stages.push(["4", async () => (run ? repeatStep(run.event) : gap("4", "repeat block", "step 3 did not execute"))]);
  stages.push(["5", plantBStep]);
  for (const [step, stage] of stages) {
    try {
      await stage();
    } catch (error) {
      record(step, "step ran to the end", false, error instanceof Error ? error.message : String(error));
    }
  }

  const final = await request<Record<string, any>>("/health").catch(() => health);
  const text = table(simulator, final);
  console.log(`\n${text}`);
  if (REPORT) writeFileSync(REPORT, text);
  process.exit(rows.some((row) => row.verdict !== "PASS") ? 1 : 0);
}

await main();

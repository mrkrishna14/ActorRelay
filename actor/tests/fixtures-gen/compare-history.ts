// Runs the real seed, retrieval, rule, vote and counter code over two history files and lists every difference.
// The default model is a stub that says yes and repeats the evidence estimate, so every no in the report came from code.
// Run: bun actor/tests/fixtures-gen/compare-history.ts <baseline.json> <candidate.json> [--llm]
// --llm uses the real model router instead, on the demo steps only. Exit 1 on a vote, rule or counter difference.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildCounter } from "../../../agent/counter";
import type { ComponentView, Glue, SimilarQuery } from "../../../agent/glue";
import { RoutedLlm, type Llm, type LlmRequest } from "../../../agent/llm";
import { evidenceEstimates, ownRows, relevantEvents, RetrievalCache, sameDirection } from "../../../agent/retrieval";
import { makeProposal, safeExecution, seedComponents } from "../../../agent/tests/fake-glue";
import { castVote, requiredMetrics } from "../../../agent/vote";
import type { ComponentId, HistoryEvent, LearnedRule, PlantId, PlantState, Proposal, Vote } from "../../../shared/types";
import { deriveRules, mergeCompanyRule, mergeDerivedRules, toCompanyRule, type Topology } from "../../src/logic/rules";
import { rankSimilar } from "../../src/logic/similar";
import { assertHistoryEvent } from "../../src/logic/validate";

const NOW = "2026-10-31T20:00:00.000Z";
const PLANTS: PlantId[] = ["plant-a", "plant-b"];
const LV_CRITICAL = 90;
const SWEEP_TARGETS = [55, 60, 65, 70, 72, 75, 77, 80, 82, 85, 88, 90, 95];
const BANDS = [[25, 39], [40, 59], [60, 70], [71, 79], [80, 87], [88, 94], [95, 100]];

type Scenario = { key: string; label: string; plantId: PlantId; from: number; to: number; speedA: number; speedB: number; live?: boolean; noCompanyRules?: boolean };

const DEMO: Scenario[] = [
  { key: "step3", label: "step 3: plant-a 50->85 from design", plantId: "plant-a", from: 50, to: 85, speedA: 50, speedB: 50 },
  { key: "step4", label: "step 4: plant-a 50->65, the scripted counter", plantId: "plant-a", from: 50, to: 65, speedA: 50, speedB: 50 },
  { key: "step5", label: "step 5: plant-a 65->85 after the live 65 run", plantId: "plant-a", from: 65, to: 85, speedA: 65, speedB: 50, live: true },
  { key: "step6", label: "step 6: plant-b 50->85 with the company rule", plantId: "plant-b", from: 50, to: 85, speedA: 65, speedB: 50 },
  { key: "step6-norule", label: "plant-b 50->85 with no company rule yet", plantId: "plant-b", from: 50, to: 85, speedA: 65, speedB: 50, noCompanyRules: true },
];

const round = (x: number, places = 2) => Number(x.toFixed(places));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const steamAt = (speed: number) => 29.7 * speed + 48;
const tagOf = (id: ComponentId) => id.split("/")[1] ?? id;

/** One plant's actors and glue, in memory, seeded the way Plant.loadSeed and Company.promoteRule do it. */
class World implements Glue {
  readonly components = new Map<ComponentId, ComponentView>();
  readonly topology: Topology = {};
  readonly history: Record<PlantId, HistoryEvent[]>;
  readonly plantRules: Record<PlantId, LearnedRule[]>;
  readonly liveEventIds: Record<PlantId, string[]> = { "plant-a": [], "plant-b": [] };
  companyRules: LearnedRule[] = [];
  proposals: Proposal[] = [];
  lastSimilar: HistoryEvent[] = [];

  constructor(events: HistoryEvent[]) {
    for (const component of seedComponents()) {
      this.components.set(component.id, structuredClone(component));
      this.topology[component.id] = component;
    }
    this.history = { "plant-a": [], "plant-b": [] };
    this.plantRules = { "plant-a": [], "plant-b": [] };
    for (const plantId of PLANTS) {
      this.history[plantId] = events.filter((e) => e.plantId === plantId);
      this.history[plantId].forEach((e) => assertHistoryEvent(e));
      this.plantRules[plantId] = deriveRules(this.history[plantId], this.topology, NOW);
      this.promote(this.plantRules[plantId], plantId);
    }
  }

  private promote(rules: LearnedRule[], plantId: PlantId) {
    for (const rule of rules) {
      if (rule.model !== null) this.companyRules = mergeCompanyRule(this.companyRules, { ...toCompanyRule(rule, plantId), scope: "company" }, NOW).rules;
    }
  }

  /** The live values at these speeds, from the fit, so both files vote from the same plant state. */
  mirror(speedA: number, speedB: number) {
    const header = clamp(6 - 0.0005 * (steamAt(speedA) + steamAt(speedB) - 3066), 4.5, 6.5);
    for (const [plantId, speed] of [["plant-a", speedA], ["plant-b", speedB]] as const) {
      const metrics: Record<string, Record<string, number>> = {
        "P-100": { speedPct: speed, feedM3h: 0.3 * speed },
        "TK-101": { levelPct: 50, tempC: 75 },
        "LV-101": { positionPct: speed },
        "E-101": { dutyKw: 17.43 * speed + 27 },
        "TV-101": { positionPct: 0.36 * speed + 32.5 + 3.6 * (6 - header), steamKgH: steamAt(speed), headerBarg: header },
      };
      for (const [tag, values] of Object.entries(metrics)) {
        (this.components.get(`${plantId}/${tag}`) as ComponentView).metrics = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, round(v)]));
      }
    }
  }

  /** What Plant.recordEvent does with an observed run. */
  recordLive(event: HistoryEvent) {
    const plantId = event.plantId;
    this.history[plantId] = [...this.history[plantId], event];
    this.liveEventIds[plantId].push(event.id);
    const merged = mergeDerivedRules(this.plantRules[plantId], deriveRules(this.history[plantId], this.topology, event.at));
    this.plantRules[plantId] = merged.rules;
    this.promote(merged.changed, plantId);
  }

  async component(id: ComponentId) {
    const found = this.components.get(id);
    if (!found) throw new Error(`no component ${id}`);
    return structuredClone(found);
  }

  async similar({ componentId, metric, to, upstreamSnapshot = {}, k }: SimilarQuery) {
    const plantId = componentId.split("/")[0] as PlantId;
    const limit = this.components.get(componentId)?.limits[metric];
    this.lastSimilar = rankSimilar({ history: this.history[plantId], componentId, metric, to, upstreamSnapshot, k, limit, liveEventIds: this.liveEventIds[plantId] });
    return this.lastSimilar;
  }

  // Same selection as Plant.rulesFor.
  async rules(componentId: ComponentId, model: string) {
    const plantId = componentId.split("/")[0] as PlantId;
    const mine = this.plantRules[plantId].filter((r) => r.model === model || r.condition.componentId === componentId || r.consequence.componentId === componentId);
    return structuredClone([...mine, ...this.companyRules.filter((r) => r.model === model)]);
  }

  async plant(plantId: PlantId): Promise<PlantState> {
    return structuredClone({ id: plantId, name: plantId, components: [], proposals: this.proposals.filter((p) => p.plantId === plantId), history: this.history[plantId], rules: this.plantRules[plantId], audit: [], tick: 0, connected: true });
  }

  async calibration() {}
  async rule() {}
  async vote() {}
  async counter() {}
}

/** Says yes and predicts what the retrieved runs show. A no can only come from code. */
class EvidenceModel implements Llm {
  constructor(private readonly world: World) {}

  async complete({ system, user }: LlmRequest) {
    const reply = (text: string) => ({ text, provider: "openai" as const, model: "evidence-stub", fallback: false });
    if (system.includes("Pick a safer target")) return reply("{}"); // buildCounter fixes the value itself.
    const id = /You are (\S+) \(/.exec(user)?.[1] as ComponentId;
    const proposal = JSON.parse(/Proposal: (\{.*\})/.exec(user)?.[1] as string);
    const own = await this.world.component(id);
    const proposer = await this.world.component(proposal.proposer);
    const relevant = relevantEvents(this.world.lastSimilar, proposal.to, proposer.limits[proposal.metric]).filter((e) => own.plantId !== proposal.plantId || ownRows(e, own).length > 0);
    const estimates = evidenceEstimates(sameDirection(relevant, proposal), own, proposal.to);
    const predicted = Object.fromEntries(requiredMetrics(own).map((metric) => [metric, estimates[metric] ?? own.metrics[metric]]));
    return reply(JSON.stringify({ vote: "yes", reason: "stub: follows the evidence", predicted, evidenceEventIds: [], evidenceRuleIds: [] }));
  }
}

function grounds(vote: Vote): string {
  if (vote.vote === "yes") return "yes";
  const reason = vote.reason.replace(/^\[[^\]]*\]\s*/, ""); // A provenance prefix can hold its own semicolon.
  if (reason.includes("insufficient history")) return "no: insufficient history";
  if (/\brule\b/.test(reason.split(";")[0])) return "no: rule";
  if (reason.includes("threshold")) return "no: threshold";
  return `no: ${reason.slice(0, 50)}`;
}

let proposalSeq = 0;

function proposalFor(scenario: Pick<Scenario, "plantId" | "from" | "to">, tag: string): Proposal {
  return makeProposal({ id: `compare-${tag}-${++proposalSeq}`, at: NOW, plantId: scenario.plantId, from: scenario.from, to: scenario.to });
}

async function votesOn(world: World, proposal: Proposal, llm: Llm): Promise<Vote[]> {
  world.proposals = [proposal];
  const deps = { glue: world, llm, cache: new RetrievalCache() };
  return Promise.all(proposal.requiredVoters.map((voter) => castVote(deps, proposal, voter)));
}

function worldFor(events: HistoryEvent[], scenario: Pick<Scenario, "speedA" | "speedB" | "live" | "noCompanyRules">): World {
  const world = new World(events);
  world.mirror(scenario.speedA, scenario.speedB);
  if (scenario.live) world.recordLive({ ...safeExecution("live-step-4"), at: NOW });
  if (scenario.noCompanyRules) world.companyRules = [];
  return world;
}

type Outcome = { retrieved: HistoryEvent[]; votes: Vote[]; rulesCited: number };

async function runScenario(events: HistoryEvent[], scenario: Scenario, tag: string, model: (world: World) => Llm): Promise<Outcome> {
  const world = worldFor(events, scenario);
  const votes = await votesOn(world, proposalFor(scenario, tag), model(world));
  return { retrieved: world.lastSimilar, votes, rulesCited: votes.reduce((sum, v) => sum + v.evidenceRuleIds.length, 0) };
}

type Counter = { to: number | null; decidedBy: string | null; votes: Vote[] };

/** The real counter after the real block at step 3, then the real vote on the value it picked. */
async function runCounter(events: HistoryEvent[], tag: string, model: (world: World) => Llm): Promise<Counter> {
  const state = { speedA: 50, speedB: 50 };
  const world = worldFor(events, state);
  const llm = model(world);
  const scenario = { plantId: "plant-a" as const, from: 50, to: 85 };
  const proposal = proposalFor(scenario, `${tag}-block`);
  const blocked: Proposal = { ...proposal, votes: await votesOn(world, proposal, llm), status: "blocked" };
  world.proposals = [blocked];
  const counter = await buildCounter({ glue: world, llm }, blocked, [blocked]);
  if (!counter) return { to: null, decidedBy: null, votes: [] };
  const follow = proposalFor({ plantId: "plant-a", from: 50, to: counter.proposal.to }, `${tag}-counter`);
  return { to: counter.proposal.to, decidedBy: counter.explainedBy, votes: await votesOn(world, follow, llm) };
}

const voteLine = (votes: Vote[]) => votes.map((v) => (v.vote === "yes" ? "y" : "N")).join("");
const lvRow = (e: HistoryEvent) => e.effects.find((r) => r.componentId === `${e.plantId}/LV-101` && r.metric === "positionPct");
const pastCritical = (e: HistoryEvent) => e.incident !== null && (lvRow(e)?.after ?? 0) >= LV_CRITICAL;
const retrievedLine = (events: HistoryEvent[]) => events.map((e) => `${e.after}${pastCritical(e) ? "!" : e.incident ? "~" : ""}`).join(" ") || "none";
const predictedLine = (vote: Vote) => Object.entries(vote.predicted).map(([k, v]) => `${k} ${round(v, 1)}`).join(", ");

function ruleLines(rules: LearnedRule[]): Map<string, string> {
  return new Map(rules.map((r) => [
    `${tagOf(r.condition.componentId ?? "-")} ${r.condition.metric} -> ${tagOf(r.consequence.componentId ?? "-")} ${r.consequence.metric} ${r.consequence.op}`,
    `${r.condition.op} ${r.condition.value} gives ${r.consequence.value} within ${r.consequence.withinTicks}, seen ${r.timesSeen}`,
  ]));
}

function bandTable(a: HistoryEvent[], b: HistoryEvent[], plantId: PlantId): string[] {
  const stats = (events: HistoryEvent[], lo: number, hi: number) => {
    const inBand = events.filter((e) => e.plantId === plantId && e.after >= lo && e.after <= hi);
    const rows = inBand.flatMap((e) => (lvRow(e) ? [{ e, lv: lvRow(e)?.after as number }] : []));
    const mean = rows.length ? round(rows.reduce((sum, r) => sum + r.lv - r.e.after, 0) / rows.length, 1) : "-";
    const tempRows = inBand.flatMap((e) => e.effects.filter((r) => r.metric === "tempC").map((r) => r.after));
    return `${inBand.length} ev, LV-speed ${mean}, LV max ${rows.length ? Math.max(...rows.map((r) => r.lv)) : "-"}, temp min ${tempRows.length ? Math.min(...tempRows) : "-"}, incidents ${inBand.filter((e) => e.incident).length}`;
  };
  return BANDS.map(([lo, hi]) => `  ${plantId} ${lo}-${hi}\n    A ${stats(a, lo, hi)}\n    B ${stats(b, lo, hi)}`);
}

/** Facts about how a file was built. A difference here can change what agents read even when votes match. */
function shapeFacts(events: HistoryEvent[]): Record<string, string> {
  const pump = (plantId: PlantId) => events.filter((e) => e.plantId === plantId);
  const header = events.flatMap((e) => e.effects.filter((r) => r.metric === "headerBarg"));
  const ticks = events.filter((e) => e.after >= 80).flatMap((e) => (lvRow(e) ? [lvRow(e)?.ticksToSettle as number] : []));
  const atDesign = (e: HistoryEvent) => e.before >= 48 && e.before <= 52;
  const near85 = pump("plant-a").filter((e) => e.after >= 82 && e.after <= 87.999);
  const serious = pump("plant-a").filter(pastCritical);
  const hottest = events.flatMap((e) => e.effects.filter((r) => r.metric === "tempC").map((r) => r.after));
  const dip85 = pump("plant-a").filter((e) => atDesign(e) && e.after >= 83 && e.after <= 87).flatMap((e) => e.effects.filter((r) => r.metric === "tempC").map((r) => r.after));
  return {
    "headerBarg rows that move": `${header.filter((r) => Math.abs(r.after - r.before) > 0.005).length} of ${header.length}`,
    "speeds rounded to 2 decimals": `${events.filter((e) => Math.abs(e.after * 100 - Math.round(e.after * 100)) < 1e-6).length} of ${events.length}`,
    "plant-a events at 82-87": `${near85.length}`,
    "incidents past LV-101 critical, lowest speed": `${serious.length ? Math.min(...serious.map((e) => round(e.after, 1))) : "none"}`,
    "incidents past LV-101 critical from design": `${serious.filter(atDesign).length}`,
    "rows where LV-101 reads 100": `${events.filter((e) => (lvRow(e)?.after ?? 0) >= 100).length}`,
    "plant-b highest speed": `${round(Math.max(...pump("plant-b").map((e) => e.after)), 1)}`,
    "LV-101 ticksToSettle at speed >=80": ticks.length ? `${Math.min(...ticks)}-${Math.max(...ticks)}` : "none",
    "TK-101 tempC after a step to 83-87 from design": dip85.length ? `${Math.min(...dip85)}-${Math.max(...dip85)}` : "none",
    "tempC range across the file": `${Math.min(...hottest)}-${Math.max(...hottest)}`,
  };
}

async function main() {
  const [pathA, pathB] = process.argv.slice(2).filter((arg) => !arg.startsWith("--")).map((arg) => resolve(arg));
  if (!pathA || !pathB) throw new Error("usage: compare-history.ts <baseline.json> <candidate.json> [--llm]");
  const useLlm = process.argv.includes("--llm");
  const a: HistoryEvent[] = JSON.parse(readFileSync(pathA, "utf8"));
  const b: HistoryEvent[] = JSON.parse(readFileSync(pathB, "utf8"));
  const router = new RoutedLlm();
  const model = (world: World): Llm => (useLlm ? router : new EvidenceModel(world));
  const diffs: { level: string; text: string }[] = [];
  const detail: string[] = [];
  const note = (level: string, text: string) => diffs.push({ level, text });

  for (const plantId of PLANTS) {
    const rulesA = ruleLines(new World(a).plantRules[plantId]);
    const rulesB = ruleLines(new World(b).plantRules[plantId]);
    detail.push(`RULES ${plantId}`);
    for (const key of new Set([...rulesA.keys(), ...rulesB.keys()])) {
      const [left, right] = [rulesA.get(key) ?? "none", rulesB.get(key) ?? "none"];
      detail.push(`  ${key}\n    A ${left}\n    B ${right}`);
      if (left !== right) note(left.replace(/, seen \d+/, "") === right.replace(/, seen \d+/, "") ? "COUNT" : "RULE", `${plantId} ${key}: A ${left}; B ${right}`);
    }
    if (!rulesA.size && !rulesB.size) detail.push("  none in either file");
  }

  detail.push("", "DEMO STEPS (votes in order TK-101 LV-101 E-101 TV-101 other-plant-TV-101; ! incident past LV-101 critical, ~ other incident)");
  for (const scenario of DEMO) {
    const left = await runScenario(a, scenario, "a", model);
    const right = await runScenario(b, scenario, "b", model);
    detail.push(`${scenario.label}`, `  retrieved A ${retrievedLine(left.retrieved)}`, `  retrieved B ${retrievedLine(right.retrieved)}`);
    if (left.retrieved.length !== right.retrieved.length) note("RETRIEVAL", `${scenario.key}: A returns ${left.retrieved.length}, B returns ${right.retrieved.length}`);
    const incidents = (o: Outcome) => o.retrieved.filter(pastCritical).length;
    if (incidents(left) !== incidents(right)) note("RETRIEVAL", `${scenario.key}: incidents past LV-101 critical in the top 5, A ${incidents(left)}, B ${incidents(right)}`);
    left.votes.forEach((voteA, index) => {
      const voteB = right.votes[index];
      const voter = voteA.componentId;
      detail.push(`  ${voter}\n    A ${grounds(voteA)} | ${predictedLine(voteA)} | similar ${voteA.similarCount}, ${voteA.evidenceEventIds.length} events, ${voteA.evidenceRuleIds.length} rules\n    B ${grounds(voteB)} | ${predictedLine(voteB)} | similar ${voteB.similarCount}, ${voteB.evidenceEventIds.length} events, ${voteB.evidenceRuleIds.length} rules`);
      if (voteA.vote !== voteB.vote) note("VOTE", `${scenario.key} ${voter}: A ${grounds(voteA)}, B ${grounds(voteB)}. B says: ${voteB.reason.slice(0, 220)}`);
      else if (grounds(voteA) !== grounds(voteB)) note("GROUNDS", `${scenario.key} ${voter}: A ${grounds(voteA)}, B ${grounds(voteB)}`);
      if (voteA.similarCount !== voteB.similarCount) note("SIMILAR", `${scenario.key} ${voter}: similarCount A ${voteA.similarCount}, B ${voteB.similarCount}`);
      const own = seedComponents().find((c) => c.id === voter);
      for (const metric of Object.keys(voteA.predicted)) {
        const span = own?.limits[metric] ? own.limits[metric].max - own.limits[metric].min : 2;
        const [x, y] = [voteA.predicted[metric], voteB.predicted[metric]];
        if (y !== undefined && Math.abs(x - y) > 0.05 * span) note("PREDICTION", `${scenario.key} ${voter} ${metric}: A ${round(x, 1)}, B ${round(y, 1)}`);
      }
    });
  }

  const [counterA, counterB] = [await runCounter(a, "a", model), await runCounter(b, "b", model)];
  detail.push("", "COUNTER after the step 3 block", `  A picks ${counterA.to} (${counterA.decidedBy}), votes ${voteLine(counterA.votes)}`, `  B picks ${counterB.to} (${counterB.decidedBy}), votes ${voteLine(counterB.votes)}`);
  if (counterA.to !== counterB.to) note("COUNTER", `A picks ${counterA.to}, B picks ${counterB.to}`);
  if (voteLine(counterA.votes) !== voteLine(counterB.votes)) note("COUNTER", `votes on the counter, A ${voteLine(counterA.votes)}, B ${voteLine(counterB.votes)}`);
  for (const vote of counterB.votes.filter((v) => v.vote === "no")) note("COUNTER", `B counter blocked by ${vote.componentId}: ${vote.reason.slice(0, 220)}`);

  if (!useLlm) {
    detail.push("", "VOTE SWEEP from 50 (same voter order)");
    for (const plantId of PLANTS) {
      for (const to of SWEEP_TARGETS) {
        const scenario: Scenario = { key: `sweep ${plantId} to ${to}`, label: "", plantId, from: 50, to, speedA: 50, speedB: 50 };
        const [left, right] = [await runScenario(a, scenario, "a", model), await runScenario(b, scenario, "b", model)];
        const [lineA, lineB] = [voteLine(left.votes), voteLine(right.votes)];
        detail.push(`  ${plantId} to ${String(to).padEnd(3)} A ${lineA}  B ${lineB}${lineA === lineB ? "" : "  <-- differs"}`);
        if (lineA !== lineB) note("SWEEP", `${plantId} to ${to}: A ${lineA}, B ${lineB}`);
      }
    }
  }

  const [factsA, factsB] = [shapeFacts(a), shapeFacts(b)];
  for (const key of Object.keys(factsA)) if (factsA[key] !== factsB[key]) note("DATA", `${key}: A ${factsA[key]}; B ${factsB[key]}`);
  detail.push("", "DATA SHAPE", ...PLANTS.flatMap((plantId) => bandTable(a, b, plantId)));

  const order = ["VOTE", "COUNTER", "RULE", "SWEEP", "GROUNDS", "RETRIEVAL", "SIMILAR", "COUNT", "DATA", "PREDICTION"];
  diffs.sort((x, y) => order.indexOf(x.level) - order.indexOf(y.level));
  console.log(`A ${pathA} (${a.length} events)\nB ${pathB} (${b.length} events)\nModel: ${useLlm ? "real router, votes can differ run to run" : "stub, says yes and repeats the evidence, so every no came from code"}\n`);
  console.log(`DIFFERENCES ${diffs.length}`);
  for (const level of order) {
    const rows = diffs.filter((d) => d.level === level);
    if (rows.length) console.log(`\n${level} (${rows.length})\n${rows.map((d) => `  ${d.text}`).join("\n")}`);
  }
  console.log(`\n${detail.join("\n")}`);
  process.exit(diffs.some((d) => ["VOTE", "COUNTER", "RULE"].includes(d.level)) ? 1 : 0);
}

await main();

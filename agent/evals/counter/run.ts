// Counter-proposal eval. Real model calls end to end: block -> counter -> full vote, up to the cap.
// bun run evals/counter/run.ts --impl real|patched|candidate --tag first --groups demo --limit 20 --tpm 150000
// Scenarios start one at a time, paced on measured tokens, so the cap holds and pacing never eats a vote's time budget.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Proposal, Vote } from "../../../shared/types";
import { buildScenarios, buildView, clearsAll, faultVoterId, makeProposal, safeCeiling, thresholdOf, type Plantview, type Scenario } from "./fixture";
import { loadImpl, type Impl } from "./impl";
import { createLlm, type LlmCall } from "./llm";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
}

const opts = {
  impl: arg("impl", "real"),
  model: arg("model", "gpt-6-luna"),
  effort: arg("effort", "none"),
  scale: Number(arg("scale", "1")),
  concurrency: Number(arg("concurrency", "8")),
  slots: Number(arg("slots", "1")),
  tpm: Number(arg("tpm", "150000")),
  limit: Number(arg("limit", "0")),
  tag: arg("tag", "run"),
  groups: arg("groups", ""),
  partial: process.argv.includes("--partial"),
};

export const MAX_COUNTERS = 2;

// The live watch loop: Plant sweeps every 2 s, the proposer polls every 800 ms, and once() lets it build one counter.
// Late votes are recorded by the actor but the counter never sees them, so this replays that timing on real latencies.
const SWEEP_MS = 2000;
const POLL_MS = 800;
const FAST_NO_MS = 2500;
const POST_MS = 100; // vote to actor, over Relay and glue

function voteVisibleAt(votes: Vote[], ms: number[], index: number): Vote[] {
  const arrivals = ms.map((m, i) => (votes[i]!.reason.startsWith("[decided from") ? Math.min(m, FAST_NO_MS) : m) + POST_MS);
  const firstNo = Math.min(...arrivals.filter((_, i) => votes[i]!.vote === "no"));
  const sweepPhase = (index * 613) % SWEEP_MS; // evenly spread, reproducible
  const pollPhase = (index * 347) % POLL_MS;
  const sweep = Math.ceil((firstNo - sweepPhase) / SWEEP_MS) * SWEEP_MS + sweepPhase;
  const seen = Math.ceil((sweep - pollPhase) / POLL_MS) * POLL_MS + pollPhase;
  return votes.filter((_, i) => arrivals[i]! <= seen);
}

type Round = {
  n: number;
  raw: number | null;
  to: number | null;
  refused: string | null;
  decidedBy: string | null;
  note: string | null;
  inRange: boolean;
  equalsFrom: boolean;
  equalsBlocked: boolean;
  clearsTruth: boolean;
  headroomUsed: number | null;
  unanimous: boolean;
  blockers: { id: string; reason: string; predicted: Record<string, number>; spurious: boolean }[];
  counterMs: number;
  voteMs: number;
  rationale: string;
  citesBlocker: boolean;
  llmCalls: number;
};

type Record_ = {
  id: string;
  group: string;
  scenario: Scenario;
  ceiling: number | null;
  parentBlocked: boolean;
  parentBlockers: string[];
  parentVotes: { id: string; vote: string; predicted: Record<string, number>; reason: string }[];
  parentVoteMs: number;
  rounds: Round[];
  capRefused: boolean | null;
  error: string | null;
  rejections: string[];
  visibleVotes?: string[];
};

function rawValue(calls: LlmCall[]): number | null {
  for (const call of [...calls].reverse()) {
    const match = call.text.match(/"(?:to|value|counter|counterValue|target)"\s*:\s*(-?\d+(?:\.\d+)?)/);
    if (match) return Number(match[1]);
  }
  return null;
}

// A no whose own predicted numbers all sit under threshold: nothing in the contract forced it.
function isSpurious(vote: Vote, view: Plantview): boolean {
  const voter = view.voters.find((v) => v.id === vote.componentId)!;
  return Object.entries(vote.predicted).every(([metric, value]) => {
    const threshold = thresholdOf(voter, metric);
    return threshold === null || value < threshold;
  });
}

async function voteAll(impl: Impl, proposal: Proposal, view: Plantview, llm: ReturnType<typeof createLlm>, rejections: string[], broken: string | null): Promise<{ votes: Vote[]; perVoter: number[]; ms: number; calls: number }> {
  const results = await Promise.all(
    view.voters.map(async (voter) => {
      const sink: LlmCall[] = [];
      const vote = await impl.vote(proposal, voter.id, view, llm, sink, (line) => rejections.push(line), voter.id === broken);
      return { vote, ms: sink.reduce((sum, c) => sum + c.ms, 0), calls: sink.length };
    }),
  );
  return {
    votes: results.map((r) => r.vote),
    perVoter: results.map((r) => r.ms),
    ms: Math.max(...results.map((r) => r.ms)),
    calls: results.reduce((sum, r) => sum + r.calls, 0),
  };
}

async function runScenario(impl: Impl, s: Scenario, llm: ReturnType<typeof createLlm>, index: number): Promise<Record_> {
  const view = buildView(s);
  const ceiling = safeCeiling(s);
  const brokenAt = (round: number) => (s.fault?.round === round ? faultVoterId(s) : null);
  const record: Record_ = { id: s.id, group: s.group, scenario: s, ceiling, parentBlocked: false, parentBlockers: [], parentVotes: [], parentVoteMs: 0, rounds: [], capRefused: null, error: null, rejections: [] };

  try {
    const parent = makeProposal(s, view, s.to, null, "Increase throughput");
    const first = await voteAll(impl, parent, view, llm, record.rejections, brokenAt(0));
    parent.votes = first.votes;
    parent.status = first.votes.some((v) => v.vote === "no") ? "blocked" : "veto_window";
    record.parentVoteMs = first.ms;
    record.parentBlocked = parent.status === "blocked";
    record.parentBlockers = first.votes.filter((v) => v.vote === "no").map((v) => v.componentId);
    record.parentVotes = first.votes.map((v) => ({ id: v.componentId, vote: v.vote, predicted: v.predicted, reason: v.reason.slice(0, 300) }));
    if (!record.parentBlocked) return record;

    if (opts.partial) {
      parent.votes = voteVisibleAt(first.votes, first.perVoter, index);
      record.visibleVotes = parent.votes.map((v) => `${v.componentId.split("/").pop()}:${v.vote}`);
    }

    const chain: Proposal[] = [parent];
    for (let n = 1; n <= MAX_COUNTERS; n++) {
      const sink: LlmCall[] = [];
      const made = await impl.counter(chain, view, s, llm, sink);
      const counterMs = sink.reduce((sum, c) => sum + c.ms, 0);
      const raw = rawValue(sink);
      if (!made.proposal) {
        record.rounds.push({ n, raw, to: null, refused: made.note ?? "no counter", decidedBy: null, note: null, inRange: false, equalsFrom: false, equalsBlocked: false, clearsTruth: false, headroomUsed: null, unanimous: false, blockers: [], counterMs, voteMs: 0, rationale: "", citesBlocker: false, llmCalls: sink.length });
        return record;
      }
      const counter = made.proposal;
      const value = counter.to;
      const lo = Math.min(s.from, s.to);
      const hi = Math.max(s.from, s.to);
      const voted = await voteAll(impl, counter, view, llm, record.rejections, brokenAt(n));
      counter.votes = opts.partial && voted.votes.some((v) => v.vote === "no") ? voteVisibleAt(voted.votes, voted.perVoter, index + n) : voted.votes;
      const unanimous = voted.votes.every((v) => v.vote === "yes");
      counter.status = unanimous ? "veto_window" : "blocked";
      const blockers = chain.flatMap((p) => p.votes.filter((v) => v.vote === "no"));
      const tags = blockers.map((v) => v.componentId.split("/")[1]!);
      record.rounds.push({
        n,
        raw,
        to: value,
        refused: null,
        decidedBy: made.decidedBy ?? null,
        note: made.note ?? null,
        inRange: value > lo && value < hi,
        equalsFrom: value === s.from,
        equalsBlocked: chain.some((p) => p.to === value),
        clearsTruth: clearsAll(value, s, view),
        headroomUsed: ceiling === null || ceiling === s.from ? null : (value - s.from) / (ceiling - s.from),
        unanimous,
        blockers: voted.votes.filter((v) => v.vote === "no").map((v) => ({ id: v.componentId, reason: v.reason.slice(0, 240), predicted: v.predicted, spurious: isSpurious(v, view) })),
        counterMs,
        voteMs: voted.ms,
        rationale: counter.rationale,
        citesBlocker: tags.some((tag) => counter.rationale.includes(tag)),
        llmCalls: sink.length + voted.calls,
      });
      if (unanimous) return record;
      chain.push(counter);
    }

    // The cap itself: a third attempt must be refused by code.
    const sink: LlmCall[] = [];
    const third = await impl.counter(chain, view, s, llm, sink);
    record.capRefused = third.proposal === null;
  } catch (err: any) {
    record.error = String(err?.message ?? err).slice(0, 300);
  }
  return record;
}

if (import.meta.main) {
  const outDir = join(import.meta.dir, "out");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${opts.tag}.jsonl`);
  writeFileSync(outPath, "");

  // Every number traces to the exact code it ran on, because these files are being edited during the run.
  const sha = (file: string) => createHash("sha1").update(readFileSync(join(import.meta.dir, "..", "..", file))).digest("hex").slice(0, 10);
  const code = { counter: sha("counter.ts"), vote: sha("vote.ts"), retrieval: sha("retrieval.ts"), llm: sha("llm.ts") };
  const impl = await loadImpl(opts.impl);
  const llm = createLlm({ model: opts.model, effort: opts.effort, concurrency: opts.concurrency });
  const wanted = opts.groups ? new Set(opts.groups.split(",")) : null;
  const matching = buildScenarios(opts.scale).filter((s) => !wanted || wanted.has(s.group));
  const scenarios = opts.limit ? matching.slice(0, opts.limit) : matching;
  console.error(`[${impl.name}] ${scenarios.length} scenarios, ${opts.model}/${opts.effort}, cap ${opts.tpm} tokens/min, code ${JSON.stringify(code)}`);

  const started = performance.now();
  let done = 0;
  const runOne = async (s: Scenario, index: number) => {
    const record = await runScenario(impl, s, llm, index);
    appendFileSync(outPath, JSON.stringify(record) + "\n");
    if (++done % 20 === 0) console.error(`${done}/${scenarios.length} ${Math.round((performance.now() - started) / 1000)}s ${JSON.stringify(llm.stats)}`);
  };
  // Spend so far decides when the next scenario may start, so the run's average never passes the cap.
  const pace = async () => {
    const due = started + (llm.stats.tokens / opts.tpm) * 60_000;
    const wait = due - performance.now();
    if (wait > 0) await Bun.sleep(wait);
  };
  const queue = scenarios.entries();
  await Promise.all(
    Array.from({ length: opts.slots }, async () => {
      for (const [index, s] of queue) {
        await pace();
        await runOne(s, index);
      }
    }),
  );
  await Bun.sleep(500); // usage bodies still parsing
  writeFileSync(join(outDir, `${opts.tag}.meta.json`), JSON.stringify({ ...opts, implName: impl.name, code, stats: llm.stats, wallSeconds: (performance.now() - started) / 1000 }));
  writeFileSync(join(outDir, `${opts.tag}.flagged.json`), JSON.stringify(llm.flagged));
  console.error(`done ${Math.round((performance.now() - started) / 1000)}s ${JSON.stringify(llm.stats)} -> ${outPath}`);
}

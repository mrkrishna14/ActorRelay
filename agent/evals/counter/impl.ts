// Adapter between the harness and whatever is under test.
import { join } from "node:path";
import type { Proposal, Vote } from "../../../shared/types";
import { buildCounter as realBuildCounter } from "../../counter";
import type { Llm as AgentLlm } from "../../llm";
import { RetrievalCache } from "../../retrieval";
import { castVote as realCastVote } from "../../vote";
import { buildCounter, castVote as candidateVote } from "./candidate";
import { makeProposal, similar, type Plantview, type Scenario } from "./fixture";
import { FixtureGlue } from "./glue";
import type { createLlm, LlmCall } from "./llm";

type Eval = ReturnType<typeof createLlm>;

export type Impl = {
  name: string;
  vote(proposal: Proposal, voterId: string, view: Plantview, llm: Eval, sink: LlmCall[], log: (line: string) => void, broken: boolean): Promise<Vote>;
  counter(chain: Proposal[], view: Plantview, s: Scenario, llm: Eval, sink: LlmCall[]): Promise<{ proposal: Proposal | null; note?: string; decidedBy?: string }>;
};

const candidateCounter: Impl["counter"] = async (chain, view, s, llm, sink) => {
  // The stand-in trusts the model on purpose, so these numbers show what enforcement has to catch.
  if (chain.length > 2) return { proposal: null, note: "cap" };
  const reply = await buildCounter({ chain, proposer: view.proposer, voters: view.voters }, llm.bind(sink)).catch(() => null);
  if (!reply) return { proposal: null, note: "unparseable reply" };
  return { proposal: makeProposal(s, view, reply.to, chain[chain.length - 1]!, reply.rationale) };
};

// What a timeout, a 429 or a policy rejection looks like to vote.ts: every attempt throws.
const failingLlm: AgentLlm = {
  complete: async () => {
    throw new Error("injected voter failure");
  },
};

const realVote: Impl["vote"] = (proposal, voterId, view, llm, sink, log, broken) =>
  realCastVote({ glue: new FixtureGlue(view), llm: broken ? failingLlm : llm.agentLlm(sink), cache: new RetrievalCache(), log }, proposal, voterId);

const counterWith = (build: typeof realBuildCounter): Impl["counter"] => async (chain, view, s, llm, sink) => {
  const lines: string[] = [];
  const blocked = chain[chain.length - 1]!;
  const made = await build({ glue: new FixtureGlue(view), llm: llm.agentLlm(sink), log: (line) => lines.push(line) }, blocked, chain);
  if (!made) return { proposal: null, note: lines.join("; ") || "buildCounter returned null with no log line" };
  return { proposal: makeProposal(s, view, made.proposal.to, blocked, made.proposal.rationale), decidedBy: made.decidedBy, note: lines.join("; ") || undefined };
};

const IMPLS: Record<string, Impl> = {
  // The shipped path: real agent/counter.ts and agent/vote.ts over a fixture Glue, real model calls.
  real: { name: "REAL agent/counter.ts + REAL agent/vote.ts", vote: realVote, counter: counterWith(realBuildCounter) },
  // Everything stand-in: only useful for raw model behaviour.
  candidate: {
    name: "stand-in vote + stand-in counter (NOT shipped code)",
    vote: (proposal, voterId, view, llm, sink) =>
      candidateVote(proposal, view.voters.find((v) => v.id === voterId)!, similar(view, proposal.to), view.rules, llm.bind(sink)),
    counter: candidateCounter,
  },
  // Real agent/vote.ts, stand-in counter: the state until agent/counter.ts lands.
  hybrid: { name: "REAL agent/vote.ts + stand-in counter (counter is NOT agent/counter.ts)", vote: realVote, counter: candidateCounter },
};

export async function loadImpl(kind: string): Promise<Impl> {
  if (kind === "patched") {
    // Proposed fixes measured before they are sent: a generated copy of agent/counter.ts in the ignored out/ folder.
    const { buildCounter: patched } = await import(join(import.meta.dir, "out", "counter.patched.ts"));
    return { name: "PATCHED copy of agent/counter.ts + REAL agent/vote.ts", vote: realVote, counter: counterWith(patched) };
  }
  const impl = IMPLS[kind];
  if (!impl) throw new Error(`no adapter for ${kind}`);
  return impl;
}

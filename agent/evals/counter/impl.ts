// Adapter between the harness and the code under test: the shipped path, or a patched copy of counter.ts.
import { join } from "node:path";
import type { Proposal, Vote } from "../../../shared/types";
import { buildCounter as realBuildCounter } from "../../counter";
import type { Llm as AgentLlm } from "../../llm";
import { castVote } from "../../vote";
import { makeProposal, type Plantview, type Scenario } from "./fixture";
import { FixtureGlue } from "./glue";
import type { createLlm, LlmCall } from "./llm";

type Eval = ReturnType<typeof createLlm>;

export type Impl = {
  name: string;
  vote(proposal: Proposal, voterId: string, view: Plantview, llm: Eval, sink: LlmCall[], log: (line: string) => void, broken: boolean): Promise<Vote>;
  counter(chain: Proposal[], view: Plantview, s: Scenario, llm: Eval, sink: LlmCall[]): Promise<{ proposal: Proposal | null; note?: string; explainedBy?: string }>;
};

// What a timeout, a 429 or a policy rejection looks like to vote.ts: every attempt throws.
const failingLlm: AgentLlm = {
  complete: async () => {
    throw new Error("injected voter failure");
  },
};

const realVote: Impl["vote"] = (proposal, voterId, view, llm, sink, log, broken) =>
  castVote({ glue: new FixtureGlue(view, [proposal]), llm: broken ? failingLlm : llm.agentLlm(sink), log }, proposal, voterId);

const counterWith = (build: typeof realBuildCounter): Impl["counter"] => async (chain, view, s, llm, sink) => {
  const lines: string[] = [];
  const blocked = chain[chain.length - 1]!;
  const made = await build({ glue: new FixtureGlue(view, chain), llm: llm.agentLlm(sink), log: (line) => lines.push(line) }, blocked, chain);
  if (!made) return { proposal: null, note: lines.join("; ") || "buildCounter returned null with no log line" };
  return { proposal: makeProposal(s, view, made.proposal.to, blocked, made.proposal.rationale), explainedBy: made.explainedBy, note: lines.join("; ") || undefined };
};

export async function loadImpl(kind: string): Promise<Impl> {
  if (kind === "real") return { name: "REAL agent/counter.ts + REAL agent/vote.ts", vote: realVote, counter: counterWith(realBuildCounter) };
  if (kind === "patched") {
    // Proposed fixes measured before they are sent: a generated copy of agent/counter.ts in the ignored out/ folder.
    const { buildCounter: patched } = await import(join(import.meta.dir, "out", "counter.patched.ts"));
    return { name: "PATCHED copy of agent/counter.ts + REAL agent/vote.ts", vote: realVote, counter: counterWith(patched) };
  }
  throw new Error(`no adapter for ${kind}`);
}

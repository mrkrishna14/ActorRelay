// Binds the adversarial tables to a vote pipeline.
// Default target is the real agent/vote.ts. ADV_TARGET=naive runs the spec-literal control instead, to show the
// tests can fail. If the real module has not landed, tests are skipped, never passed.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentState, HistoryEvent, LearnedRule, Proposal, Vote } from "../../../shared/types";
import { naiveVote } from "./controls/naive-vote";

export type LlmFn = (prompt: string, attempt: number) => Promise<string>;

export type VoteCase = {
  proposal: Proposal;
  own: ComponentState;
  events: HistoryEvent[];
  rules?: LearnedRule[];
  llm: LlmFn;
  // Glue faults. When set, that fetch fails or returns this junk instead of the fixture.
  fail?: Partial<Record<"component" | "proposer" | "similar" | "rules" | "plant", "throw" | "http500" | { junk: unknown }>>;
};

export type VoteRun = { vote: Vote | null; prompts: string[]; logs?: string[]; threw: unknown };
export type Pipeline = (c: VoteCase) => Promise<VoteRun>;

const here = dirname(fileURLToPath(import.meta.url));
const REAL_VOTE = join(here, "..", "..", "vote.ts");

async function bindReal(): Promise<Pipeline | null> {
  if (!existsSync(REAL_VOTE)) return null;
  const { bindVote } = await import("./bind-vote");
  return bindVote();
}

function recording(llm: LlmFn, prompts: string[]): LlmFn {
  return (prompt, attempt) => {
    prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    return llm(prompt, attempt);
  };
}

const naive: Pipeline = async (c) => {
  const prompts: string[] = [];
  if (c.fail) {
    // The control has no fetch step; treat a fetch failure the way a careless pipeline would: empty results.
    const events = c.fail.similar ? [] : c.events;
    const rules = c.fail.rules ? [] : (c.rules ?? []);
    const vote = await naiveVote({ proposal: c.proposal, own: c.own, events, rules, llm: recording(c.llm, prompts) });
    return { vote, prompts, threw: undefined };
  }
  const vote = await naiveVote({ proposal: c.proposal, own: c.own, events: c.events, rules: c.rules ?? [], llm: recording(c.llm, prompts) });
  return { vote, prompts, threw: undefined };
};

export const TARGET = process.env.ADV_TARGET === "naive" ? "naive control" : "real agent/vote.ts";
export const pipeline: Pipeline | null = process.env.ADV_TARGET === "naive" ? naive : await bindReal();
export { recording };

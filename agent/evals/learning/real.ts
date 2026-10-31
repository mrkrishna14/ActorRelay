// Drives the real agent/vote.ts and agent/learn.ts with real LLM calls. World wraps the real actor logic functions;
// the actor process, glue, Relay and the plant are in-memory stand-ins, and observed values are generated.
import type { ComponentId, HistoryEvent, LearnedRule, PlantId, PlantState, Proposal, Vote, CalibrationEntry } from "../../../shared/types.ts";
import type { ComponentView, Glue, SimilarQuery } from "../../glue.ts";
import { callOpenAi, type Llm, type LlmReply, type LlmRequest } from "../../llm.ts";
import { RetrievalCache } from "../../retrieval.ts";
import { learnFromBlock, learnFromExecution } from "../../learn.ts";
import { castVote, type VoteDeps } from "../../vote.ts";
import { stats } from "./llm.ts";
import type { VoteRecord } from "./reference.ts";
import { World } from "./world.ts";

export class WorldGlue implements Glue {
  votes: Vote[] = [];
  constructor(readonly world: World) {}
  async component(id: ComponentId): Promise<ComponentView> {
    const c = this.world.components.get(id);
    if (!c) throw new Error(`unknown component ${id}`);
    return { ...structuredClone(c), calibration: this.world.calibration.get(id) ?? [] };
  }
  async similar(q: SimilarQuery): Promise<HistoryEvent[]> {
    return this.world.similar({ ...q, upstreamSnapshot: q.upstreamSnapshot ?? {} });
  }
  async rules(componentId: ComponentId): Promise<LearnedRule[]> {
    return this.world.rulesFor(componentId);
  }
  async plant(plantId: PlantId): Promise<PlantState> {
    const proposals = this.world.proposals.filter((p) => p.plantId === plantId);
    return { id: plantId, name: plantId, components: [], proposals, history: this.world.history[plantId], rules: this.world.plantRules[plantId], audit: [], tick: 0, connected: true };
  }
  async calibration(componentId: ComponentId, entry: CalibrationEntry) {
    this.world.addCalibration(componentId, entry);
  }
  async rule(rule: LearnedRule) {
    const home = (rule.condition.componentId ?? rule.consequence.componentId)!.split("/")[0] as PlantId;
    this.world.promote(rule, home);
  }
  async vote(vote: Vote) {
    this.votes.push(vote);
  }
  async counter() {}
}

// Vendors go to OpenAI while the Claude CLI is logged out, labelled exactly as the routed client labels it.
class CappedLlm implements Llm {
  private active = 0;
  private waiting: (() => void)[] = [];
  answered = 0;
  constructor(private readonly model: string, private readonly effort: string, private readonly cap: number) {}
  async complete(request: LlmRequest): Promise<LlmReply> {
    if (this.active >= this.cap) await new Promise<void>((res) => this.waiting.push(res));
    this.active++;
    try {
      const reply = await callOpenAi(request, this.model, this.effort);
      stats.calls++;
      this.answered++;
      return { ...reply, fallback: request.vendor === "claude" };
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

// Why vote attempts failed, reported by run.ts: a 429 and a parse rejection need different fixes.
export const attemptLog: string[] = [];

export async function load(model: { model: string; effort: string }, opts: { fastNoMs: number }) {
  const llm = new CappedLlm(model.model, model.effort, Number(process.env.LEARNING_CONCURRENCY ?? 24));
  const worlds = new WeakMap<World, { deps: VoteDeps; glue: WorldGlue }>();
  const wired = (world: World) => {
    let w = worlds.get(world);
    if (!w) {
      const glue = new WorldGlue(world);
      w = { glue, deps: { glue, llm, cache: new RetrievalCache(), fastNoMs: opts.fastNoMs, log: (line) => attemptLog.push(line) } };
      worlds.set(world, w);
    }
    return w;
  };

  return {
    label: `real-vote.ts+learn.ts-fastNo${opts.fastNoMs}`,
    cast: async (p: Proposal, id: ComponentId, world: World): Promise<VoteRecord> => {
      const started = performance.now();
      const { deps } = wired(world);
      const vote = await castVote(deps, p, id);
      const c = world.components.get(id)!;
      const said = vote.reason.match(/Agent said (yes|no):/)?.[1] as "yes" | "no" | undefined;
      const fast = vote.reason.startsWith("[decided from retrieved evidence");
      return {
        vote,
        retrieved: world.similar({ componentId: p.proposerComponentId, metric: p.metric, to: p.to, upstreamSnapshot: {}, k: 5 }),
        rules: world.companyRules,
        newest: world.newestExecution(p.proposerComponentId, p.metric),
        ms: performance.now() - started,
        forced: fast ? "fast-no" : vote.reason === "malformed prediction" ? "malformed" : vote.reason.includes("insufficient history") ? "insufficient" : null,
        llmVote: said ?? (vote.vote === "yes" ? "yes" : null),
        threshold: Object.fromEntries(Object.entries(c.limits).map(([m, l]) => [m, l.critical * (1 - c.marginPct / 100)])),
      };
    },
    onVotes: async (p: Proposal, votes: Vote[], world: World) => {
      const { glue, deps } = wired(world);
      await Promise.all(votes.map((v) => learnFromBlock({ glue, cache: deps.cache }, p, v)));
    },
    learn: async (_p: Proposal, _votes: Vote[], event: HistoryEvent, world: World) => {
      const { glue, deps } = wired(world);
      const owned = new Set(world.components.keys());
      await learnFromExecution({ glue, cache: deps.cache }, event, owned);
    },
  };
}

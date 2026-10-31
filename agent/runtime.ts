// The agents' reactions to Relay messages. Transport is injected, so tests and spawn.ts drive the same code.
import type { ComponentId, PlantId, Proposal } from "../shared/types";
import { buildCounter } from "./counter";
import type { Glue } from "./glue";
import { learnFromBlock, learnFromExecution } from "./learn";
import type { Llm } from "./llm";
import { RetrievalCache } from "./retrieval";
import { wireMessageSchema, type WireMessage } from "./schemas";
import { castVote } from "./vote";

/** Relay allows 20 s to reply and the actors expire at 30 s; anything older cannot be voted on. */
const MAX_PROPOSAL_AGE_MS = 30_000;
const BLOCK_POLL_MS = 800;
const BLOCK_WATCH_MS = 40_000;
const LEARN_TRIES = 3;
const LEARN_RETRY_MS = 1000;

export type Post = (message: WireMessage, channel: string, from: ComponentId) => Promise<void>;

export type RuntimeOptions = {
  glue: Glue;
  llm: Llm;
  post: Post;
  owned: ComponentId[];
  cache?: RetrievalCache;
  log?: (line: string) => void;
  fastNoMs?: number;
  pollMs?: number;
};

export const channelForVote = (proposal: Proposal, voter: ComponentId) => (voter.startsWith(`${proposal.plantId}/`) ? proposal.plantId : "company");

export class AgentRuntime {
  readonly cache: RetrievalCache;
  private readonly owned: Set<ComponentId>;
  private readonly seen = new Set<string>();
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly options: RuntimeOptions) {
    this.cache = options.cache ?? new RetrievalCache();
    this.owned = new Set(options.owned);
  }

  private get log() {
    return this.options.log ?? console.log;
  }

  /** Seeds the cache so a restarted process can still cite the newest run. */
  async warm(plants: PlantId[]) {
    await Promise.all(
      plants.map(async (id) => {
        const plant = await this.options.glue.plant(id);
        this.cache.addEvents(plant.history);
        plant.rules.forEach((rule) => this.cache.addRule(rule));
      }),
    );
  }

  /** Every Relay payload lands here. It is parsed and validated first, and anything else is dropped. */
  onMessage(raw: unknown): void {
    const parsed = wireMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.log(`dropped invalid relay message: ${parsed.error.issues[0]?.message}`);
      return;
    }
    const message = parsed.data;
    if (message.type === "proposal") this.track(this.onProposal(message.proposal));
    else if (message.type === "executed") this.track(this.onExecuted(message));
    else if (message.type === "rule") this.cache.addRule(message.rule);
  }

  /** Resolves once all work started so far has finished. */
  async drain() {
    while (this.inFlight.size) await Promise.all(this.inFlight);
  }

  private track(work: Promise<unknown>) {
    const guarded = work.catch((error) => this.log(`agent work failed: ${error instanceof Error ? error.message : error}`));
    this.inFlight.add(guarded);
    void guarded.finally(() => this.inFlight.delete(guarded));
  }

  private once(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  private async onProposal(proposal: Proposal) {
    const age = Date.now() - Date.parse(proposal.at);
    if (proposal.status !== "voting" || age > MAX_PROPOSAL_AGE_MS) return;
    const voters = proposal.requiredVoters.filter((id) => this.owned.has(id) && id !== proposal.proposerComponentId);
    const work: Promise<unknown>[] = voters.filter((id) => this.once(`vote|${proposal.id}|${id}`)).map((id) => this.voteAs(proposal, id));
    if (this.owned.has(proposal.proposerComponentId) && this.once(`watch|${proposal.id}`)) work.push(this.watchForBlock(proposal));
    await Promise.all(work);
  }

  private async voteAs(proposal: Proposal, voter: ComponentId) {
    const { glue, llm, post, fastNoMs } = this.options;
    const started = Date.now();
    const vote = await castVote({ glue, llm, cache: this.cache, fastNoMs, log: this.log }, proposal, voter);
    this.log(`${voter} voted ${vote.vote} on ${proposal.id} in ${Date.now() - started} ms`);
    await post({ type: "vote", vote }, channelForVote(proposal, voter), voter);
    await learnFromBlock({ glue, cache: this.cache, log: this.log }, proposal, vote).catch((error) => this.log(`rule check failed: ${error}`));
  }

  /** No Relay message announces a block, so the proposer watches its own proposal until it settles. */
  private async watchForBlock(proposal: Proposal) {
    const { glue, llm, post, pollMs } = this.options;
    const deadline = Date.now() + BLOCK_WATCH_MS;
    while (Date.now() < deadline) {
      await Bun.sleep(pollMs ?? BLOCK_POLL_MS);
      const plant = await glue.plant(proposal.plantId).catch(() => null);
      const current = plant?.proposals.find((p) => p.id === proposal.id);
      if (!plant || !current || current.status === "voting") continue;
      if (current.status !== "blocked" || !this.once(`counter|${proposal.id}`)) return;
      const counter = await buildCounter({ glue, llm, log: this.log }, current, plant.proposals);
      if (!counter) return;
      this.log(`${proposal.proposerComponentId} countered ${proposal.id} with ${counter.proposal.to} (${counter.decidedBy})`);
      await post({ type: "counter", parentProposalId: counter.parentProposalId, proposal: counter.proposal }, proposal.plantId, proposal.proposerComponentId);
      return;
    }
  }

  private async onExecuted(message: Extract<WireMessage, { type: "executed" }>) {
    if (!this.once(`executed|${message.proposalId}`)) return;
    for (let attempt = 1; ; attempt++) {
      try {
        const entries = await learnFromExecution({ glue: this.options.glue, cache: this.cache, log: this.log }, message.event, this.owned);
        return this.log(`calibrated ${entries.length} metrics for ${message.proposalId}`);
      } catch (error) {
        // learn.ts skips what is already recorded, so a retry after a partial failure repeats nothing.
        if (attempt >= LEARN_TRIES) throw error;
        this.log(`learning failed for ${message.proposalId}, retrying: ${error}`);
        await Bun.sleep(this.options.pollMs ?? LEARN_RETRY_MS);
      }
    }
  }
}

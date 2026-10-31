// In-memory Glue over one scenario, so the real vote.ts and counter.ts run with no services.
import type { ComponentId, LearnedRule, PlantId, PlantState, Proposal } from "../../../shared/types";
import type { Glue, SimilarQuery } from "../../glue";
import type { ProposalInput } from "../../schemas";
import { similar, type Plantview } from "./fixture";

export class FixtureGlue implements Glue {
  readonly posted: { parentProposalId: string; proposal: ProposalInput }[] = [];

  constructor(
    private readonly view: Plantview,
    private readonly proposals: Proposal[] = [],
  ) {}

  async component(id: ComponentId) {
    const found = [this.view.proposer, ...this.view.voters].find((c) => c.id === id);
    if (!found) throw new Error(`unknown component ${id}`);
    return found;
  }
  async similar(query: SimilarQuery) {
    return similar(this.view, query.to, query.k, query.upstreamSnapshot);
  }
  async rules(): Promise<LearnedRule[]> {
    return this.view.rules;
  }
  async plant(plantId: PlantId): Promise<PlantState> {
    return { id: plantId, name: plantId, components: [], proposals: this.proposals, history: this.view.history, rules: this.view.rules, audit: [], tick: 0, connected: true };
  }
  async calibration() {}
  async rule() {}
  async vote() {}
  async counter(parentProposalId: string, proposal: ProposalInput) {
    this.posted.push({ parentProposalId, proposal });
  }
}

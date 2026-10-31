// The only path to the simulator. Plant.claimDispatch hands out one token per proposal, so a repeated callback cannot
// write twice, and the value written is the one in the actor's execution record, never anything from a request.
import type { ComponentId, PlantId, PlantState, Proposal } from "../shared/types";
import { HttpError, plantOfProposal, type ActorPort } from "./actors";
import { SetpointFailed, type BridgePort, type Snapshot } from "./bridge";
import { dispatchClaimSchema } from "./contract";

const SET_METRIC_TRIES = 3;
const SET_METRIC_WAIT_MS = 300;
const CONFIRM_TRIES = 4;
const CONFIRM_WAIT_MS = 500;
const SAME_VALUE = 0.01;
const RESET_RUNNING = "dispatch refused while a reset runs";

type ComponentRead = { id: ComponentId; status: string; metrics: Record<string, number>; limits: Record<string, { min: number; max: number; critical: number }> };
type ExecutionRead = { state: string };

export type DispatchResult =
  | { dispatched: true; proposalId: string; componentId: ComponentId; metric: string; value: number; applied: number | null; recorded: boolean }
  | { dispatched: false; proposalId: string; state: string; reason?: string };

export type DispatchLogEntry = { at: string; proposalId: string; componentId: ComponentId; metric: string; value: number; ok: boolean; detail: string };

export class Dispatcher {
  private readonly inflight = new Map<string, Promise<DispatchResult>>();
  private readonly upstream = new Map<string, Record<string, number>>();
  /** Every /setpoint attempted, newest last, so a double write would be visible from /health. */
  readonly log: DispatchLogEntry[] = [];

  constructor(
    private readonly actors: ActorPort,
    private readonly bridge: BridgePort,
    private readonly isResetting: () => boolean,
    private readonly say: (line: string) => void = console.log,
  ) {}

  run(proposalId: string): Promise<DispatchResult> {
    const running = this.inflight.get(proposalId);
    if (running) return running;
    if (this.isResetting()) return Promise.reject(new HttpError(503, RESET_RUNNING));
    const work = this.dispatch(proposalId).finally(() => this.inflight.delete(proposalId));
    this.inflight.set(proposalId, work);
    return work;
  }

  /** Resolves when every dispatch already running has finished. */
  async idle() {
    while (this.inflight.size) await Promise.allSettled(this.inflight.values());
  }

  /** What the plant looked like when the command went out, for the history event. */
  upstreamFor(proposalId: string) {
    return this.upstream.get(proposalId);
  }

  clear() {
    this.upstream.clear();
    this.log.length = 0;
  }

  private async dispatch(proposalId: string): Promise<DispatchResult> {
    const plantId = plantOfProposal(proposalId);
    const execution = await this.actors.call<ExecutionRead>("Plant", plantId, "execute", [proposalId]);
    if (execution.state !== "accepted") return { dispatched: false, proposalId, state: execution.state };

    const proposal = await this.proposal(plantId, proposalId);
    const proposer = await this.actors.call<ComponentRead>("Component", proposal.proposerComponentId, "getState");
    const voters = await Promise.all(proposal.requiredVoters.map((id) => this.actors.call<ComponentRead>("Component", id, "getState")));
    const live = await this.bridge.snapshot(plantId).catch(() => null);

    const refusal = preflight(proposal, proposer, voters);
    if (refusal) return this.refuse(plantId, proposalId, refusal);

    // Plant compares this with proposal.from and fails the execution itself if the plant has moved.
    const measured = live?.[proposal.proposerComponentId]?.[proposal.metric] ?? proposer.metrics[proposal.metric];
    const parsed = dispatchClaimSchema.safeParse(await this.actors.call("Plant", plantId, "claimDispatch", [proposalId, measured]));
    if (!parsed.success) return this.refuse(plantId, proposalId, "claimDispatch returned no usable token");
    const claim = parsed.data;
    if (!claim.dispatch) return { dispatched: false, proposalId, state: claim.state };

    this.upstream.set(proposalId, upstreamSnapshot(proposal, live, proposer, voters));
    const { componentId, metric, value, token } = claim;
    let applied: number | null;
    try {
      ({ applied } = await this.bridge.setpoint({ componentId, metric, value, proposalId }));
      this.record(proposalId, componentId, metric, value, true, `applied ${applied ?? "not reported"}`);
    } catch (error) {
      const failed = error instanceof SetpointFailed ? error : new SetpointFailed(String(error), false);
      this.record(proposalId, componentId, metric, value, false, failed.message);
      if (failed.refused) {
        await this.actors.call("Plant", plantId, "reportDispatchFailure", [proposalId, failed.message]);
        return { dispatched: false, proposalId, state: "failed", reason: failed.message };
      }
      // No answer: the write may have landed, so it is neither sent again nor reverted. Plant holds the claim, and a
      // reading of the new value or a later /observed settles it.
      if (!(await this.landed(plantId, componentId, metric, value))) return { dispatched: false, proposalId, state: "unknown", reason: failed.message };
      applied = value;
      this.record(proposalId, componentId, metric, value, true, "confirmed from a simulator reading after no answer");
    }
    if (applied !== null && Math.abs(applied - value) > 1e-6) this.say(`dispatch ${proposalId}: simulator applied ${applied}, claim was ${value}`);
    return { dispatched: true, proposalId, componentId, metric, value, applied, recorded: await this.setMetric(componentId, metric, value, proposalId, token) };
  }

  private async proposal(plantId: PlantId, proposalId: string): Promise<Proposal> {
    const plant = await this.actors.call<PlantState>("Plant", plantId, "getState");
    const proposal = plant.proposals.find((item) => item.id === proposalId);
    if (!proposal) throw new HttpError(404, `proposal_not_found: ${proposalId}`);
    return proposal;
  }

  private async refuse(plantId: PlantId, proposalId: string, reason: string): Promise<DispatchResult> {
    this.say(`dispatch ${proposalId} refused: ${reason}`);
    await this.actors.call("Plant", plantId, "reportDispatchFailure", [proposalId, reason]);
    return { dispatched: false, proposalId, state: "failed", reason };
  }

  private async landed(plantId: PlantId, componentId: ComponentId, metric: string, value: number): Promise<boolean> {
    for (let attempt = 1; attempt <= CONFIRM_TRIES; attempt++) {
      const reading = await this.bridge.snapshot(plantId).then((snapshot) => snapshot[componentId]?.[metric]).catch(() => undefined);
      if (reading !== undefined && Math.abs(reading - value) <= SAME_VALUE) return true;
      if (attempt < CONFIRM_TRIES) await Bun.sleep(CONFIRM_WAIT_MS);
    }
    return false;
  }

  /** The simulator already moved, so this retries; setMetric is safe to repeat because the token burns only on success. */
  private async setMetric(componentId: ComponentId, metric: string, value: number, proposalId: string, token: string): Promise<boolean> {
    for (let attempt = 1; attempt <= SET_METRIC_TRIES; attempt++) {
      try {
        await this.actors.call("Component", componentId, "setMetric", [metric, value, proposalId, token]);
        return true;
      } catch (error) {
        this.say(`setMetric ${proposalId} attempt ${attempt}: ${error instanceof Error ? error.message : error}`);
        if (attempt < SET_METRIC_TRIES) await Bun.sleep(SET_METRIC_WAIT_MS * attempt);
      }
    }
    return false;
  }

  private record(proposalId: string, componentId: ComponentId, metric: string, value: number, ok: boolean, detail: string) {
    this.log.push({ at: new Date().toISOString(), proposalId, componentId, metric, value, ok, detail });
    if (this.log.length > 50) this.log.shift();
  }
}

/** Last checks at the write path, on live readings the actors do not compare. Returns why to refuse, or null. */
export function preflight(proposal: Proposal, proposer: ComponentRead, voters: ComponentRead[]): string | null {
  const limit = proposer.limits[proposal.metric];
  if (!limit) return `${proposal.proposerComponentId} has no limit for ${proposal.metric}`;
  if (proposal.to > limit.max) return `${proposal.metric} ${proposal.to} is above its operating max ${limit.max}`;
  const critical = voters.find((voter) => voter.status === "critical");
  return critical ? `required voter ${critical.id} is critical` : null;
}

function upstreamSnapshot(proposal: Proposal, live: Snapshot | null, proposer: ComponentRead, voters: ComponentRead[]): Record<string, number> {
  const steamId = `${proposal.plantId}/TV-101`;
  const feed = live?.[proposal.proposerComponentId]?.feedM3h ?? proposer.metrics.feedM3h;
  const header = live?.[steamId]?.headerBarg ?? voters.find((voter) => voter.id === steamId)?.metrics.headerBarg;
  return { ...(feed === undefined ? {} : { feedM3h: feed }), ...(header === undefined ? {} : { headerBarg: header }) };
}

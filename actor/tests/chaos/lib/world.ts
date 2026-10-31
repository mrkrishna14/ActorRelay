// Drives the published ActorRelay actors over the real runtime, and plays glue's part of the execute flow
// exactly as ar-actors published it on the board at 12:29. FAKE: this file stands in for glue and the bridge.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GlueCall } from "./fakeGlue";
import type { Ctx } from "./scenario";
import { hostPid, sleep, until } from "./server";

export const componentActorId = (id: string) => id.replace("/", ".");
export const COMPANY = "company";

export type SimCommand = { atEpochMs: number; proposalId: string; componentId: string; metric: string; value: number; attempt: number };

export type GlueFlowHooks = {
  /** Runs after Plant.execute accepted, before claimDispatch. */
  beforeClaim?: (call: GlueCall) => Promise<void>;
  /** Runs after claimDispatch said dispatch, before the simulation command. */
  beforeSetpoint?: (call: GlueCall) => Promise<void>;
  /** Runs after the simulation accepted the command, before setMetric. */
  afterSetpoint?: (call: GlueCall) => Promise<void>;
  /** Simulation refuses the command, which must route to reportDispatchFailure. */
  setpointFails?: boolean;
};

const plantOfProposal = (proposalId: string) => /^(plant-[a-z0-9]+)-p\d+-/.exec(proposalId)?.[1] ?? "plant-a";

export class World {
  seed: any;
  sim: SimCommand[] = [];
  executes: { proposalId: string; ok: boolean; error?: string }[] = [];
  claims: { proposalId: string; dispatch: boolean | null; error?: string; attempt: number }[] = [];
  setMetricResults: { proposalId: string; ok: boolean; error?: string }[] = [];
  hooks: GlueFlowHooks = {};

  constructor(readonly ctx: Ctx) {
    this.seed = JSON.parse(readFileSync(join(ctx.config.projectDir, "..", "shared", "plants.json"), "utf8"));
  }

  plant(id: string) {
    return this.seed.plants.find((plant: any) => plant.id === id);
  }

  /** Two seeded incident events per plant, so one live event is the third sighting that promotes a rule. */
  history(plantId: string): any[] {
    return [0, 1].map((index) => ({
      id: `chaos-seed-${plantId}-${index}`,
      at: new Date(Date.now() - 3_600_000 + index * 60_000).toISOString(),
      plantId,
      componentId: `${plantId}/P-100`,
      metric: "speedPct",
      before: 50,
      after: 85,
      upstreamSnapshot: { feedM3h: 15 },
      effects: [{ componentId: `${plantId}/LV-101`, metric: "positionPct", before: 50, after: 92, ticksToSettle: 3 }],
      incident: "chaos fixture: LV-101 near saturation",
      approvedBy: [],
      operator: "chaos-fixture",
      proposalId: null,
    }));
  }

  /** Published reset order: Company, then Plants, then Components. Plants register themselves with Company. */
  async seedAll(): Promise<void> {
    const { client } = this.ctx;
    await client.call("Company", COMPANY, "loadSeed", [{ ...this.seed.company, rules: [], crossPlantProposals: [], audit: [] }]);
    for (const plant of this.seed.plants) await client.call("Plant", plant.id, "loadSeed", [plant, this.history(plant.id)]);
    for (const plant of this.seed.plants) {
      for (const component of plant.components) {
        await client.call("Component", componentActorId(component.id), "loadSeed", [{ ...component, lastTick: new Date().toISOString() }]);
      }
    }
  }

  /** Fake executor for the two outbound routes the Plant uses. Mirrors ar-actors' 12:33 flow on the board. */
  installGlue(): void {
    const { glue } = this.ctx;
    glue.on("/tick", { kind: "ok" });
    glue.on("/execute-callback", {
      kind: "fn",
      fn: async (call) => {
        await this.onExecuteCallback(call);
        return Response.json({ ok: true });
      },
    });
  }

  /** execute, then claimDispatch, then the one simulation command, then setMetric. */
  async onExecuteCallback(call: GlueCall): Promise<void> {
    const { client } = this.ctx;
    const proposalId = (call.body as any).proposalId as string;
    const plantId = plantOfProposal(proposalId);
    const attempt = this.claims.filter((claim) => claim.proposalId === proposalId).length;
    try {
      await client.call("Plant", plantId, "execute", [proposalId]);
      this.executes.push({ proposalId, ok: true });
    } catch (error: any) {
      this.executes.push({ proposalId, ok: false, error: String(error?.message ?? error) });
      return;
    }
    await this.hooks.beforeClaim?.(call);
    let claim: any;
    try {
      claim = await client.call("Plant", plantId, "claimDispatch", [proposalId]);
      this.claims.push({ proposalId, dispatch: claim?.dispatch === true, attempt });
    } catch (error: any) {
      this.claims.push({ proposalId, dispatch: null, error: String(error?.message ?? error), attempt });
      return;
    }
    if (claim?.dispatch !== true) return;
    await this.hooks.beforeSetpoint?.(call);
    if (this.hooks.setpointFails) {
      await client.invoke("Plant", plantId, "reportDispatchFailure", [proposalId, "chaos: simulator refused the setpoint"]);
      return;
    }
    this.sim.push({ atEpochMs: Date.now(), proposalId, componentId: claim.componentId, metric: claim.metric, value: claim.value, attempt });
    await this.hooks.afterSetpoint?.(call);
    try {
      await client.call("Component", componentActorId(claim.componentId), "setMetric", [claim.metric, claim.value, proposalId, claim.token]);
      this.setMetricResults.push({ proposalId, ok: true });
    } catch (error: any) {
      this.setMetricResults.push({ proposalId, ok: false, error: String(error?.message ?? error) });
    }
  }

  commandsFor(proposalId: string): SimCommand[] {
    return this.sim.filter((command) => command.proposalId === proposalId);
  }

  async propose(plantId = "plant-a", to = 65, metric = "speedPct"): Promise<any> {
    const proposal = await this.ctx.client.call("Plant", plantId, "propose", [
      { proposerComponentId: `${plantId}/P-100`, metric, to, rationale: "chaos scenario proposal" },
    ]);
    return proposal?.proposal ?? proposal;
  }

  vote(proposal: any, componentId: string, vote: "yes" | "no" = "yes"): any {
    const component = this.seed.plants.flatMap((plant: any) => plant.components).find((item: any) => item.id === componentId);
    const predicted = Object.fromEntries(Object.keys(component.limits).map((metric) => [metric, component.metrics[metric]]));
    // similarCount above zero: Plant turns a zero-history yes near a critical limit into a no, and TK-101 sits there.
    return {
      proposalId: proposal.id,
      componentId,
      agentId: `agent:${componentId}`,
      vote,
      reason: vote === "yes" ? "chaos vote: within envelope" : "chaos vote: over threshold",
      predicted,
      marginPct: 10,
      evidenceEventIds: this.history(proposal.plantId).map((event) => event.id),
      evidenceRuleIds: [],
      similarCount: 2,
    };
  }

  async castVote(proposal: any, componentId: string, vote: "yes" | "no" = "yes"): Promise<any> {
    return await this.ctx.client.call("Plant", proposal.plantId, "vote", [this.vote(proposal, componentId, vote)]);
  }

  async castVotes(proposal: any, voters: string[]): Promise<void> {
    for (const voter of voters) await this.castVote(proposal, voter);
  }

  async plantState(plantId = "plant-a"): Promise<any> {
    return await this.ctx.client.call("Plant", plantId, "getState");
  }

  async proposal(plantId: string, id: string): Promise<any> {
    const state = await this.plantState(plantId);
    return state.proposals.find((item: any) => item.id === id);
  }

  /** Reads through the mailbox, so a wedged actor shows up here as a timeout. */
  async waitStatus(plantId: string, id: string, statuses: string[], timeoutMs: number): Promise<any> {
    return await until(
      async () => {
        const outcome = await this.ctx.client.invoke("Plant", plantId, "getState", [], 15_000);
        if (outcome.kind !== "completed") return undefined;
        const found = outcome.result.proposals.find((item: any) => item.id === id);
        return found && statuses.includes(found.status) ? found : undefined;
      },
      timeoutMs,
      200,
    );
  }

  /** Durable facts, read with no side effects. Audit and history are compared as sets of ids plus counts. */
  async durable(): Promise<Durable> {
    const { client } = this.ctx;
    const plants: Record<string, any> = {};
    for (const id of ["plant-a", "plant-b"]) plants[id] = await client.call("Plant", id, "getState");
    const components: Record<string, any> = {};
    for (const plant of this.seed.plants) {
      for (const component of plant.components) {
        components[component.id] = await client.call("Component", componentActorId(component.id), "getState");
      }
    }
    const company = await client.call("Company", COMPANY, "getState");
    return { plants, components, company };
  }

  /** One Plant only, cheap enough to read inside a vote window on a loaded machine. */
  async durablePlant(plantId = "plant-a"): Promise<Durable> {
    return { plants: { [plantId]: await this.plantState(plantId) }, components: {}, company: { rules: [], audit: [] } };
  }

  /** Everything acknowledged before the crash must still be present after it. New entries are allowed. */
  checkIntact(before: Durable, after: Durable, label: string): void {
    const { ctx } = this;
    for (const id of Object.keys(before.plants)) {
      const old = before.plants[id];
      const now = after.plants[id];
      ctx.check(`${label}: ${id} history intact`, subset(old.history.map(eventKey), now.history.map(eventKey)), counts(old.history, now.history));
      ctx.check(`${label}: ${id} rules intact`, subset(old.rules.map(ruleKey), now.rules.map(ruleKey)), counts(old.rules, now.rules));
      ctx.check(`${label}: ${id} audit intact`, subset(old.audit.map(auditKey), now.audit.map(auditKey)), counts(old.audit, now.audit));
      for (const proposal of old.proposals) {
        const current = now.proposals.find((item: any) => item.id === proposal.id);
        ctx.check(`${label}: ${id} proposal ${proposal.id} present`, Boolean(current));
        if (!current) continue;
        ctx.check(
          `${label}: ${id} ${proposal.id} acknowledged votes intact`,
          subset(proposal.votes.map((vote: any) => JSON.stringify(vote)), current.votes.map((vote: any) => JSON.stringify(vote))),
          `${proposal.votes.length} -> ${current.votes.length}`,
        );
        ctx.equal(`${label}: ${id} ${proposal.id} no duplicate voter`, new Set(current.votes.map((vote: any) => vote.componentId)).size, current.votes.length);
        ctx.check(`${label}: ${id} ${proposal.id} vetoDeadline preserved`, !proposal.vetoDeadline || proposal.vetoDeadline === current.vetoDeadline, `${proposal.vetoDeadline} -> ${current.vetoDeadline}`);
      }
      ctx.equal(`${label}: ${id} no duplicate history ids`, duplicates(now.history.map((event: any) => event.id)), []);
      ctx.equal(`${label}: ${id} no duplicate rule ids`, duplicates(now.rules.map((rule: any) => rule.id)), []);
    }
    for (const [id, component] of Object.entries<any>(before.components)) {
      const now = after.components[id];
      ctx.check(`${label}: ${id} calibration intact`, subset(component.calibration.map(jsonKey), now.calibration.map(jsonKey)), counts(component.calibration, now.calibration));
      if (component.marginPct !== now.marginPct) ctx.note(`${label}: ${id} marginPct ${component.marginPct} -> ${now.marginPct}`);
    }
    ctx.check(`${label}: company rules intact`, subset(before.company.rules.map(ruleKey), after.company.rules.map(ruleKey)), counts(before.company.rules, after.company.rules));
    ctx.check(`${label}: company audit intact`, subset(before.company.audit.map(auditKey), after.company.audit.map(auditKey)), counts(before.company.audit, after.company.audit));
    ctx.equal(`${label}: no duplicate company rule ids`, duplicates(after.company.rules.map((rule: any) => rule.id)), []);
  }

  /** Stage by stage, per plant: does the tick come back alone, after a dashboard read, or only after tick()?
   *  `tickAtKill` must be read just before the kill. /tick carries no plant id, so arrivals at glue are the direct
   *  evidence for the whole server, and the persisted counter, read only after each silence, is the per-plant view. */
  async checkTickResumes(label: string, plantId: string, tickAtKill: number, restartedAt: number, silentMs = 5_000): Promise<string> {
    const { ctx } = this;
    const readTick = async () => (await this.plantState(plantId)).tick as number;
    const arrivals = () => ctx.glue.of("/tick").filter((call) => call.atEpochMs > restartedAt);
    await sleep(silentMs);
    const quietArrivals = arrivals().length;
    const afterSilence = await readTick();
    // A tick in flight at the kill can still land, so the counter alone proves nothing: arrivals must have happened.
    let stage = "never";
    if (quietArrivals > 0 && afterSilence > tickAtKill + 2) stage = "alone";
    else {
      await sleep(4_000);
      const afterRead = await readTick();
      if (afterRead > afterSilence) stage = "after_read";
      else {
        await ctx.client.invoke("Plant", plantId, "tick");
        await sleep(4_000);
        if ((await readTick()) > afterRead + 1) stage = "after_tick";
      }
    }
    const first = arrivals()[0];
    if (first) ctx.metric(`${label}.firstTickAfterRestartMs`, first.atEpochMs - restartedAt);
    ctx.note(`${label}: ${plantId} tick ${tickAtKill} at kill, ${afterSilence} after ${silentMs}ms of silence, ${quietArrivals} /tick arrivals in that silence; resumed: ${stage}`);
    ctx.check(`${label}: ${plantId} tick resumes with no outside call`, stage === "alone", stage);
    ctx.check(`${label}: ${plantId} tick resumes at all`, stage !== "never", stage);
    if (stage !== "never") {
      const before = await readTick();
      await sleep(3_000);
      const after = await readTick();
      ctx.check(`${label}: ${plantId} tick counter keeps advancing`, after > before, `${before} -> ${after}`);
    }
    return stage;
  }

  /** SIGSTOP on an actor's host parks it mid-call, which gives a repeatable crash point on the real runtime. */
  async hostOf(actor: string, id: string): Promise<number | null> {
    await this.ctx.client.call(actor, id, "getState");
    return hostPid(this.ctx.server.pgid, actor, id);
  }
}

export type Durable = { plants: Record<string, any>; components: Record<string, any>; company: any };

const eventKey = (event: any) => event.id;
const ruleKey = (rule: any) => rule.id;
const auditKey = (entry: any) => JSON.stringify([entry.at, entry.kind, entry.refId, entry.by]);
const jsonKey = (value: unknown) => JSON.stringify(value);
const counts = (before: unknown[], after: unknown[]) => `${before.length} -> ${after.length}`;

function subset(small: string[], large: string[]): boolean {
  const set = new Set(large);
  return small.every((item) => set.has(item));
}

export function duplicates(items: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const item of items) (seen.has(item) ? repeated : seen).add(item);
  return [...repeated];
}

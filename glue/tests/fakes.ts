// TEST FAKES. Unit tests drive the real Glue class and its real routes; only the actors, the simulator and Relay are these
// in-memory stand-ins. Nothing here proves anything about real Terse, the real bridge or real Relay. e2e.ts does that.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEvent, LearnedRule, PlantId, PlantState, Proposal, Vote } from "../../shared/types";
import { HttpError, type ActorKind, type ActorPort } from "../actors";
import { Glue } from "../app";
import type { BridgePort, SetpointBody, Snapshot } from "../bridge";
import type { PublishType, RelayPort } from "../relay";

export const repoRoot = join(import.meta.dir, "..", "..");
const plantsFile = JSON.parse(readFileSync(join(repoRoot, "shared", "plants.json"), "utf8"));
export const allComponents: { id: string }[] = plantsFile.plants.flatMap((plant: { components: { id: string }[] }) => plant.components);

export type Call = { kind: ActorKind; id: string; method: string; args: unknown[] };
type Handler = (id: string, args: unknown[]) => unknown;

export const PROPOSAL_ID = "plant-a-p00001-abcd1234";

export function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: PROPOSAL_ID,
    at: "2026-10-31T20:00:00.000Z",
    plantId: "plant-a",
    proposerComponentId: "plant-a/P-100",
    proposerAgentId: "agent:plant-a/P-100",
    metric: "speedPct",
    from: 50,
    to: 65,
    rationale: "Test.",
    requiredVoters: ["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101", "plant-b/TV-101"],
    votes: [],
    status: "executed",
    vetoDeadline: null,
    parentProposalId: null,
    crossPlant: true,
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    id: "event-1",
    at: "2026-10-31T20:00:00.000Z",
    plantId: "plant-a",
    componentId: "plant-a/P-100",
    metric: "speedPct",
    before: 50,
    after: 65,
    upstreamSnapshot: {},
    effects: [{ componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: 66, ticksToSettle: 3 }],
    incident: null,
    approvedBy: [],
    operator: null,
    proposalId: null,
    ...overrides,
  };
}

export function makeVote(overrides: Partial<Vote> = {}): Vote {
  return {
    proposalId: PROPOSAL_ID,
    componentId: "plant-a/LV-101",
    agentId: "agent:plant-a/LV-101",
    vote: "no",
    reason: "Predicted past the threshold.",
    predicted: { positionPct: 89 },
    marginPct: 10,
    evidenceEventIds: ["event-1"],
    evidenceRuleIds: [],
    similarCount: 3,
    ...overrides,
  };
}

export function makeRule(overrides: Partial<LearnedRule> = {}): LearnedRule {
  return {
    id: "rule-1",
    scope: "plant",
    model: "outlet-valve-A",
    text: "P-100 speedPct >= 80 -> LV-101 positionPct >= 85 within 3 ticks, seen 3 times",
    condition: { componentId: "plant-a/P-100", metric: "speedPct", op: ">=", value: 80 },
    consequence: { componentId: "plant-a/LV-101", metric: "positionPct", op: ">=", value: 85, withinTicks: 3 },
    supportEventIds: ["event-1", "event-2", "event-3"],
    timesSeen: 3,
    createdAt: "2026-10-31T20:00:00.000Z",
    lastSeenAt: "2026-10-31T20:00:00.000Z",
    ...overrides,
  };
}

export function makeComponent(id: string, overrides: Record<string, unknown> = {}) {
  const seeded = allComponents.find((component) => component.id === id);
  return { ...seeded, calibration: [], ...overrides };
}

/** Records every call in order. A test overrides one `Kind.method` to script an answer or a refusal. */
export class FakeActors implements ActorPort {
  calls: Call[] = [];
  proposal = makeProposal();
  claims = 0;
  components: Record<string, Record<string, unknown>> = {};
  handlers: Record<string, Handler> = {
    "Plant.getState": (id) => this.plant(id as PlantId),
    "Plant.execute": () => ({ state: this.claims === 0 ? "accepted" : "claimed" }),
    "Plant.claimDispatch": () => {
      this.claims += 1;
      if (this.claims > 1) return { dispatch: false, proposalId: this.proposal.id, state: "claimed" };
      return { dispatch: true, proposalId: this.proposal.id, componentId: "plant-a/P-100", metric: "speedPct", value: 65, token: "one-time-token" };
    },
    "Plant.reportDispatchFailure": () => ({ state: "failed" }),
    "Plant.propose": () => makeProposal({ status: "voting" }),
    "Plant.vote": () => makeProposal({ status: "voting" }),
    "Plant.veto": () => makeProposal({ status: "vetoed" }),
    "Plant.recordEvent": () => makeEvent({ id: `event-${PROPOSAL_ID}`, proposalId: PROPOSAL_ID }),
    "Plant.promoteRule": (_id, args) => args[0],
    "Plant.similar": () => [makeEvent()],
    "Plant.rulesFor": () => [makeRule()],
    "Plant.loadSeed": () => ({ components: 5, history: 0, rules: 0 }),
    "Company.getState": () => ({ plants: ["plant-a", "plant-b"], sharedResources: [], rules: [], crossPlantProposals: [], audit: [] }),
    "Company.loadSeed": () => ({}),
    "Component.getState": (id) => this.components[id] ?? makeComponent(id.replaceAll(".", "/")),
    "Component.mirror": (id) => makeComponent(id),
    "Component.setMetric": (id) => makeComponent(id),
    "Component.addCalibration": (id) => makeComponent(id),
    "Component.loadSeed": (id) => makeComponent(id),
  };

  plant(id: PlantId): PlantState {
    return { id, name: id, components: ["x"], proposals: [this.proposal], history: [], rules: [], audit: [], tick: 1, connected: true };
  }

  async call<T>(kind: ActorKind, id: string, method: string, args: unknown[] = []): Promise<T> {
    this.calls.push({ kind, id, method, args });
    const handler = this.handlers[`${kind}.${method}`];
    if (!handler) throw new HttpError(503, `no fake for ${kind}.${method}`);
    return (await handler(id, args)) as T;
  }

  named(method: string) {
    return this.calls.filter((call) => call.method === method);
  }

  order() {
    return this.calls.map((call) => `${call.kind}.${call.method}`);
  }
}

export class FakeBridge implements BridgePort {
  writes: SetpointBody[] = [];
  resets = 0;
  snapshots = 0;
  failWrite: Error | null = null;
  failReset = false;
  snapshotBody: (plantId: PlantId) => Snapshot = (plantId) => {
    const snapshot: Snapshot = {};
    snapshot[`${plantId}/P-100`] = { speedPct: 50, feedM3h: 15 };
    snapshot[`${plantId}/TV-101`] = { positionPct: 50, steamKgH: 1533, headerBarg: 6 };
    return snapshot;
  };

  async snapshot(plantId: PlantId) {
    this.snapshots += 1;
    return this.snapshotBody(plantId);
  }

  async setpoint(body: SetpointBody) {
    this.writes.push(body);
    if (this.failWrite) throw this.failWrite;
    return { applied: body.value };
  }

  async reset() {
    this.resets += 1;
    if (this.failReset) throw new Error("bridge down");
  }
}

export class FakeRelay implements RelayPort {
  sent: { type: PublishType; payload: any; channels: readonly string[]; ref: string }[] = [];

  async publish(type: PublishType, payload: unknown, channels: readonly string[], ref: string) {
    this.sent.push({ type, payload, channels, ref });
    return true;
  }

  status() {
    return { connected: true, error: null, published: [] };
  }
}

export function build(options: { repoRoot?: string } = {}) {
  const actors = new FakeActors();
  const bridge = new FakeBridge();
  const relay = new FakeRelay();
  const lines: string[] = [];
  const glue = new Glue({ actors, bridge, relay, config: { repoRoot: options.repoRoot ?? repoRoot, wakeMs: 1000, allowedOrigins: [] }, log: (line) => lines.push(line) });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    glue.handle(new Request(`http://glue${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  const get = (path: string, headers: Record<string, string> = {}) => glue.handle(new Request(`http://glue${path}`, { headers }));
  return { actors, bridge, relay, glue, post, get, lines };
}

/** A repo root with plants.json and only the stand-in history, or with the real file too. */
export function tempRepo(withRealHistory: boolean) {
  const root = mkdtempSync(join(tmpdir(), "glue-test-"));
  mkdirSync(join(root, "shared"), { recursive: true });
  mkdirSync(join(root, "actor", "tests", "fixtures-gen"), { recursive: true });
  writeFileSync(join(root, "shared", "plants.json"), readFileSync(join(repoRoot, "shared", "plants.json")));
  writeFileSync(join(root, "actor", "tests", "fixtures-gen", "history.json"), JSON.stringify([makeEvent({ id: "standin-1" })]));
  if (withRealHistory) writeFileSync(join(root, "shared", "history.json"), JSON.stringify([makeEvent({ id: "real-1" }), makeEvent({ id: "real-2", plantId: "plant-b" })]));
  return root;
}

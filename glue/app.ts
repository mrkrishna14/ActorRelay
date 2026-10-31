// The HTTP surface of TASK3.MD. Routes validate and forward; every decision about a plant is made in an actor or an agent.
import type { ComponentId, HistoryEvent, LearnedRule, PlantId, Proposal, Vote } from "../shared/types";
import { HttpError, plantOfComponent, plantOfProposal, readWithRetry, type ActorPort } from "./actors";
import type { BridgePort } from "./bridge";
import { COMPANY_ACTOR_ID, PLANT_IDS, type GlueConfig } from "./config";
import { Dispatcher } from "./dispatch";
import { MirrorPump } from "./mirror";
import { compactPlant, Reads } from "./reads";
import type { Inbound, RelayPort } from "./relay";
import { plantIdSchema, routeSchemas, rulesQuerySchema, similarQuerySchema, type ProposalInput, type Route, type RouteBody } from "./contract";
import { loadSeed, type SeedInfo } from "./seed";

export type GlueDeps = {
  actors: ActorPort;
  bridge: BridgePort;
  relay: RelayPort;
  config: Pick<GlueConfig, "repoRoot" | "wakeMs" | "allowedOrigins">;
  log?: (line: string) => void;
};

const SEED_TIMEOUT_MS = 20_000;
const VOTE_TIMEOUT_MS = 6000;
const OBSERVED_TIMEOUT_MS = 6000;
/** Plant's callback gives up after 1.5 s, so a slower dispatch answers 202 and keeps running. */
const CALLBACK_REPLY_MS = 1000;
/** The simulator's push gives up after 0.9 s; it should not count a busy actor as a dead glue. */
const MIRROR_REPLY_MS = 500;
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const COMPONENT_ROUTE = "/component/";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class Glue {
  private readonly actors: ActorPort;
  private readonly bridge: BridgePort;
  private readonly relay: RelayPort;
  private readonly config: GlueDeps["config"];
  private readonly say: (line: string) => void;
  private readonly componentIds: ComponentId[];
  readonly reads: Reads;
  readonly mirror: MirrorPump;
  readonly dispatcher: Dispatcher;

  private resetting = false;
  private waking = false;
  private actorsUp = false;
  private ticks = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seedInfo: SeedInfo;
  private readonly votes = new Set<string>();
  private readonly announced = new Map<string, string>();

  constructor(deps: GlueDeps) {
    this.actors = deps.actors;
    this.bridge = deps.bridge;
    this.relay = deps.relay;
    this.config = deps.config;
    this.say = deps.log ?? console.log;
    const seed = loadSeed(deps.config.repoRoot);
    this.componentIds = seed.plantsFile.plants.flatMap((plant) => plant.components.map((component) => component.id));
    this.seedInfo = seed.info;
    this.reads = new Reads(this.actors, () => this.componentIds);
    this.mirror = new MirrorPump(this.actors, this.bridge, (state) => this.reads.remember(state));
    this.dispatcher = new Dispatcher(this.actors, this.bridge, () => this.resetting, this.say);
  }

  /**
   * A restart of the actor server loses every alarm, and a Plant re-arms only when called. So glue reads both Plants
   * itself, whether or not a page is open, and treats refused connections as normal while the server rebuilds.
   */
  start() {
    void this.wake();
    this.timer = setInterval(() => void this.wake(), this.config.wakeMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async wake() {
    if (this.waking || this.resetting) return;
    this.waking = true;
    try {
      const reads = await Promise.allSettled(PLANT_IDS.map((id) => this.reads.plant(id)));
      const up = reads.every((read) => read.status === "fulfilled");
      if (up !== this.actorsUp) this.say(up ? "actors reachable" : `actors unreachable: ${message((reads.find((read) => read.status === "rejected") as PromiseRejectedResult).reason)}`);
      this.actorsUp = up;
      const company = await this.reads.company().catch(() => null);
      if (company) this.announce(company.rules);
      await this.mirror.poll();
    } finally {
      this.waking = false;
    }
  }

  /** Company rules appear when a Plant flushes them on its own sweep, so they are noticed here and posted on `company`. */
  private announce(rules: LearnedRule[]) {
    for (const rule of rules) {
      const version = `${rule.timesSeen}|${rule.lastSeenAt}`;
      if (this.announced.get(rule.id) === version) continue;
      this.announced.set(rule.id, version);
      void this.relay.publish("rule", { rule }, ["company"], `${rule.id}:${version}`);
    }
  }

  private services() {
    return { actors: this.actorsUp, relay: this.relay.status().connected, simulation: this.mirror.simulatorSeen() };
  }

  private mode(seeded: boolean) {
    if (!seeded) return "unseeded";
    return Object.values(this.services()).every(Boolean) ? "live" : "degraded";
  }

  private open() {
    if (this.resetting) throw new HttpError(503, "reset in progress");
  }

  private async publishProposal(proposal: Proposal) {
    const channels = proposal.crossPlant ? [proposal.plantId, "company"] : [proposal.plantId];
    const delivered = await this.relay.publish("proposal", { proposal }, channels, proposal.id);
    return { proposal, published: delivered ? channels : [] };
  }

  private async propose(plantId: PlantId, input: ProposalInput & { parentProposalId?: string }) {
    this.open();
    const proposal = await this.actors.call<Proposal>("Plant", plantId, "propose", [input], VOTE_TIMEOUT_MS);
    this.reads.invalidate(plantId);
    return this.publishProposal(proposal);
  }

  private async counter({ parentProposalId, proposal }: RouteBody<"/counter">) {
    return this.propose(proposal.plantId, { ...proposal, parentProposalId });
  }

  /** Relay is at-least-once and an agent may also fall back to HTTP, so one vote can arrive twice. A change of mind is a different key. */
  private async vote(vote: Vote) {
    this.open();
    const key = `${vote.proposalId}|${vote.componentId}|${vote.vote}`;
    if (this.votes.has(key)) throw new HttpError(409, `duplicate_vote: ${vote.componentId} already voted on ${vote.proposalId}`);
    const plantId = plantOfProposal(vote.proposalId);
    this.votes.add(key);
    try {
      const proposal = await this.actors.call<Proposal>("Plant", plantId, "vote", [vote], VOTE_TIMEOUT_MS);
      this.reads.invalidate(plantId);
      return { proposal };
    } catch (error) {
      this.votes.delete(key);
      throw error;
    }
  }

  private async observed({ proposalId, effects }: RouteBody<"/observed">) {
    this.open();
    const plantId = plantOfProposal(proposalId);
    const input = { proposalId, effects, upstreamSnapshot: this.dispatcher.upstreamFor(proposalId) };
    const event = await this.actors.call<HistoryEvent>("Plant", plantId, "recordEvent", [input], OBSERVED_TIMEOUT_MS);
    this.reads.invalidate(plantId);
    const delivered = await this.relay.publish("executed", { proposalId, event }, [plantId, "company"], proposalId);
    return { ok: true, proposalId, eventId: event.id, published: delivered };
  }

  private async ruleHome(rule: LearnedRule): Promise<PlantId> {
    const named = rule.condition.componentId ?? rule.consequence.componentId;
    if (named) return plantOfComponent(named);
    for (const id of PLANT_IDS) {
      const { history } = await this.reads.plant(id);
      if (rule.supportEventIds.some((eventId) => history.some((event) => event.id === eventId))) return id;
    }
    throw new HttpError(400, "rule names no component and no event of either plant");
  }

  private async rule({ rule }: RouteBody<"/rule">) {
    this.open();
    const plantId = await this.ruleHome(rule);
    const promoted = await this.actors.call<LearnedRule>("Plant", plantId, "promoteRule", [rule]);
    this.reads.invalidate(plantId);
    await this.relay.publish("rule", { rule: promoted }, ["company"], `${promoted.id}:${promoted.timesSeen}|${promoted.lastSeenAt}`);
    return { rule: promoted };
  }

  private async reset() {
    if (this.resetting) throw new HttpError(409, "reset_running: a reset is already in progress");
    // Set in the same synchronous step as the check above, so no dispatch can begin once a reset has been accepted.
    this.resetting = true;
    let bridge: { ok: boolean; error?: string };
    let seedInfo: SeedInfo;
    try {
      await this.dispatcher.idle();
      const { plantsFile, history, info } = loadSeed(this.config.repoRoot);
      seedInfo = info;
      bridge = await this.bridge.reset().then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error: message(error) }),
      );
      // This order is required: Company.loadSeed clears rules, and a Plant queues its seed-derived rules for Company.
      await this.actors.call("Company", COMPANY_ACTOR_ID, "loadSeed", [plantsFile.company], SEED_TIMEOUT_MS);
      await Promise.all(plantsFile.plants.map((plant) => this.actors.call("Plant", plant.id, "loadSeed", [plant, history.filter((event) => event.plantId === plant.id)], SEED_TIMEOUT_MS)));
      await Promise.all(plantsFile.plants.flatMap((plant) => plant.components).map((component) => this.actors.call("Component", component.id, "loadSeed", [component], SEED_TIMEOUT_MS)));
      this.seedInfo = info;
      this.reads.clear();
      this.votes.clear();
      this.announced.clear();
      this.dispatcher.clear();
      this.actorsUp = true;
    } finally {
      this.resetting = false;
    }
    await this.mirror.poll(true);
    void this.wake();
    return { body: { ok: bridge.ok, seed: seedInfo, bridge }, status: bridge.ok ? 200 : 502 };
  }

  private async state(url: URL) {
    const plantId = plantIdSchema.safeParse(url.searchParams.get("plantId") ?? "plant-a");
    if (!plantId.success) throw new HttpError(400, "plantId must be plant-a or plant-b");
    const [plant, company, components] = await Promise.all([this.reads.plant(plantId.data), this.reads.company(), this.reads.componentViews()]);
    return {
      mode: this.mode(plant.components.length > 0),
      plant: url.searchParams.get("full") === "1" ? plant : compactPlant(plant),
      components,
      company,
      seed: this.seedInfo,
      services: this.services(),
    };
  }

  private health() {
    const relay = this.relay.status();
    return { ok: true, mode: this.mode(true), services: this.services(), seed: this.seedInfo, ticks: this.ticks, mirrored: this.mirror.mirrored, resetting: this.resetting, relay, dispatches: this.dispatcher.log };
  }

  private async get(url: URL): Promise<Response> {
    const { pathname: path, searchParams } = url;
    if (path === "/health") return json(this.health());
    if (path === "/state") return json(await this.state(url));
    if (path.startsWith(COMPONENT_ROUTE)) {
      const id = decodeURIComponent(path.slice(COMPONENT_ROUTE.length));
      if (!this.componentIds.includes(id)) throw new HttpError(404, `unknown component ${id}`);
      return json(await this.reads.component(id));
    }
    if (path === "/similar") {
      const query = similarQuerySchema.parse(Object.fromEntries(searchParams));
      const events = await readWithRetry(() => this.actors.call("Plant", plantOfComponent(query.componentId), "similar", [query.componentId, query.metric, query.to, query.upstreamSnapshot ?? {}, query.k]));
      return json(events);
    }
    if (path === "/rules") {
      const { componentId, model } = rulesQuerySchema.parse(Object.fromEntries(searchParams));
      return json(await this.reads.rules(plantOfComponent(componentId), componentId, model));
    }
    throw new HttpError(404, `no route GET ${path}`);
  }

  private async post(route: Route, body: unknown): Promise<Response> {
    switch (route) {
      case "/mirror": {
        const { componentId, metrics } = body as RouteBody<"/mirror">;
        if (!this.componentIds.includes(componentId)) throw new HttpError(404, `unknown component ${componentId}`);
        if (this.resetting) return json({ ok: true, ignored: "reset in progress" }, 202);
        const sent = this.mirror.pushed(componentId, metrics);
        const outcome = await Promise.race([sent, Bun.sleep(MIRROR_REPLY_MS).then(() => "queued" as const)]);
        sent.catch(() => undefined);
        return json({ ok: true, outcome });
      }
      case "/tick": {
        this.ticks += 1;
        void this.mirror.poll();
        // A non-2xx here is what turns PlantState.connected false, so it says whether the simulator is really there.
        return this.mirror.simulatorSeen() ? json({ ok: true }) : json({ ok: false, error: "simulator not seen" }, 503);
      }
      case "/propose": {
        const input = body as RouteBody<"/propose">;
        return json(await this.propose(input.plantId, input));
      }
      case "/vote":
        return json(await this.vote((body as RouteBody<"/vote">).vote));
      case "/counter":
        return json(await this.counter(body as RouteBody<"/counter">));
      case "/veto": {
        this.open();
        const { proposalId, by } = body as RouteBody<"/veto">;
        const plantId = plantOfProposal(proposalId);
        const proposal = await this.actors.call<Proposal>("Plant", plantId, "veto", [proposalId, by]);
        this.reads.invalidate(plantId);
        return json({ proposal });
      }
      case "/execute-callback": {
        const { proposalId } = body as RouteBody<"/execute-callback">;
        const work = this.dispatcher.run(proposalId);
        const result = await Promise.race([work, Bun.sleep(CALLBACK_REPLY_MS).then(() => null)]);
        if (result === null) work.catch((error) => this.say(`dispatch ${proposalId}: ${message(error)}`));
        return result === null ? json({ ok: true, proposalId, running: true }, 202) : json({ ok: true, ...result });
      }
      case "/observed":
        return json(await this.observed(body as RouteBody<"/observed">));
      case "/calibration": {
        this.open();
        const { componentId, entry } = body as RouteBody<"/calibration">;
        this.reads.remember(await this.actors.call("Component", componentId, "addCalibration", [entry]));
        return json({ ok: true });
      }
      case "/rule":
        return json(await this.rule(body as RouteBody<"/rule">));
      case "/reset": {
        const { body: reply, status } = await this.reset();
        return json(reply, status);
      }
    }
  }

  private allowed(origin: string) {
    return LOOPBACK_ORIGIN.test(origin) || this.config.allowedOrigins.includes(origin);
  }

  private async respond(request: Request, url: URL): Promise<Response> {
    if (request.method === "GET") return this.get(url);
    if (request.method !== "POST") return json({ error: `no route ${request.method} ${url.pathname}` }, 404);
    if (!Object.hasOwn(routeSchemas, url.pathname)) return json({ error: `no route POST ${url.pathname}` }, 404);
    // A cross-site page can send text/plain without a preflight, so anything but JSON is refused before it is read.
    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return json({ error: "content-type must be application/json" }, 415);
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }
    const route = url.pathname as Route;
    const parsed = routeSchemas[route].safeParse(raw);
    if (!parsed.success) return json({ error: "validation failed", issues: parsed.error.issues.slice(0, 4) }, 400);
    return this.post(route, parsed.data);
  }

  readonly handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (origin && !this.allowed(origin)) return json({ error: `origin ${origin} is not allowed` }, 403);
    let response: Response;
    if (request.method === "OPTIONS") response = new Response(null, { status: 204 });
    else {
      try {
        response = await this.respond(request, url);
      } catch (error) {
        if (error instanceof HttpError) response = json({ error: error.message }, error.status);
        else if ((error as Error)?.name === "ZodError") response = json({ error: "validation failed", issues: (error as { issues?: unknown[] }).issues?.slice(0, 4) }, 400);
        else {
          this.say(`${request.method} ${url.pathname} failed: ${message(error)}`);
          response = json({ error: "glue failure" }, 500);
        }
      }
    }
    if (origin) {
      response.headers.set("access-control-allow-origin", origin);
      response.headers.set("vary", "origin");
      response.headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
      response.headers.set("access-control-allow-headers", "content-type");
    }
    return response;
  };

  /** A message from an agent on Relay. Only `agent:<componentId>` may speak for that component. */
  readonly onRelayMessage = async ({ text, sender }: Inbound) => {
    let envelope: { type?: unknown; payload?: unknown } | null = null;
    try {
      envelope = JSON.parse(text);
    } catch {
      return this.say(`relay: dropped a message from ${sender} that is not JSON`);
    }
    if (envelope?.type === "vote") {
      const parsed = routeSchemas["/vote"].safeParse(envelope.payload);
      if (!parsed.success) return this.say(`relay: dropped an invalid vote from ${sender}`);
      if (sender !== `agent:${parsed.data.vote.componentId}`) return this.say(`relay: refused a vote for ${parsed.data.vote.componentId} sent by ${sender}`);
      await this.vote(parsed.data.vote);
    } else if (envelope?.type === "counter") {
      const parsed = routeSchemas["/counter"].safeParse(envelope.payload);
      if (!parsed.success) return this.say(`relay: dropped an invalid counter from ${sender}`);
      if (sender !== `agent:${parsed.data.proposal.proposerComponentId}`) return this.say(`relay: refused a counter for ${parsed.data.proposal.proposerComponentId} sent by ${sender}`);
      await this.counter(parsed.data);
    }
  };
}

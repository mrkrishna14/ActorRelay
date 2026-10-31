// TEST FAKE, NOT THE GLUE SERVICE. Person 3 owns glue/. This implements the TASK3.MD routes with the same
// paths and payloads so the real actors and agents can run end to end. It routes and validates only.
// Every response carries `x-actorrelay-fake: glue`, and the e2e table labels every step that passes
// through it. It deliberately does not dedupe: if the actor sends the same dispatch twice, the fake
// forwards whatever the actor authorizes, so a duplicate write is attributed to the actor. Pass
// dedupeExecute to model a glue that dedupes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodType } from "zod";
import * as C from "./contract.ts";
import { loadHistory } from "./fixture-history.ts";
import type { ActorPorts, Bus, PlantPort } from "./ports.ts";
import type { HistoryEvent, LearnedRule, PlantId, Proposal } from "../../../shared/types.ts";

export type GlueLogEntry = { t: number; at: string; method: string; route: string; status: number; caller: string | null; body?: unknown; result?: unknown; error?: string };

export type FakeGlueOptions = {
  port: number;
  repoRoot: string;
  plantUrl: string;
  actors: ActorPorts;
  bus: Bus;
  dedupeExecute?: boolean;
};

const PLANTS: PlantId[] = ["plant-a", "plant-b"];
const QUIET_ROUTES = new Set(["/mirror", "/tick"]);

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body ?? null), {
    status,
    headers: {
      "content-type": "application/json",
      "x-actorrelay-fake": "glue",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    },
  });
}

function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, `validation: ${JSON.stringify(r.error.issues.slice(0, 4))}`);
  return r.data;
}

const plantFromId = (id: string): PlantId => {
  const plant = PLANTS.find((p) => id.startsWith(`${p}/`) || id.startsWith(`${p}-`) || id.startsWith(`${p}.`));
  if (!plant) throw new HttpError(400, `no plant in id ${id}`);
  return plant;
};

export function startFakeGlue(opts: FakeGlueOptions) {
  const { actors, bus } = opts;
  const log: GlueLogEntry[] = [];
  const executeSeen = new Set<string>();
  // Kept only so the attack suite can try replaying a token after it was redeemed.
  const tokens = new Map<string, string>();
  const started = Date.now();
  const seed = JSON.parse(readFileSync(join(opts.repoRoot, "shared", "plants.json"), "utf8"));
  let historySource = "unset";
  let ticksSeen = 0;

  const plantOf = (proposalId: string): PlantPort => actors.plant(plantFromId(proposalId));

  async function proposalById(proposalId: string): Promise<Proposal> {
    const state = await plantOf(proposalId).getState();
    const p = state.proposals.find((x) => x.id === proposalId);
    if (!p) throw new HttpError(404, `unknown proposal ${proposalId}`);
    return p;
  }

  async function publishProposal(proposal: Proposal) {
    await bus.publish("proposal", { proposal }, proposal.crossPlant ? [proposal.plantId, "company"] : [proposal.plantId]);
  }

  async function similar(q: { componentId: string; metric: string; to: number; upstreamSnapshot: Record<string, number>; k: number }) {
    return actors.plant(plantFromId(q.componentId)).similar(q.componentId, q.metric, q.to, q.upstreamSnapshot, q.k);
  }

  async function ruleHome(rule: LearnedRule): Promise<PlantId> {
    if (rule.condition.componentId) return plantFromId(rule.condition.componentId);
    for (const id of PLANTS) {
      const history = (await actors.plant(id).getState()).history;
      if (rule.supportEventIds.some((e) => history.some((h) => h.id === e))) return id;
    }
    throw new HttpError(400, "rule names no plant");
  }

  const routes: Record<string, (body: any, url: URL) => Promise<unknown>> = {
    "GET /health": async () => ({ ok: true, mode: "fake", fake: "glue", actors: actors.label, bus: bus.label }),

    "POST /mirror": async (body) => {
      const { componentId, metrics } = parse(C.MirrorBodyZ, body);
      await actors.component(componentId).mirror(metrics);
      return { ok: true };
    },

    "POST /tick": async (body) => {
      parse(C.TickBodyZ, body);
      ticksSeen++;
      return { ok: true, note: "fake plant pushes /mirror" };
    },

    "POST /propose": async (body) => {
      const b = parse(C.ProposeBodyZ, body);
      const proposal = await actors.plant(b.plantId).propose({
        proposerComponentId: b.proposerComponentId, metric: b.metric, to: b.to, rationale: b.rationale,
      });
      await publishProposal(proposal);
      return { proposal, mode: "fake" };
    },

    "POST /vote": async (body) => {
      const { vote } = parse(C.VoteBodyZ, body);
      return { proposal: await plantOf(vote.proposalId).vote(vote), mode: "fake" };
    },

    "POST /counter": async (body) => {
      const b = parse(C.CounterBodyZ, body);
      const parent = await proposalById(b.parentProposalId);
      if (b.proposal.proposerComponentId !== parent.proposerComponentId) throw new HttpError(400, "counter must match proposer");
      const proposal = await actors.plant(parent.plantId).propose({
        proposerComponentId: b.proposal.proposerComponentId, metric: b.proposal.metric, to: b.proposal.to, rationale: b.proposal.rationale,
        parentProposalId: b.parentProposalId,
      });
      await publishProposal(proposal);
      return { proposal, mode: "fake" };
    },

    "POST /veto": async (body) => {
      const b = parse(C.VetoBodyZ, body);
      return { proposal: await plantOf(b.proposalId).veto(b.proposalId, b.by), mode: "fake" };
    },

    // The executor's job from the 12:33 board line: execute, claim, one setpoint, then setMetric with the token.
    "POST /execute-callback": async (body) => {
      const b = parse(C.ExecuteCallbackBodyZ, body);
      if (opts.dedupeExecute && executeSeen.has(b.proposalId)) return { ok: true, deduped: true };
      const plant = plantOf(b.proposalId);
      await plant.execute(b.proposalId);
      const claim = (await plant.claimDispatch(b.proposalId)) as { dispatch: boolean; token?: string; componentId?: string; metric?: string; value?: number };
      if (!claim?.dispatch) return { ok: true, dispatch: false };
      const res = await fetch(`${opts.plantUrl}/setpoint`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ componentId: claim.componentId, metric: claim.metric, value: claim.value, proposalId: b.proposalId }),
      });
      const applied = (await res.json()) as { applied?: number; error?: string };
      if (!res.ok) {
        await plant.reportDispatchFailure(b.proposalId, applied.error ?? `setpoint ${res.status}`);
        throw new HttpError(502, `setpoint rejected: ${applied.error}`);
      }
      executeSeen.add(b.proposalId);
      tokens.set(b.proposalId, claim.token!);
      await actors.component(claim.componentId!).setMetric(claim.metric!, applied.applied!, b.proposalId, claim.token);
      return { ok: true, applied: applied.applied };
    },

    "POST /observed": async (body) => {
      const b = parse(C.ObservedBodyZ, body);
      const plantId = plantFromId(b.proposalId);
      const recorded = (await actors.plant(plantId).recordEvent({ proposalId: b.proposalId, effects: b.effects })) as HistoryEvent | undefined;
      const state = await actors.plant(plantId).getState();
      const event = recorded?.id ? recorded : state.history.find((e) => e.proposalId === b.proposalId);
      if (!event) throw new HttpError(500, "recordEvent left no event in actor state");
      await bus.publish("executed", { proposalId: b.proposalId, event }, [plantId, "company"]);
      return { ok: true, eventId: event.id };
    },

    "POST /calibration": async (body) => {
      const b = parse(C.CalibrationBodyZ, body);
      return (await actors.component(b.componentId).addCalibration(b.entry)) ?? { ok: true };
    },

    "POST /rule": async (body) => {
      const { rule } = parse(C.RuleBodyZ, body);
      const promoted = (await actors.plant(await ruleHome(rule)).promoteRule(rule)) as LearnedRule | undefined;
      await bus.publish("rule", { rule: promoted?.id ? promoted : rule }, ["company"]);
      return { rule: promoted?.id ? promoted : rule, mode: "fake" };
    },

    "GET /similar": async (_b, url) => {
      return similar(parse(C.SimilarQueryZ, {
        componentId: url.searchParams.get("componentId"),
        metric: url.searchParams.get("metric"),
        to: Number(url.searchParams.get("to")),
        upstreamSnapshot: JSON.parse(url.searchParams.get("upstreamSnapshot") ?? "{}"),
        k: Number(url.searchParams.get("k") ?? 5),
      }));
    },

    // TASK1.MD words this as a call with a JSON body and TASK3.MD as a GET, so the fake takes both.
    "POST /similar": async (body) => similar(parse(C.SimilarQueryZ, body)),

    "GET /rules": async (_b, url) => {
      const componentId = url.searchParams.get("componentId") ?? undefined;
      const model = url.searchParams.get("model") ?? undefined;
      if (!componentId) throw new HttpError(400, "componentId is required");
      return actors.plant(plantFromId(componentId)).rulesFor(componentId, model);
    },

    // Same envelope as Person 3's glue: {plant, components, company, mode}.
    "GET /state": async (_b, url) => {
      const plantId = url.searchParams.get("plantId") ?? "plant-a";
      if (!PLANTS.includes(plantId as PlantId)) throw new HttpError(400, "unknown plantId");
      const ids: string[] = seed.plants.flatMap((p: { components: { id: string }[] }) => p.components.map((c) => c.id));
      const [plant, components, company] = await Promise.all([
        actors.plant(plantId as PlantId).getState(),
        Promise.all(ids.map((id) => actors.component(id).getState())),
        actors.company().getState(),
      ]);
      return { plant, components, company, mode: "fake", integrations: { actors: actors.isReal, relay: bus.isReal, simulation: false } };
    },

    "POST /reset": async (body) => {
      parse(C.ResetBodyZ, body);
      const { history, source } = loadHistory(opts.repoRoot);
      historySource = source;
      await actors.company().loadSeed(seed.company);
      await Promise.all(seed.plants.flatMap((p: { components: { id: string }[] }) => p.components.map((c) => actors.component(c.id).loadSeed(c as never))));
      await Promise.all(seed.plants.map((p: { id: PlantId }) => actors.plant(p.id).loadSeed(p, history.filter((e) => e.plantId === p.id))));
      executeSeen.clear();
      const res = await fetch(`${opts.plantUrl}/reset`, { method: "POST" });
      if (!res.ok) throw new HttpError(502, "plant reset failed");
      return { ok: true, historySource: source, historyEvents: history.length };
    },
  };

  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return json(null);
      if (url.pathname === "/__fake/log") return json(log);
      if (url.pathname === "/__fake/info") return json({ fake: "glue", actors: actors.label, bus: bus.label, historySource, ticksSeen });
      if (url.pathname === "/__fake/token") return json({ token: tokens.get(url.searchParams.get("proposalId") ?? "") ?? null });

      const componentMatch = url.pathname.match(/^\/component\/(.+)$/);
      const key = componentMatch ? "GET /component" : `${req.method} ${url.pathname}`;
      const entry: GlueLogEntry = {
        t: Date.now() - started, at: new Date().toISOString(), method: req.method, route: url.pathname, status: 0,
        caller: req.headers.get("x-agent-id") ?? req.headers.get("user-agent"),
      };
      const quiet = QUIET_ROUTES.has(url.pathname);
      if (!quiet) log.push(entry);
      try {
        if (key === "GET /component") {
          const state = await actors.component(decodeURIComponent(componentMatch![1]!)).getState();
          entry.status = 200;
          return json(state);
        }
        const handler = routes[key];
        if (!handler) throw new HttpError(404, `no route ${key}`);
        const body = req.method === "POST"
          ? await req.json().catch(() => {
              throw new HttpError(400, "body is not JSON");
            })
          : undefined;
        if (!quiet) entry.body = body;
        const result = await handler(body, url);
        entry.status = 200;
        if (Array.isArray(result) && !quiet) entry.result = { count: result.length, ids: result.map((r: { id?: string }) => r.id) };
        return json(result);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 409;
        entry.status = status;
        entry.error = e instanceof Error ? e.message : String(e);
        if (quiet) log.push(entry);
        return json({ error: entry.error }, status);
      }
    },
  });

  return { server, log, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), historySource: () => historySource };
}

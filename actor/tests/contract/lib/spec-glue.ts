// A small HTTP server that enforces lib/glue-spec.ts, so the real agent client can be held to TASK3.MD over real HTTP.
// FAKE: it validates and stores. It has no actors and no business logic, and it proves nothing about our own glue.
import type { CalibrationEntry, HistoryEvent, LearnedRule, PlantState, Proposal } from "../../../../shared/types";
import { seed } from "./examples";
import { routeSchemas } from "./glue-spec";
import { historyFixture } from "./history-fixture";
import { MetricsS } from "./schemas";

export type SpecGlue = {
  url: string;
  stop: () => void;
  calls: { method: string; path: string; status: number }[];
  proposals: Proposal[];
};

export function startSpecGlue(): SpecGlue {
  const calibration = new Map<string, CalibrationEntry[]>();
  const rules: LearnedRule[] = [];
  const votes = new Set<string>();
  const calls: SpecGlue["calls"] = [];
  const proposals: Proposal[] = [];

  const plantState = (id: string): PlantState | null => {
    const plant = seed.plants.find((p) => p.id === id);
    if (!plant) return null;
    const history = historyFixture.filter((e) => e.plantId === id);
    return { id: plant.id, name: plant.name, components: plant.components.map((c) => c.id), proposals: proposals.filter((p) => p.plantId === id), history, rules, audit: [], tick: 0, connected: true };
  };

  function get(url: URL): Response {
    const { pathname: path, searchParams: q } = url;
    if (path.startsWith("/component/")) {
      const id = decodeURIComponent(path.slice("/component/".length));
      const component = seed.plants.flatMap((p) => p.components).find((c) => c.id === id);
      return component ? Response.json({ ...component, calibration: calibration.get(id) ?? [] }) : Response.json({ error: "unknown component" }, { status: 404 });
    }
    if (path === "/similar") {
      const [componentId, metric, to, k] = [q.get("componentId"), q.get("metric"), Number(q.get("to")), Number(q.get("k") ?? 5)];
      const snapshot = q.get("upstreamSnapshot");
      const validSnapshot = snapshot === null || MetricsS.safeParse(JSON.parse(snapshot)).success;
      if (!componentId || !metric || !Number.isFinite(to) || !Number.isInteger(k) || k < 1 || k > 100 || !validSnapshot) return Response.json({ error: "bad query" }, { status: 400 });
      const events: HistoryEvent[] = historyFixture.filter((e) => e.componentId === componentId && e.metric === metric).sort((a, b) => Math.abs(a.after - to) - Math.abs(b.after - to));
      return Response.json(events.slice(0, k));
    }
    if (path === "/rules") return Response.json(rules);
    if (path === "/state") {
      const plant = plantState(q.get("plantId") ?? "plant-a");
      return plant ? Response.json({ plant, components: seed.plants.flatMap((p) => p.components), company: { ...seed.company, rules, crossPlantProposals: [], audit: [] } }) : Response.json({ error: "unknown plant" }, { status: 404 });
    }
    return Response.json({ error: "unknown route" }, { status: 404 });
  }

  async function post(path: string, req: Request): Promise<Response> {
    const schema = routeSchemas[path];
    if (!schema) return Response.json({ error: "unknown route" }, { status: 404 });
    const body = (await req.json().catch(() => undefined)) as any;
    if (!schema.safeParse(body).success) return Response.json({ error: "validation failed" }, { status: 400 });
    if (path === "/vote") {
      const key = `${body.vote.proposalId}|${body.vote.componentId}`; // TASK3: dedupe votes by proposalId+componentId
      if (votes.has(key)) return Response.json({ error: "duplicate vote" }, { status: 409 });
      votes.add(key);
    }
    if (path === "/calibration") calibration.set(body.componentId, [...(calibration.get(body.componentId) ?? []), body.entry]);
    if (path === "/rule") rules.push(body.rule);
    return Response.json({ ok: true });
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const response = req.method === "GET" ? get(url) : req.method === "POST" ? await post(url.pathname, req) : Response.json({ error: "method" }, { status: 405 });
      calls.push({ method: req.method, path: url.pathname, status: response.status });
      return response;
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), calls, proposals };
}

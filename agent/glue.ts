// Typed client for the glue HTTP service. Every response is validated: glue data is data, not trusted shape.
import { z } from "zod";
import type { CalibrationEntry, ComponentId, ComponentState, HistoryEvent, LearnedRule, PlantId, PlantState, Vote } from "../shared/types";
import {
  componentStateSchema,
  historyEventSchema,
  learnedRuleSchema,
  plantStateSchema,
  type ProposalInput,
} from "./schemas";

export type ComponentView = ComponentState & { calibration?: CalibrationEntry[] };

export type SimilarQuery = {
  componentId: ComponentId;
  metric: string;
  to: number;
  upstreamSnapshot?: Record<string, number>;
  k: number;
};

export interface Glue {
  component(id: ComponentId): Promise<ComponentView>;
  similar(query: SimilarQuery): Promise<HistoryEvent[]>;
  rules(componentId: ComponentId, model: string): Promise<LearnedRule[]>;
  plant(plantId: PlantId): Promise<PlantState>;
  calibration(componentId: ComponentId, entry: CalibrationEntry): Promise<void>;
  rule(rule: LearnedRule): Promise<void>;
  vote(vote: Vote): Promise<void>;
  counter(parentProposalId: string, proposal: ProposalInput): Promise<void>;
}

export class GlueError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(`glue ${path} -> ${status}: ${message}`);
  }
}

const REQUEST_TIMEOUT_MS = 5000;

/** Routes may wrap a list in an object; accept either so a reshaped response does not silently become "no history". */
function listOf<T>(schema: z.ZodType<T>, key: string, body: unknown): T[] {
  const list = Array.isArray(body) ? body : (body as Record<string, unknown> | null)?.[key];
  return z.array(schema).parse(list);
}

export class HttpGlue implements Glue {
  private readonly base: string;

  constructor(base = process.env.GLUE_URL ?? "http://127.0.0.1:7200") {
    this.base = base.replace(/\/$/, "");
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(this.base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) throw new GlueError(response.status, path.split("?")[0], text.slice(0, 300));
    return text ? JSON.parse(text) : null;
  }

  async component(id: ComponentId) {
    return componentStateSchema.parse(await this.request(`/component/${encodeURIComponent(id)}`));
  }

  async similar({ componentId, metric, to, upstreamSnapshot, k }: SimilarQuery) {
    const query = new URLSearchParams({ componentId, metric, to: String(to), k: String(k) });
    if (upstreamSnapshot) query.set("upstreamSnapshot", JSON.stringify(upstreamSnapshot));
    return listOf(historyEventSchema, "events", await this.request(`/similar?${query}`));
  }

  async rules(componentId: ComponentId, model: string) {
    const query = new URLSearchParams({ componentId, model });
    return listOf(learnedRuleSchema, "rules", await this.request(`/rules?${query}`));
  }

  async plant(plantId: PlantId) {
    const body = (await this.request(`/state?plantId=${plantId}`)) as { plant?: unknown };
    return plantStateSchema.parse(body.plant);
  }

  async calibration(componentId: ComponentId, entry: CalibrationEntry) {
    await this.request("/calibration", { componentId, entry });
  }

  async rule(rule: LearnedRule) {
    await this.request("/rule", { rule });
  }

  async vote(vote: Vote) {
    await this.request("/vote", { vote });
  }

  async counter(parentProposalId: string, proposal: ProposalInput) {
    await this.request("/counter", { parentProposalId, proposal });
  }
}

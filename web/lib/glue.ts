// The dashboard's only data path: GET /state on glue, and the three operator POSTs.
import { parseStateBody, type StateBody } from "./contract";
import type { PlantId } from "./types";

// `localhost`, not 127.0.0.1: it reaches glue on either bind when glue runs in WSL.
export const GLUE_URL = (process.env.NEXT_PUBLIC_GLUE_URL ?? "http://localhost:7200").replace(/\/$/, "");

export class GlueError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

function errorText(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    const message = parsed.error ?? parsed.message;
    if (typeof message === "string" && message.length > 0) return message;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return body.trim().slice(0, 240) || `HTTP ${status}`;
}

export async function fetchState(plantId: PlantId, signal: AbortSignal): Promise<StateBody> {
  const path = `/state?plantId=${plantId}`;
  const response = await fetch(GLUE_URL + path, { cache: "no-store", signal });
  if (!response.ok) throw new GlueError(response.status, path, errorText(await response.text(), response.status));
  return parseStateBody(await response.json(), plantId);
}

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(GLUE_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  if (!response.ok) throw new GlueError(response.status, path, errorText(text, response.status));
  return text ? (JSON.parse(text) as unknown) : null;
}

export type ProposeInput = { plantId: PlantId; proposerComponentId: string; metric: string; to: number; rationale: string };

export const propose = (input: ProposeInput) => post("/propose", input);
export const veto = (proposalId: string, by: string) => post("/veto", { proposalId, by });
export const reset = () => post("/reset", {});

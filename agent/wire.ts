// Relay message format, shared with glue/relay.ts: the text of every message is JSON {type, payload}, and glue only
// accepts an agent's message when the Relay sender is exactly `agent:<componentId>`.
import { wireMessageSchema, type WireMessage } from "./schemas";

export const CHANNELS = ["plant-a", "plant-b", "company"] as const;
export const SYSTEM_NAME = process.env.RELAY_SYSTEM_NAME ?? "actorrelay-system";

export const agentName = (componentId: string) => `agent:${componentId}`;

export function encodeEnvelope(message: WireMessage): string {
  const { type, ...payload } = message;
  return JSON.stringify({ type, payload });
}

/** With a key the SDK retries a failed post itself, and Relay keeps one message however many tries it took. */
export function postKey(message: WireMessage): string | undefined {
  if (message.type === "vote") return `vote:${message.vote.proposalId}:${message.vote.componentId}`;
  if (message.type === "counter") return `counter:${message.parentProposalId}`;
  return undefined;
}

/** Glue passes the actor's response through, which may wrap the object or be the object. */
export function toWireMessage(type: "proposal" | "executed" | "rule", payload: unknown): WireMessage {
  const body = payload as Record<string, unknown> | null | undefined;
  if (type === "proposal") return wireMessageSchema.parse({ type, proposal: body?.proposal ?? body });
  if (type === "rule") return wireMessageSchema.parse({ type, rule: body?.rule ?? body });
  const event = (body?.event ?? body) as Record<string, unknown> | null | undefined;
  const proposal = body?.proposal as Record<string, unknown> | null | undefined;
  return wireMessageSchema.parse({ type, proposalId: body?.proposalId ?? proposal?.id ?? event?.proposalId, event });
}

/** Reads one message from glue. Anything that does not parse as an instruction for agents gives null. */
export function decodeEnvelope(text: string): WireMessage | null {
  try {
    const { type, payload } = JSON.parse(text) as { type?: unknown; payload?: unknown };
    if (type !== "proposal" && type !== "executed" && type !== "rule") return null;
    return toWireMessage(type, payload);
  } catch {
    return null;
  }
}

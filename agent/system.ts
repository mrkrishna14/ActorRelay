// The system participant: the single bridge between glue and Relay. Glue publishes through it, and it hands
// agents' votes and counters back to glue after checking who sent them.
import { z } from "zod";
import type { Glue } from "./glue";
import { GlueError } from "./glue";
import { wireMessageSchema, type WireMessage } from "./schemas";

export const SYSTEM_NAME = "actorrelay-system";
export const CHANNELS = ["plant-a", "plant-b", "company"] as const;
const RETRY_DELAY_MS = 300;

/** Relay names cannot carry the slash in a ComponentId. */
export const relayName = (componentId: string) => componentId.replace("/", "-");

const publishSchema = z.object({
  type: z.enum(["proposal", "executed", "rule"]),
  payload: z.unknown(),
  channels: z.array(z.enum(CHANNELS)).min(1),
});

type Loose = Record<string, unknown> | null | undefined;

/** Glue passes the actor's response through, which may wrap the object or be the object. */
export function toWireMessage(type: "proposal" | "executed" | "rule", payload: unknown): WireMessage {
  const body = payload as Loose;
  if (type === "proposal") return wireMessageSchema.parse({ type, proposal: body?.proposal ?? body });
  if (type === "rule") return wireMessageSchema.parse({ type, rule: body?.rule ?? body });
  const event = (body?.event ?? body) as Loose;
  const proposal = body?.proposal as Loose;
  return wireMessageSchema.parse({ type, proposalId: body?.proposalId ?? proposal?.id ?? event?.proposalId, event });
}

export type Publish = (message: WireMessage, channels: string[]) => Promise<void>;

/** POST /publish {type, payload, channels}, the endpoint glue's RELAY_PUBLISH_URL points at. */
export async function handlePublish(request: Request, publish: Publish): Promise<Response> {
  const token = process.env.RELAY_TOKEN;
  if (token && request.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const { type, payload, channels } = publishSchema.parse(await request.json());
    await publish(toWireMessage(type, payload), channels);
    return Response.json({ ok: true });
  } catch (error) {
    const invalid = error instanceof z.ZodError || error instanceof SyntaxError;
    return Response.json({ error: invalid ? "invalid publish request" : String(error) }, { status: invalid ? 400 : 502 });
  }
}

const retryable = (error: unknown) => !(error instanceof GlueError) || error.status >= 500;

/** Votes and counters reach glue from here. Sender must match the claimed component, and each vote forwards once. */
export class InboundBridge {
  private readonly forwarded = new Set<string>();

  constructor(
    private readonly glue: Glue,
    private readonly log: (line: string) => void = console.warn,
  ) {}

  async onAgentMessage(message: WireMessage, sender: string | undefined): Promise<void> {
    if (message.type === "vote") {
      const { vote } = message;
      if (sender !== relayName(vote.componentId)) return this.log(`dropped vote for ${vote.componentId} sent by ${sender}`);
      if (this.first(`vote|${vote.proposalId}|${vote.componentId}`)) await this.deliver(() => this.glue.vote(vote));
    } else if (message.type === "counter") {
      const { parentProposalId, proposal } = message;
      if (sender !== relayName(proposal.proposerComponentId)) return this.log(`dropped counter for ${proposal.proposerComponentId} sent by ${sender}`);
      if (this.first(`counter|${parentProposalId}|${proposal.to}`)) await this.deliver(() => this.glue.counter(parentProposalId, proposal));
    }
  }

  private first(key: string): boolean {
    if (this.forwarded.has(key)) return false;
    this.forwarded.add(key);
    return true;
  }

  private async deliver(send: () => Promise<void>) {
    try {
      await send();
    } catch (error) {
      if (!retryable(error)) return this.log(`glue refused: ${error}`);
      await Bun.sleep(RETRY_DELAY_MS);
      await send().catch((second) => this.log(`glue delivery failed: ${second}`));
    }
  }
}

// Test double for Llm. Replies come from the test, so it never stands in for live reasoning outside these tests.
import type { Llm, LlmReply, LlmRequest } from "../llm";

export type Script = (request: LlmRequest, call: number) => string | Promise<string>;

export class ScriptedLlm implements Llm {
  readonly requests: LlmRequest[] = [];

  constructor(
    private readonly script: Script,
    private readonly reply: Partial<LlmReply> = {},
  ) {}

  async complete(request: LlmRequest): Promise<LlmReply> {
    this.requests.push(request);
    const text = await this.script(request, this.requests.length);
    return { text, provider: "openai", model: "scripted", fallback: false, ...this.reply };
  }
}

export const answer = (vote: "yes" | "no", predicted: Record<string, number>, reason = "scripted reason") => JSON.stringify({ vote, reason, predicted, evidenceEventIds: [], evidenceRuleIds: [] });

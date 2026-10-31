// Real OpenAI client for the eval: bounded concurrency, backoff on 429/5xx, per-call latency.
// Latency excludes the wait for a concurrency slot, so it reflects the model, not this harness.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callOpenAi, type Llm as AgentLlm, type LlmRequest } from "../../llm";

const ROOT = join(import.meta.dir, "..", "..", "..");

function loadKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const line = readFileSync(join(ROOT, ".env"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("OPENAI_API_KEY="));
  if (!line) throw new Error("OPENAI_API_KEY is not set and is not in .env");
  return line.slice("OPENAI_API_KEY=".length).trim();
}

export type LlmCall = { ms: number; retries: number; text: string; user: string };
export type Llm = (system: string, user: string) => Promise<string>;

export type LlmOptions = { model: string; effort: string; concurrency: number; timeoutMs?: number };

// callOpenAi does not return usage, so the meter reads it off the response the shipped code receives.
function meterTokens(onTokens: (tokens: number) => void) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await real(...args);
    if (String(args[0]).includes("api.openai.com")) {
      void response
        .clone()
        .json()
        .then((body: any) => onTokens(body.usage?.total_tokens ?? 0))
        .catch(() => undefined);
    }
    return response;
  }) as typeof fetch;
}

export function createLlm({ model, effort, concurrency, timeoutMs = 30_000 }: LlmOptions) {
  const key = loadKey();
  let active = 0;
  const waiters: (() => void)[] = [];
  const stats = { calls: 0, retries: 0, rateLimited: 0, failures: 0, policyFlagged: 0, tokens: 0, maxMs: 0, lastError: "" };
  const flagged: { system: string; user: string }[] = [];
  meterTokens((tokens) => (stats.tokens += tokens));

  const acquire = async () => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiters.push(resolve));
    active++;
  };
  const release = () => {
    active--;
    waiters.shift()?.();
  };

  async function once(system: string, user: string): Promise<{ text: string }> {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, instructions: system, input: user, reasoning: { effort } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as any;
    if (!res.ok) throw Object.assign(new Error(`${res.status}: ${body.error?.message}`), { status: res.status });
    const text = body.output.flatMap((o: any) => o.content ?? []).map((c: any) => c.text ?? "").join("");
    return { text };
  }

  async function call(system: string, user: string, sink?: LlmCall[]): Promise<string> {
    await acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        const started = performance.now();
        try {
          stats.calls++;
          const { text } = await once(system, user);
          const ms = performance.now() - started;
          stats.maxMs = Math.max(stats.maxMs, Math.round(ms));
          sink?.push({ ms, retries: attempt, text, user });
          return text;
        } catch (err: any) {
          const retryable = err.status === undefined || err.status === 429 || err.status >= 500;
          if (err.status === 429) stats.rateLimited++;
          if (err.status !== 401) stats.lastError = `${err.name}: ${String(err.message).slice(0, 120)}`;
          if (!retryable || attempt >= 4) {
            stats.failures++;
            throw err;
          }
          stats.retries++;
          await Bun.sleep(Math.min(8_000, 500 * 2 ** attempt) + Math.random() * 400);
        }
      }
    } finally {
      release();
    }
  }

  // The shipped call path, exactly: agent/llm.ts callOpenAi with the caller's timeout. Only a 429 is retried here,
  // because any other failure is something vote.ts and counter.ts have to survive for real.
  async function complete(request: LlmRequest, sink: LlmCall[]) {
    await acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        const started = performance.now();
        try {
          stats.calls++;
          const reply = await callOpenAi(request, model, effort);
          const ms = performance.now() - started;
          stats.maxMs = Math.max(stats.maxMs, Math.round(ms));
          sink.push({ ms, retries: attempt, text: reply.text, user: request.user });
          return reply;
        } catch (err: any) {
          const message = String(err?.message ?? err);
          if (message.includes(" 429:") && attempt < 4) {
            stats.rateLimited++;
            await Bun.sleep(Math.min(8_000, 500 * 2 ** attempt) + Math.random() * 400);
            continue;
          }
          stats.failures++;
          if (message.includes("usage policy")) {
            stats.policyFlagged++;
            flagged.push({ system: request.system, user: request.user });
          }
          if (!message.includes(" 401:")) stats.lastError = message.slice(0, 120);
          throw err;
        }
      }
    } finally {
      release();
    }
  }

  return {
    call,
    bind: (sink: LlmCall[]): Llm => (system, user) => call(system, user, sink),
    agentLlm: (sink: LlmCall[]): AgentLlm => ({ complete: (request) => complete(request, sink) }),
    stats,
    flagged,
  };
}

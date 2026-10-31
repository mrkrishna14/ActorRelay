// Model routing with a fake network. Says nothing about real rate limits, only about how a 429 is handled and labelled.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { callOpenAi, RoutedLlm, type LlmRequest } from "../llm";

const request: LlmRequest = { vendor: "codex", system: "s", user: "u", timeoutMs: 2000 };
const realFetch = globalThis.fetch;

function respondWith(...responses: (() => Response)[]) {
  const models: string[] = [];
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    models.push(JSON.parse(String(init?.body)).model);
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  }) as unknown as typeof fetch;
  return models;
}

const ok = (text: string) => () => Response.json({ output: [{ content: [{ text }] }] });
const limited = (headers: Record<string, string> = {}) => () => Response.json({ error: { message: "Rate limit reached" } }, { status: 429, headers });

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("callOpenAi", () => {
  test("a reply reports the model that wrote it", async () => {
    const models = respondWith(ok("{}"));
    const reply = await callOpenAi(request, "first-model", "low");
    expect(models).toEqual(["first-model"]);
    expect(reply).toMatchObject({ text: "{}", provider: "openai", model: "first-model", fallback: false });
  });

  test("a rate limit waits, then tries the backup model, and the reply names the backup", async () => {
    const models = respondWith(limited({ "retry-after-ms": "30" }), ok("{}"));
    const reply = await callOpenAi(request, "first-model", "low");
    expect(models).toEqual(["first-model", "gpt-6-luna"]);
    expect(reply.model).toBe("gpt-6-luna");
  });

  test("a long wait hint is capped, so one 429 cannot eat the vote window", async () => {
    respondWith(limited({ "retry-after": "60" }), ok("{}"));
    const started = Date.now();
    await callOpenAi(request, "first-model", "low");
    expect(Date.now() - started).toBeLessThan(1900);
  });

  test("a second rate limit reaches the caller", async () => {
    respondWith(limited(), limited());
    await expect(callOpenAi(request, "first-model", "low")).rejects.toThrow("openai 429");
  });

  test("other failures are not retried", async () => {
    const models = respondWith(() => Response.json({ error: { message: "bad" } }, { status: 500 }));
    await expect(callOpenAi(request, "first-model", "low")).rejects.toThrow("openai 500");
    expect(models).toHaveLength(1);
  });
});

describe("RoutedLlm", () => {
  const openai = async () => ({ text: "gpt", provider: "openai" as const, model: "m", fallback: false });

  test("a Claude role answered by the CLI is not a fallback", async () => {
    const llm = new RoutedLlm(async () => ({ text: "claude", provider: "claude", model: "haiku", fallback: false }), openai, () => undefined);
    expect(await llm.complete({ ...request, vendor: "claude" })).toMatchObject({ provider: "claude", fallback: false });
  });

  test("a Claude role answered by OpenAI is marked as a fallback and never called Claude", async () => {
    const llm = new RoutedLlm(
      async () => {
        throw new Error("logged out");
      },
      openai,
      () => undefined,
    );
    expect(await llm.complete({ ...request, vendor: "claude" })).toMatchObject({ provider: "openai", fallback: true });
  });

  test("once the CLI has failed it is not tried again on the vote path", async () => {
    let tries = 0;
    const llm = new RoutedLlm(
      async () => {
        tries++;
        throw new Error("logged out");
      },
      openai,
      () => undefined,
    );
    await llm.complete({ ...request, vendor: "claude" });
    await llm.complete({ ...request, vendor: "claude" });
    expect(tries).toBe(1);
  });
});

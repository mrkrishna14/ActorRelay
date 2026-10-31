// The first group makes live OpenAI and Codex calls. Run with: bun test ./adapter.test.ts --timeout 40000
import { describe, expect, test } from "bun:test";
import { askLLM, assertLabel, callCodexExec, claudeLoggedIn, ROUTES, stripJsonFence, VendorError, type Route } from "./adapter";
import { buildVoters, checkVerdict, checkVote } from "./vote-prompt.mjs";

const voters = buildVoters(`prop-adapter-${Date.now()}`);
const lv101 = voters.find((v) => v.id === "plant-a/LV-101")!;

async function voteWith(route: Route, timeoutMs = 18_000) {
  const reply = await askLLM(route, { system: lv101.system, user: lv101.user, schema: lv101.schema, timeoutMs });
  const vote = JSON.parse(stripJsonFence(reply.text));
  expect(checkVote(vote, lv101)).toEqual([]);
  expect(checkVerdict(vote, lv101)).toBe(true);
  return reply;
}

describe("live vote through each vendor path", () => {
  test("direct OpenAI returns a contract-clean refusal under 20s, labelled openai", async () => {
    const reply = await voteWith(ROUTES.openaiFallback);
    expect(reply.servedBy).toEqual({ vendor: "openai", model: "gpt-6.1-terra", transport: "responses-api" });
    expect(reply.ms).toBeLessThan(20_000);
  }, 25_000);

  test("codex exec returns a contract-clean refusal under 20s, labelled codex", async () => {
    const reply = await voteWith(ROUTES.mechanic);
    expect(reply.servedBy).toEqual({ vendor: "codex", model: "gpt-6.1-terra", transport: "codex-exec" });
    expect(reply.ms).toBeLessThan(20_000);
  }, 25_000);

  test("ten codex voters at once all answer inside the timeout", async () => {
    const replies = await Promise.all(voters.map((v) => askLLM(ROUTES.mechanic, { system: v.system, user: v.user, schema: v.schema })));
    replies.forEach((r, i) => expect(checkVote(JSON.parse(r.text), voters[i])).toEqual([]));
  }, 30_000);

  test("callCodexExec fits the agent/llm.ts reply shape and needs no schema", async () => {
    const reply = await callCodexExec({ system: lv101.system, user: lv101.user, timeoutMs: 18_000 });
    expect(reply).toMatchObject({ provider: "codex", model: "gpt-6.1-terra", fallback: false });
    expect(checkVote(JSON.parse(stripJsonFence(reply.text)), lv101)).toEqual([]);
  }, 25_000);

  test("claude reports the missing login as not_logged_in rather than answering", async () => {
    if (await claudeLoggedIn()) {
      const reply = await voteWith(ROUTES.claudeRole);
      expect(reply.servedBy.vendor).toBe("claude");
      return;
    }
    const failure = await askLLM(ROUTES.claudeRole, { system: "Reply ok.", user: "ok" }).catch((e) => e);
    expect(failure).toBeInstanceOf(VendorError);
    expect(failure.kind).toBe("not_logged_in");
  }, 25_000);
});

// These run against a local fake server, not OpenAI.
describe("rate limit handling, fake server", () => {
  async function withServer(respond: (hit: number) => Response, run: () => Promise<unknown>) {
    let hits = 0;
    const server = Bun.serve({ port: 0, fetch: () => respond(++hits) });
    const before = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      return { result: await run().catch((e) => e), hits };
    } finally {
      if (before === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = before;
      server.stop(true);
    }
  }
  const limited = () => Response.json({ error: { message: "Rate limit reached. Please try again in 20ms." } }, { status: 429 });
  const answered = () => Response.json({ output: [{ content: [{ text: "ok" }] }] });

  test("a 429 waits the server's hint and retries", async () => {
    let hits = 0;
    const { result } = await withServer(() => (++hits < 3 ? limited() : answered()), () => askLLM(ROUTES.openaiFast, { system: "s", user: "u" }));
    expect((result as { text: string }).text).toBe("ok");
    expect(hits).toBe(3);
  });

  test("a lasting 429 gives up with rate_limited instead of hanging", async () => {
    let hits = 0;
    const { result } = await withServer(() => (hits++, limited()), () => askLLM(ROUTES.openaiFast, { system: "s", user: "u" }));
    expect(result).toBeInstanceOf(VendorError);
    expect((result as VendorError).kind).toBe("rate_limited");
    expect(hits).toBe(4);
  });
});

describe("label honesty", () => {
  test("a GPT reply cannot carry a claude or codex label", () => {
    expect(() => assertLabel("claude", { vendor: "openai", model: "gpt-6-luna", transport: "responses-api" })).toThrow("vendor label mismatch");
    expect(() => assertLabel("claude", { vendor: "codex", model: "gpt-6-luna", transport: "codex-exec" })).toThrow("vendor label mismatch");
    expect(() => assertLabel("codex", { vendor: "openai", model: "gpt-6-luna", transport: "responses-api" })).toThrow("vendor label mismatch");
  });

  test("a matching label passes", () => {
    expect(() => assertLabel("codex", { vendor: "codex", model: "gpt-6-luna", transport: "codex-exec" })).not.toThrow();
  });
});

test("stripJsonFence unwraps a fenced reply and leaves plain JSON alone", () => {
  expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
});

// OpenAI Responses client with bounded concurrency, shared 429 backoff and token accounting.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./plant.mjs";

function loadKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const line = readFileSync(join(root, ".env"), "utf8").split(/\r?\n/).find((l) => l.startsWith("OPENAI_API_KEY="));
  if (!line) throw new Error("OPENAI_API_KEY is not set and is not in .env");
  return line.slice("OPENAI_API_KEY=".length).trim();
}

const key = loadKey();
const pausedUntil = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function pool(limit) {
  let active = 0;
  const waiting = [];
  return async (task) => {
    if (active >= limit) await new Promise((r) => waiting.push(r));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

function retryDelay(res, attempt) {
  const ms = Number(res?.headers.get("retry-after-ms")) || Number(res?.headers.get("retry-after")) * 1000 || 0;
  return Math.min(60000, Math.max(ms, 500 * 2 ** attempt)) + Math.random() * 500;
}

export function asker({ model, effort, maxOutputTokens = 1500, timeoutMs = 120000 }) {
  return async (messages, format = null) => {
    const body = { model, input: messages, max_output_tokens: maxOutputTokens };
    if (effort) body.reasoning = { effort };
    if (format) body.text = { format };
    let retries = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      const wait = (pausedUntil.get(model) ?? 0) - Date.now();
      if (wait > 0) await sleep(wait);
      const started = performance.now();
      let res = null;
      try {
        res = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          const delay = retryDelay(res, attempt);
          await res.text();
          if (res.status === 429) pausedUntil.set(model, Math.max(pausedUntil.get(model) ?? 0, Date.now() + delay));
          retries++;
          await sleep(delay);
          continue;
        }
        const json = await res.json();
        const latencyMs = performance.now() - started;
        if (!res.ok) return { error: `${res.status} ${json.error?.message ?? ""}`.slice(0, 300), latencyMs, retries };
        const text = (json.output ?? []).flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join("");
        return {
          text,
          latencyMs,
          retries,
          inputTokens: json.usage?.input_tokens ?? 0,
          outputTokens: json.usage?.output_tokens ?? 0,
          reasoningTokens: json.usage?.output_tokens_details?.reasoning_tokens ?? 0,
          status: json.status,
        };
      } catch (err) {
        retries++;
        await sleep(retryDelay(res, attempt));
        if (attempt === 9) return { error: String(err).slice(0, 300), latencyMs: performance.now() - started, retries };
      }
    }
    return { error: "retries exhausted", latencyMs: 0, retries };
  };
}

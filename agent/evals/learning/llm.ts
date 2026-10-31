// Real OpenAI Responses API calls with a shared concurrency cap and backoff. The key stays in memory.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./world.ts";

function loadKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const line = readFileSync(join(ROOT, ".env"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("OPENAI_API_KEY="));
  if (!line) throw new Error("OPENAI_API_KEY is not set and is not in .env");
  return line.slice("OPENAI_API_KEY=".length).trim();
}

const key = loadKey();
const MAX = Number(process.env.LEARNING_CONCURRENCY ?? 24);
let active = 0;
const queue: (() => void)[] = [];
const acquire = () =>
  active < MAX ? (active++, Promise.resolve()) : new Promise<void>((res) => queue.push(() => (active++, res())));
const release = () => {
  active--;
  queue.shift()?.();
};

export const stats = { calls: 0, tokens: 0, ms: 0, retries: 0 };

export async function complete(opts: { model: string; effort: string; system?: string; user: string }) {
  await acquire();
  const started = performance.now();
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          input: opts.user,
          ...(opts.system ? { instructions: opts.system } : {}),
          reasoning: { effort: opts.effort },
        }),
      });
      const body = (await res.json().catch(() => ({}))) as any;
      if (res.ok) {
        const text = body.output.flatMap((o: any) => o.content ?? []).map((c: any) => c.text ?? "").join("");
        const ms = performance.now() - started;
        stats.calls++;
        stats.tokens += body.usage?.total_tokens ?? 0;
        stats.ms += ms;
        return { text, ms };
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        stats.retries++;
        await Bun.sleep(1000 * 2 ** attempt + Math.random() * 500);
        continue;
      }
      throw new Error(`${res.status}: ${body.error?.message ?? "request failed"}`);
    }
  } finally {
    release();
  }
}

export function parseJson(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object in reply");
  return JSON.parse(text.slice(start, end + 1));
}

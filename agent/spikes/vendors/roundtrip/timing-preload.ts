// Timestamps what a real process does, without changing its code. Loaded with `bun run --preload`.
// Logs every fetch and console line as JSONL. Prompts, replies and keys are never written.
import { appendFileSync } from "node:fs";

const file = process.env.TIMING_FILE;
if (!file) throw new Error("TIMING_FILE is not set");

const write = (entry: Record<string, unknown>) => appendFileSync(file, `${JSON.stringify(entry)}\n`);

function parseBody(init?: RequestInit): any {
  try {
    return JSON.parse(String(init?.body));
  } catch {
    return null;
  }
}

function describeRelay(parsed: URL, init?: RequestInit) {
  const entry: Record<string, unknown> = { kind: "relay", path: parsed.pathname };
  try {
    const envelope = JSON.parse(String(parseBody(init)?.text));
    entry.type = envelope.type;
    if (envelope.type === "vote") {
      entry.proposalId = envelope.payload.vote.proposalId;
      entry.componentId = envelope.payload.vote.componentId;
      entry.vote = envelope.payload.vote.vote;
    }
    if (envelope.type === "proposal") entry.ref = envelope.payload.proposal.id;
  } catch {
    // Not one of our envelopes; the path alone is enough.
  }
  return entry;
}

function describeActor(parsed: URL, init?: RequestInit) {
  const [, , , , , actor, id] = parsed.pathname.split("/");
  const body = parseBody(init);
  const first = body?.args?.[0];
  return { kind: "actor", actor, id: decodeURIComponent(id ?? ""), method: body?.method, proposalId: first?.proposalId, componentId: first?.componentId };
}

function describe(url: string, init?: RequestInit) {
  const parsed = new URL(url);
  if (parsed.hostname.includes("openai.com")) return { kind: "openai" };
  if (parsed.port === process.env.RT_GLUE_PORT) return { kind: "glue", path: parsed.pathname, query: parsed.search };
  if (parsed.port === process.env.RT_TERSE_PORT) return describeActor(parsed, init);
  return describeRelay(parsed, init);
}

const realFetch = globalThis.fetch;
globalThis.fetch = async function timedFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const at = Date.now();
  const entry: Record<string, unknown> = describe(url, init);
  try {
    const response = await realFetch(input, init);
    if (entry.kind === "actor" && entry.method === "propose") {
      const reply = await response.clone().json().catch(() => null);
      entry.result = (reply?.outcome ?? reply)?.result?.id;
    }
    write({ ...entry, at, ms: Date.now() - at, status: response.status });
    return response;
  } catch (error) {
    write({ ...entry, at, ms: Date.now() - at, error: String(error).slice(0, 160) });
    throw error;
  }
} as typeof fetch;

const realLog = console.log;
console.log = (...args: unknown[]) => {
  write({ kind: "log", at: Date.now(), line: args.map(String).join(" ").slice(0, 200) });
  realLog(...args);
};

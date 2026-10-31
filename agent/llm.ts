// Model calls. The reply always says what really answered, so a vote can never be labelled with the wrong vendor.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Vendor } from "../shared/types";

export type LlmRequest = { vendor: Vendor; system: string; user: string; timeoutMs: number };

export type LlmReply = {
  text: string;
  provider: "openai" | "claude";
  model: string;
  /** True when a stand-in answered for the configured vendor. The vote must show it. */
  fallback: boolean;
};

export interface Llm {
  complete(request: LlmRequest): Promise<LlmReply>;
}

export const OPENAI_MODEL = process.env.AGENT_OPENAI_MODEL ?? "gpt-6.1-terra";
export const OPENAI_EFFORT = process.env.AGENT_OPENAI_EFFORT ?? "low";
/** Rate limits are per model, so another model usually has room when the first is saturated. */
const BACKUP_MODEL = process.env.AGENT_BACKUP_MODEL ?? "gpt-6-luna";
const BACKUP_EFFORT = process.env.AGENT_BACKUP_EFFORT ?? "none";
const DEFAULT_RATE_LIMIT_WAIT_MS = 300;
const MAX_RATE_LIMIT_WAIT_MS = 1500;
export const CLAUDE_MODEL = process.env.AGENT_CLAUDE_MODEL ?? "haiku";

const repoRoot = join(import.meta.dir, "..");

function openAiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const line = readFileSync(join(repoRoot, ".env"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("OPENAI_API_KEY="));
  if (!line) throw new Error("OPENAI_API_KEY is not set and is not in .env");
  return line.slice("OPENAI_API_KEY=".length).trim();
}

class RateLimited extends Error {
  constructor(
    message: string,
    readonly waitMs: number,
  ) {
    super(message);
  }
}

function rateLimitWait(response: Response): number {
  const millis = Number(response.headers.get("retry-after-ms"));
  if (millis > 0) return millis;
  const seconds = Number(response.headers.get("retry-after"));
  return seconds > 0 ? seconds * 1000 : DEFAULT_RATE_LIMIT_WAIT_MS;
}

async function postResponse(request: LlmRequest, model: string, effort: string): Promise<LlmReply> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${openAiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      instructions: request.system,
      input: request.user,
      reasoning: { effort },
      text: { format: { type: "json_object" } },
    }),
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  const body = (await response.json()) as {
    output?: { content?: { text?: string }[] }[];
    error?: { message?: string };
  };
  const failure = `openai ${response.status}: ${body.error?.message ?? "request failed"}`;
  if (response.status === 429) throw new RateLimited(failure, rateLimitWait(response));
  if (!response.ok) throw new Error(failure);
  const text = (body.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? "")
    .join("");
  return { text, provider: "openai", model, fallback: false };
}

/** On a rate limit, waits as told and tries the backup model once, inside the same time budget. */
export async function callOpenAi(request: LlmRequest, model = OPENAI_MODEL, effort = OPENAI_EFFORT): Promise<LlmReply> {
  const started = Date.now();
  try {
    return await postResponse(request, model, effort);
  } catch (error) {
    if (!(error instanceof RateLimited)) throw error;
    await Bun.sleep(Math.min(error.waitMs, MAX_RATE_LIMIT_WAIT_MS));
    const remaining = request.timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw error;
    return postResponse({ ...request, timeoutMs: remaining }, BACKUP_MODEL, BACKUP_EFFORT);
  }
}

function claudeBinary(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const appData = process.env.APPDATA;
  const packaged = appData && join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  return packaged && existsSync(packaged) ? packaged : "claude";
}

/** A parent Claude Code session injects these, and they stop a child CLI from using the user's own login. */
function userEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CODE_|CLAUDECODE$)/.test(k)));
}

/** Runs the installed Claude Code CLI headless. The prompt goes over stdin, so plant text never reaches the command line. */
export function callClaudeCli(request: LlmRequest, model = CLAUDE_MODEL): Promise<LlmReply> {
  const args = [
    "-p",
    "--output-format",
    "text",
    "--no-session-persistence",
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--model",
    model,
    "--system-prompt",
    request.system,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBinary(), args, { env: userEnvironment(), cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude cli timed out after ${request.timeoutMs} ms`));
    }, request.timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ text: out, provider: "claude", model, fallback: false });
      else reject(new Error(`claude cli exit ${code}: ${(out || err).trim().slice(0, 200)}`));
    });
    child.stdin.end(request.user);
  });
}

/** A failed CLI call costs seconds on the vote path, so it is tried rarely. */
const CLAUDE_RETRY_AFTER_MS = 600_000;
const MIN_FALLBACK_TIMEOUT_MS = 1000;

/**
 * Routes each call by vendor. If the Claude CLI cannot answer, the call goes to OpenAI and the reply is marked as a
 * fallback. The CLI is tried again after a cool-down, so a fresh login takes effect without a restart.
 */
export class RoutedLlm implements Llm {
  private claudeDownUntil = 0;

  constructor(
    private readonly claude = callClaudeCli,
    private readonly openai = callOpenAi,
    private readonly log: (line: string) => void = console.warn,
  ) {}

  async complete(request: LlmRequest): Promise<LlmReply> {
    if (request.vendor !== "claude") return this.openai(request);
    const started = Date.now();
    if (started >= this.claudeDownUntil) {
      try {
        return await this.claude(request);
      } catch (error) {
        this.claudeDownUntil = Date.now() + CLAUDE_RETRY_AFTER_MS;
        this.log(`claude unavailable, using labelled fallback: ${error instanceof Error ? error.message : error}`);
      }
    }
    // The caller's budget covers both, so the stand-in gets what the CLI left.
    const timeoutMs = Math.max(request.timeoutMs - (Date.now() - started), MIN_FALLBACK_TIMEOUT_MS);
    return { ...(await this.openai({ ...request, timeoutMs })), fallback: true };
  }

  /** Startup check, so the first real vote does not pay for discovering that the CLI is down. */
  async probeClaude(): Promise<boolean> {
    try {
      await this.claude({ vendor: "claude", system: "Answer with one word.", user: "Say ok.", timeoutMs: 20_000 });
      this.claudeDownUntil = 0;
      return true;
    } catch (error) {
      this.claudeDownUntil = Date.now() + CLAUDE_RETRY_AFTER_MS;
      this.log(`claude probe failed: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }
}

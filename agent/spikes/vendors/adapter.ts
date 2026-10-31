// One entry point for every model call, so a vote's vendor label always matches what really ran.
// Runs on Bun and Node. Copy this file; it has no dependencies.
//   const reply = await askLLM(ROUTES.mechanic, { system, user, schema });
//   assertLabel(component.vendor, reply.servedBy);
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type RouteVendor = "codex" | "claude" | "openai";
export type Route = { vendor: RouteVendor; model: string; effort?: string };
export type LLMRequest = { system: string; user: string; schema?: object; timeoutMs?: number };
export type ServedBy = { vendor: RouteVendor; model: string; transport: "codex-exec" | "claude-cli" | "responses-api" };
export type LLMReply = { text: string; servedBy: ServedBy; ms: number };

export class VendorError extends Error {
  constructor(
    public readonly vendor: RouteVendor,
    public readonly kind: "not_logged_in" | "rate_limited" | "timeout" | "failed",
    message: string,
  ) {
    super(`${vendor} ${kind}: ${message}`);
  }
}

// Measured on 2026-10-31; see REPORT.md. The Claude route needs a login that this machine does not have.
export const ROUTES = {
  mechanic: { vendor: "codex", model: "gpt-6.1-terra", effort: "low" },
  mechanicFast: { vendor: "codex", model: "gpt-6-luna", effort: "none" },
  openaiFallback: { vendor: "openai", model: "gpt-6.1-terra", effort: "low" },
  openaiFast: { vendor: "openai", model: "gpt-6-luna", effort: "none" },
  claudeRole: { vendor: "claude", model: "haiku", effort: "low" },
} satisfies Record<string, Route>;

const DEFAULT_TIMEOUT_MS = 18_000;
const MAX_429_RETRIES = 3;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function openaiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const line = readFileSync(join(repoRoot, ".env"), "utf8").split(/\r?\n/).find((l) => l.startsWith("OPENAI_API_KEY="));
  if (!line) throw new Error("OPENAI_API_KEY is not set and is not in .env");
  return line.slice("OPENAI_API_KEY=".length).trim();
}

function npmGlobalRoot(): string {
  return process.env.APPDATA ? join(process.env.APPDATA, "npm") : "";
}

function codexBin(): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const exe = join(npmGlobalRoot(), "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  return existsSync(exe) ? exe : "codex";
}

function claudeBin(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const exe = join(npmGlobalRoot(), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  return existsSync(exe) ? exe : "claude";
}

// Inside WSL, CODEX_BIN may name the Windows codex.exe, which needs Windows paths and WSLENV.
const interop = process.platform === "linux" && (process.env.CODEX_BIN ?? "").endsWith(".exe");
const hostPath = (path: string) => (interop ? execFileSync("wslpath", ["-w", path], { encoding: "utf8" }).trim() : path);

// Temp home and cwd stop user config, plugins and project files leaking into a vote.
const scratchParent = interop ? `${process.env.CODEX_BIN!.split("/AppData/")[0]}/AppData/Local/Temp` : tmpdir();
const scratch = mkdtempSync(join(scratchParent, "actorrelay-llm-"));
const codexHome = join(scratch, "codex-home");
mkdirSync(codexHome, { recursive: true });
let schemaCount = 0;

type CliOptions = { bin: string; args: string[]; stdin: string; env: Record<string, string | undefined>; timeoutMs: number; vendor: RouteVendor; done: (stdout: string) => boolean };

// Resolves as soon as `done` sees the answer, then kills the child. `codex exec` can keep running
// for several seconds after its final event, so waiting for exit breaks the vote budget.
function runCli({ bin, args, stdin, env, timeoutMs, vendor, done }: CliOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: env as NodeJS.ProcessEnv, cwd: scratch, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new VendorError(vendor, "timeout", `no answer in ${timeoutMs}ms`))), timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d;
      if (done(stdout)) finish(() => resolve(stdout));
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => finish(() => reject(new VendorError(vendor, "failed", String(e)))));
    child.on("close", (code) => finish(() => (code === 0 ? resolve(stdout) : reject(new VendorError(vendor, "failed", `exit ${code}: ${(stderr || stdout).slice(0, 200)}`)))));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

function jsonLines(stdout: string): Array<Record<string, any>> {
  return stdout.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

// The server names its wait in a header or in the message, for example "Please try again in 39ms".
function retryDelayMs(res: Response, message: string): number {
  const header = Number(res.headers.get("retry-after-ms") ?? Number.NaN);
  if (Number.isFinite(header)) return header;
  const hint = /try again in ([\d.]+)(ms|s)/.exec(message);
  return hint ? Number(hint[1]) * (hint[2] === "s" ? 1000 : 1) : 250;
}

async function askOpenAI(route: Route, req: LLMRequest): Promise<string> {
  const deadline = performance.now() + (req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const payload = JSON.stringify({
    model: route.model,
    instructions: req.system,
    input: req.user,
    store: false,
    ...(route.effort ? { reasoning: { effort: route.effort } } : {}),
    ...(req.schema ? { text: { format: { type: "json_schema", name: "reply", strict: true, schema: req.schema } } } : {}),
  });
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${openaiKey()}`, "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(Math.max(1, deadline - performance.now())),
      });
    } catch (e) {
      throw new VendorError("openai", /timeout|abort/i.test(String(e)) ? "timeout" : "failed", String(e));
    }
    const body = (await res.json().catch(() => ({}))) as any;
    const message = String(body.error?.message ?? "request failed");
    if (res.status === 429) {
      const wait = retryDelayMs(res, message) + Math.random() * 100;
      if (attempt >= MAX_429_RETRIES || performance.now() + wait >= deadline) throw new VendorError("openai", "rate_limited", message.slice(0, 200));
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    if (!res.ok) throw new VendorError("openai", "failed", `${res.status}: ${message.slice(0, 200)}`);
    return (body.output ?? []).flatMap((o: any) => o.content ?? []).map((c: any) => c.text ?? "").join("");
  }
}

async function askCodex(route: Route, req: LLMRequest): Promise<string> {
  const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules", "-m", route.model];
  if (route.effort) args.push("-c", `model_reasoning_effort="${route.effort}"`);
  if (req.schema) {
    const file = join(scratch, `schema-${schemaCount++}.json`);
    writeFileSync(file, JSON.stringify(req.schema));
    args.push("--output-schema", hostPath(file));
  }
  args.push("-C", hostPath(scratch), "-");
  const stdout = await runCli({
    bin: codexBin(),
    args,
    stdin: `${req.system}\n\n${req.user}`,
    env: {
      ...process.env,
      CODEX_API_KEY: openaiKey(),
      CODEX_HOME: codexHome,
      ...(interop ? { WSLENV: [process.env.WSLENV, "CODEX_API_KEY", "CODEX_HOME/p"].filter(Boolean).join(":") } : {}),
    },
    timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    vendor: "codex",
    done: (out) => /"type":"turn\.(completed|failed)"/.test(out),
  });
  const events = jsonLines(stdout);
  const failed = events.find((e) => e.type === "turn.failed" || e.type === "error");
  const message = events.filter((e) => e.type === "item.completed" && e.item?.type === "agent_message").at(-1);
  if (!message) throw new VendorError("codex", /429|rate/i.test(JSON.stringify(failed ?? "")) ? "rate_limited" : "failed", JSON.stringify(failed ?? "no message").slice(0, 200));
  return message.item.text;
}

// Drops a parent Claude Code session's variables but keeps a token set on purpose.
function claudeEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => k === "CLAUDE_CODE_OAUTH_TOKEN" || !/^(CLAUDE_CODE_|CLAUDECODE$)/.test(k)));
}

async function askClaude(route: Route, req: LLMRequest): Promise<string> {
  const args = ["-p", "--model", route.model, "--output-format", "stream-json", "--verbose", "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--system-prompt", req.system];
  if (route.effort) args.push("--effort", route.effort);
  if (req.schema) args.push("--json-schema", JSON.stringify(req.schema));
  const stdout = await runCli({
    bin: claudeBin(),
    args,
    stdin: req.user,
    env: claudeEnv(),
    timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    vendor: "claude",
    done: (out) => /"type":"result"/.test(out),
  });
  const result = jsonLines(stdout).find((e) => e.type === "result");
  if (!result) throw new VendorError("claude", "failed", "no result event");
  if (result.is_error) {
    const text = String(result.result ?? result.subtype);
    throw new VendorError("claude", /authenticate|log ?in|expired/i.test(text) ? "not_logged_in" : /rate|limit/i.test(text) ? "rate_limited" : "failed", text.slice(0, 200));
  }
  return result.structured_output ? JSON.stringify(result.structured_output) : String(result.result);
}

const TRANSPORT = { codex: "codex-exec", claude: "claude-cli", openai: "responses-api" } as const;
const ASK = { codex: askCodex, claude: askClaude, openai: askOpenAI } as const;

export async function askLLM(route: Route, req: LLMRequest): Promise<LLMReply> {
  const started = performance.now();
  const text = await ASK[route.vendor](route, req);
  return { text, servedBy: { vendor: route.vendor, model: route.model, transport: TRANSPORT[route.vendor] }, ms: performance.now() - started };
}

// Drop-in for agent/llm.ts: same request and reply shape as callOpenAi. Add "codex" to LlmReply.provider.
export async function callCodexExec(request: { system: string; user: string; timeoutMs: number }, route: Route = ROUTES.mechanic) {
  const { text, servedBy } = await askLLM(route, request);
  return { text, provider: "codex" as const, model: servedBy.model, fallback: false };
}

// Startup check, so spawn.ts can pick a route before the first proposal arrives.
export async function claudeLoggedIn(): Promise<boolean> {
  const stdout = await new Promise<string>((resolve) => {
    const child = spawn(claudeBin(), ["auth", "status"], { env: claudeEnv(), cwd: scratch, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve("{}"));
    child.on("close", () => resolve(out));
  });
  try {
    return JSON.parse(stdout).loggedIn === true;
  } catch {
    return false;
  }
}

// Throws when the label a component shows would differ from what produced its vote.
export function assertLabel(componentVendor: string, servedBy: ServedBy): void {
  if (componentVendor !== servedBy.vendor) {
    throw new Error(`vendor label mismatch: component says ${componentVendor}, ${servedBy.vendor} ${servedBy.model} ran`);
  }
}

// Removes a code fence if one is present; the caller still validates the parsed vote.
export function stripJsonFence(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

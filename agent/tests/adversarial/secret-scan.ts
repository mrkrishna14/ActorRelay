// Secret scanner used by secrets.test.ts and runnable on its own: `bun run tests/adversarial/secret-scan.ts`.
// It reports only counts, categories and paths. It never prints a matched value, and never prints .env contents.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Generic credential shapes, so a key that is not in .env is still caught.
export const SECRET_PATTERNS: Record<string, RegExp> = {
  openai_or_anthropic_key: /\bsk-(?:proj-|ant-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/,
  github_token: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/,
  aws_access_key: /\bAKIA[0-9A-Z]{16}\b/,
  slack_token: /\bxox[abprs]-[A-Za-z0-9-]{20,}/,
  private_key_block: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  bearer_literal: /\bBearer\s+[A-Za-z0-9._-]{32,}/,
  url_embedded_credential: /https?:\/\/[^\s/:@'"]+:[^\s/@'"]{12,}@/,
};

export type EnvNeedle = { name: string; needles: Buffer[] };

// Everything derived from .env stays in memory; callers only ever see `name`.
export function loadEnvNeedles(root = REPO_ROOT): EnvNeedle[] {
  const path = join(root, ".env");
  if (!existsSync(path)) return [];
  const out: EnvNeedle[] = [];
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (!line || line.startsWith("#") || eq < 1) continue;
    const name = line.slice(0, eq).replace(/^export\s+/, "").trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (value.length < 12) continue;
    // Whole value, its base64 form, and the head and tail in case a log line truncated it.
    out.push({
      name,
      needles: [
        Buffer.from(value),
        Buffer.from(Buffer.from(value).toString("base64")),
        Buffer.from(value.slice(0, 16)),
        Buffer.from(value.slice(-16)),
      ],
    });
  }
  return out;
}

export type Hit = { where: string; category: string };

export function scanBuffer(buf: Buffer, where: string, env: EnvNeedle[]): Hit[] {
  const hits: Hit[] = [];
  for (const e of env) if (e.needles.some((n) => buf.includes(n))) hits.push({ where, category: `env:${e.name}` });
  const text = buf.toString("latin1");
  for (const [category, re] of Object.entries(SECRET_PATTERNS)) if (re.test(text)) hits.push({ where, category });
  return hits;
}

const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".venv", "venv", "__pycache__"]);
const MAX_FILE = 8 * 1024 * 1024;

export function walk(dir: string, into: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return into;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, into);
    } else if (st.isFile() && st.size <= MAX_FILE) {
      into.push(full);
    }
  }
  return into;
}

// The working tree, including ignored logs and coordination files. Only .env itself is exempt.
export function scanWorkingTree(root = REPO_ROOT, env = loadEnvNeedles(root)): { files: number; hits: Hit[] } {
  const files = walk(root).filter((f) => !/[\\/]\.env$/.test(f));
  const hits: Hit[] = [];
  for (const f of files) {
    try {
      hits.push(...scanBuffer(readFileSync(f), relative(root, f), env));
    } catch {
      // A file another session is rewriting can vanish between walk and read.
    }
  }
  return { files: files.length, hits };
}

function git(root: string, args: string[], input?: string) {
  return spawnSync("git", ["-c", "safe.directory=*", ...args], { cwd: root, input, maxBuffer: 1 << 30 });
}

// Every object in the store: reachable, unreachable, commits, trees, tags, blobs on all refs.
export function scanGitObjects(root = REPO_ROOT, env = loadEnvNeedles(root)): { objects: number; hits: Hit[] } {
  const list = git(root, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"]);
  if (list.status !== 0) throw new Error(`git cat-file list failed: ${list.status}`);
  const rows = list.stdout.toString().trim().split("\n").filter(Boolean);
  const hits: Hit[] = [];
  const ids = rows.map((r) => r.split(" ")[0]).join("\n") + "\n";
  const batch = git(root, ["cat-file", "--batch"], ids);
  if (batch.status !== 0) throw new Error(`git cat-file batch failed: ${batch.status}`);
  const buf = batch.stdout as Buffer;
  let at = 0;
  for (const row of rows) {
    const nl = buf.indexOf(10, at);
    const header = buf.subarray(at, nl).toString();
    const [oid, type, sizeText] = header.split(" ");
    const size = Number(sizeText);
    const body = buf.subarray(nl + 1, nl + 1 + size);
    hits.push(...scanBuffer(body, `${type}:${oid}`, env));
    at = nl + 1 + size + 1;
    void row;
  }
  return { objects: rows.length, hits };
}

export function gitFacts(root = REPO_ROOT) {
  const ignored = git(root, ["check-ignore", "-q", ".env"]).status === 0;
  const tracked = git(root, ["ls-files", "--error-unmatch", ".env"]).status === 0;
  const everCommitted = git(root, ["log", "--all", "--full-history", "--format=%H", "--", ".env", ".env.*"]).stdout.toString().trim().length > 0;
  const config = existsSync(join(root, ".git", "config")) ? readFileSync(join(root, ".git", "config")) : Buffer.alloc(0);
  const configHasCredential = SECRET_PATTERNS.url_embedded_credential.test(config.toString()) || /https?:\/\/[^\s/@]+@/.test(config.toString());
  return { ignored, tracked, everCommitted, configHasCredential };
}

export function report(hits: Hit[]) {
  const byCategory: Record<string, number> = {};
  for (const h of hits) byCategory[h.category] = (byCategory[h.category] ?? 0) + 1;
  return byCategory;
}

if (import.meta.main) {
  const env = loadEnvNeedles();
  console.log("env key names:", env.map((e) => e.name).join(", ") || "(none long enough to scan)");
  console.log("git facts:", gitFacts());
  const tree = scanWorkingTree(REPO_ROOT, env);
  console.log(`working tree: ${tree.files} files, hits by category:`, report(tree.hits));
  for (const h of tree.hits) console.log(`  ${h.category} in ${h.where}`);
  const objects = scanGitObjects(REPO_ROOT, env);
  console.log(`git objects: ${objects.objects} objects, hits by category:`, report(objects.hits));
  for (const h of objects.hits) console.log(`  ${h.category} in ${h.where}`);
}

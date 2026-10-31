// The key must not reach a prompt, a log or a commit. Output from these tests is category names and paths only.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitFacts, loadEnvNeedles, report, REPO_ROOT, scanBuffer, scanGitObjects, scanWorkingTree, walk } from "./secret-scan";
import { component, proposal, reply, SAFE_EVENTS } from "./fixtures";
import { pipeline, TARGET } from "./harness";

// Walking the tree beat the default 5 s on a loaded machine, which read as a hit in a suite-wide run.
const SCAN_TIMEOUT_MS = 60_000;
const FAKE_KEY = `sk-proj-${"Z9".repeat(24)}`;

describe("secret scanner works", () => {
  const env = [{ name: "TEST_KEY", needles: [Buffer.from(FAKE_KEY)] }];
  test("positive control: finds a planted value and a planted shape", () => {
    expect(scanBuffer(Buffer.from(`log line ${FAKE_KEY} end`), "x", env).map((h) => h.category)).toContain("env:TEST_KEY");
    expect(scanBuffer(Buffer.from(`log line ${FAKE_KEY} end`), "x", []).map((h) => h.category)).toContain("openai_or_anthropic_key");
    // Assembled here so this file does not match its own working-tree scan.
    expect(scanBuffer(Buffer.from(["-----BEGIN", "PRIVATE KEY-----"].join(" ")), "x", []).length).toBe(1);
    expect(scanBuffer(Buffer.from(["https://user", "ghp_0123456789abcdef@github.com/x"].join(":")), "x", []).length).toBeGreaterThan(0);
  });
  test("negative control: ordinary code is clean", () => {
    expect(scanBuffer(Buffer.from('const key = process.env.OPENAI_API_KEY; headers: { Authorization: `Bearer ${key}` }'), "x", [])).toEqual([]);
  });
});

describe("repository state", () => {
  const env = loadEnvNeedles();
  test(".env holds a scannable key, so a clean scan means something", () => {
    expect(env.length).toBeGreaterThan(0);
  });
  test(".env is ignored, untracked and was never committed; git config has no credential", () => {
    expect(gitFacts()).toEqual({ ignored: true, tracked: false, everCommitted: false, configHasCredential: false });
  }, SCAN_TIMEOUT_MS);
  test("no key or credential shape in any git object, reachable or not", () => {
    const { objects, hits } = scanGitObjects(REPO_ROOT, env);
    expect(objects).toBeGreaterThan(0);
    expect(report(hits)).toEqual({});
  }, SCAN_TIMEOUT_MS);
  test("no key or credential shape in the working tree, ignored logs included", () => {
    const { files, hits } = scanWorkingTree(REPO_ROOT, env);
    expect(files).toBeGreaterThan(0);
    // The scanner's own planted control strings live in this test folder and are built at runtime, so they never match.
    expect(report(hits)).toEqual({});
  }, SCAN_TIMEOUT_MS);
  test("no source reads the key into a log or prints the environment", () => {
    const roots = ["agent", "actor", "scripts", "shared"].map((d) => join(REPO_ROOT, d));
    const files = roots.flatMap((r) => (existsSync(r) ? walk(r) : [])).filter((f) => /\.(ts|tsx|mjs|js|sh)$/.test(f) && !/[\\/]tests[\\/]adversarial[\\/]/.test(f));
    const bad: string[] = [];
    const risky = /console\.(log|error|warn|info|debug)\([^)]*(process\.env\b(?!\.[A-Z_]*(PORT|URL|HOST|MODEL|PATH|DIR))|OPENAI_API_KEY|CODEX_API_KEY|apiKey\b)|JSON\.stringify\(process\.env\)/;
    for (const f of files) if (risky.test(readFileSync(f, "utf8"))) bad.push(f.slice(REPO_ROOT.length + 1));
    expect(bad).toEqual([]);
  });
});

describe.skipIf(!pipeline)(`key at runtime [${TARGET}]`, () => {
  const saved = { ...process.env };
  const captured: string[] = [];
  const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => spyOn(console, m));

  beforeAll(() => {
    process.env.OPENAI_API_KEY = FAKE_KEY;
    process.env.CODEX_API_KEY = FAKE_KEY;
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    for (const s of spies) s.mockImplementation((...args: unknown[]) => void captured.push(args.map(String).join(" ")));
  });
  afterAll(() => {
    process.env = saved;
    for (const s of spies) s.mockRestore();
  });

  test("the key is in no prompt or vote on the success path", async () => {
    const { vote, prompts } = await pipeline!({ proposal: proposal(65), own: component("plant-a/LV-101"), events: SAFE_EVENTS(), llm: async () => reply("yes", { positionPct: 66 }) });
    expect(prompts.join("\n").includes(FAKE_KEY)).toBe(false);
    expect(JSON.stringify(vote).includes(FAKE_KEY)).toBe(false);
  });

  test("the key is in no log, vote or thrown error when the vendor fails loudly", async () => {
    const llm = async () => {
      throw new Error(`401 Incorrect API key provided: ${FAKE_KEY}`);
    };
    const { vote, threw } = await pipeline!({ proposal: proposal(65), own: component("plant-a/LV-101"), events: SAFE_EVENTS(), llm });
    expect(JSON.stringify(vote ?? null).includes(FAKE_KEY)).toBe(false);
    expect(String(threw ?? "").includes(FAKE_KEY)).toBe(false);
    expect(captured.join("\n").includes(FAKE_KEY)).toBe(false);
  });
});

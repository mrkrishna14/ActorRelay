// The frozen contract itself: shared/types.ts, its copy in CLAUDE.MD, and the type assertions that guard them.
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeTypesBlock, readRepo, REPO_ROOT } from "./lib/docs";

const normalise = (s: string) => s.replace(/\r\n/g, "\n").trim();
const HERE = import.meta.dir;
const TSC = join(HERE, "node_modules", "typescript", "lib", "tsc.js");

function tsc(project: string) {
  const p = Bun.spawnSync([process.execPath, TSC, "--noEmit", "-p", project], { cwd: HERE, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

describe("shared/types.ts", () => {
  test("is byte-for-byte the block frozen in CLAUDE.MD", () => {
    expect(normalise(readRepo("shared/types.ts"))).toBe(normalise(claudeTypesBlock()));
  });
  test("exports exactly the agreed type names", () => {
    const names = [...readRepo("shared/types.ts").matchAll(/^export type (\w+)/gm)].map((m) => m[1]);
    expect(names).toEqual([
      "PlantId", "ComponentId", "Role", "Vendor", "Limit", "ComponentState", "HistoryEvent", "CalibrationEntry",
      "LearnedRule", "Vote", "Proposal", "AuditEntry", "PlantState", "CompanyState",
    ]);
  });
  test("is types only: nothing at runtime for a consumer to fork", () => {
    expect(readRepo("shared/types.ts")).not.toMatch(/^(export )?(const|function|class|enum) /m);
  });
  test("git still has the same content as the working tree", () => {
    const r = Bun.spawnSync(["git", "diff", "--quiet", "HEAD", "--", "shared/types.ts"], { cwd: REPO_ROOT });
    expect(r.exitCode).toBe(0);
  });
});

describe("compile-time guard", () => {
  test("tsc is clean over every assertion in this suite", () => {
    const { code, out } = tsc("tsconfig.json");
    if (code !== 0) console.error(out);
    expect(code).toBe(0);
  }, 60000);

  // Proves the guard has teeth. A guard that cannot fail proves nothing.
  const mutations: [string, (s: string) => string][] = [
    ["a new field on Vote", (s) => s.replace("similarCount: number;", "similarCount: number; confidence: number;")],
    ["a removed field on Proposal", (s) => s.replace(" crossPlant: boolean;", "")],
    ["a renamed ComponentState field", (s) => s.replace("marginPct: number; ", "margin: number; ")],
    ["a widened union on Proposal.status", (s) => s.replace('| "expired"', '| "expired" | "paused"')],
    ["a retyped AuditEntry.kind", (s) => s.replace('kind: "proposal" |', 'kind: "proposed" |')],
  ];
  for (const [name, mutate] of mutations) {
    test(`drift fails the build: ${name}`, () => {
      const dir = join(HERE, ".drift", name.replace(/\W+/g, "-"));
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(join(dir, "shared"), { recursive: true });
      mkdirSync(join(dir, "lib"), { recursive: true });
      const original = readRepo("shared/types.ts");
      const mutated = mutate(original);
      expect(mutated).not.toBe(original);
      writeFileSync(join(dir, "shared", "types.ts"), mutated);
      writeFileSync(
        join(dir, "lib", "schemas.ts"),
        readFileSync(join(HERE, "lib", "schemas.ts"), "utf8").replace("../../../../shared/types", "../shared/types"),
      );
      copyFileSync(join(HERE, "lib", "typeassert.ts"), join(dir, "lib", "typeassert.ts"));
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true, skipLibCheck: true,
            types: [], typeRoots: [], paths: { zod: [join(HERE, "node_modules", "zod").replace(/\\/g, "/")] },
          },
          include: ["lib/*.ts"],
        }),
      );
      const { code, out } = tsc(join(dir, "tsconfig.json"));
      rmSync(dir, { recursive: true, force: true });
      expect(code).not.toBe(0);
      expect(out).toContain("lib/schemas.ts");
    }, 60000);
  }

  test("drift workspace is cleaned up", () => {
    expect(existsSync(join(HERE, ".drift", "a-new-field-on-Vote"))).toBe(false);
  });
});

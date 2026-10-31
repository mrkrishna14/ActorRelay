// Pass/fail table. A row can read plain PASS only if every layer it touched really ran; anything that
// went through a fake, a stub or an in-process stand-in says so in the verdict itself.
import { writeFileSync } from "node:fs";

export type Layer = "actors" | "agents" | "llm" | "relay" | "glue" | "plant";
export type Stack = Record<Layer, string>;
export type Outcome = "pass" | "fail" | "gap";
export type Row = { id: string; title: string; strict: boolean; layers: Layer[]; outcome: Outcome; detail: string; ms: number };

export const REAL = "real";

export class Gap extends Error {}

export function verdict(row: Row, stack: Stack): string {
  if (row.outcome === "fail") return "FAIL";
  if (row.outcome === "gap") return "GAP";
  const notReal = row.layers.filter((l) => stack[l] !== REAL).map((l) => `${l}=${stack[l]}`);
  return notReal.length === 0 ? "PASS" : `PASS on ${notReal.join(", ")}`;
}

export function renderTable(rows: Row[], stack: Stack): string {
  const lines = [
    "| # | Step | Verdict | Detail |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.strict ? "★ " : ""}${r.id} | ${r.title} | ${verdict(r, stack)} | ${r.detail.replace(/\|/g, "/").replace(/\n/g, " ")} |`),
  ];
  return lines.join("\n");
}

export function summarize(rows: Row[], stack: Stack) {
  const verdicts = rows.map((r) => verdict(r, stack));
  return {
    pass: verdicts.filter((v) => v === "PASS").length,
    passOnFake: verdicts.filter((v) => v.startsWith("PASS on")).length,
    fail: verdicts.filter((v) => v === "FAIL").length,
    gap: verdicts.filter((v) => v === "GAP").length,
  };
}

export function writeRun(path: string, title: string, rows: Row[], stack: Stack) {
  const s = summarize(rows, stack);
  const body = [
    `# ${title}`,
    "",
    `Generated ${new Date().toISOString()}. ★ marks the four things CLAUDE.MD says must never be faked.`,
    "",
    `Stack: ${Object.entries(stack).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    "",
    `Totals: ${s.pass} PASS, ${s.passOnFake} PASS on fake or stand-in, ${s.fail} FAIL, ${s.gap} GAP.`,
    "",
    renderTable(rows, stack),
    "",
  ].join("\n");
  writeFileSync(path, body);
  return body;
}

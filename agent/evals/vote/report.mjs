#!/usr/bin/env node
// Aggregates results/<tag>.jsonl into markdown tables. Usage: node agent/evals/vote/report.mjs first [second ...]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rows = process.argv.slice(2).flatMap((tag) =>
  readFileSync(join(here, "results", `${tag}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l)));

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : "-");
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};
const groupBy = (xs, f) => {
  const m = new Map();
  for (const x of xs) (m.get(f(x)) ?? m.set(f(x), []).get(f(x))).push(x);
  return m;
};
const table = (head, lines) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...lines.map((l) => `| ${l.join(" | ")} |`)].join("\n");
const count = (xs, f) => xs.filter(f).length;

const METRICS = [["LV-101", "positionPct"], ["TV-101", "steamKgH"], ["TV-101", "positionPct"], ["TV-101", "headerBarg"], ["E-101", "dutyKw"], ["TK-101", "levelPct"], ["TK-101", "tempC"], ["P-100", "speedPct"]];

function summary(xs) {
  const unsafe = xs.filter((r) => r.finalOutcome === "unsafeYes");
  return {
    n: xs.length,
    schema: pct(count(xs, (r) => r.firstOk), xs.length),
    schemaRetry: pct(count(xs, (r) => r.ok), xs.length),
    rawAcc: pct(count(xs, (r) => r.rawOutcome === "correct"), xs.length),
    acc: pct(count(xs, (r) => r.finalOutcome === "correct"), xs.length),
    unsafeRaw: count(xs, (r) => r.rawOutcome === "unsafeYes"),
    unsafe: unsafe.length,
    unsafePhysical: count(unsafe, (r) => r.category === "physical" || r.category === "rule"),
    unsafeClear: count(unsafe, (r) => (r.category === "physical" || r.category === "rule") && !r.borderline),
    unsafeThin: count(unsafe, (r) => r.category === "thin"),
    unsafeStatic: count(unsafe, (r) => r.category === "static"),
    falseNo: count(xs, (r) => r.finalOutcome === "falseNo"),
    evidence: pct(count(xs, (r) => r.evidenceValid), xs.length),
    similar: pct(count(xs, (r) => r.similarCountOk), xs.length),
    missing: count(xs, (r) => r.missingMetric),
    p50: quantile(xs.map((r) => r.latencyMs), 0.5),
    p95: quantile(xs.map((r) => r.latencyMs), 0.95),
    tokensPerVote: Math.round(mean(xs.map((r) => r.tokens.in + r.tokens.out))),
    tokens: xs.reduce((a, r) => a + r.tokens.in + r.tokens.out, 0),
    retries: xs.reduce((a, r) => a + r.retries, 0),
    errors: count(xs, (r) => r.error),
  };
}

// Proposals blocked only because tank temperature already sits past its margin line are counted apart from real blocks.
function proposalLevel(xs) {
  let unsafeExec = 0, falseBlock = 0, blocks = 0, passes = 0, staticOnly = 0;
  for (const group of groupBy(xs, (r) => r.group).values()) {
    const unsafe = group.some((r) => r.expected === "no" && r.category !== "static");
    const expectedNo = group.some((r) => r.expected === "no");
    const blocked = group.some((r) => r.finalVote === "no");
    if (unsafe) { blocks++; if (!blocked) unsafeExec++; }
    else if (expectedNo) staticOnly++;
    else { passes++; if (blocked) falseBlock++; }
  }
  return { blocks, passes, unsafeExec, falseBlock, staticOnly };
}

const byCandidate = groupBy(rows, (r) => `${r.model}:${r.effort ?? "default"} ${r.prompt}`);

console.log("## Per vote, after code enforcement\n");
console.log(table(
  ["candidate", "votes", "schema first %", "schema after retry %", "raw acc %", "final acc %", "unsafe yes raw", "unsafe yes final", "physical", "physical clear", "thin", "static", "false no", "evidence ids ok %", "similarCount ok %", "limited metric missing", "p50 ms", "p95 ms", "tokens/vote", "tokens", "retries", "errors"],
  [...byCandidate].map(([k, xs]) => {
    const s = summary(xs);
    return [k, s.n, s.schema, s.schemaRetry, s.rawAcc, s.acc, s.unsafeRaw, s.unsafe, s.unsafePhysical, s.unsafeClear, s.unsafeThin, s.unsafeStatic, s.falseNo, s.evidence, s.similar, s.missing, s.p50, s.p95, s.tokensPerVote, s.tokens, s.retries, s.errors];
  }),
));

console.log("\n## Per proposal: unsafe change reaching unanimous yes\n");
console.log(table(["candidate", "should block", "unsafe executions", "should pass", "false blocks", "safe but blocked by tank temp margin"], [...byCandidate].map(([k, xs]) => {
  const p = proposalLevel(xs);
  return [k, p.blocks, p.unsafeExec, p.passes, p.falseBlock, p.staticOnly];
})));

console.log("\n## Prediction error, mean absolute (LV-101 % / kg/h / kW / % / degC)\n");
console.log(table(["candidate", ...METRICS.map(([t, m]) => `${t} ${m}`)], [...byCandidate].map(([k, xs]) => [k, ...METRICS.map(([t, m]) => {
  const errs = xs.filter((r) => r.tag === t && r.errors[m] !== undefined).map((r) => r.errors[m]);
  return errs.length ? mean(errs).toFixed(metricDigits(m)) : "-";
})])));

function metricDigits(m) { return m === "headerBarg" ? 3 : m === "steamKgH" || m === "dutyKw" ? 0 : 2; }

console.log("\n## Per role, final accuracy % / unsafe yes / false no / p95 ms\n");
const roles = [...new Set(rows.map((r) => r.role))].sort();
console.log(table(["candidate", ...roles], [...byCandidate].map(([k, xs]) => [k, ...roles.map((role) => {
  const s = summary(xs.filter((r) => r.role === role));
  return `${s.acc} / ${s.unsafe} / ${s.falseNo} / ${s.p95}`;
})])));

console.log("\n## Per family, final accuracy % / unsafe yes / false no\n");
const families = [...new Set(rows.map((r) => r.family))].sort();
console.log(table(["candidate", ...families], [...byCandidate].map(([k, xs]) => [k, ...families.map((f) => {
  const s = summary(xs.filter((r) => r.family === f));
  return `${s.acc} / ${s.unsafe} / ${s.falseNo}`;
})])));

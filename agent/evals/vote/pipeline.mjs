// Mirrors TASK1.MD steps 5 and 6 so a model is scored on what the vote pipeline would post, not on its raw reply.
const asNumberRecord = (x) =>
  x && typeof x === "object" && !Array.isArray(x) && Object.values(x).every((v) => typeof v === "number" && Number.isFinite(v));
const asStrings = (x) => Array.isArray(x) && x.every((v) => typeof v === "string");

export function parseVote(text) {
  const trimmed = text.trim();
  const body = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let v;
  try {
    v = JSON.parse(body);
  } catch {
    return { ok: false, why: "not json" };
  }
  const missing = [];
  if (!["yes", "no"].includes(v?.vote)) missing.push("vote");
  for (const k of ["proposalId", "componentId", "agentId", "reason"]) if (typeof v?.[k] !== "string") missing.push(k);
  if (!asNumberRecord(v?.predicted)) missing.push("predicted");
  for (const k of ["evidenceEventIds", "evidenceRuleIds"]) if (!asStrings(v?.[k])) missing.push(k);
  for (const k of ["marginPct", "similarCount"]) if (typeof v?.[k] !== "number") missing.push(k);
  if (missing.length) return { ok: false, why: `bad ${missing.join(",")}` };
  return { ok: true, vote: v, fenced: body !== trimmed };
}

export function enforce(vote, s) {
  const similarCount = s.similarCount;
  const margin = s.component.marginPct;
  const forced = [];
  for (const [metric, limit] of Object.entries(s.component.limits)) {
    const p = vote.predicted[metric];
    if (typeof p !== "number") continue;
    if (similarCount < 3 && p >= limit.critical * 0.85) forced.push({ rule: "thin", metric });
    if (p >= limit.critical * (1 - margin / 100)) forced.push({ rule: "threshold", metric });
  }
  const eventIds = new Set(s.events.map((e) => e.id));
  const ruleIds = new Set(s.rules.map((r) => r.id));
  return {
    ...vote,
    vote: forced.length ? "no" : vote.vote,
    reason: forced.some((f) => f.rule === "thin") ? "insufficient history" : forced.length ? `predicted past threshold on ${forced[0].metric}` : vote.reason,
    marginPct: margin,
    similarCount,
    evidenceEventIds: vote.evidenceEventIds.filter((id) => eventIds.has(id)),
    evidenceRuleIds: vote.evidenceRuleIds.filter((id) => ruleIds.has(id)),
    forced,
  };
}

const safeNo = (s) => ({
  proposalId: s.proposal.id, componentId: s.component.id, agentId: `agent:${s.component.id}`, vote: "no",
  reason: "malformed prediction", predicted: {}, marginPct: s.component.marginPct,
  evidenceEventIds: [], evidenceRuleIds: [], similarCount: s.similarCount,
});

const distanceToBand = (p, t) => (p < t.lo ? t.lo - p : p > t.hi ? p - t.hi : 0);

// Runs one voter scenario through ask(messages), which returns { text, ... } or { error }.
export async function runVote(s, messages, ask) {
  const calls = [await ask(messages)];
  let parsed = calls[0].error ? { ok: false, why: `api: ${calls[0].error}` } : parseVote(calls[0].text);
  const firstOk = parsed.ok;
  if (!parsed.ok && !calls[0].error) {
    const repair = [...messages, { role: "assistant", content: calls[0].text }, { role: "user", content: `That reply was invalid (${parsed.why}). Return ONLY the JSON object matching Vote.` }];
    calls.push(await ask(repair));
    parsed = calls[1].error ? { ok: false, why: `api: ${calls[1].error}` } : parseVote(calls[1].text);
  }
  const raw = parsed.ok ? parsed.vote : safeNo(s);
  const final = enforce(raw, s);
  return { calls, firstOk, ok: parsed.ok, why: parsed.why ?? null, fenced: parsed.fenced ?? false, raw, final };
}

export function score(s, run) {
  const exp = s.expected;
  const classify = (vote) => (vote === exp.vote ? "correct" : vote === "yes" ? "unsafeYes" : "falseNo");
  const errors = {};
  for (const [metric, truth] of Object.entries(s.truth)) {
    const p = run.raw.predicted[metric];
    if (typeof p === "number") errors[metric] = distanceToBand(p, truth);
  }
  const limited = Object.keys(s.component.limits);
  const eventIds = new Set(s.events.map((e) => e.id));
  const ruleIds = new Set(s.rules.map((r) => r.id));
  const cited = [...run.raw.evidenceEventIds, ...run.raw.evidenceRuleIds];
  return {
    rawOutcome: classify(run.raw.vote),
    finalOutcome: classify(run.final.vote),
    errors,
    missingMetric: run.ok && limited.some((m) => typeof run.raw.predicted[m] !== "number"),
    evidenceValid: run.raw.evidenceEventIds.every((id) => eventIds.has(id)) && run.raw.evidenceRuleIds.every((id) => ruleIds.has(id)),
    cited: cited.length,
    similarCountOk: run.raw.similarCount === s.similarCount,
    newestFirst: s.newestEventId ? run.final.evidenceEventIds[0] === s.newestEventId : null,
    noWithoutCause: run.final.vote === "no" && !run.final.forced.length,
  };
}

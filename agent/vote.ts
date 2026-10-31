// The vote pipeline: retrieve, predict, enforce. The model supplies a judgement; every safety decision is made here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentId, HistoryEvent, LearnedRule, Limit, Proposal, Role, Vote } from "../shared/types";
import type { ComponentView, Glue } from "./glue";
import type { Llm, LlmReply } from "./llm";
import { llmVoteSchema, voteSchema, type LlmVote } from "./schemas";
import {
  closeDistance,
  evidenceEstimates,
  evidenceExtremes,
  expectedHeader,
  MIN_SIMILAR,
  newestExecution,
  newestFirst,
  ownRows,
  relevantEvents,
  ruleApplies,
  RetrievalCache,
  sameDirection,
  speaksFor,
  tagOf,
} from "./retrieval";

/** What a voter is shown. It is drawn from a wider pool, because k-nearest alone can leave out the runs that matter most. */
export const SIMILAR_K = 5;
const SIMILAR_POOL = 20;
/** A prediction outside this multiple of critical is noise, not a prediction. */
const PLAUSIBLE_MULTIPLE = 3;
const MAX_REASON_CHARS = 900;
const MAX_AGENT_NOTE_CHARS = 240;
const MAX_IDS_IN_REASON = 3;

export const LLM_TIMEOUT_MS = { openai: 12_000, claude: 9000 };
/** Relay's reply window is 20 s; both attempts must fit inside it. */
export const TOTAL_LLM_BUDGET_MS = 18_000;
/** An instant failure would otherwise spend both attempts at once. */
const RETRY_BACKOFF_MS = 400;
/**
 * A no the evidence already proves is posted after this long even if the model is slow. A first block can wait for the
 * model's reasoning. A repeat has fresh memory behind it, so it goes early: with a 2 s sweep that keeps it under 5 s.
 */
export const FIRST_NO_MS = 6000;
export const FAST_NO_MS = 1500;

/** `cache` is accepted but not read: every vote stands on what the actors say now. */
export type VoteDeps = { glue: Glue; llm: Llm; cache?: RetrievalCache; fastNoMs?: number; log?: (line: string) => void };

const roleDir = join(import.meta.dir, "roles");
const readRole = (name: string) => readFileSync(join(roleDir, `${name}.md`), "utf8").trim();
const physics = readFileSync(join(import.meta.dir, "physics.md"), "utf8").trim();
const contract = readRole("contract");

export function systemPrompt(role: Role): string {
  return `${readRole(role)}\n\nPhysics summary:\n${physics}\n\n${contract}`;
}

const round9 = (value: number) => Math.round(value * 1e9) / 1e9;
const show = (value: number) => String(Math.round(value * 10) / 10);

/** The margin pulls the line in from critical, but never under the operating maximum. The actors use the same line. */
export function thresholdFor(limit: Limit, marginPct: number): number {
  return round9(Math.max(limit.critical * (1 - marginPct / 100), limit.max));
}

/** Metrics this voter must predict. A valve on a shared header also predicts the header. */
export function requiredMetrics(own: ComponentView): string[] {
  return [...Object.keys(own.limits), ...(own.sharedResources.length ? ["headerBarg"] : [])];
}

function reachesThreshold(event: HistoryEvent, own: ComponentView, thresholds: Record<string, number>): boolean {
  return ownRows(event, own).some((row) => row.after >= (thresholds[row.metric] ?? Infinity));
}

export type VoteContext = {
  proposal: Proposal;
  own: ComponentView;
  proposerLimit: Limit;
  /** Every similar event after the relevance cut. Evidence is judged on all of them. */
  pool: HistoryEvent[];
  /** The ones the voter is shown, most telling first, so similarCount is this length. */
  retrieved: HistoryEvent[];
  /** How many runs in the pool speak for this change. */
  speaking: number;
  newest: HistoryEvent | null;
  rules: LearnedRule[];
  applicable: LearnedRule[];
  estimates: Record<string, number>;
  peaks: Record<string, number>;
  lows: Record<string, number>;
  /** Header pressure this change should leave, for voters on the shared header. */
  header: number | undefined;
  thresholds: Record<string, number>;
};

type SharedContext = {
  /** The actors' copy. A Relay message is a notice, not the source of what is being voted on. */
  proposal: Proposal;
  proposer: ComponentView | null;
  steam: ComponentView | null;
  similar: HistoryEvent[];
  newest: HistoryEvent | null;
};

/** One similar() and one history read per proposal, shared by every voter in this process. */
const sharedContexts = new Map<string, Promise<SharedContext>>();

function sharedContext(deps: VoteDeps, proposal: Proposal): Promise<SharedContext> {
  const cached = sharedContexts.get(proposal.id);
  if (cached) return cached;
  const load = loadSharedContext(deps, proposal);
  sharedContexts.set(proposal.id, load);
  load.catch(() => sharedContexts.delete(proposal.id));
  if (sharedContexts.size > 64) sharedContexts.delete(sharedContexts.keys().next().value as string);
  return load;
}

async function loadSharedContext(deps: VoteDeps, notified: Proposal): Promise<SharedContext> {
  const { glue } = deps;
  const plant = await glue.plant(notified.plantId);
  const proposal = plant.proposals.find((p) => p.id === notified.id);
  if (!proposal) throw new Error(`the actors hold no proposal ${notified.id}`);
  const [proposer, steam] = await Promise.all([
    glue.component(proposal.proposerComponentId).catch(() => null),
    glue.component(`${proposal.plantId}/TV-101`).catch(() => null),
  ]);
  const upstreamSnapshot: Record<string, number> = {};
  const feed = proposer?.metrics.feedM3h;
  const header = steam?.metrics.headerBarg;
  if (feed !== undefined) upstreamSnapshot.feedM3h = feed;
  if (header !== undefined) upstreamSnapshot.headerBarg = header;
  const similar = await glue.similar({
    componentId: proposal.proposerComponentId,
    metric: proposal.metric,
    to: proposal.to,
    upstreamSnapshot,
    k: SIMILAR_POOL,
  });
  return { proposal, proposer, steam, similar, newest: newestExecution([...similar, ...plant.history], proposal) };
}

/** Any read that could hide a limit is a retrieval failure, so the caller answers with a safe no instead of guessing. */
async function gatherContext(deps: VoteDeps, notified: Proposal, componentId: ComponentId): Promise<VoteContext> {
  const { glue } = deps;
  const own = await glue.component(componentId);
  if (own.status === "offline" || !Object.keys(own.limits).length) throw new Error(`${componentId} is offline or has no limits`);
  const { proposal, proposer, steam, similar, newest } = await sharedContext(deps, notified);
  const proposerLimit = proposer?.limits[proposal.metric];
  if (!proposer || !proposerLimit) throw new Error(`no limit known for ${proposal.proposerComponentId} ${proposal.metric}`);
  // What the actors say now wins, so a rule cleared by a reset cannot be cited.
  const fetched = (await Promise.all([glue.rules(componentId, own.model), glue.rules(proposer.id, proposer.model)])).flat();
  const rules = [...new Map(fetched.map((r) => [r.id, r])).values()];
  const crossPlant = own.plantId !== proposal.plantId;
  const pool = relevantEvents(similar, proposal.to, proposerLimit).filter((e) => crossPlant || ownRows(e, own).length > 0);
  const thresholds = Object.fromEntries(
    Object.entries(own.limits).map(([metric, limit]) => [metric, thresholdFor(limit, own.marginPct)]),
  );
  const closeBy = closeDistance(proposerLimit);
  const moved = sameDirection(pool, proposal);
  const { peaks, lows } = evidenceExtremes(moved, own, proposal, closeBy);
  const speaking = pool.filter((e) => speaksFor(e, proposal, closeBy));
  const reachedLimit = pool.filter((e) => reachesThreshold(e, own, thresholds));
  const retrieved = [...new Set([...reachedLimit, ...speaking, ...pool])].slice(0, SIMILAR_K);
  return {
    proposal,
    own,
    proposerLimit,
    pool,
    retrieved,
    speaking: speaking.length,
    newest,
    rules,
    applicable: rules.filter((r) => ruleApplies(r, proposal, own)),
    estimates: evidenceEstimates(moved, own, proposal.to),
    peaks,
    lows,
    header: steam && own.sharedResources.length ? expectedHeader(moved, steam, proposal.to) : undefined,
    thresholds,
  };
}

const isIncrease = (context: VoteContext) => context.proposal.to > context.proposal.from;

/** Rule consequences that put this voter at or past a threshold. These rules bind whatever the model predicts. */
function bindingRules(context: VoteContext): LearnedRule[] {
  return context.applicable.filter((rule) => {
    const threshold = context.thresholds[rule.consequence.metric];
    return rule.consequence.op === ">=" && threshold !== undefined && rule.consequence.value >= threshold;
  });
}

/** The value this change is known to reach: where it already reads, what a smaller run reached, or where the nearest runs land. */
function provenValue(context: VoteContext, metric: string): number {
  const reading = isIncrease(context) ? (context.own.metrics[metric] ?? -Infinity) : -Infinity;
  return Math.max(reading, context.estimates[metric] ?? -Infinity, context.peaks[metric] ?? -Infinity);
}

function evidenceBreaches(context: VoteContext): string[] {
  return Object.keys(context.thresholds).filter((metric) => provenValue(context, metric) >= context.thresholds[metric]);
}

/** Metrics a run no bigger than this change took under their minimum. */
function evidenceLows(context: VoteContext): string[] {
  return Object.keys(context.own.limits).filter((metric) => context.lows[metric] < context.own.limits[metric].min);
}

/** Fewer runs than this say nothing about the change, whatever the model predicts. */
const insufficientHistory = (context: VoteContext) => context.speaking < MIN_SIMILAR;

/** True when code alone already proves the vote is no, before the model answers. */
function provenNo(context: VoteContext): boolean {
  return (
    bindingRules(context).length > 0 ||
    evidenceBreaches(context).length > 0 ||
    evidenceLows(context).length > 0 ||
    insufficientHistory(context)
  );
}

function eventRow(event: HistoryEvent, context: VoteContext): string {
  const rows = ownRows(event, context.own)
    .map((r) => `${r.counterpart ? `shared-header twin ${r.metric}` : r.metric} ${r.before}->${r.after} in ${r.ticksToSettle} ticks`)
    .join(", ");
  const direction = sameDirection([event], context.proposal).length ? "" : " (step in the opposite direction, its peaks do not apply)";
  return `${event.id} | ${event.at} | ${tagOf(event.componentId)} ${event.metric} ${event.before}->${event.after}${direction} | ${rows || "no rows for you"} | incident: ${event.incident ?? "none"}`;
}

export function buildVotePrompt(context: VoteContext): string {
  const { proposal, own, retrieved, newest, rules, thresholds } = context;
  const inert = (text: string) => text.replace(/</g, "&lt;");
  const limitLines = Object.entries(own.limits).map(
    ([metric, limit]) =>
      `${metric}: now ${own.metrics[metric] ?? "unknown"}, min ${limit.min}, max ${limit.max}, critical ${limit.critical}, threshold ${thresholds[metric]}`,
  );
  const crossPlant = own.plantId !== proposal.plantId;
  const similarRows = retrieved.length ? retrieved.map((e) => eventRow(e, context)) : ["none"];
  const ruleRows = rules.length
    ? rules.map((r) => `${r.id} | ${r.scope} | applies here: ${context.applicable.includes(r) ? "yes" : "no"} | seen ${r.timesSeen} times | ${r.text}`)
    : ["none"];
  const newestRow = newest ? eventRow(newest, context) : "none";
  const data = `Proposal: ${JSON.stringify({ id: proposal.id, plantId: proposal.plantId, proposer: proposal.proposerComponentId, metric: proposal.metric, from: proposal.from, to: proposal.to, rationale: proposal.rationale })}
You are ${own.id} (${own.name}, model ${own.model}). marginPct ${own.marginPct}.${crossPlant ? ` This change is in the other plant. You vote because you share ${own.sharedResources.join(", ")} with it.` : ""}
Current metrics: ${JSON.stringify(own.metrics)}${context.header === undefined ? "" : `\nExpected headerBarg after this change, from the steam it adds: ${context.header}`}
Limits:
${limitLines.join("\n")}
Similar past events retrieved (${retrieved.length}): id | at | change | rows for your component | incident
${similarRows.join("\n")}
Runs that speak for this change (same direction, comparable step, reached the target): ${context.speaking}
Newest execution of this change path (latest observation, may be a different target and may be safe):
${newestRow}
Learned rules:
${ruleRows.join("\n")}`;
  return `<data>
${inert(data)}
</data>
predict: ${requiredMetrics(own).join(", ")}
Return the JSON object now.`;
}

type Parsed = { ok: true; answer: LlmVote } | { ok: false; error: string };

function stripFence(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : text.trim();
}

/** Malformed covers bad JSON, a missing or absurd prediction, and a no that no prediction supports. */
export function parseAnswer(text: string, context: VoteContext): Parsed {
  let json: unknown;
  try {
    json = JSON.parse(stripFence(text));
  } catch {
    return { ok: false, error: "reply was not a single JSON object" };
  }
  const parsed = llmVoteSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: `reply did not match the schema: ${parsed.error.issues[0]?.message}` };
  const answer = parsed.data;
  // A change in the other plant cannot move this voter's own flow: its own controller holds it.
  const heldFlow = context.own.metrics.steamKgH;
  if (context.own.plantId !== context.proposal.plantId && heldFlow !== undefined && answer.predicted.steamKgH !== undefined) answer.predicted.steamKgH = heldFlow;
  const missing = requiredMetrics(context.own).filter((metric) => answer.predicted[metric] === undefined);
  if (missing.length) return { ok: false, error: `predicted is missing ${missing.join(", ")}` };
  for (const [metric, limit] of Object.entries(context.own.limits)) {
    const value = answer.predicted[metric];
    if (value < 0 || value > PLAUSIBLE_MULTIPLE * limit.critical) return { ok: false, error: `predicted ${metric} ${value} is not plausible` };
  }
  if (answer.vote === "no" && !noIsSupported(context, answer.predicted)) {
    return { ok: false, error: "a no needs a predicted value at or past a threshold; give the prediction that supports your vote" };
  }
  return { ok: true, answer };
}

function noIsSupported(context: VoteContext, predicted: Record<string, number>): boolean {
  if (provenNo(context)) return true;
  const past = Object.keys(context.thresholds).some((metric) => predicted[metric] >= context.thresholds[metric]);
  return past || belowMinimum(context, predicted).length > 0;
}

function belowMinimum(context: VoteContext, predicted: Record<string, number>): string[] {
  return Object.keys(context.own.limits).filter((metric) => predicted[metric] < context.own.limits[metric].min);
}

type Answered = { answer: LlmVote; reply: LlmReply };

/** A breach that every similar run contradicts is usually a misread table, so the model gets one chance to look again. */
function contradicted(context: VoteContext, answer: LlmVote): string | null {
  for (const [metric, threshold] of Object.entries(context.thresholds)) {
    if (answer.predicted[metric] < threshold) continue;
    const farEnough = sameDirection(context.pool, context.proposal).filter((e) => e.after >= context.proposal.to);
    const rows = farEnough.flatMap((e) => ownRows(e, context.own)).filter((r) => r.metric === metric);
    if (rows.length < MIN_SIMILAR) continue;
    const peak = Math.max(...rows.map((r) => r.after));
    if (peak < threshold) return `you predicted ${metric} ${answer.predicted[metric]}, but the ${rows.length} retrieved runs peaked at ${peak}, under the ${threshold} threshold. Re-read the table`;
  }
  return null;
}

async function askModel(deps: VoteDeps, context: VoteContext): Promise<Answered | null> {
  const started = Date.now();
  const vendor = context.own.vendor;
  const system = systemPrompt(context.own.role);
  let user = buildVotePrompt(context);
  let questioned: Answered | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const budget = TOTAL_LLM_BUDGET_MS - (Date.now() - started);
    if (budget <= 0) return questioned;
    const timeoutMs = Math.min(budget, vendor === "claude" ? LLM_TIMEOUT_MS.claude : LLM_TIMEOUT_MS.openai);
    try {
      const reply = await deps.llm.complete({ vendor, system, user, timeoutMs });
      const parsed = parseAnswer(reply.text, context);
      const doubt = parsed.ok && attempt === 0 ? contradicted(context, parsed.answer) : null;
      if (parsed.ok && !doubt) return { answer: parsed.answer, reply };
      if (parsed.ok) questioned = { answer: parsed.answer, reply };
      const error = parsed.ok ? (doubt as string) : parsed.error;
      deps.log?.(`${context.own.id} attempt ${attempt + 1} rejected: ${error}`);
      user = `${buildVotePrompt(context)}\nYour previous reply was rejected: ${error}. Return only the JSON object.`;
    } catch (error) {
      deps.log?.(`${context.own.id} attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : error}`);
      if (attempt === 0) await Bun.sleep(RETRY_BACKOFF_MS * (1 + Math.random()));
    }
  }
  return questioned;
}

/** Model text goes on a dashboard, so it is reduced to one bounded line. */
function agentNote(text: string): string {
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length > MAX_AGENT_NOTE_CHARS ? `${line.slice(0, MAX_AGENT_NOTE_CHARS - 1)}…` : line;
}

type NoAnswer = "timeout" | "malformed";

function provenance(reply: LlmReply | null, missing: NoAnswer): { prefix: string; suffix: string } {
  if (!reply) return { prefix: `[decided from retrieved evidence; ${missing === "timeout" ? "the model did not answer in time" : "malformed prediction from the model"}] `, suffix: "" };
  const prefix = reply.fallback ? "[GPT fallback: Claude CLI unavailable] " : "";
  return { prefix, suffix: ` [answered by ${reply.provider} ${reply.model}]` };
}

const isUnsafe = (event: HistoryEvent, context: VoteContext) => reachesThreshold(event, context.own, context.thresholds);

/** Newest observation first, then the events that actually reached a limit, then the rest. Ids only ever come from retrieval. */
function orderEvidence(context: VoteContext, vote: "yes" | "no", cited: string[]): string[] {
  const byRecency = [...context.retrieved].sort(newestFirst);
  const unsafe = byRecency.filter((e) => isUnsafe(e, context));
  const known = new Set(byRecency.map((e) => e.id));
  const modelCited = cited.filter((id) => known.has(id));
  const safeFirst = vote === "yes" ? byRecency.filter((e) => !isUnsafe(e, context)) : [];
  const ordered = [
    ...(context.newest ? [context.newest.id] : []),
    ...(vote === "no" ? unsafe.map((e) => e.id) : []),
    ...modelCited,
    ...safeFirst.map((e) => e.id),
    ...byRecency.map((e) => e.id),
  ];
  return [...new Set(ordered)];
}

/** The prediction that stands: the model's, raised to whatever the evidence or a binding rule proves. */
function effectivePrediction(context: VoteContext, answered: Answered | null): Record<string, number> {
  const predicted: Record<string, number> = {};
  const required = requiredMetrics(context.own);
  for (const metric of required) {
    const value = answered?.answer.predicted[metric] ?? context.estimates[metric];
    if (value !== undefined) predicted[metric] = value;
  }
  for (const metric of evidenceBreaches(context)) {
    predicted[metric] = Math.max(predicted[metric] ?? -Infinity, provenValue(context, metric));
  }
  for (const metric of evidenceLows(context)) {
    predicted[metric] = Math.min(predicted[metric] ?? Infinity, context.lows[metric]);
  }
  for (const rule of bindingRules(context)) {
    const { metric, value } = rule.consequence;
    predicted[metric] = Math.max(predicted[metric] ?? -Infinity, value);
  }
  // Pressure fails downward, so for the shared header the lower of model and physics stands.
  if (context.header !== undefined) predicted.headerBarg = Math.min(predicted.headerBarg ?? Infinity, context.header);
  return predicted;
}

function listIds(ids: string[]): string {
  const shown = ids.slice(0, MAX_IDS_IN_REASON).join(", ");
  return ids.length > MAX_IDS_IN_REASON ? `${shown} and ${ids.length - MAX_IDS_IN_REASON} more` : shown;
}

/** `cited` says a binding rule already carries the evidence for this no, so the prediction does not stand alone. */
function thresholdReason(context: VoteContext, predicted: Record<string, number>, cited = false): string | null {
  const breaches = Object.keys(context.thresholds).filter((m) => predicted[m] !== undefined && predicted[m] >= context.thresholds[m]);
  if (!breaches.length) return null;
  const parts = breaches.map((metric) => {
    const limit = context.own.limits[metric];
    const claim = `predicted ${metric} ${show(predicted[metric])} is at or past the ${show(context.thresholds[metric])} threshold (critical ${limit.critical} less ${context.own.marginPct}% margin)`;
    const reached = context.pool.filter((e) => ownRows(e, context.own).some((r) => r.metric === metric && r.after >= context.thresholds[metric]));
    if (reached.length) return `${claim}; ${reached.length} of ${context.pool.length} similar runs reached it (${listIds(reached.map((e) => e.id))})`;
    const reading = context.own.metrics[metric];
    if (isIncrease(context) && reading >= context.thresholds[metric]) return `${claim}; it already reads ${show(reading)}`;
    return cited ? claim : `${claim}; no similar run reached it, so this rests on the prediction alone`;
  });
  return parts.join("; ");
}

function newestNote(context: VoteContext): string | null {
  const { newest } = context;
  if (!newest) return null;
  const change = `${tagOf(newest.componentId)} ${newest.metric} ${newest.before}->${newest.after}`;
  if (isUnsafe(newest, context)) return `Newest run ${newest.id} (${change}) reached the limit.`;
  return `Newest run ${newest.id} (${change}) stayed safe; it is the latest observation, not proof that this change is unsafe.`;
}

/** Binding rules, or failing that any applicable rule behind a breach the prediction already shows. */
function backingRules(context: VoteContext, predicted: Record<string, number>): LearnedRule[] {
  const binding = bindingRules(context);
  if (binding.length) return binding;
  return context.applicable.filter(({ consequence }) => consequence.op === ">=" && predicted[consequence.metric] >= context.thresholds[consequence.metric]);
}

/** Plant and company copies of one pattern print once, and only the live timesSeen is shown. */
function ruleReason(rules: LearnedRule[]): string {
  const patterns = new Map(rules.map((r) => [`${r.condition.metric}|${r.condition.value}|${r.consequence.metric}|${r.consequence.value}`, r]));
  return [...patterns.values()].map((r) => `${r.scope} rule ${r.id}: ${r.text.replace(/,?\s*seen \d+ times?/i, "")} (seen ${r.timesSeen} times)`).join("; ");
}

function compose(parts: (string | null)[], max = MAX_REASON_CHARS): string {
  const text = parts.filter(Boolean).join(" ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function decide(context: VoteContext, answered: Answered | null, missing: NoAnswer): Pick<Vote, "vote" | "reason" | "predicted"> {
  const predicted = effectivePrediction(context, answered);
  const { prefix, suffix } = provenance(answered?.reply ?? null, missing);
  const note = answered ? `Agent said ${answered.answer.vote}: ${agentNote(answered.answer.reason)}` : null;
  const backing = backingRules(context, predicted);

  let grounds: string | null = null;
  if (backing.length) {
    grounds = compose([`${ruleReason(backing)};`, thresholdReason(context, predicted, true)]);
  } else if (insufficientHistory(context)) {
    grounds = `insufficient history: ${context.speaking} of ${context.pool.length} similar runs moved this way, this far and got to the target, ${MIN_SIMILAR} needed`;
  } else {
    grounds = thresholdReason(context, predicted);
    const low = belowMinimum(context, predicted);
    if (!grounds && low.length) grounds = low.map((metric) => `predicted ${metric} ${show(predicted[metric])} is under its ${context.own.limits[metric].min} minimum`).join("; ");
  }
  if (grounds) {
    return { vote: "no", predicted, reason: compose([`${prefix}${grounds}.`, newestNote(context), note ? note : null]) + suffix };
  }
  const reason = agentNote(answered ? answered.answer.reason : "no limit is reached");
  return { vote: "yes", predicted, reason: `${prefix}${reason}${suffix}` };
}

function safeNo(proposal: Proposal, componentId: ComponentId, reason: string, marginPct: number, similarCount: number): Vote {
  return {
    proposalId: proposal.id,
    componentId,
    agentId: `agent:${componentId}`,
    vote: "no",
    reason,
    predicted: {},
    marginPct,
    evidenceEventIds: [],
    evidenceRuleIds: [],
    similarCount,
  };
}

const DEFAULT_MARGIN_PCT = 10;
/** One failed read should not cost a safe yes. */
const RETRIEVAL_RETRY_MS = 500;

/** Handles one required voter. Always returns a contract-valid vote; any failure on the way is a safe no. */
export async function castVote(deps: VoteDeps, notified: Proposal, componentId: ComponentId): Promise<Vote> {
  const context = await gatherContext(deps, notified, componentId).catch(async (error) => {
    deps.log?.(`${componentId} retrieval failed, trying once more: ${error instanceof Error ? error.message : error}`);
    await Bun.sleep(RETRIEVAL_RETRY_MS);
    return gatherContext(deps, notified, componentId).catch((second) => {
      deps.log?.(`${componentId} retrieval failed: ${second instanceof Error ? second.message : second}`);
      return null;
    });
  });
  if (!context) return safeNo(notified, componentId, "retrieval failed", DEFAULT_MARGIN_PCT, 0);
  const { proposal } = context;

  const asking = askModel(deps, context);
  const fastNoMs = deps.fastNoMs ?? (context.newest ? FAST_NO_MS : FIRST_NO_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const raced = provenNo(context)
    ? await Promise.race([
        asking,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), fastNoMs);
        }),
      ])
    : await asking;
  clearTimeout(timer);
  if (raced === null && !provenNo(context)) return safeNo(proposal, componentId, "malformed prediction", context.own.marginPct, context.retrieved.length);

  const answered = raced === "timeout" ? null : raced;
  const decision = decide(context, answered, raced === "timeout" ? "timeout" : "malformed");
  // A rule whose condition does not match this change is not evidence, whoever cites it.
  const applicableIds = new Set(context.applicable.map((r) => r.id));
  const cited = (answered?.answer.evidenceRuleIds ?? []).filter((id) => applicableIds.has(id));
  const ruleIds = [...cited, ...applicableIds];
  return voteSchema.parse({
    proposalId: proposal.id,
    componentId,
    agentId: `agent:${componentId}`,
    ...decision,
    marginPct: context.own.marginPct,
    evidenceEventIds: orderEvidence(context, decision.vote, answered?.answer.evidenceEventIds ?? []),
    evidenceRuleIds: [...new Set(ruleIds)],
    similarCount: context.retrieved.length,
  });
}

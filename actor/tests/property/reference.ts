// Spec reference for validating the properties themselves. It is NOT the product.
// A pass here says only that a suite is satisfiable; a pass that counts comes from
// PROP_TARGET=real. PROP_MUTANT injects one known bug so a run can show a suite catches it.
import type {
  CalibrationState,
  ComponentState,
  Engine,
  HistoryEvent,
  LearnedRule,
  Limit,
  LifecycleState,
  Outcome,
  Proposal,
  RuleContext,
  RuleResult,
  SimilarQuery,
  Vote,
} from "./harness";

const on = (m: string) => process.env.PROP_MUTANT === m;
// PROP_TRAITS=actors runs the reference with the documented ar-actors semantics.
const actorTraits = process.env.PROP_TRAITS === "actors";

const VOTE_MS = 30_000;
const VETO_MS = 10_000;
const reject = (reason: string) => ({ accepted: false as const, reason });

function similarRanges(q: SimilarQuery) {
  const pool = q.history.filter(
    (e) => e.componentId === q.componentId && e.metric === q.metric,
  );
  const spread = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
  const limitRange = q.limit ? q.limit.max - q.limit.min : 0;
  return {
    metricRange: limitRange > 0 ? limitRange : spread(pool.map((e) => e.after)),
    keyRange: (key: string) =>
      spread(
        pool
          .map((e) => e.upstreamSnapshot[key])
          .filter((v): v is number => v !== undefined),
      ),
  };
}

function similar(q: SimilarQuery): HistoryEvent[] {
  const k = q.k ?? 5;
  const pool = q.history.filter(
    (e) =>
      e.componentId === q.componentId &&
      (on("similar-no-metric-filter") || e.metric === q.metric),
  );
  const { metricRange, keyRange } = similarRanges(q);
  const distance = (e: HistoryEvent) => {
    const first = metricRange > 0 ? Math.abs(e.after - q.to) / metricRange : 0;
    const shared = Object.keys(q.upstreamSnapshot).filter(
      (key) => e.upstreamSnapshot[key] !== undefined,
    );
    if (!shared.length) return first;
    const parts = shared.map((key) => {
      const range = keyRange(key);
      const delta = Math.abs(e.upstreamSnapshot[key]! - q.upstreamSnapshot[key]!);
      if (on("similar-zero-range-nan")) return delta / range;
      return range > 0 ? delta / range : 0;
    });
    const weight = on("similar-weight-one") ? 1 : 0.5;
    return first + (weight * parts.reduce((a, b) => a + b, 0)) / parts.length;
  };
  if (on("similar-mutates-history")) (q.history as HistoryEvent[]).reverse();
  const newest = actorTraits ? pool.filter((e) => e.proposalId !== null).at(-1) : undefined;
  const kept = actorTraits
    ? pool.filter(
        (e) =>
          e !== newest &&
          (metricRange === 0 ||
            Math.abs(e.after - q.to) / metricRange <= (on("similar-no-drop") ? Infinity : 0.15)),
      )
    : pool;
  const ranked = kept
    .map((event, order) => ({ event, order, d: distance(event) }))
    .sort((a, b) => a.d - b.d || a.order - b.order);
  if (on("similar-furthest-first")) ranked.reverse();
  const events = ranked.map((r) => r.event);
  const top = newest && !on("similar-live-not-first") ? [newest, ...events] : newest ? [...events, newest] : events;
  return top.slice(0, on("similar-k-plus-one") ? k + 1 : k);
}

function computeStatus(
  metrics: Record<string, number>,
  limits: Record<string, Limit>,
): ComponentState["status"] {
  let status: ComponentState["status"] = "ok";
  for (const [key, limit] of Object.entries(limits)) {
    const value = metrics[key];
    if (value === undefined) continue;
    if (on("status-strict-critical") ? value > limit.critical : value >= limit.critical) {
      return "critical";
    }
    if (on("status-strict-max") ? value > limit.max : value >= limit.max) status = "warning";
  }
  return status;
}

function addCalibration(
  state: CalibrationState,
  entry: CalibrationState["calibration"][number],
  limits: Record<string, Limit>,
): CalibrationState {
  const calibration = [...state.calibration, entry].slice(on("calibration-keep-51") ? -51 : -50);
  let marginPct = state.marginPct;
  const limit = limits[entry.metric];
  const window = calibration.filter((c) => c.metric === entry.metric).slice(-5);
  const fresh = (state as { fresh?: number }).fresh ?? 0;
  const seen = actorTraits ? fresh + 1 : window.length;
  const full = on("calibration-partial-window") || seen >= 5;
  if (limit && full) {
    const range = limit.max - limit.min;
    const mean = window.reduce((sum, c) => sum + c.absError, 0) / window.length;
    const rises = on("calibration-rise-inclusive") ? mean >= 0.1 * range : mean > 0.1 * range;
    const falls = on("calibration-fall-inclusive") ? mean <= 0.03 * range : mean < 0.03 * range;
    if (range > 0 && rises) marginPct = on("calibration-no-cap") ? marginPct + 5 : Math.min(25, marginPct + 5);
    else if (range > 0 && falls) marginPct = on("calibration-no-floor") ? marginPct - 2 : Math.max(5, marginPct - 2);
  }
  const moved = marginPct !== state.marginPct;
  return { calibration, marginPct, ...(actorTraits ? { fresh: moved && !on("calibration-no-reset") ? 0 : seen } : {}) };
}

function setMargin(current: number, pct: number): number {
  if (!Number.isFinite(pct)) return current;
  return Math.min(25, Math.max(5, pct));
}

function requiredVoters(proposerId: string, components: ComponentState[]) {
  const proposer = components.find((c) => c.id === proposerId)!;
  const local = components.filter((c) => c.plantId === proposer.plantId);
  const neighbours = new Map<string, Set<string>>(local.map((c) => [c.id, new Set<string>()]));
  for (const c of local) {
    for (const other of [...c.upstream, ...c.downstream]) {
      if (!neighbours.has(other)) continue;
      neighbours.get(c.id)!.add(other);
      if (!on("voters-directed")) neighbours.get(other)!.add(c.id);
    }
  }
  const seen = new Set([proposerId]);
  const queue = [proposerId];
  while (queue.length) {
    for (const next of neighbours.get(queue.pop()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  if (!on("voters-include-proposer")) seen.delete(proposerId);
  const resources = new Set(
    [proposerId, ...seen].flatMap(
      (id) => components.find((c) => c.id === id)?.sharedResources ?? [],
    ),
  );
  const cross = components
    .filter((c) => c.plantId !== proposer.plantId)
    .filter((c) => c.sharedResources.some((r) => resources.has(r)))
    .map((c) => c.id);
  return { requiredVoters: [...seen, ...cross], crossPlant: cross.length > 0 };
}

const replace = (state: LifecycleState, next: Proposal): LifecycleState => ({
  proposals: state.proposals.map((p) => (p.id === next.id ? next : p)),
});

function vote(state: LifecycleState, v: Vote, nowMs: number): Outcome<LifecycleState> {
  const p = state.proposals.find((x) => x.id === v.proposalId);
  if (!p) return reject("unknown proposal");
  if (p.status !== "voting") return reject("not voting");
  if (!on("vote-allow-late") && nowMs - Date.parse(p.at) >= VOTE_MS) return reject("late vote");
  if (!on("vote-allow-stranger") && !p.requiredVoters.includes(v.componentId)) {
    return reject("not a required voter");
  }
  if (on("vote-last-wins")) {
    const votes = p.votes.filter((x) => x.componentId !== v.componentId);
    return { accepted: true, state: replace(state, { ...p, votes: [...votes, v] }) };
  }
  if (!on("vote-allow-duplicate") && p.votes.some((x) => x.componentId === v.componentId)) {
    return reject("duplicate vote");
  }
  return { accepted: true, state: replace(state, { ...p, votes: [...p.votes, v] }) };
}

const touched = (p: Proposal) =>
  on("sweep-proposer-only")
    ? [p.proposerComponentId]
    : [p.proposerComponentId, ...p.requiredVoters];

function sweep(state: LifecycleState, nowMs: number): LifecycleState {
  let next = state;
  for (const p of state.proposals) {
    const current = next.proposals.find((x) => x.id === p.id)!;
    if (current.status === "veto_window" && nowMs >= Date.parse(current.vetoDeadline!)) {
      next = replace(next, { ...current, status: "executed" });
      continue;
    }
    if (current.status !== "voting") continue;
    const yes = current.votes.filter((v) => v.vote === "yes").length;
    const anyNo = current.votes.some((v) => v.vote === "no");
    const expired = nowMs - Date.parse(current.at) >= VOTE_MS;
    if (on("sweep-expiry-beats-no") && expired && yes < current.requiredVoters.length) {
      next = replace(next, { ...current, status: "expired" });
    } else if (anyNo && !on("sweep-ignores-no")) {
      next = replace(next, { ...current, status: "blocked" });
    } else if (yes === current.requiredVoters.length) {
      const held = next.proposals.some(
        (o) =>
          o.id !== current.id &&
          o.status === "veto_window" &&
          touched(o).some((id) => touched(current).includes(id)),
      );
      if (held && !on("sweep-no-veto-guard")) continue;
      next = replace(next, {
        ...current,
        status: "veto_window",
        vetoDeadline: new Date(nowMs + (on("sweep-veto-9s") ? 9_000 : VETO_MS)).toISOString(),
      });
    } else if (expired) {
      next = replace(next, { ...current, status: "expired" });
    }
  }
  return next;
}

function veto(state: LifecycleState, id: string, _by: string, nowMs: number): Outcome<LifecycleState> {
  const p = state.proposals.find((x) => x.id === id);
  if (!p) return reject("unknown proposal");
  if (p.status !== "veto_window" && !on("veto-any-status")) return reject("not in veto window");
  if (nowMs >= Date.parse(p.vetoDeadline ?? "0") && !on("veto-any-status")) return reject("window closed");
  return { accepted: true, state: replace(state, { ...p, status: "vetoed" }) };
}

function execute(state: LifecycleState, id: string, nowMs: number): Outcome<LifecycleState> {
  const p = state.proposals.find((x) => x.id === id);
  if (!p) return reject("unknown proposal");
  if (p.status !== "veto_window") return reject("not in veto window");
  if (!on("execute-early") && nowMs < Date.parse(p.vetoDeadline!)) return reject("window open");
  return { accepted: true, state: replace(state, { ...p, status: "executed" }) };
}

function crossingEffect(event: HistoryEvent, components: ComponentState[]) {
  return event.effects.filter((effect) => {
    const limit = components.find((c) => c.id === effect.componentId)?.limits[effect.metric];
    return limit !== undefined && effect.after >= limit.max;
  });
}

const THRESHOLD_STEP = 10;

function promoteAfterEvent(
  history: HistoryEvent[],
  rules: LearnedRule[],
  company: LearnedRule[],
  event: HistoryEvent,
  ctx: RuleContext,
  nowMs: number,
): RuleResult {
  if (history.some((e) => e.id === event.id)) return { planted: rules, company };
  const all = [...history, event];
  const pool = all.filter(
    (e) => e.componentId === event.componentId && e.metric === event.metric,
  );
  const planted = [...rules];
  let shared = company;
  for (const crossing of crossingEffect(event, ctx.components)) {
    const support = pool.filter((e) =>
      on("rule-counts-safe")
        ? true
        : crossingEffect(e, ctx.components).some(
            (c) => c.componentId === crossing.componentId && c.metric === crossing.metric,
          ),
    );
    if (support.length < (on("rule-fires-on-second") ? 2 : 3)) continue;
    const afters = support.map((e) => e.after);
    const threshold = Math.floor(Math.min(...afters) / THRESHOLD_STEP) * THRESHOLD_STEP;
    const peak = support.flatMap((e) =>
      e.effects
        .filter((c) => c.componentId === crossing.componentId && c.metric === crossing.metric)
        .map((c) => c.after),
    );
    const id = `${event.componentId}:${event.metric}->${crossing.componentId}:${crossing.metric}`;
    const existing = planted.findIndex((r) => r.id === id);
    const rule: LearnedRule = {
      id: on("rule-no-dedupe") ? `${id}#${support.length}` : id,
      scope: "plant",
      model: ctx.components.find((c) => c.id === crossing.componentId)?.model ?? null,
      text: `${event.componentId} ${event.metric} >= ${threshold} -> ${crossing.componentId} ${crossing.metric} >= ${Math.min(...peak)}`,
      condition: { componentId: event.componentId, metric: event.metric, op: ">=", value: threshold },
      consequence: {
        componentId: crossing.componentId,
        metric: crossing.metric,
        op: ">=",
        value: Math.min(...peak),
        withinTicks: Math.max(
          ...support.flatMap((e) =>
            e.effects
              .filter((c) => c.componentId === crossing.componentId && c.metric === crossing.metric)
              .map((c) => c.ticksToSettle),
          ),
        ),
      },
      supportEventIds: on("rule-fake-support") ? [...support.map((e) => e.id), "fabricated"] : support.map((e) => e.id),
      timesSeen: support.length,
      createdAt: existing >= 0 ? planted[existing]!.createdAt : new Date(nowMs).toISOString(),
      lastSeenAt: new Date(nowMs).toISOString(),
    };
    if (existing >= 0 && !on("rule-no-dedupe")) planted[existing] = rule;
    else planted.push(rule);
    const model = rule.model;
    if (on("rule-promotes-any-model") || ctx.otherPlantComponents.some((c) => c.model === model)) {
      shared = companyPromote(
        shared,
        {
          ...rule,
          scope: "company",
          condition: { ...rule.condition, componentId: null },
          consequence: { ...rule.consequence, componentId: null },
        },
        nowMs,
      );
    }
  }
  return { planted, company: shared };
}

function submitRule(rule: LearnedRule, history: HistoryEvent[]): boolean {
  const ids = rule.supportEventIds;
  if (ids.length < 3 || new Set(ids).size !== ids.length) return false;
  return ids.every((id) => {
    const event = history.find((e) => e.id === id);
    if (!event) return false;
    const conditionHolds =
      event.metric === rule.condition.metric &&
      (rule.condition.op === ">=" ? event.after >= rule.condition.value : event.after <= rule.condition.value);
    const consequenceHolds = event.effects.some(
      (e) =>
        e.metric === rule.consequence.metric &&
        (rule.consequence.componentId === null || e.componentId === rule.consequence.componentId) &&
        (rule.consequence.op === ">=" ? e.after >= rule.consequence.value : e.after <= rule.consequence.value),
    );
    return conditionHolds && consequenceHolds;
  });
}

function submitCompanyRule(rule: LearnedRule, ctx: RuleContext): boolean {
  const both = (model: string | null) =>
    ctx.components.some((c) => c.model === model) && ctx.otherPlantComponents.some((c) => c.model === model);
  return rule.supportEventIds.length >= 3 && both(rule.model);
}

function companyPromote(rules: LearnedRule[], rule: LearnedRule, nowMs: number): LearnedRule[] {
  const key = (r: LearnedRule) => JSON.stringify([r.condition, r.consequence]);
  const match = rules.find((r) => key(r) === key(rule));
  if (!match || on("rule-company-no-dedupe")) return [...rules, rule];
  return rules.map((r) =>
    r === match
      ? {
          ...r,
          timesSeen: r.timesSeen + 1,
          supportEventIds: [...new Set([...r.supportEventIds, ...rule.supportEventIds])],
          lastSeenAt: new Date(nowMs).toISOString(),
        }
      : r,
  );
}

export const engine: Engine = {
  name: actorTraits ? "reference+actor-traits" : "reference",
  traits: {
    similarLive: actorTraits ? { dropBeyond: 0.15 } : null,
    calibrationFreshWindow: actorTraits,
    lateVetoWins: false,
    blockedRecordsLateVotes: false,
    staleExpires: false,
    failedDispatchExpires: false,
    ruleThresholdScan: false,
  },
  similarRanges,
  similar,
  computeStatus,
  addCalibration,
  setMargin,
  requiredVoters,
  vote,
  veto,
  sweep,
  execute,
  promoteAfterEvent,
  submitRule,
  submitCompanyRule,
};


import type { ChatMessage, ComponentTag, Equipment, EvidenceItem, HarnessSession, PlantId, Proposal, ProposalVote, TrendPoint } from "./types";
import { CONTROL_TARGETS, controlTarget, parseControlRequest, type ControlMetric } from "./controls";
import { interpolateSampleEffects, sampleControlEffects } from "./control-effects";

export const DEMO_EPOCH = Date.UTC(2026, 9, 31, 19, 14, 21);
export const DEMO_REVIEW_MS = 5800;
export const PLANTS: { id: PlantId; name: string }[] = [{ id: "plant-a", name: "Plant A" }, { id: "plant-b", name: "Plant B" }];
export const COMPONENTS = [
  { tag: "P-100", name: "Feed pump", role: "Mechanic", vendor: "codex", metrics: { speedPct: 50, feedM3h: 15 }, limits: { speedPct: { min: 20, max: 90, critical: 95 } } },
  { tag: "TK-101", name: "Hold tank", role: "Process engineer", vendor: "claude", metrics: { levelPct: 50, tempC: 75, levelSetpointPct: 50, tempSetpointC: 75 }, limits: { levelPct: { min: 20, max: 70, critical: 80 }, tempC: { min: 70, max: 80, critical: 85 } } },
  { tag: "LV-101", name: "Outlet valve", role: "Mechanic", vendor: "codex", metrics: { positionPct: 50 }, limits: { positionPct: { min: 10, max: 80, critical: 90 } } },
  { tag: "E-101", name: "Steam coil", role: "Chemical engineer", vendor: "claude", metrics: { dutyKw: 900 }, limits: { dutyKw: { min: 300, max: 1600, critical: 1800 } } },
  { tag: "TV-101", name: "Steam valve", role: "Safety", vendor: "claude", metrics: { positionPct: 50, steamKgH: 1533, headerBarg: 6, steamSetpointKgH: 1533, steamFlowLocal: 0 }, limits: { positionPct: { min: 5, max: 85, critical: 95 }, steamKgH: { min: 0, max: 2700, critical: 3000 } } },
] as const;

export const EVIDENCE: EvidenceItem[] = [
  { id: "event-a-088", kind: "event", title: "Outlet valve reached its travel limit", plantId: "plant-a", at: "2026-10-24T15:22:00Z", summary: "Illustrative historical run: a pump increase to 90% drove LV-101 to full travel. The tank level exceeded its operating band. This fixture demonstrates the evidence viewer; it is not a recorded live-plant incident.", before: 50, after: 90, predicted: 94, observed: 100, supportIds: ["event-a-091", "event-a-097"] },
  { id: "event-a-091", kind: "event", title: "Insufficient outlet headroom at high feed", plantId: "plant-a", at: "2026-10-26T18:40:00Z", summary: "Illustrative run at 85% pump speed. Outlet position settled near 89%, above the 81% review threshold. Used with two related fixture events to explain the blocked proposal.", before: 50, after: 85, predicted: 89, observed: 89 },
  { id: "event-a-097", kind: "event", title: "Outlet travel exceeded the review band", plantId: "plant-a", at: "2026-10-27T17:10:00Z", summary: "Illustrative high-feed run: a target of 88% pushed outlet-valve travel to 92%. Together with two other high-feed sample events, it supports reviewing pump increases against the outlet-headroom rule.", before: 50, after: 88, predicted: 92, observed: 92 },
  { id: "event-a-102", kind: "event", title: "A safer throughput increase", plantId: "plant-a", at: "2026-10-29T16:15:00Z", summary: "Illustrative safe run: P-100 increased from 50% to 65%. LV-101 settled near 67% while tank temperature returned to its target. A safe run supports a safer alternative; it does not by itself prove an unsafe outcome at a higher speed.", before: 50, after: 65, predicted: 66, observed: 67 },
  { id: "rule-lv-03", kind: "rule", title: "Preserve outlet-valve headroom", plantId: "plant-a", at: "2026-10-30T17:30:00Z", summary: "P-100 ≥ 80% can drive LV-101 ≥ 85% during a throughput step. Review changes against the 81% safety threshold. This sample company rule illustrates how Plant B can consult evidence from Plant A; live rule promotion requires the external agent and actor services.", before: 50, after: 85, predicted: 89, observed: 89, supportIds: ["event-a-088", "event-a-091", "event-a-097"] },
];

export interface AuditItem { id: string; at: number; plantId: PlantId | "company"; text: string; evidenceId?: string }
export interface DemoState {
  now: number; components: Equipment[]; messages: ChatMessage[]; proposals: Proposal[];
  evidence: EvidenceItem[]; audit: AuditItem[]; trends: Record<PlantId, TrendPoint[]>;
  paused: boolean; observation: { plantId: PlantId; proposalId: string; from: number; target: number; startedAt: number; proposerTag?: ComponentTag; metric?: string; baseline?: Equipment[] } | null;
}
export type DemoAction = { type: "tick"; now: number } | { type: "reset"; now: number } | { type: "pause" } | { type: "veto"; id: string; now: number } | { type: "send"; text: string; channel: string; now: number } | { type: "propose"; plantId: PlantId; to: number; now: number; tag?: ComponentTag; metric?: string };

function message(id: string, channel: string, sender: string, text: string, at: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, channel, sender, text, at, kind: "agent", ...extra };
}

export function createDemoState(now = DEMO_EPOCH): DemoState {
  const components = PLANTS.flatMap(({ id: plantId }) => COMPONENTS.map((item) => ({ ...item, id: `${plantId}/${item.tag}`, plantId, status: "ok" as const, marginPct: 10, metrics: { ...item.metrics }, limits: { ...item.limits } }))) as Equipment[];
  const seed = (offset: number) => now - offset * 1000;
  return {
    now, components, paused: false, observation: null,
    proposals: [{ id: "p-014", plantId: "plant-a", from: 50, to: 85, status: "blocked", votes: [{ tag: "LV-101", plantId: "plant-a", vote: "no", predicted: 89, reason: "Above the 81% safety threshold", evidence: ["event-a-088", "event-a-091", "rule-lv-03"] }], createdAt: seed(18) }],
    messages: [
      message("seed-1", "plant-a", "Operator", "Increase throughput to 85%.", seed(20), { kind: "operator" }),
      message("seed-2", "plant-a", "P-100", "Proposing 50 → 85%. Requesting votes.", seed(18), { vendor: "Codex", tag: "P-100", plantId: "plant-a", proposalId: "p-014" }),
      message("seed-3", "plant-a", "LV-101", "NO. Predicted position 89%; safety threshold 81%.", seed(14), { vendor: "Codex", tag: "LV-101", plantId: "plant-a", evidence: ["event-a-088", "rule-lv-03"], proposalId: "p-014" }),
      message("seed-4", "plant-a", "TV-101", "Shared steam-header review received.", seed(9), { vendor: "Claude", tag: "TV-101", plantId: "plant-b", proposalId: "p-014" }),
      message("seed-5", "plant-a", "P-100", "Safer counterproposal: 65%.", seed(3), { vendor: "Codex", tag: "P-100", plantId: "plant-a", proposalId: "p-014" }),
      message("seed-b", "plant-b", "Plant B", "Ready for review. Five equipment agents share steam-header-1 with Plant A.", seed(12), { kind: "system", plantId: "plant-b" }),
      message("seed-company", "company", "Company", "Plant A's outlet-headroom rule is available to both plants.", seed(7), { kind: "system", evidence: ["rule-lv-03"] }),
    ],
    evidence: [...EVIDENCE],
    audit: [{ id: "audit-seed", at: seed(13), plantId: "plant-a", text: "LV-101 rejected proposal p-014 · 3 supporting events", evidenceId: "event-a-088" }],
    trends: Object.fromEntries(PLANTS.map(({ id }) => [id, Array.from({ length: 61 }, (_, i) => ({ time: now - (60 - i) * 2000, value: 50 + Math.sin(i * 0.6) * 0.13 }))])) as Record<PlantId, TrendPoint[]>,
  };
}

export function demoSessions(state: DemoState): HarnessSession[] {
  const active = state.proposals.findLast((p) => p.status === "voting");
  return state.components.map((equipment) => ({ id: equipment.id, name: equipment.tag, tag: equipment.tag, plantId: equipment.plantId, vendor: equipment.vendor, status: active && active.plantId === equipment.plantId ? "busy" : "idle", fidelity: "inferred", updatedAt: state.now }));
}

export function reviewVotes(plantId: PlantId, to: number): ProposalVote[] {
  const valve = to + (to >= 75 ? 4 : 2);
  const otherPlant: PlantId = plantId === "plant-a" ? "plant-b" : "plant-a";
  const tags = ["TK-101", "LV-101", "E-101", "TV-101", "TV-101"] as const;
  return tags.map((tag, i) => ({
    tag, plantId: i === 4 ? otherPlant : plantId,
    vote: tag === "LV-101" && valve >= 81 ? "no" : "yes",
    predicted: tag === "LV-101" ? valve : tag === "TK-101" ? 75 : tag === "E-101" ? Math.round(17.43 * to + 27) : Number((6 - Math.max(0, to - 50) * 0.012).toFixed(1)),
    reason: tag === "LV-101" ? (valve >= 81 ? "Predicted travel exceeds 81% safety threshold" : "Outlet headroom preserved") : i === 4 ? "Cross-plant shared header reviewed" : "Within the sample operating envelope",
    evidence: tag === "LV-101" ? (valve >= 81 ? ["event-a-088", "event-a-091", "rule-lv-03"] : ["event-a-102"]) : ["event-a-102"],
  }));
}

export function loopReviewVotes(state: DemoState, proposal: Proposal): ProposalVote[] {
  const metric = proposal.metric as ControlMetric;
  const effects = sampleControlEffects(state.components, proposal.plantId, metric, proposal.to);
  const proposer = proposal.proposerTag ?? "P-100";
  return effects.filter(c => c.plantId === proposal.plantId ? c.tag !== proposer : c.tag === "TV-101").map(c => {
    const breaches = Object.entries(c.limits ?? {}).filter(([name, limit]) => c.metrics[name] < limit.min || c.metrics[name] >= limit.critical * (1 - c.marginPct / 100));
    const own = state.components.find(item => item.plantId === proposal.plantId && item.tag === proposer)!;
    const ownLimit = own.limits?.[metric];
    const targetUnsafe = ownLimit && (proposal.to < ownLimit.min || proposal.to >= ownLimit.critical * (1 - own.marginPct / 100));
    const primary = c.tag === "TK-101" ? "tempC" : c.tag === "P-100" ? "speedPct" : c.tag === "E-101" ? "dutyKw" : c.tag === "TV-101" ? "steamKgH" : "positionPct";
    const blocked = !!targetUnsafe || breaches.length > 0;
    return { tag: c.tag, plantId: c.plantId, vote: blocked ? "no" : "yes", predicted: c.metrics[primary], reason: `Browser sample model: ${blocked ? targetUnsafe ? "requested target exceeds its review margin" : `${breaches.map(([name]) => name).join(", ")} exceeds its operating envelope` : `${c.plantId !== proposal.plantId ? "cross-plant shared-header" : "coupled loop"} estimate remains within limits`}`, evidence: [] };
  });
}

function propose(state: DemoState, plantId: PlantId, to: number, now: number, tag: ComponentTag = "P-100", requestedMetric?: string): DemoState {
  const metric = requestedMetric ?? CONTROL_TARGETS.find(target => target.tag === tag)?.metric ?? "speedPct";
  const target = controlTarget(tag, metric);
  if (!target || !Number.isFinite(to) || to < target.min || to > target.max) return { ...state, messages: [...state.messages, message(`invalid-${now}`, plantId, "Demo guide", target ? `Choose a ${tag === "P-100" ? "pump target" : target.label.toLowerCase() + " target"} between ${target.min}${target.unit} and ${target.max}${target.unit}.` : "Select a supported control loop.", now, { kind: "system" })] };
  if (state.proposals.some((p) => p.status === "voting" || p.status === "veto_window") || state.observation) return { ...state, messages: [...state.messages, message(`pending-${now}`, plantId, "Demo guide", "A change is already in progress. Let its review and observations finish, or veto it before execution.", now, { kind: "system" })] };
  const equipment = state.components.find((c) => c.plantId === plantId && c.tag === tag)!;
  const from = equipment.metrics[target.setpointMetric ?? metric] ?? equipment.metrics[metric];
  const previous = state.proposals.findLast((p) => p.plantId === plantId && (p.proposerTag ?? "P-100") === tag && (p.metric ?? "speedPct") === metric);
  const proposal: Proposal = { id: `p-${state.proposals.length + 14}`, plantId, proposerTag: tag, metric, from, to, status: "voting", votes: [], createdAt: now, parentId: previous?.status === "blocked" ? previous.id : undefined };
  return { ...state, now, proposals: [...state.proposals, proposal], messages: [...state.messages, message(`${proposal.id}-request`, plantId, tag, `Proposing ${target.loop} ${Math.round(from)} → ${to}${target.unit}. ${metric === "speedPct" ? "Reviewing equipment and cross-plant evidence." : "Browser sample model reviews coupled effects; no live agents are called."}`, now, { tag, plantId, vendor: equipment.vendor === "codex" ? "Codex" : "Claude", proposalId: proposal.id })], audit: [...state.audit, { id: `${proposal.id}-audit`, at: now, plantId, text: `Proposal ${proposal.id}: ${target.loop} ${Math.round(from)} → ${to}${target.unit}` }] };
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  if (action.type === "reset") return createDemoState(action.now);
  if (action.type === "pause") return { ...state, paused: !state.paused };
  if (action.type === "propose") return propose(state, action.plantId, action.to, action.now, action.tag, action.metric);
  if (action.type === "send") {
    const text = action.text.trim().slice(0, 4000);
    if (!text) return state;
    const channel = ["plant-a", "plant-b", "company"].includes(action.channel) ? action.channel : "plant-a";
    const next = { ...state, messages: [...state.messages, message(`operator-${action.now}`, channel, "Operator", text, action.now, { kind: "operator" })] };
    const target = parseControlRequest(text);
    if (target && channel !== "company") return propose(next, channel as PlantId, target.to, action.now, target.tag, target.metric);
    return { ...next, messages: [...next.messages, message(`guide-${action.now}`, channel, "Demo guide", channel === "company" ? "The company channel shows shared-resource reviews and rules. Select a plant to propose an operating change." : "Try “Propose 65%” to watch each equipment agent review a safer target. Select an agent to see its location, current task, decision summary, and evidence.", action.now + 1, { kind: "system" })] };
  }
  if (action.type === "veto") {
    const proposal = state.proposals.find((p) => p.id === action.id);
    if (!proposal || proposal.status !== "veto_window" || !proposal.vetoDeadline || action.now >= proposal.vetoDeadline) return state;
    return { ...state, proposals: state.proposals.map((p) => p.id === action.id ? { ...p, status: "vetoed" } : p), messages: [...state.messages, message(`${proposal.id}-veto`, proposal.plantId, "Operator", "Change vetoed. No setpoint was applied.", action.now, { kind: "operator" })], audit: [...state.audit, { id: `${proposal.id}-veto`, plantId: proposal.plantId, at: action.now, text: `Operator vetoed ${proposal.id}` }] };
  }
  if (action.type !== "tick") return state;
  let next = { ...state, now: action.now };
  for (const proposal of state.proposals) {
    if (proposal.status === "voting") {
      const isPump = !proposal.metric || proposal.metric === "speedPct";
      const expected = isPump ? reviewVotes(proposal.plantId, proposal.to) : loopReviewVotes(state, proposal);
      const received = Math.max(0, Math.min(expected.length, Math.floor((action.now - proposal.createdAt - 800) / 1000)));
      let votes = expected.slice(0, received);
      const refusal = votes.findIndex((vote) => vote.vote === "no");
      if (refusal !== -1) votes = votes.slice(0, refusal + 1);
      if (votes.length <= proposal.votes.length) continue;
      const blocked = votes.some((v) => v.vote === "no");
      const complete = blocked || votes.length === expected.length;
      const newVotes = votes.slice(proposal.votes.length);
      const voteMessages = newVotes.map((vote) => message(`${proposal.id}-vote-${vote.plantId}-${vote.tag}`, proposal.plantId, vote.tag,
        `${vote.vote.toUpperCase()} · ${vote.reason}.${vote.plantId !== proposal.plantId ? " Shared-header review from the other plant." : ""}`,
        action.now, { tag: vote.tag, plantId: vote.plantId, vendor: vote.tag === "LV-101" ? "Codex" : "Claude", evidence: vote.evidence, proposalId: proposal.id }));
      if (!complete) {
        next = { ...next, proposals: next.proposals.map((p) => p.id === proposal.id ? { ...p, votes } : p), messages: [...next.messages, ...voteMessages] };
        continue;
      }
      next = { ...next, proposals: next.proposals.map((p) => p.id === proposal.id ? { ...p, votes, status: blocked ? "blocked" : "veto_window", vetoDeadline: blocked ? undefined : action.now + 5_000 } : p), messages: [...next.messages,
        ...voteMessages,
        message(`${proposal.id}-decision`, proposal.plantId, blocked ? (isPump ? "LV-101" : votes.find(v => v.vote === "no")!.tag) : "Equipment consensus", !isPump ? blocked ? `Browser sample review refused: ${votes.find(v => v.vote === "no")!.reason}. No target applied.` : `All 5 browser sample reviews accepted. ${proposal.to}${controlTarget(proposal.proposerTag!, proposal.metric!)?.unit ?? ""} can apply after the 5-second veto window.` : blocked ? `NO. Predicted outlet position ${votes[1].predicted}%; safety threshold 81%. ${proposal.plantId === "plant-b" ? "Plant A's shared headroom rule applies here too." : "A 65% target preserves headroom."}` : `All 5 required votes are YES, including the other plant's steam valve. ${proposal.to}% can execute after the 5-second veto window.`, action.now, { tag: blocked ? (isPump ? "LV-101" : votes.find(v => v.vote === "no")!.tag) : proposal.proposerTag ?? "P-100", plantId: proposal.plantId, vendor: blocked ? "Codex" : undefined, evidence: !isPump ? [] : blocked ? ["event-a-088", "rule-lv-03"] : ["event-a-102"], proposalId: proposal.id }),
      ], audit: [...next.audit, { id: `${proposal.id}-decision`, at: action.now, plantId: proposal.plantId, text: blocked ? `${proposal.id} blocked · evidence-backed outlet constraint` : `${proposal.id} unanimous · 10s human veto window`, evidenceId: !isPump ? undefined : blocked ? "rule-lv-03" : "event-a-102" }] };
    }
    if (proposal.status === "veto_window" && proposal.vetoDeadline && action.now >= proposal.vetoDeadline) {
      next = { ...next, proposals: next.proposals.map((p) => p.id === proposal.id ? { ...p, status: "executed" } : p), observation: { plantId: proposal.plantId, proposalId: proposal.id, from: proposal.from, target: proposal.to, startedAt: action.now, proposerTag: proposal.proposerTag, metric: proposal.metric, baseline: state.components.map(c => ({ ...c, metrics: { ...c.metrics } })) }, messages: [...next.messages, message(`${proposal.id}-execute`, proposal.plantId, "Demo controller", `Veto window passed. Applying the sample ${proposal.to}${controlTarget(proposal.proposerTag ?? "P-100", proposal.metric ?? "speedPct")?.unit ?? "%"} target; awaiting observed response.`, action.now, { kind: "system" })], audit: [...next.audit, { id: `${proposal.id}-execute`, at: action.now, plantId: proposal.plantId, text: `${proposal.id} applied in frontend demo · observing response` }] };
    }
  }
  if (next.observation && !next.paused) {
    const observation = next.observation;
    const progress = Math.min(1, (action.now - observation.startedAt) / 5000);
    const isLoop = !!observation.metric && observation.metric !== "speedPct";
    if (isLoop) { const baseline = observation.baseline ?? state.components; next.components = interpolateSampleEffects(baseline, sampleControlEffects(baseline, observation.plantId, observation.metric as ControlMetric, observation.target), progress); }
    const speed = observation.from + (observation.target - observation.from) * progress;
    if (!isLoop) next.components = next.components.map((c) => {
      if (c.plantId !== observation.plantId) return c.tag === "TV-101" ? { ...c, metrics: { ...c.metrics, headerBarg: Number((6 - Math.max(0, speed - 50) * 0.012).toFixed(2)) } } : c;
      const metrics = { ...c.metrics };
      if (c.tag === "P-100") Object.assign(metrics, { speedPct: speed, feedM3h: speed * 0.3 });
      if (c.tag === "LV-101") metrics.positionPct = speed + progress * 2;
      if (c.tag === "TK-101") metrics.tempC = 75 - Math.sin(progress * Math.PI) * 2;
      if (c.tag === "E-101") metrics.dutyKw = 17.43 * speed + 27;
      if (c.tag === "TV-101") Object.assign(metrics, { positionPct: 0.36 * speed + 32.5, steamKgH: 29.7 * speed + 48, headerBarg: 6 - Math.max(0, speed - 50) * 0.012 });
      return { ...c, metrics };
    });
    if (progress >= 1) {
      const evidenceId = `observed-${observation.proposalId}`;
      if (isLoop) {
        const target = controlTarget(observation.proposerTag!, observation.metric!); const unit = target?.unit ?? "";
        const observed = next.components.find(c => c.plantId === observation.plantId && c.tag === observation.proposerTag)!.metrics[observation.metric!];
        next = { ...next, observation: null, evidence: [...next.evidence, { id: evidenceId, kind: "event", title: `Browser sample ${target?.label ?? observation.metric} ${observation.target}${unit}`, plantId: observation.plantId, at: new Date(action.now).toISOString(), summary: "Frontend demo observation. Browser-only sample mass/energy and hydrostatic estimates; these are not measured simulator values or live agent decisions.", before: observation.from, after: observation.target, predicted: observation.target, observed }], messages: [...next.messages, message(`${observation.proposalId}-observed`, observation.plantId, "Demo observation", `Browser sample response: ${target?.label ?? observation.metric} ${Number(observed.toFixed(2))}${unit}. Coupled equipment estimates updated; this is an illustrative browser model.`, action.now, { kind: "system", evidence: [evidenceId] })], audit: [...next.audit, { id: `${observation.proposalId}-observed`, at: action.now, plantId: observation.plantId, text: `Sample ${target?.loop} response ${Number(observed.toFixed(2))}${unit}`, evidenceId }] };
      } else next = { ...next, observation: null, evidence: [...next.evidence, { id: evidenceId, kind: "event", title: `Sample ${observation.target}% run completed`, plantId: observation.plantId, at: new Date(action.now).toISOString(), summary: "Frontend demo observation. These values animate a fixture scenario; no actor, plant simulator, or live agent has been called. This record demonstrates where measured results and calibration will appear after integration.", before: observation.from, after: observation.target, predicted: observation.target + 1, observed: observation.target + 2 }], messages: [...next.messages, message(`${observation.proposalId}-observed`, observation.plantId, "Demo observation", `Outlet position settled at ${observation.target + 2}%. Predicted ${observation.target + 1}%, sample error 1 point. Observation added to this demo's memory.`, action.now, { kind: "system", evidence: [evidenceId] })], audit: [...next.audit, { id: `${observation.proposalId}-observed`, at: action.now, plantId: observation.plantId, text: `Observation recorded · LV-101 ${observation.target + 2}% · sample calibration error 1 point`, evidenceId }] };
    }
  }
  if (!next.paused) {
    next.trends = { ...next.trends };
    for (const { id } of PLANTS) {
      const value = next.components.find((c) => c.plantId === id && c.tag === "LV-101")!.metrics.positionPct;
      next.trends[id] = [...next.trends[id].filter((p) => p.time >= action.now - 120_000), { time: action.now, value }].slice(-121);
    }
  }
  return next;
}

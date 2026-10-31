import type { DemoState } from "./demo";
import { controlTarget } from "./controls";
import type { AgentActivity, ComponentTag, Equipment, Proposal } from "./types";

const locations: Record<ComponentTag, string> = {
  "P-100": "Feed storage · west pump bay",
  "TK-101": "Process hall · heated tank bay",
  "LV-101": "Discharge · east process line",
  "E-101": "Thermal loop · inside TK-101",
  "TV-101": "Utilities · shared steam rack",
};

const value = (equipment: Equipment, key: string, decimals = 0) => (equipment.metrics[key] ?? 0).toFixed(decimals);
const plantName = (id: string) => id === "plant-a" ? "Plant A" : "Plant B";

function monitoring(equipment: Equipment, now: number): AgentActivity {
  const summaries: Record<ComponentTag, [string, string]> = {
    "P-100": ["Track feed availability and pump throughput", `Pump speed is ${value(equipment, "speedPct")}%; feed is ${value(equipment, "feedM3h", 1)} m³/h. A throughput change needs downstream equipment review.`],
    "TK-101": ["Hold tank level and temperature in range", `Tank level is ${value(equipment, "levelPct", 1)}% and temperature is ${value(equipment, "tempC", 1)}°C. Check inventory and thermal response before accepting more feed.`],
    "LV-101": ["Preserve outlet-valve travel headroom", `Outlet position is ${value(equipment, "positionPct")}% against an 81% review threshold. Compare higher feed against the shared headroom rule.`],
    "E-101": ["Match heating duty to the process load", `The coil supplies ${value(equipment, "dutyKw")} kW. Review the heat balance before the feed rate changes.`],
    "TV-101": ["Protect the steam header shared by both plants", `Header pressure is ${value(equipment, "headerBarg", 1)} barg; local steam flow is ${value(equipment, "steamKgH")} kg/h. Review changes in either plant.`],
  };
  const [task, summary] = summaries[equipment.tag];
  return { id: equipment.id, plantId: equipment.plantId, tag: equipment.tag, equipmentName: equipment.name, vendor: equipment.vendor, role: equipment.role, location: `${plantName(equipment.plantId)} / ${locations[equipment.tag]}`, state: "monitoring", task, summary, latestAction: "Read current sample measurements; no change requested.", updatedAt: now, evidence: [], progress: 0 };
}

function involves(equipment: Equipment, proposal: Proposal) {
  return equipment.plantId === proposal.plantId || equipment.tag === "TV-101";
}

const proposalDescription = (proposal: Proposal) => {
  const control = controlTarget(proposal.proposerTag ?? "P-100", proposal.metric ?? "speedPct");
  return { tag: proposal.proposerTag ?? "P-100", label: control ? `${control.loop} ${control.label.toLowerCase()}` : proposal.metric ?? "pump speed", unit: control?.unit ?? "" };
};

/** Public state summaries, derived from measurements and recorded votes. */
export function demoAgentActivities(state: DemoState): AgentActivity[] {
  const active = state.proposals.findLast((proposal) => proposal.status === "voting" || proposal.status === "veto_window");
  const observing = state.observation ? state.proposals.find((proposal) => proposal.id === state.observation?.proposalId) : undefined;
  return state.components.map((equipment) => {
    const activity = monitoring(equipment, state.now);
    const proposal = active && involves(equipment, active) ? active : undefined;
    if (proposal) {
      const description = proposalDescription(proposal);
      const crossPlant = equipment.plantId !== proposal.plantId;
      const proposer = equipment.tag === description.tag && !crossPlant;
      const vote = proposal.votes.find((item) => item.tag === equipment.tag && item.plantId === equipment.plantId);
      const target = `${description.label} ${proposal.from} → ${proposal.to}${description.unit}`;
      activity.task = proposer ? `Coordinate ${target}` : crossPlant ? `Review ${plantName(proposal.plantId)}'s ${description.label} and shared steam demand` : `Review ${target} against ${equipment.name.toLowerCase()} limits`;
      activity.updatedAt = state.messages.findLast((message) => message.proposalId === proposal.id && message.tag === equipment.tag && message.plantId === equipment.plantId)?.at ?? proposal.createdAt;
      activity.progress = Math.min(85, 15 + proposal.votes.length * 14);
      if (proposal.status === "veto_window") {
        activity.state = "waiting";
        activity.summary = proposer ? `All required agents accepted ${proposal.to}${description.unit} for ${description.label}. The operator can veto before the 5-second window ends.` : `${vote?.reason ?? "Equipment review complete"}. Waiting for the operator veto window; no setpoint has changed yet.`;
        activity.latestAction = vote ? `Voted ${vote.vote.toUpperCase()} on ${proposal.id}; waiting for human oversight.` : `Collected ${proposal.votes.length} accepted reviews for ${proposal.id}.`;
        activity.evidence = vote?.evidence ?? [];
      } else if (vote) {
        activity.state = vote.vote === "no" ? "blocked" : "ready";
        activity.summary = vote.reason;
        activity.latestAction = `Submitted ${vote.vote.toUpperCase()} vote on ${proposal.id}.`;
        activity.evidence = vote.evidence;
        activity.progress = 100;
      } else if (proposer) {
        activity.state = state.now - proposal.createdAt < 1800 ? "thinking" : "waiting";
        activity.summary = `Prepare ${target} and gather the other equipment agents' reviews, including the shared steam header. ${proposal.votes.length}/5 votes received.`;
        activity.latestAction = `Opened proposal ${proposal.id}; current ${description.label} target remains ${proposal.from}${description.unit}.`;
      } else {
        activity.state = state.now - proposal.createdAt < 1400 ? "thinking" : "reviewing";
        activity.summary = crossPlant ? `Check how ${plantName(proposal.plantId)}'s ${description.label} change affects steam available here.` : `Compare the proposed ${description.label} of ${proposal.to}${description.unit} with current measurements, equipment limits, and relevant recorded evidence.`;
        activity.latestAction = `${crossPlant ? "Received cross-plant review" : "Reviewing measurements and evidence for"} ${proposal.id}.`;
      }
      return activity;
    }
    if (observing && involves(equipment, observing)) {
      const description = proposalDescription(observing);
      activity.state = "observing";
      activity.task = `Observe ${description.label} at ${observing.to}${description.unit} and compare prediction with response`;
      activity.summary = `${equipment.plantId !== observing.plantId ? "Track shared steam-header pressure" : "Read the changing simulator measurements"}. A completed observation is recorded separately from the acceptance vote.`;
      activity.latestAction = `The veto window ended for ${observing.id}; observing the measured response.`;
      activity.updatedAt = state.observation!.startedAt;
      activity.progress = 80 + Math.round(Math.min(1, (state.now - state.observation!.startedAt) / 5000) * 20);
      return activity;
    }
    const last = state.proposals.findLast((item) => involves(equipment, item));
    if (!last) return activity;
    const description = proposalDescription(last);
    const ownVote = last.votes.find((vote) => vote.tag === equipment.tag && vote.plantId === equipment.plantId);
    const proposer = equipment.plantId === last.plantId && equipment.tag === description.tag;
    if (last.status === "blocked" && ownVote?.vote === "no") {
      activity.state = "blocked";
      activity.task = `Refuse the proposed ${description.label} of ${last.to}${description.unit}`;
      activity.summary = ownVote.reason;
      activity.latestAction = `Rejected ${last.id}; shared the supporting evidence.`;
      activity.updatedAt = state.messages.findLast((message) => message.proposalId === last.id && message.tag === equipment.tag && message.plantId === equipment.plantId)?.at ?? last.createdAt;
      activity.evidence = ownVote.evidence;
      activity.progress = 100;
    } else if (last.status === "blocked" && proposer) {
      activity.state = "ready";
      activity.task = "Review the refusal before preparing another proposal";
      activity.summary = `An equipment agent refused ${last.to}${description.unit} for ${description.label}. Any alternative needs a fresh equipment review.`;
      activity.latestAction = `Received refusal on ${last.id}; the previous setpoint remains in place.`;
      activity.updatedAt = last.createdAt;
      activity.evidence = last.votes.filter((vote) => vote.vote === "no").flatMap((vote) => vote.evidence);
      activity.progress = 100;
    } else if (last.status === "vetoed") {
      activity.latestAction = `Operator vetoed ${last.id}. No setpoint was applied.`;
      activity.updatedAt = state.messages.find((message) => message.id === `${last.id}-veto`)?.at ?? last.createdAt;
    } else if (last.status === "executed") {
      activity.latestAction = `Completed ${last.id}; monitoring the measured response.`;
      activity.evidence = state.evidence.some((record) => record.id === `observed-${last.id}`) ? [`observed-${last.id}`] : [];
      const observedAt = state.evidence.find((record) => record.id === `observed-${last.id}`)?.at;
      activity.updatedAt = observedAt ? Date.parse(observedAt) : last.createdAt;
    }
    return activity;
  });
}

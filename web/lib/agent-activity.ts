import type { DemoState } from "./demo";
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

/** Public, deterministic demo state. These summaries are not private model reasoning. */
export function demoAgentActivities(state: DemoState): AgentActivity[] {
  const active = state.proposals.findLast((proposal) => proposal.status === "voting" || proposal.status === "veto_window");
  const observing = state.observation ? state.proposals.find((proposal) => proposal.id === state.observation?.proposalId) : undefined;
  return state.components.map((equipment) => {
    const activity = monitoring(equipment, state.now);
    const proposal = active && involves(equipment, active) ? active : undefined;
    if (proposal) {
      const crossPlant = equipment.plantId !== proposal.plantId;
      const vote = proposal.votes.find((item) => item.tag === equipment.tag && item.plantId === equipment.plantId);
      const reviewTasks: Record<ComponentTag, string> = {
        "P-100": `Coordinate the pump change · ${proposal.from.toFixed(0)} → ${proposal.to}%`,
        "TK-101": `Check tank level and temperature at ${proposal.to}% feed`,
        "LV-101": `Check outlet headroom at ${proposal.to}% feed`,
        "E-101": `Calculate heating duty at ${proposal.to}% feed`,
        "TV-101": crossPlant ? `Review ${plantName(proposal.plantId)}'s shared-header demand` : `Review steam demand at ${proposal.to}% feed`,
      };
      activity.task = reviewTasks[equipment.tag];
      activity.updatedAt = proposal.createdAt;
      activity.progress = Math.min(85, 15 + proposal.votes.length * 14);
      if (proposal.status === "veto_window") {
        activity.state = "waiting";
        activity.summary = equipment.tag === "P-100" ? `All five required agents accepted ${proposal.to}%. The operator can veto before the 10-second window ends.` : `${vote?.reason ?? "Equipment review complete"}. Waiting for the operator veto window; no setpoint has changed yet.`;
        activity.latestAction = vote ? `Voted ${vote.vote.toUpperCase()} on ${proposal.id}; waiting for human oversight.` : `Collected 5/5 YES votes for ${proposal.id}.`;
        activity.evidence = vote?.evidence ?? [];
        return activity;
      }
      if (equipment.tag === "P-100" && !crossPlant) {
        activity.state = state.now - proposal.createdAt < 1800 ? "thinking" : "waiting";
        activity.summary = `Prepare the ${proposal.to}% target and gather tank, outlet, heat-duty, and both steam-valve reviews. ${proposal.votes.length}/5 votes received.`;
        activity.latestAction = `Opened proposal ${proposal.id}; current pump speed remains ${proposal.from.toFixed(0)}%.`;
      } else if (vote) {
        activity.state = vote.vote === "no" ? "blocked" : "ready";
        activity.summary = vote.reason;
        activity.latestAction = `Submitted ${vote.vote.toUpperCase()} vote on ${proposal.id}.`;
        activity.evidence = vote.evidence;
        activity.progress = 100;
        activity.updatedAt = state.messages.find((message) => message.id === `${proposal.id}-vote-${equipment.plantId}-${equipment.tag}`)?.at ?? proposal.createdAt;
      } else {
        activity.state = state.now - proposal.createdAt < 1400 ? "thinking" : "reviewing";
        const steps: Record<ComponentTag, string> = {
          "P-100": "Review the proposed pump target.",
          "TK-101": "Compare incoming feed against the tank inventory and temperature envelope.",
          "LV-101": `Predict outlet travel at ${proposal.to}% feed and compare it against the 81% safety threshold using the sample headroom evidence.`,
          "E-101": "Calculate the heating duty required by the proposed flow and check the coil envelope.",
          "TV-101": crossPlant ? `Check how ${plantName(proposal.plantId)}'s demand affects the steam pressure available here.` : "Check local steam demand and shared-header pressure before accepting the flow change.",
        };
        activity.summary = steps[equipment.tag];
        activity.latestAction = crossPlant ? `Received cross-plant review ${proposal.id}.` : `Reading sample measurements and evidence for ${proposal.id}.`;
        activity.evidence = equipment.tag === "LV-101" ? ["rule-lv-03", "event-a-102"] : [];
      }
      return activity;
    }
    if (observing && involves(equipment, observing)) {
      activity.state = "observing";
      activity.task = `Observe the ${observing.to}% run and compare prediction with response`;
      activity.summary = `${equipment.plantId !== observing.plantId ? "Track shared steam-header pressure" : "Read the changing sample measurements"}. A completed observation is recorded separately from the acceptance vote.`;
      activity.latestAction = `The veto window ended for ${observing.id}; observing the frontend response.`;
      activity.updatedAt = state.observation!.startedAt;
      activity.progress = 80 + Math.round(Math.min(1, (state.now - state.observation!.startedAt) / 5000) * 20);
      return activity;
    }
    const last = state.proposals.findLast((item) => item.plantId === equipment.plantId);
    if (last?.status === "blocked" && equipment.tag === "LV-101") {
      const refusal = last.votes.find((vote) => vote.vote === "no");
      activity.state = "blocked";
      activity.task = `Prevent an unsafe ${last.to}% feed target`;
      activity.summary = `Predicted outlet travel ${refusal?.predicted ?? last.to + 4}% exceeds the 81% threshold. The sample evidence supports refusing this change; current equipment remains at its previous setpoint.`;
      activity.latestAction = `Rejected ${last.id}. Shared the headroom rule and supporting events.`;
      activity.updatedAt = state.messages.findLast((message) => message.proposalId === last.id && message.tag === equipment.tag)?.at ?? last.createdAt;
      activity.evidence = refusal?.evidence ?? ["rule-lv-03"];
      activity.progress = 100;
    } else if (last?.status === "blocked" && equipment.tag === "P-100") {
      activity.state = "ready";
      activity.task = "Prepare a safer 65% counterproposal";
      activity.summary = "The outlet agent refused 85%. A 65% target preserves predicted outlet headroom and still needs a fresh five-agent review.";
      activity.latestAction = `Proposed a safer alternative after ${last.id} was blocked.`;
      activity.updatedAt = state.messages.findLast((message) => message.proposalId === last.id && message.tag === equipment.tag)?.at ?? last.createdAt;
      activity.evidence = ["event-a-102"];
      activity.progress = 100;
    } else if (last?.status === "vetoed") {
      activity.latestAction = `Operator vetoed ${last.id}. No setpoint was applied.`;
      activity.updatedAt = state.messages.find((message) => message.id === `${last.id}-veto`)?.at ?? last.createdAt;
    } else if (last?.status === "executed") {
      activity.latestAction = `Completed ${last.id}; sample observation recorded. Monitoring the new operating point.`;
      activity.evidence = [`observed-${last.id}`];
      const observedAt = state.evidence.find((record) => record.id === `observed-${last.id}`)?.at;
      activity.updatedAt = observedAt ? Date.parse(observedAt) : last.createdAt;
    }
    return activity;
  });
}

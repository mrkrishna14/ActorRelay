"use client";

import { ArrowUpRight, CircleNotch, Cpu } from "@phosphor-icons/react";
import type { AgentActivity, AgentActivityState } from "../lib/types";
import { agentColor, agentColorStyle } from "../lib/agent-colors";
import "./agent-context.css";

interface Props { activity: AgentActivity; onDetails: () => void }

export const agentStateLabels: Record<AgentActivityState, string> = {
  monitoring: "Monitoring", thinking: "Thinking", reviewing: "Reviewing", waiting: "Waiting",
  blocked: "Blocked", ready: "Ready", observing: "Observing",
};

export default function AgentContextBar({ activity, onDetails }: Props) {
  const activeReview = activity.state === "thinking" || activity.state === "reviewing";
  const role = activity.role.replaceAll("_", " ");
  return <section className="agent-context-bar ar-agent-hue" style={agentColorStyle(activity.plantId, activity.tag)} aria-label="Selected equipment agent activity">
    <span className="agent-context-avatar" aria-hidden="true" title={`${agentColor(activity.plantId, activity.tag)?.name ?? ""} agent`}><Cpu size={18} weight="light" /></span>
    <div className="agent-context-identity"><strong><code>{activity.tag}</code><span>{activity.equipmentName}</span></strong><p title={`${role} · ${activity.vendor === "codex" ? "Codex" : "Claude"} · ${activity.location}`}>{role}<i />{activity.vendor === "codex" ? "Codex" : "Claude"}<i /><span>{activity.location}</span></p></div>
    <div className="agent-context-current"><div><span className={`agent-context-state agent-context-state-${activity.state}`} role="status" aria-live="polite">{activeReview ? <CircleNotch size={10} className="agent-context-spinner" aria-hidden="true" /> : <i aria-hidden="true" />}{agentStateLabels[activity.state]}</span><span className="agent-context-sample" title="Frontend sample activity">Sample</span></div><p title={activity.task}>{activity.task}</p></div>
    <button className="agent-context-details" onClick={onDetails} aria-label={`Agent details for ${activity.tag} in ${activity.plantId === "plant-a" ? "Plant A" : "Plant B"}`}><span>Agent details</span><ArrowUpRight size={14} /></button>
  </section>;
}

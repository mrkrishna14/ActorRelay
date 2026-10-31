"use client";

import { useEffect, useId, useRef } from "react";
import { ArrowRight, ArrowUpRight, BookOpen, CheckCircle, Cpu, FileText, Info, X, XCircle } from "@phosphor-icons/react";
import type { AgentActivity, AgentActivityState } from "../lib/types";
import { agentStateLabels } from "./AgentContextBar";
import { agentColorStyle } from "../lib/agent-colors";
import "./agent-context.css";

interface Props { activity: AgentActivity | null; onClose: () => void; onEvidence: (id: string) => void }

const definitions: Record<AgentActivityState, string> = {
  monitoring: "Watching the equipment's sample measurements. No proposal needs this agent's review.",
  thinking: "Preparing a concise decision summary using the sample task context and available evidence.",
  reviewing: "Assessing the requested change against equipment limits and the available sample evidence.",
  waiting: "Waiting for other equipment reviews or for the human veto window to finish.",
  blocked: "The sample change was refused because a constraint was not satisfied. The rejected target is not applied.",
  ready: "This agent's sample review is complete. A ready agent alone does not authorize a change.",
  observing: "Comparing the sample response after an accepted change with the earlier prediction.",
};

const workflow = [
  { state: "monitoring", label: "Monitoring" }, { state: "reviewing", label: "Reviewing" },
  { state: "waiting", label: "Waiting" }, { state: "observing", label: "Observing" },
] as const;

export default function AgentStateDialog({ activity, onClose, onEvidence }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();
  const noteId = useId();
  const open = activity !== null;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, [open]);
  if (!activity) return null;

  const activeStep = activity.state === "monitoring" ? 0 : ["thinking", "reviewing", "blocked"].includes(activity.state) ? 1 : ["waiting", "ready"].includes(activity.state) ? 2 : 3;
  const updated = new Date(activity.updatedAt);
  const validTime = !Number.isNaN(updated.getTime());
  const role = activity.role.replaceAll("_", " ");

  return <dialog ref={dialogRef} className="agent-state-dialog" aria-labelledby={titleId} aria-describedby={noteId}
    onCancel={(event) => { event.preventDefault(); closeRef.current(); }}
    onClick={(event) => { if (event.target === event.currentTarget) closeRef.current(); }}>
    <div className="agent-state-shell ar-agent-hue" style={agentColorStyle(activity.plantId, activity.tag)}>
      <header className="agent-state-header"><div><span className="agent-state-eyebrow">{activity.plantId === "plant-a" ? "PLANT A" : "PLANT B"} / EQUIPMENT AGENT</span><h2 id={titleId}><span className="agent-state-avatar" aria-hidden="true"><Cpu size={18} weight="light" /></span><code className="agent-state-tag">{activity.tag}</code><span>{activity.equipmentName}</span></h2></div><button className="agent-state-close" aria-label="Close agent details" onClick={() => closeRef.current()}><X size={19} /></button></header>
      <div className="agent-state-metadata"><span>{role}</span><span>{activity.vendor === "codex" ? "Codex" : "Claude"}</span><span>{activity.location}</span><span className="agent-state-sample">Sample activity</span></div>

      <div className="agent-state-content">
        <section className="agent-state-task"><div className="agent-state-section-label"><h3>Current task</h3><span className={`agent-context-state agent-context-state-${activity.state}`}><i />{agentStateLabels[activity.state]}</span></div><p>{activity.task}</p><small>{definitions[activity.state]}</small></section>

        <section className="agent-state-workflow" aria-label="Agent review workflow"><ol>{workflow.map((step, index) => <li key={step.state} className={index === activeStep ? "agent-workflow-current" : ""} aria-current={index === activeStep ? "step" : undefined}><span><i>{index + 1}</i>{step.label}</span>{index !== workflow.length - 1 ? <ArrowRight size={13} aria-hidden="true" /> : null}</li>)}</ol><div className={`agent-state-rejection ${activity.state === "blocked" ? "agent-state-rejection-active" : ""}`}><span /><XCircle size={14} /><span>Review can block the proposal</span></div></section>

        <section className="agent-state-summary"><div className="agent-state-section-label"><h3>Decision summary</h3><BookOpen size={14} /></div><p>{activity.summary || "No decision summary has been supplied for this task."}</p></section>

        <section className="agent-state-latest"><CheckCircle size={17} weight="light" /><div><h3>Latest action</h3><p>{activity.latestAction || "No action reported."}</p></div><time dateTime={validTime ? updated.toISOString() : undefined}>{validTime ? updated.toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "short", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "Time unavailable"}</time></section>

        <section className="agent-state-evidence"><div className="agent-state-section-label"><h3>Referenced evidence</h3><span>{activity.evidence.length} records</span></div>{activity.evidence.length ? <div>{activity.evidence.map((id) => <button key={id} onClick={() => onEvidence(id)}>{id.startsWith("rule") ? <BookOpen size={14} /> : <FileText size={14} />}<code>{id}</code><ArrowUpRight size={13} /></button>)}</div> : <p>No evidence links are attached to the current sample task.</p>}</section>

        <details className="agent-state-help"><summary><Info size={15} />What do agent states mean?</summary><dl>{(Object.keys(definitions) as AgentActivityState[]).map((state) => <div key={state} className={activity.state === state ? "agent-state-definition-current" : ""}><dt>{agentStateLabels[state]}</dt><dd>{definitions[state]}</dd></div>)}</dl></details>
      </div>
      <footer id={noteId} className="agent-state-footer">Sample activity follows the frontend scenario. States and summaries do not indicate that a live model, tool, or harness has run.</footer>
    </div>
  </dialog>;
}

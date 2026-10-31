"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, BookOpen, CheckCircle, FileText, HandPalm, LinkSimple, Timer, X, XCircle } from "@phosphor-icons/react";
import type { ComponentTag, Proposal, ProposalStatus } from "../lib/types";
import { agentColorStyle } from "../lib/agent-colors";
import "./proposal-review.css";

interface Props {
  proposal: Proposal;
  onClose: () => void;
  onVeto: () => void;
  onEvidence: (id: string) => void;
  onCounter: (to: number) => void;
}

const statusNames: Record<ProposalStatus, string> = {
  voting: "Collecting votes", blocked: "Blocked", veto_window: "Human veto window",
  vetoed: "Vetoed", executed: "Executed", expired: "Expired",
};
const predictionLabels: Record<ComponentTag, { label: string; unit: string }> = {
  "P-100": { label: "Pump speed", unit: "%" },
  "TK-101": { label: "Temperature", unit: "°C" },
  "LV-101": { label: "Outlet position", unit: "%" },
  "E-101": { label: "Coil duty", unit: "kW" },
  "TV-101": { label: "Steam header", unit: "barg" },
};

export default function ProposalReview({ proposal, onClose, onVeto, onEvidence, onCounter }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();
  const noteId = useId();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (proposal.status !== "veto_window") return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(interval);
  }, [proposal.status, proposal.vetoDeadline]);

  const remaining = proposal.vetoDeadline ? Math.max(0, proposal.vetoDeadline - now) : 0;
  const seconds = Math.ceil(remaining / 1000);
  const canVeto = proposal.status === "veto_window" && remaining > 0;
  const yesCount = proposal.votes.filter((vote) => vote.vote === "yes").length;
  const noCount = proposal.votes.filter((vote) => vote.vote === "no").length;
  const plantName = proposal.plantId === "plant-a" ? "Plant A" : "Plant B";

  return <dialog ref={dialogRef} className="proposal-review-dialog" aria-labelledby={titleId} aria-describedby={noteId}
    onCancel={(event) => { event.preventDefault(); closeRef.current(); }}
    onClick={(event) => { if (event.target === event.currentTarget) closeRef.current(); }}>
    <div className="proposal-review-shell">
      <header className="proposal-review-header">
        <div><span className="proposal-review-eyebrow">{plantName.toUpperCase()} / SAMPLE PROPOSAL</span><h2 id={titleId}>Equipment consensus</h2></div>
        <button className="proposal-review-close" aria-label="Close proposal review" onClick={() => closeRef.current()}><X size={19} /></button>
      </header>

      <div className="proposal-review-request"><div><code>{proposal.id}</code>{proposal.parentId ? <span>Counter to {proposal.parentId}</span> : <span>P-100 · Feed pump</span>}</div><strong>{proposal.from}<small>%</small><ArrowRight size={21} />{proposal.to}<small>%</small></strong></div>

      <div className={`proposal-review-status proposal-review-status-${proposal.status}`}>
        {proposal.status === "blocked" || proposal.status === "vetoed" ? <XCircle size={21} /> : proposal.status === "executed" ? <CheckCircle size={21} /> : <Timer size={21} />}
        <div><strong>{statusNames[proposal.status]}</strong><p>{proposal.status === "blocked" ? "An equipment agent refused this change. No setpoint was applied." : proposal.status === "voting" ? "Waiting for equipment and shared-resource review. No setpoint is applied during voting." : proposal.status === "veto_window" ? "Unanimous review is complete. You can stop the change before its deadline." : proposal.status === "vetoed" ? "The operator stopped this change. No setpoint was applied." : proposal.status === "expired" ? "Review did not finish in time. No setpoint was applied." : "The frontend sample accepted the target. Observed response is recorded separately."}</p></div>
        {proposal.status === "veto_window" ? <span className="proposal-review-timer" aria-label={`${seconds} seconds left to veto`}>{seconds}<small>s</small></span> : null}
      </div>

      <section className="proposal-review-votes" aria-label="Equipment votes">
        <div className="proposal-review-vote-heading"><h3>Equipment review</h3><span>{proposal.votes.length}/5 received <i /> {yesCount} yes · {noCount} no</span></div>
        {proposal.votes.length ? <ol>{proposal.votes.map((vote) => {
          const crossPlant = vote.plantId !== proposal.plantId;
          const metric = predictionLabels[vote.tag];
          return <li key={`${vote.plantId}/${vote.tag}`} className={`proposal-review-vote proposal-review-vote-${vote.vote} ar-agent-hue`} style={agentColorStyle(vote.plantId, vote.tag)}>
            <div className="proposal-review-vote-top"><span className="proposal-review-vote-symbol">{vote.vote === "yes" ? <CheckCircle size={18} weight="light" /> : <XCircle size={18} />}</span><i className="proposal-review-agent-dot" aria-hidden="true" /><strong className="proposal-review-agent-tag">{vote.tag}</strong><span>{vote.plantId === "plant-a" ? "Plant A" : "Plant B"}</span>{crossPlant ? <span className="proposal-review-crossplant"><LinkSimple size={11} />Cross-plant</span> : null}<b>{vote.vote.toUpperCase()}</b></div>
            <div className="proposal-review-vote-body"><div className="proposal-review-prediction"><span>Predicted {metric.label.toLowerCase()}</span><strong>{vote.predicted.toLocaleString(undefined, { maximumFractionDigits: 1 })}<small>{metric.unit}</small></strong></div><p>{vote.reason}</p></div>
            {crossPlant ? <p className="proposal-review-shared-note">TV-101 reviews the steam header shared by both plants.</p> : null}
            {vote.evidence.length ? <div className="proposal-review-evidence" aria-label={`${vote.tag} supporting evidence`}>{vote.evidence.map((id) => <button key={id} onClick={() => onEvidence(id)} title={`Open ${id}`}>{id.startsWith("rule") ? <BookOpen size={12} /> : <FileText size={12} />}<span>{id}</span></button>)}</div> : <p className="proposal-review-no-evidence">No supporting records supplied.</p>}
          </li>;
        })}</ol> : <div className="proposal-review-waiting"><Timer size={23} weight="light" /><strong>No votes received yet</strong><p>Only received votes will appear here.</p></div>}
      </section>

      {proposal.status === "veto_window" ? <div className="proposal-review-action"><div><strong>{canVeto ? "Human veto window" : "Veto deadline reached"}</strong><p>{canVeto ? "Unanimous votes are required, followed by this 10-second veto window." : "The review is awaiting its next state update."}</p></div><button className="proposal-review-veto" disabled={!canVeto} onClick={() => { if (proposal.vetoDeadline && Date.now() < proposal.vetoDeadline) onVeto(); }}><HandPalm size={17} />Veto change</button></div> : null}
      {proposal.status === "blocked" ? <div className="proposal-review-action"><div><strong>Review a safer alternative</strong><p>A 65% counterproposal starts a new equipment review.</p></div><button className="proposal-review-counter" onClick={() => { onCounter(65); closeRef.current(); }}>Propose 65%<ArrowRight size={16} /></button></div> : null}
      <footer className="proposal-review-footer" id={noteId}>Sample proposal and fixture votes. This frontend preview does not call live agents, durable actors, or physical equipment.</footer>
    </div>
  </dialog>;
}

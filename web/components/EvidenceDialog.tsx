"use client";

import { useEffect, useId, useRef } from "react";
import { ArrowUpRight, BookOpen, ClockCounterClockwise, Database, X } from "@phosphor-icons/react";
import type { EvidenceItem } from "../lib/types";
import "./support-panels.css";

interface Props { item: EvidenceItem | null; onClose: () => void; onNavigate?: (id: string) => void }

export default function EvidenceDialog({ item, onClose, onNavigate }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();
  useEffect(() => {
    if (!item) return;
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, [!!item]);
  if (!item) return null;
  const Icon = item.kind === "rule" ? BookOpen : ClockCounterClockwise;
  const time = new Date(item.at);
  const formattedTime = Number.isNaN(time.getTime()) ? item.at : time.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return <dialog ref={dialogRef} className="support-dialog support-evidence-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); closeRef.current(); }} onClick={(event) => { if (event.target === event.currentTarget) closeRef.current(); }}>
    <div className="support-dialog-shell">
      <header className="support-dialog-header"><div><span className="support-eyebrow"><Icon size={13} />{item.kind === "rule" ? "LEARNED RULE" : "HISTORY EVENT"}</span><h2 id={titleId}>{item.title}</h2></div><button className="support-close" aria-label="Close evidence" onClick={() => closeRef.current()}><X size={20} /></button></header>
      <div className="support-evidence-meta"><code>{item.id}</code><span>{item.plantId === "plant-a" ? "Plant A" : "Plant B"}</span><time dateTime={Number.isNaN(time.getTime()) ? undefined : item.at}>{formattedTime}</time></div>
      <div className="support-dialog-content">
        <div className="support-provenance"><Database size={17} /><div><strong>Illustrative evidence record</strong><p>Sample data for this frontend preview. Provenance and measurements have not been verified against a live actor or simulator.</p></div></div>
        <p className="support-evidence-summary">{item.summary}</p>
        <div className="support-evidence-values"><div><small>Requested change</small><strong>{item.before}% <span>→</span> {item.after}%</strong></div><div><small>Predicted position</small><strong>{item.predicted == null ? "Not recorded" : `${item.predicted}%`}</strong></div><div><small>Observed position</small><strong>{item.observed}%</strong></div></div>
        {item.predicted != null && <p className="support-prediction-note">Prediction difference: <strong>{Math.abs(item.predicted - item.observed).toFixed(1)} percentage points.</strong> This sample is not a calibration score.</p>}
        <div className="support-evidence-support"><div className="support-section-heading"><h3>Supporting evidence</h3><span>{item.supportIds?.length ?? 0} records</span></div>{item.supportIds?.length ? <div className="support-evidence-links">{item.supportIds.map((id) => <button key={id} disabled={!onNavigate} onClick={() => onNavigate?.(id)}><ClockCounterClockwise size={15} /><code>{id}</code><ArrowUpRight size={15} /></button>)}</div> : <p className="support-empty">No linked records in this sample.</p>}</div>
      </div><footer className="support-dialog-footer">Every vote should cite retrieved events and applicable rules.</footer>
    </div>
  </dialog>;
}

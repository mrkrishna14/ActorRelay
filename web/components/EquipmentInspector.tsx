"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Gauge, ShieldCheck, X } from "@phosphor-icons/react";
import type { Equipment } from "../lib/types";
import "./support-panels.css";

interface Props { equipment: Equipment; onClose: () => void; onPropose: (value: number) => void }
const metricInfo: Record<string, { label: string; unit: string }> = {
  speedPct: { label: "Pump speed", unit: "%" }, feedM3h: { label: "Feed flow", unit: "m³/h" },
  levelPct: { label: "Tank level", unit: "%" }, tempC: { label: "Temperature", unit: "°C" },
  positionPct: { label: "Valve position", unit: "%" }, dutyKw: { label: "Heating duty", unit: "kW" },
  steamKgH: { label: "Steam flow", unit: "kg/h" },
};
const roleLabel = (role: string) => role.replaceAll("_", " ");

export default function EquipmentInspector({ equipment, onClose, onPropose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();
  const inputId = useId();
  const [target, setTarget] = useState(String(equipment.metrics.speedPct ?? 65));
  const [error, setError] = useState("");
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { setTarget(String(equipment.metrics.speedPct ?? 65)); setError(""); }, [equipment.id, equipment.metrics.speedPct]);

  const propose = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = Number(target);
    const min = equipment.limits?.speedPct?.min ?? 20;
    const max = equipment.limits?.speedPct?.max ?? 90;
    if (!target.trim() || !Number.isFinite(value) || value < min || value > max) { setError(`Enter a value between ${min} and ${max}%.`); return; }
    onPropose(value);
    closeRef.current();
  };

  return <dialog ref={dialogRef} className="support-dialog support-equipment-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); closeRef.current(); }} onClick={(event) => { if (event.target === event.currentTarget) closeRef.current(); }}>
    <div className="support-dialog-shell">
      <header className="support-dialog-header"><div><span className="support-eyebrow">{equipment.plantId === "plant-a" ? "PLANT A" : "PLANT B"} / EQUIPMENT</span><h2 id={titleId}>{equipment.tag} <span>{equipment.name}</span></h2></div><button className="support-close" aria-label="Close equipment details" onClick={() => closeRef.current()}><X size={20} /></button></header>
      <div className="support-equipment-meta"><span><Gauge size={15} />{roleLabel(equipment.role)}</span><span>{equipment.vendor === "codex" ? "Codex" : "Claude"} agent</span><span className="support-status-text">{equipment.status === "ok" ? "Within operating range" : equipment.status === "offline" ? "Offline" : "Review required"}</span></div>
      <div className="support-dialog-content">
        <div className="support-section-heading"><h3>Current measurements</h3><span>Sample simulation</span></div>
        <div className="support-metric-grid">{Object.entries(equipment.metrics).map(([metric, value]) => {
          const info = metricInfo[metric] ?? { label: metric.replace(/([A-Z])/g, " $1"), unit: "" };
          const limit = equipment.limits?.[metric];
          const threshold = limit ? limit.critical * (1 - equipment.marginPct / 100) : null;
          const extent = limit ? Math.max(limit.critical * 1.1, value * 1.1, metric.endsWith("Pct") ? 100 : 0) : 1;
          return <div key={metric} className="support-metric-card"><span>{info.label}</span><strong>{value.toLocaleString(undefined, { maximumFractionDigits: 1 })}<small>{info.unit}</small></strong>{limit ? <><div className="support-limit-track" role="img" aria-label={`${info.label}: ${value} ${info.unit}. Safety threshold ${threshold?.toFixed(1)} ${info.unit}. Critical limit ${limit.critical} ${info.unit}.`}><i style={{ width: `${Math.min(100, value / extent * 100)}%` }} /><b style={{ left: `${(threshold ?? 0) / extent * 100}%` }} /><em style={{ left: `${limit.critical / extent * 100}%` }} /></div><div className="support-limit-labels"><span>Operating {limit.min}–{limit.max}</span><span>Critical {limit.critical}{info.unit}</span></div></> : <p className="support-metric-info">Informational measurement</p>}</div>;
        })}</div>
        <div className="support-safety-note"><ShieldCheck size={22} weight="light" /><div><strong>{equipment.marginPct}% safety margin</strong><p>Agents assess proposals below the critical limit, with this margin reserved. Predicted effects are checked against retrieved equipment history.</p></div></div>
        {equipment.tag === "P-100" ? <form className="support-proposal-form" onSubmit={propose}>
          <div><h3>Propose a speed change</h3><p>Connected equipment vote first. Unanimous agreement opens a 10-second human veto window.</p></div>
          <label htmlFor={inputId}>Requested pump speed</label><div className="support-proposal-input"><input id={inputId} type="number" inputMode="decimal" min={equipment.limits?.speedPct?.min ?? 20} max={equipment.limits?.speedPct?.max ?? 90} step="0.1" value={target} onChange={(event) => { setTarget(event.target.value); setError(""); }} aria-invalid={!!error} aria-describedby={error ? `${inputId}-error` : undefined} required /><span>%</span><button type="submit">Create proposal <ArrowRight size={16} /></button></div>{error && <p id={`${inputId}-error`} role="alert" className="support-form-error">{error}</p>}
        </form> : <div className="support-readonly-note">This equipment reviews proposed feed changes through its agent. Start a setpoint proposal from P-100 or the agent conversation.</div>}
      </div><footer className="support-dialog-footer">Illustrative simulation state. Proposals do not operate physical equipment.</footer>
    </div>
  </dialog>;
}

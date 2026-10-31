"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Gauge, ShieldCheck, X } from "@phosphor-icons/react";
import type { ComponentTag, Equipment } from "../lib/types";
import { CONTROL_TARGETS, controlTarget, type ControlMetric, type ControlTarget } from "../lib/controls";
import "./support-panels.css";

interface Props {
  equipment: Equipment;
  components?: Equipment[];
  initialMetric?: ControlMetric;
  live?: boolean;
  onClose: () => void;
  onPropose: (value: number, metric?: ControlMetric, tag?: ComponentTag) => void;
}
const metricInfo: Record<string, { label: string; unit: string }> = {
  speedPct: { label: "Pump speed", unit: "%" }, feedM3h: { label: "Feed flow", unit: "m³/h" },
  levelPct: { label: "Tank level", unit: "%" }, tempC: { label: "Temperature", unit: "°C" },
  positionPct: { label: "Valve position", unit: "%" }, dutyKw: { label: "Heating duty", unit: "kW" },
  steamKgH: { label: "Steam flow", unit: "kg/h" }, headerBarg: { label: "Steam header pressure", unit: "bar(g)" },
};
const metadataMetrics = new Set(["levelSetpointPct", "tempSetpointC", "steamSetpointKgH", "steamFlowLocal"]);
const roleLabel = (role: string) => role.replaceAll("_", " ");
const formatValue = (value: number | undefined, unit: string) => Number.isFinite(value) ? `${value!.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}` : "Not available";
const defaultMetric = (tag: ComponentTag): ControlMetric => tag === "P-100" ? "speedPct" : tag === "LV-101" ? "levelPct" : tag === "TV-101" ? "steamKgH" : "tempC";

export default function EquipmentInspector({ equipment, components, initialMetric, live = false, onClose, onPropose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();
  const inputId = useId();
  const controllerId = useId();
  const [metric, setMetric] = useState<ControlMetric>(initialMetric ?? defaultMetric(equipment.tag));
  const selectedControl = CONTROL_TARGETS.find((item) => item.metric === metric)!;
  const controlledEquipment = (components ?? [equipment]).find((item) => item.plantId === equipment.plantId && item.tag === selectedControl.tag);
  const currentSetpoint = selectedControl.setpointMetric ? controlledEquipment?.metrics[selectedControl.setpointMetric] : controlledEquipment?.metrics[selectedControl.metric];
  const measured = controlledEquipment?.metrics[selectedControl.metric];
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { setMetric(initialMetric ?? defaultMetric(equipment.tag)); }, [equipment.id, equipment.tag, initialMetric]);
  useEffect(() => {
    setTarget(String(currentSetpoint ?? measured ?? selectedControl.min));
    setError("");
    // Incoming measurements must not overwrite a setpoint the operator is editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metric, equipment.id]);

  const selectControl = (control: ControlTarget) => {
    setMetric(control.metric);
    setError("");
    formRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const propose = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = Number(target);
    if (!target.trim() || !Number.isFinite(value) || value < selectedControl.min || value > selectedControl.max) {
      setError(`Enter a value between ${selectedControl.min} and ${selectedControl.max} ${selectedControl.unit}.`);
      return;
    }
    onPropose(value, selectedControl.metric, selectedControl.tag);
    closeRef.current();
  };

  return <dialog ref={dialogRef} className="support-dialog support-equipment-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); closeRef.current(); }} onClick={(event) => { if (event.target === event.currentTarget) closeRef.current(); }}>
    <div className="support-dialog-shell">
      <header className="support-dialog-header"><div><span className="support-eyebrow">{equipment.plantId === "plant-a" ? "PLANT A" : "PLANT B"} / EQUIPMENT</span><h2 id={titleId}>{equipment.tag} <span>{equipment.name}</span></h2></div><button className="support-close" aria-label="Close equipment details" onClick={() => closeRef.current()}><X size={20} /></button></header>
      <div className="support-equipment-meta"><span><Gauge size={15} />{roleLabel(equipment.role)}</span><span>{equipment.vendor === "codex" ? "Codex" : "Claude"} agent</span><span className="support-status-text">{equipment.status === "ok" ? "Within operating range" : equipment.status === "offline" ? "Offline" : "Review required"}</span></div>
      <div className="support-dialog-content">
        <div className="support-section-heading"><h3>Current measurements</h3><span>{live ? "Live simulator readings" : "Browser demo readings"}</span></div>
        <div className="support-metric-grid">{Object.entries(equipment.metrics).filter(([key]) => !metadataMetrics.has(key)).map(([key, value]) => {
          const info = metricInfo[key] ?? { label: key.replace(/([A-Z])/g, " $1"), unit: "" };
          const command = controlTarget(equipment.tag, key);
          const setpoint = command?.setpointMetric ? equipment.metrics[command.setpointMetric] : undefined;
          const limit = equipment.limits?.[key];
          const threshold = limit ? limit.critical * (1 - equipment.marginPct / 100) : null;
          const extent = limit ? Math.max(limit.critical * 1.1, value * 1.1, key.endsWith("Pct") ? 100 : 0) : 1;
          return <div key={key} className={`support-metric-card ${command && metric === command.metric ? "support-metric-selected" : ""}`} role={command ? "button" : undefined} tabIndex={command ? 0 : undefined} aria-label={command ? `Edit ${command.loop} ${command.label} setpoint` : undefined} onClick={command ? () => selectControl(command) : undefined} onKeyDown={command ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectControl(command); } } : undefined}>
            {command ? <span className="support-metric-select">{info.label}<span>Edit {command.loop} <ArrowRight size={12} /></span></span> : <span>{info.label}</span>}
            <strong>{value.toLocaleString(undefined, { maximumFractionDigits: 1 })}<small>{info.unit}</small></strong>
            {command?.setpointMetric && <p className="support-metric-setpoint">Setpoint: {formatValue(setpoint, info.unit)}</p>}
            {limit ? <><div className="support-limit-track" role="img" aria-label={`${info.label}: ${value} ${info.unit}. Safety threshold ${threshold?.toFixed(1)} ${info.unit}. Critical limit ${limit.critical} ${info.unit}.`}><i style={{ width: `${Math.min(100, value / extent * 100)}%` }} /><b style={{ left: `${(threshold ?? 0) / extent * 100}%` }} /><em style={{ left: `${limit.critical / extent * 100}%` }} /></div><div className="support-limit-labels"><span>Operating {limit.min}–{limit.max}</span><span>Critical {limit.critical}{info.unit}</span></div></> : <p className="support-metric-info">Informational measurement</p>}
          </div>;
        })}</div>
        <div className="support-safety-note"><ShieldCheck size={22} weight="light" /><div><strong>{equipment.marginPct}% safety margin</strong><p>Agents assess proposals below the critical limit, with this margin reserved. Predicted effects are checked against retrieved equipment history.</p></div></div>
        <form ref={formRef} className="support-proposal-form" onSubmit={propose}>
          <div><h3>Propose an operating setpoint</h3><p>Connected equipment vote first. Unanimous agreement opens a 10-second human veto window.</p></div>
          <label htmlFor={controllerId}>Controller · {equipment.plantId === "plant-a" ? "Plant A" : "Plant B"}</label>
          <select id={controllerId} className="support-controller-select" value={metric} onChange={(event) => { setMetric(event.target.value as ControlMetric); setError(""); }}>{CONTROL_TARGETS.map((control) => <option key={control.metric} value={control.metric}>{control.loop} · {control.label} · {control.tag}</option>)}</select>
          <div className="support-control-readings"><span><small>Measured {selectedControl.label.toLowerCase()}</small><strong>{formatValue(measured, selectedControl.unit)}</strong></span><span><small>{selectedControl.setpointMetric ? "Current setpoint" : "Current pump command"}</small><strong>{formatValue(currentSetpoint, selectedControl.unit)}</strong></span></div>
          <p className="support-control-mode">{metric === "steamKgH" ? `FIC-201: local steam-flow control; temperature target restores cascade.${controlledEquipment?.metrics.steamFlowLocal === 0 ? " Currently following the temperature controller." : controlledEquipment?.metrics.steamFlowLocal === 1 ? " Local steam-flow control is active." : ""}` : metric === "tempC" ? "TIC-101 sets the tank temperature target and restores steam-flow cascade control." : metric === "levelPct" ? "LIC-101 sets the tank level target; the controller adjusts the outlet valve." : "The feed pump agent reviews the requested speed with connected equipment."}</p>
          <label htmlFor={inputId}>Requested {selectedControl.label.toLowerCase()}{selectedControl.setpointMetric ? " setpoint" : ""}</label>
          <div className="support-proposal-input"><input id={inputId} type="number" inputMode="decimal" min={selectedControl.min} max={selectedControl.max} step={selectedControl.step} value={target} onChange={(event) => { setTarget(event.target.value); setError(""); }} aria-invalid={!!error} aria-describedby={error ? `${inputId}-error` : undefined} required /><span>{selectedControl.unit}</span><button type="submit">Create proposal <ArrowRight size={16} /></button></div>
          {error && <p id={`${inputId}-error`} role="alert" className="support-form-error">{error}</p>}
        </form>
      </div><footer className="support-dialog-footer">{live ? "Live simulator state. Proposals still require equipment consensus." : "Illustrative browser simulation state."} No physical equipment is operated.</footer>
    </div>
  </dialog>;
}

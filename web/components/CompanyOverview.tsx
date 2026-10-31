"use client";

import { ArrowUpRight, BookOpen, Factory, LinkSimple } from "@phosphor-icons/react";
import type { Equipment, EvidenceItem, PlantId } from "../lib/types";
import "./support-panels.css";

interface Props {
  plants: { id: PlantId; name: string; components: Equipment[] }[];
  onOpenPlant: (id: PlantId) => void;
  rules: EvidenceItem[];
  onRuleClick: (id: string) => void;
}

export default function CompanyOverview({ plants, onOpenPlant, rules, onRuleClick }: Props) {
  return (
    <section className="support-company" aria-label="Company overview">
      <div className="support-company-intro">
        <div><span className="support-eyebrow">ONE COMPANY. SHARED KNOWLEDGE.</span><h2>Every plant learns together.</h2><p>Two process units. Ten equipment agents. One shared steam header.</p></div>
        <span className="support-sample-label">Simulated plant</span>
      </div>

      <div className="support-company-plants">
        {plants.map((plant) => {
          const tank = plant.components.find((e) => e.tag === "TK-101");
          const pump = plant.components.find((e) => e.tag === "P-100");
          const attention = plant.components.filter((e) => e.status !== "ok").length;
          return <button key={plant.id} className="support-plant-card" onClick={() => onOpenPlant(plant.id)}>
            <span className="support-plant-card-top"><Factory size={20} weight="light" /><span className="support-status-text">{attention ? `${attention} need review` : "Operating"}</span><ArrowUpRight className="support-card-open" size={17} /></span>
            <strong>{plant.name}</strong><span className="support-card-description">Heated hold tank</span>
            <span className="support-plant-readings"><span><small>Tank level</small><b>{tank ? `${(tank.metrics.levelPct ?? 0).toFixed(1)}%` : "—"}</b></span><span><small>Temperature</small><b>{tank ? `${(tank.metrics.tempC ?? 0).toFixed(1)} °C` : "—"}</b></span><span><small>Feed pump</small><b>{pump ? `${(pump.metrics.speedPct ?? 0).toFixed(0)}%` : "—"}</b></span></span>
            <span className="support-component-pills">{plant.components.map((component) => <span key={component.id}><i className={component.status !== "ok" ? "support-dot-review" : ""} />{component.tag}</span>)}</span>
            <span className="support-card-footer">{plant.components.length} equipment agents<span>Open plant <ArrowUpRight size={12} /></span></span>
          </button>;
        })}
      </div>

      <div className="support-shared-resource">
        <div className="support-resource-branch"><span>Plant A · TV-101</span><i /></div>
        <div className="support-resource-node"><LinkSimple size={21} /><div><strong>Shared steam header</strong><span>steam-header-1 · 6 barg design pressure</span></div></div>
        <div className="support-resource-branch"><i /><span>Plant B · TV-101</span></div>
      </div>
      <p className="support-resource-note">A change in steam demand is reviewed across both plants before it can proceed.</p>

      <div className="support-company-library">
        <div className="support-section-heading"><BookOpen size={17} /><h3>Company knowledge</h3><span>{rules.length} {rules.length === 1 ? "record" : "records"}</span></div>
        <p>Evidence from one plant can inform the same equipment in another.</p>
        <div className="support-rule-list">{rules.length ? rules.map((rule) => <button key={rule.id} onClick={() => onRuleClick(rule.id)}><span className="support-rule-icon"><BookOpen size={16} /></span><span><strong>{rule.title}</strong><small>{rule.plantId === "plant-a" ? "Plant A" : "Plant B"} · {rule.supportIds?.length ?? 0} supporting events · sample record</small></span><ArrowUpRight size={16} /></button>) : <div className="support-empty">Shared rules will appear here when evidence is available.</div>}</div>
      </div>
    </section>
  );
}

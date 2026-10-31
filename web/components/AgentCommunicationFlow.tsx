"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AgentActivity, ChatMessage, ComponentTag, Equipment, PlantId, Proposal } from "../lib/types";
import { agentColorStyle } from "../lib/agent-colors";
import { agentFlowLinks, FLOW_TAGS } from "../lib/agent-flow";
import { controlTarget } from "../lib/controls";
import "./agent-communication-flow.css";

interface Props {
  components: Equipment[];
  activities: AgentActivity[];
  proposals: Proposal[];
  messages: ChatMessage[];
  now: number;
  live: boolean;
  selected: string;
  onSelect: (tag: ComponentTag, plantId: PlantId) => void;
}

const plantName = (plantId: PlantId) => plantId === "plant-a" ? "Plant A" : "Plant B";
const statusName: Record<Proposal["status"], string> = {
  voting: "Collecting votes", blocked: "Change blocked", veto_window: "Human veto window",
  vetoed: "Vetoed by operator", executed: "Change executed", expired: "Proposal expired",
};

/** Shows recorded proposal routes. It does not infer raw network delivery from votes. */
export default function AgentCommunicationFlow({ components, activities, proposals, messages, now, live, selected, onSelect }: Props) {
  const markerId = useId().replace(/:/g, "");
  const proposal = proposals.reduce<Proposal | null>((latest, item) => !latest || item.createdAt > latest.createdAt ? item : latest, null);
  const recordedLinks = agentFlowLinks(proposal, components, messages, now);
  const decisionKeys = recordedLinks.filter((link) => link.kind !== "request").map((link) => `${proposal?.createdAt ?? 0}:${link.id}:${link.kind}`);
  const decisionSignature = JSON.stringify(decisionKeys);
  // Baseline historical votes on mount; only newly observed decisions get arrival bursts.
  const seenDecisions = useRef(new Set(decisionKeys));
  const source = useRef(live);
  const [arrivals, setArrivals] = useState<Record<string, number>>({});
  useEffect(() => {
    if (source.current !== live) {
      source.current = live;
      seenDecisions.current = new Set(JSON.parse(decisionSignature) as string[]);
      setArrivals((current) => Object.keys(current).length ? {} : current);
      return;
    }
    const fresh = (JSON.parse(decisionSignature) as string[]).filter((key) => !seenDecisions.current.has(key));
    if (!fresh.length) return;
    fresh.forEach((key) => seenDecisions.current.add(key));
    setArrivals((current) => ({ ...current, ...Object.fromEntries(fresh.map((key) => [key, Date.now() + 6000])) }));
  }, [decisionSignature, live]);
  useEffect(() => {
    const deadlines = Object.values(arrivals);
    if (!deadlines.length) return;
    const timeout = window.setTimeout(() => setArrivals((current) => Object.fromEntries(Object.entries(current).filter(([, until]) => until > Date.now()))), Math.max(0, Math.min(...deadlines) - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [arrivals]);
  const links = recordedLinks.map((link) => ({ ...link, active: link.active || !!arrivals[`${proposal?.createdAt ?? 0}:${link.id}:${link.kind}`] }));
  const activeCount = links.filter((link) => link.active).length;
  const proposerTag = proposal?.proposerTag ?? "P-100";
  const control = controlTarget(proposerTag, proposal?.metric ?? "speedPct");
  const unit = control?.unit ?? "";
  const proposerId = proposal ? `${proposal.plantId}/${proposerTag}` : null;
  const yesCount = links.filter((link) => link.kind === "yes").length;
  const noCount = links.filter((link) => link.kind === "no").length;
  const point = (component: Equipment) => ({ x: component.plantId === "plant-a" ? 24 : 556, y: 75 + FLOW_TAGS.indexOf(component.tag) * 91 });
  const sorted = ["plant-a", "plant-b"].flatMap((plantId) => FLOW_TAGS.flatMap((tag) => components.filter((item) => item.plantId === plantId && item.tag === tag)));
  const proposer = components.find((component) => component.id === proposerId);
  return <section className="agent-flow" aria-label="Agent communication map">
    <header className="agent-flow-header">
      <div><strong>Who is talking to whom</strong><p>{proposal ? `${plantName(proposal.plantId)} · ${proposerTag} · ${control?.loop ?? "Operating target"}: ${proposal.from}${unit} → ${proposal.to}${unit}` : "Every equipment agent has its own identity."}</p></div>
      <div className="agent-flow-header-status"><span className={`agent-flow-source ${live ? "is-live" : ""}`}><i aria-hidden="true" />{live ? "Live proposal activity" : "Sample activity"}</span><span className={`agent-flow-traffic ${activeCount ? "is-active" : ""}`} role="status"><i aria-hidden="true" />{activeCount ? `${activeCount} active review ${activeCount === 1 ? "route" : "routes"}` : "No active communication"}</span></div>
    </header>
    <div className="agent-flow-canvas">
      <svg viewBox="0 0 840 565" role="group" aria-label="Plant A and Plant B equipment agents, with directed proposal requests and recorded votes">
        <defs>{["request", "yes", "no"].map((kind) => <marker key={kind} id={`${markerId}-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className={`agent-flow-arrow agent-flow-${kind}`} /></marker>)}</defs>
        <rect className="agent-flow-plant-bg" x="12" y="18" width="284" height="524" rx="12" />
        <rect className="agent-flow-plant-bg" x="544" y="18" width="284" height="524" rx="12" />
        <text className="agent-flow-plant-title" x="30" y="48">PLANT A</text><text className="agent-flow-plant-title" x="562" y="48">PLANT B</text>
        <text className="agent-flow-plant-count" x="278" y="48" textAnchor="end">5 agents</text><text className="agent-flow-plant-count" x="810" y="48" textAnchor="end">5 agents</text>
        {links.map((link) => {
          const reviewer = components.find((item) => item.id === (link.kind === "request" ? link.to : link.from));
          if (!reviewer) return null;
          const p = point(reviewer);
          const left = reviewer.plantId === "plant-a";
          const nodeX = left ? 284 : 556;
          const hubX = left ? 364 : 476;
          const hubY = 237 + FLOW_TAGS.indexOf(reviewer.tag) * 15;
          const nodeY = p.y + 35;
          const requestPath = `M ${hubX} ${hubY} C ${left ? 315 : 525} ${hubY}, ${left ? 325 : 515} ${nodeY}, ${nodeX} ${nodeY}`;
          const votePath = `M ${nodeX} ${nodeY} C ${left ? 325 : 515} ${nodeY}, ${left ? 315 : 525} ${hubY}, ${hubX} ${hubY}`;
          const routePath = link.kind === "request" ? requestPath : votePath;
          return <g key={link.id} className={`agent-flow-route agent-flow-${link.kind} ${link.active ? "is-active" : ""} ${link.channel === "company" ? "is-company" : ""}`}>
            <title>{`${link.kind === "request" ? "Review request to" : `${link.kind.toUpperCase()} vote from`} ${plantName(reviewer.plantId)} ${reviewer.tag}${link.channel === "company" ? " via company: shared steam header" : ""}${link.evidence.length ? `. Evidence: ${link.evidence.join(", ")}` : ""}`}</title>
            <path d={routePath} markerEnd={`url(#${markerId}-${link.kind})`} />
            {link.active && <><path className="agent-flow-pulse" d={routePath} />{[0, 1, 2].map((packet) => <circle key={`${link.kind}-${packet}`} r="5" className="agent-flow-packet" aria-hidden="true"><animateMotion dur="1.8s" begin={`${-packet * .6}s`} repeatCount="indefinite" path={routePath} /></circle>)}</>}
          </g>;
        })}
        {proposer && (() => { const p = point(proposer); const left = proposer.plantId === "plant-a"; return <path className="agent-flow-origin" d={`M ${left ? 284 : 556} ${p.y + 35} C ${left ? 335 : 505} ${p.y + 35}, 420 150, 420 204`} />; })()}
        <g className={`agent-flow-hub ${activeCount ? "is-active" : ""}`}>
          <rect x="364" y="204" width="112" height="124" rx="15" />
          <text x="420" y="229" textAnchor="middle" className="agent-flow-hub-label">PROPOSAL</text>
          <text x="420" y="252" textAnchor="middle" className="agent-flow-hub-title">{proposal ? proposerTag : "No proposal"}</text>
          <text x="420" y="273" textAnchor="middle">{proposal ? plantName(proposal.plantId) : "Awaiting change"}</text>
          <text x="420" y="304" textAnchor="middle">{proposal ? `${yesCount} YES · ${noCount} NO` : "10 agents ready"}</text>
        </g>
        <text x="420" y="359" textAnchor="middle" className="agent-flow-center-note">{proposal ? statusName[proposal.status] : "Propose a setpoint change"}</text>
        <text x="420" y="378" textAnchor="middle" className="agent-flow-center-note">{proposal ? "Requests → reviewers" : "to see review routes"}</text>
        <text x="420" y="397" textAnchor="middle" className="agent-flow-center-note">{proposal ? "Votes → proposing agent" : "and agent decisions."}</text>
        {sorted.map((component) => {
          const p = point(component);
          const link = links.find((item) => item.from === component.id || item.to === component.id && component.id !== proposerId);
          const vote = proposal?.votes.find((item) => item.tag === component.tag && item.plantId === component.plantId);
          const isProposer = component.id === proposerId;
          const participates = isProposer || !!link;
          const activity = activities.find((item) => item.tag === component.tag && item.plantId === component.plantId);
          const communicating = isProposer ? activeCount > 0 : !!link?.active;
          const state = isProposer ? "PROPOSER" : vote ? vote.vote.toUpperCase() : participates ? proposal?.status === "voting" ? "WAITING" : "NO VOTE" : "MONITORING";
          const crossPlant = participates && !isProposer && component.plantId !== proposal?.plantId;
          return <g key={component.id} role="button" tabIndex={0} aria-label={`${plantName(component.plantId)}, ${component.name}, ${component.tag}. ${state}${crossPlant ? ". Shared steam header reviewer" : ""}. Select agent.`}
            className={`agent-flow-node ${selected === component.id ? "is-selected" : ""} ${communicating ? "is-active" : ""} ${participates ? "is-participating" : ""}`} style={agentColorStyle(component.plantId, component.tag) as CSSProperties}
            onClick={() => onSelect(component.tag, component.plantId)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(component.tag, component.plantId); } }}>
            <title>{`${component.role} · ${component.vendor}${vote ? `. ${vote.reason}${vote.evidence.length ? `. Evidence: ${vote.evidence.join(", ")}` : ""}` : activity ? `. ${activity.task}` : ""}`}</title>
            <rect x={p.x} y={p.y} width="260" height="76" rx="9" />
            {communicating && <><rect className="agent-flow-node-pulse" x={p.x - 4} y={p.y - 4} width="268" height="84" rx="13" aria-hidden="true" /><circle cx={p.x + 18} cy={p.y + 20} r="10" className="agent-flow-status-ripple" aria-hidden="true" /></>}
            <circle cx={p.x + 18} cy={p.y + 20} r="4" className="agent-flow-identity" />
            <text x={p.x + 30} y={p.y + 24} className="agent-flow-node-tag">{component.tag}</text>
            <text x={p.x + 244} y={p.y + 23} textAnchor="end" className={`agent-flow-node-state agent-flow-state-${vote?.vote ?? "idle"}`}>{state}</text>
            <text x={p.x + 16} y={p.y + 46} className="agent-flow-node-name">{component.name}</text>
            <text x={p.x + 16} y={p.y + 64} className="agent-flow-node-role">{crossPlant ? "Shared steam header · company channel" : `${component.role.replaceAll("_", " ")} · ${component.vendor === "codex" ? "Codex" : "Claude"}`}</text>
          </g>;
        })}
      </svg>
    </div>
    <footer className="agent-flow-footer"><span><i className="flow-key-request" />Review request</span><span><i className="flow-key-yes" />YES vote</span><span><i className="flow-key-no" />NO vote</span><span><i className="flow-key-company" />Cross-plant review</span><p>Arrows show proposal and vote records. Packets show pending reviews and newly received votes.</p></footer>
  </section>;
}

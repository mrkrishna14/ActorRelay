"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowsClockwise, ArrowUpRight, CaretDown, CaretRight, ChatCircleDots, Check, Cpu, Drop, FileText, Gauge, Info, ListBullets, PaperPlaneTilt, ShieldCheck, UserCircle, WaveSine } from "@phosphor-icons/react";
import type { AgentActivity, AgentActivityState, AgentWorkspaceProps, ChatMessage, ComponentTag, PlantId } from "../lib/types";
import { AGENT_COLORS, agentColorStyle } from "../lib/agent-colors";
import "./agent-workspace.css";

const displayChannel = (channel: string) => channel === "plant-a" ? "Plant A" : channel === "plant-b" ? "Plant B" : channel === "company" ? "Company" : channel;
const displayVendor = (vendor?: string) => vendor ? vendor.charAt(0).toUpperCase() + vendor.slice(1) : "Relay";
const formatTime = (at: number) => new Date(at).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const activityLabels: Record<AgentActivityState, string> = {
  monitoring: "Monitoring", thinking: "Thinking", reviewing: "Reviewing", waiting: "Waiting",
  blocked: "Blocked", ready: "Ready", observing: "Observing",
};
const activityDescriptions: Record<AgentActivityState, string> = {
  monitoring: "Watching the sample plant measurements.", thinking: "Evaluating a sample operating change.",
  reviewing: "Comparing a proposal with sample evidence.", waiting: "Awaiting the other equipment votes.",
  blocked: "Refusing a change beyond the safety margin.", ready: "Ready for the next operating decision.",
  observing: "Comparing the expected and sample response.",
};
const roleNames: Record<string, string> = {
  mechanic: "Mechanic", process_engineer: "Process engineer",
  chemical_engineer: "Chemical engineer", safety: "Safety specialist",
};
const displayRole = (role: string) => roleNames[role] || role.replaceAll("_", " ");
const equipmentNames: Record<ComponentTag, string> = {
  "P-100": "Feed pump", "TK-101": "Hold tank", "LV-101": "Outlet valve", "E-101": "Steam coil", "TV-101": "Steam valve",
};
const activityLocation = (activity: AgentActivity) => activity.location.toLowerCase().includes(displayChannel(activity.plantId).toLowerCase())
  ? activity.location : `${displayChannel(activity.plantId)} · ${activity.location}`;
const progressValue = (progress: number) => Math.round(Math.max(0, Math.min(100, Number.isFinite(progress) ? progress : 0)));
const DEFAULT_HARNESS_HEIGHT = 370;
const MIN_HARNESS_HEIGHT = 120;
const HARNESS_DIVIDER_HEIGHT = 8;

function useHarnessResize(expanded: boolean, resetVersion = 0) {
  const workspace = useRef<HTMLElement>(null);
  const drag = useRef<{ pointerId: number; y: number; height: number; target: HTMLDivElement } | null>(null);
  const [availableHeight, setAvailableHeight] = useState(760);
  const [requestedHeight, setRequestedHeight] = useState(DEFAULT_HARNESS_HEIGHT);
  const [dragging, setDragging] = useState(false);
  const maximum = Math.max(MIN_HARNESS_HEIGHT, Math.min(500, availableHeight - 280 - HARNESS_DIVIDER_HEIGHT));
  const clamp = (height: number) => Math.round(Math.max(MIN_HARNESS_HEIGHT, Math.min(maximum, height)));
  const height = clamp(requestedHeight);
  const releaseCapture = () => {
    const current = drag.current;
    drag.current = null;
    if (current?.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
  };
  const stop = () => { releaseCapture(); setDragging(false); };

  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setAvailableHeight(entry.contentRect.height));
    setAvailableHeight(element.clientHeight);
    observer.observe(element);
    const blur = () => { releaseCapture(); setDragging(false); };
    window.addEventListener("blur", blur);
    return () => { observer.disconnect(); window.removeEventListener("blur", blur); releaseCapture(); };
  }, []);
  useEffect(() => { if (!expanded) stop(); }, [expanded]);
  useEffect(() => { setRequestedHeight(DEFAULT_HARNESS_HEIGHT); }, [resetVersion]);

  return {
    workspace, height, maximum, dragging,
    conversationHeight: availableHeight - (expanded ? height + HARNESS_DIVIDER_HEIGHT : 91),
    reset: () => setRequestedHeight(clamp(DEFAULT_HARNESS_HEIGHT)),
    pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
      if (!expanded || event.button !== 0 || drag.current) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, y: event.clientY, height, target: event.currentTarget };
      setDragging(true);
    },
    pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
      const current = drag.current;
      if (!current || event.pointerId !== current.pointerId) return;
      setRequestedHeight(clamp(current.height + current.y - event.clientY));
    },
    stop,
    keyDown(event: KeyboardEvent<HTMLDivElement>) {
      const step = event.shiftKey ? 40 : 10;
      if (event.key === "ArrowUp") setRequestedHeight(clamp(height + step));
      else if (event.key === "ArrowDown") setRequestedHeight(clamp(height - step));
      else if (event.key === "Home") setRequestedHeight(MIN_HARNESS_HEIGHT);
      else if (event.key === "End") setRequestedHeight(maximum);
      else return;
      event.preventDefault();
    },
  };
}

function EquipmentIcon({ tag, operator = false }: { tag?: ComponentTag; operator?: boolean }) {
  if (operator) return <UserCircle size={23} weight="light" />;
  if (tag === "P-100") return <Gauge size={23} weight="light" />;
  if (tag === "TK-101") return <Drop size={23} weight="light" />;
  if (tag === "E-101") return <WaveSine size={23} weight="light" />;
  if (tag === "TV-101") return <ShieldCheck size={23} weight="light" />;
  return <Cpu size={23} weight="light" />;
}

function ActivityChip({ state }: { state: AgentActivityState }) {
  return <span className={`agent-activity-chip agent-activity-${state}`} title={`Current sample state: ${activityLabels[state]}`}><span aria-hidden="true" />{activityLabels[state]}</span>;
}

type HighlightFn = (tag: ComponentTag | null, plantId?: PlantId) => void;
const TAG_SPLIT = /\b(P-100|TK-101|LV-101|E-101|TV-101)\b/;
const TAG_ORDER: ComponentTag[] = ["P-100", "TK-101", "LV-101", "E-101", "TV-101"];
const isTag = (value: string): value is ComponentTag => (TAG_ORDER as string[]).includes(value);
const plantFromChannel = (channel: string): PlantId | undefined => {
  const name = channel.replace(/^#/, "");
  return name === "plant-a" || name === "plant-b" ? name : undefined;
};

/** Equipment tags in message text become agent-colored chips that point at the equipment. */
function MessageText({ text, plantId, onSelect, onHighlight, onRestore }: {
  text: string; plantId: PlantId; onSelect: AgentWorkspaceProps["onSelect"]; onHighlight: HighlightFn; onRestore: () => void;
}) {
  const parts = text.split(TAG_SPLIT);
  return <p>{parts.map((part, index) => index % 2 === 1 && isTag(part)
    ? <button key={index} type="button" className="agent-mention ar-agent-hue" style={agentColorStyle(plantId, part)}
      title={`${equipmentNames[part]} · ${part} (${displayChannel(plantId)}). Select to locate it in the plant view.`}
      aria-label={`${part}, ${equipmentNames[part]}, ${displayChannel(plantId)}. Select equipment.`}
      onClick={() => onSelect(part, plantId)}
      onMouseEnter={() => onHighlight(part, plantId)} onMouseLeave={onRestore}
      onFocus={(event) => { event.stopPropagation(); onHighlight(part, plantId); }}
      onBlur={(event) => { event.stopPropagation(); onRestore(); }}><i aria-hidden="true" />{part}</button>
    : part)}</p>;
}

function Message({ message, activity, fallbackPlant, channelPlant, onEvidence, onAgentDetails, onSelect, onHighlight }: {
  message: ChatMessage; activity?: AgentActivity; fallbackPlant: PlantId; channelPlant?: PlantId;
  onEvidence: AgentWorkspaceProps["onEvidence"]; onAgentDetails: (activity: AgentActivity) => void;
  onSelect: AgentWorkspaceProps["onSelect"]; onHighlight: HighlightFn;
}) {
  const operator = message.kind === "operator";
  const system = message.kind === "system" || (!operator && !message.tag);
  const messagePlant = message.plantId ?? channelPlant ?? fallbackPlant;
  const agentTag = !operator && message.tag ? message.tag : undefined;
  const crossPlant = !!agentTag && !!channelPlant && messagePlant !== channelPlant;
  const title = operator ? "You · Operator" : message.tag ? `${equipmentNames[message.tag]} · ${message.tag}` : message.sender && message.sender !== "Plant A" && message.sender !== "Plant B" && message.sender !== "Company" ? message.sender : "Plant coordination";
  const restore = () => onHighlight(agentTag ?? null, agentTag ? messagePlant : undefined);
  const kindClass = operator ? "agent-message-operator" : system ? "agent-message-system" : "agent-message-agent";
  return <article className={`agent-message ${kindClass} ${agentTag ? "agent-message-colored ar-agent-hue" : ""}`} style={agentTag ? agentColorStyle(messagePlant, agentTag) : undefined}
    onMouseEnter={agentTag ? restore : undefined} onMouseLeave={() => onHighlight(null)}
    onFocus={agentTag ? restore : undefined} onBlur={() => onHighlight(null)}>
    <span className="agent-message-icon" aria-hidden="true">{system ? <Info size={16} /> : <EquipmentIcon tag={message.tag} operator={operator} />}</span>
    <div className="agent-message-content">
      <div className="agent-message-meta">
        {activity && agentTag ? <button className="agent-message-name" onClick={() => onAgentDetails(activity)}>{title}</button> : <span className="agent-message-name">{title}</span>}
        {crossPlant && <span className="agent-message-plant-tag" title={`${displayChannel(messagePlant)} agent posting in ${displayChannel(channelPlant!)}`}>{displayChannel(messagePlant)}</span>}
        <time dateTime={new Date(message.at).toISOString()}>{formatTime(message.at)}</time>
      </div>
      {activity && agentTag && <div className="agent-message-identity"><span>{displayVendor(activity.vendor)} · {displayRole(activity.role)}</span><ActivityChip state={activity.state} /><span className="agent-message-location">{activityLocation(activity)}</span></div>}
      <MessageText text={message.text} plantId={messagePlant} onSelect={onSelect} onHighlight={onHighlight} onRestore={restore} />
      {!!message.evidence?.length && <div className="agent-evidence-list">{message.evidence.map((id) => <button key={id} onClick={() => onEvidence(id)} className="agent-evidence-button"><FileText size={16} /><span>{id === "event-a-088" ? "3 past events" : id.toLowerCase().includes("rule") ? id : "View observation"}</span><ArrowUpRight size={12} /></button>)}</div>}
    </div>
  </article>;
}

/** Compact key so the operator can map a color back to its equipment agent. */
function AgentColorLegend({ plantId }: { plantId: PlantId }) {
  return <div className="relay-color-legend-list">
    <strong>Agent colors · {displayChannel(plantId)}</strong>
    {TAG_ORDER.map((tag) => <p key={tag} className="ar-agent-hue" style={agentColorStyle(plantId, tag)}><i aria-hidden="true" /><code>{tag}</code><span>{equipmentNames[tag]}</span><small>{AGENT_COLORS[plantId][tag].name}</small></p>)}
    <p className="relay-color-legend-operator"><i aria-hidden="true" /><code>You</code><span>Operator messages</span><small>Neutral</small></p>
    <small>{displayChannel(plantId === "plant-a" ? "plant-b" : "plant-a")} agents use a lighter hue of the same family. Green and red stay reserved for yes / no votes.</small>
  </div>;
}

export default function AgentWorkspace(props: AgentWorkspaceProps) {
  const { channel, onChannelChange, selected, plantId, onSelect, messages, proposal, onSend, onVeto, onEvidence, activities: activityItems, onAgentDetails, onHighlight: highlightProp } = props;
  const activities = activityItems || [];
  const onHighlight: HighlightFn = (tag, target) => highlightProp?.(tag, target);
  const channelPlant = plantFromChannel(channel);
  const pointAt = (activity: AgentActivity) => ({
    onMouseEnter: () => onHighlight(activity.tag, activity.plantId), onMouseLeave: () => onHighlight(null),
    onFocus: () => onHighlight(activity.tag, activity.plantId), onBlur: () => onHighlight(null),
  });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [expanded, setExpanded] = useState(true);
  const [showActivity, setShowActivity] = useState(false);
  const [showContext, setShowContext] = useState(true);
  const [now, setNow] = useState(Date.now());
  const feed = useRef<HTMLDivElement>(null);
  const harnessResize = useHarnessResize(expanded, props.layoutResetVersion);
  const channelOptions = ["plant-a", "plant-b", "company"];
  const filteredMessages = messages.filter((message) => message.channel.replace(/^#/, "") === channel.replace(/^#/, ""));
  const visibleActivities = activities.filter((activity) => channel === "company" || activity.plantId === plantId);
  const selectedActivity = activities.find((activity) => activity.tag === selected && activity.plantId === plantId);
  const vetoSeconds = proposal?.vetoDeadline ? Math.max(0, Math.ceil((proposal.vetoDeadline - now) / 1000)) : 0;
  const pendingReview = proposal?.status === "voting" || proposal?.status === "veto_window";
  useEffect(() => { if (feed.current) feed.current.scrollTop = feed.current.scrollHeight; }, [filteredMessages.length, channel]);
  useEffect(() => {
    if (proposal?.status !== "veto_window") return;
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [proposal?.status]);
  useEffect(() => { setSendError(""); }, [channel]);

  const openAgent = (activity: AgentActivity) => { onSelect(activity.tag, activity.plantId); onAgentDetails?.(activity.tag, activity.plantId); };
  const sendText = async (text: string, destination = channel, clearDraft = false) => {
    if (!text.trim() || sending) return;
    setSending(true); setSendError("");
    try { await onSend(text.trim(), destination); if (clearDraft) setDraft(""); }
    catch (error) { setSendError(error instanceof Error ? error.message : "The sample message could not be sent. Please try again."); }
    finally { setSending(false); }
  };
  const send = (event: FormEvent) => { event.preventDefault(); void sendText(draft, channel, true); };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendText(draft, channel, true); }
  };
  const quickReview = () => {
    const destination = channel === "company" ? plantId : channel;
    onChannelChange(destination);
    void sendText("Propose 65%", destination);
  };

  return <aside ref={harnessResize.workspace} className={`agent-workspace ${harnessResize.dragging ? "agent-harness-is-resizing" : ""}`} aria-label="Agent conversation and Relay harness">
    <section className="agent-conversation" aria-labelledby="agent-heading">
      <header className="agent-section-header"><h2 id="agent-heading">Agents</h2><div className="agent-channel-select"><label className="agent-sr-only" htmlFor="agent-channel">Agent channel</label><select id="agent-channel" value={channel} onChange={(event) => onChannelChange(event.target.value)}>{channelOptions.map((name) => <option key={name} value={name}>#{name}</option>)}</select><CaretDown size={14} aria-hidden="true" /></div><button className="agent-icon-button" title="Show selected agent context" aria-label="Toggle selected agent context" aria-expanded={showContext} onClick={() => setShowContext(!showContext)}><Cpu size={20} /></button></header>
      <div className="agent-chat-state"><span className="agent-connection-dot" /><span>Interactive agent demo</span><span>Sample activity</span></div>
      {selectedActivity && showContext && <section style={agentColorStyle(selectedActivity.plantId, selectedActivity.tag)} {...pointAt(selectedActivity)} className={`agent-selected-context ar-agent-hue ${harnessResize.conversationHeight < 620 ? "agent-context-compact" : ""} ${harnessResize.conversationHeight < 340 ? "agent-context-minimal" : ""}`} aria-label="Selected agent task and summary">
        <div className="agent-context-heading"><span className="agent-avatar" aria-hidden="true"><EquipmentIcon tag={selectedActivity.tag} /></span><button onClick={() => openAgent(selectedActivity)}><strong>{selectedActivity.equipmentName} <span>· {selectedActivity.tag}</span></strong><span>{displayRole(selectedActivity.role)} · {displayVendor(selectedActivity.vendor)}</span></button><ActivityChip state={selectedActivity.state} /></div>
        <p className="agent-context-location">{activityLocation(selectedActivity)}</p>
        <p className="agent-context-task" title={selectedActivity.task}><span>Current task</span>{selectedActivity.task}</p>
        <p className="agent-context-summary" title={selectedActivity.summary}>{selectedActivity.summary}</p>
        <div className="agent-context-progress"><span>Sample task progress</span><span>{progressValue(selectedActivity.progress)}%</span><div role="progressbar" aria-label={`${selectedActivity.equipmentName} sample task progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressValue(selectedActivity.progress)}><i style={{ width: `${progressValue(selectedActivity.progress)}%` }} /></div></div>
      </section>}
      <div ref={feed} className="agent-message-feed" role="log" aria-live="polite" aria-relevant="additions text" aria-label={`Messages in ${channel}`}>
        {filteredMessages.length ? filteredMessages.map((message) => <Message key={message.id} message={message} activity={activities.find((activity) => activity.tag === message.tag && activity.plantId === (message.plantId || channelPlant || plantId))} fallbackPlant={plantId} channelPlant={channelPlant} onEvidence={onEvidence} onAgentDetails={openAgent} onSelect={onSelect} onHighlight={onHighlight} />) : <div className="agent-empty"><ChatCircleDots size={32} weight="light" /><strong>Your equipment agents are ready</strong><p>Send a sample proposal to see each specialist review its equipment and explain its vote.</p><button onClick={quickReview} disabled={sending || pendingReview}>Run 65% review <ArrowUpRight size={14} /></button></div>}
      </div>
      {proposal?.status === "veto_window" && <div className="agent-veto-strip" role="status"><div><span className="agent-veto-label"><Check size={15} /> Consensus reached</span><span>P-100 → {proposal.to}% · {vetoSeconds}s to execute in demo</span></div><button onClick={onVeto} disabled={!vetoSeconds}>Veto change</button><div className="agent-veto-progress" style={{ width: `${Math.min(100, vetoSeconds * 10)}%` }} /></div>}
      <form className="agent-composer" onSubmit={send}>
        <div className="agent-composer-routing"><label htmlFor="agent-send-channel">To:</label><div><select id="agent-send-channel" value={channel} onChange={(event) => onChannelChange(event.target.value)}>{channelOptions.map((name) => <option key={name} value={name}>{displayChannel(name)}</option>)}</select><CaretDown size={12} /></div><span>Browser demo</span></div>
        <div className="agent-composer-input"><label className="agent-sr-only" htmlFor="agent-message">Message the agents</label><textarea id="agent-message" rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} placeholder={proposal?.status === "blocked" ? "Propose 65% instead…" : "Message your equipment agents…"} /><button type="submit" aria-label="Send message" title="Send message" disabled={sending || !draft.trim()}>{sending ? <ArrowsClockwise size={21} className="relay-spin" /> : <PaperPlaneTilt size={23} weight="fill" />}</button></div>
        <div className="agent-composer-quick-actions"><button type="button" onClick={quickReview} disabled={sending || pendingReview}><Check size={13} />Run 65% review</button><span>Enter to send · Shift + Enter for a new line</span></div>
        {sendError && <p className="agent-send-error" role="alert">{sendError}</p>}
        <p className="agent-composer-note">Sample changes need equipment consensus and a 10s veto window.</p>
      </form>
    </section>

    {expanded && <div className={`agent-harness-resizer ${harnessResize.dragging ? "agent-harness-resizer-active" : ""}`} role="separator" aria-label="Resize agent conversation and harness" aria-orientation="horizontal" aria-controls="relay-harness-panel" aria-valuemin={MIN_HARNESS_HEIGHT} aria-valuemax={harnessResize.maximum} aria-valuenow={harnessResize.height} aria-valuetext={`${harnessResize.height} pixels for Agent Relay harness`} tabIndex={0} title="Drag to resize · ↑/↓ adjust · Double-click to reset" onPointerDown={harnessResize.pointerDown} onPointerMove={harnessResize.pointerMove} onPointerUp={harnessResize.stop} onPointerCancel={harnessResize.stop} onLostPointerCapture={harnessResize.stop} onKeyDown={harnessResize.keyDown} onDoubleClick={harnessResize.reset} />}
    <section id="relay-harness-panel" className={`relay-harness ${expanded ? "relay-harness-expanded" : ""}`} style={{ height: expanded ? harnessResize.height : 91 }} aria-labelledby="relay-heading">
      <header className="relay-harness-header"><button className="relay-expand-button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-controls="relay-harness-body"><h2 id="relay-heading">Agent Relay</h2>{expanded ? <CaretDown size={15} /> : <CaretRight size={15} />}</button><button className="agent-icon-button" aria-label={showActivity ? "Show agent task list" : "Show latest agent actions"} title={showActivity ? "Show agent task list" : "Show latest agent actions"} onClick={() => setShowActivity(!showActivity)}><ListBullets size={19} /></button></header>
      <div className="relay-harness-summary"><span><span className="relay-status-dot relay-status-demo" />Demo harness · sample agents</span><span>{activities.length} agents / 3 channels</span></div>
      {expanded && <div id="relay-harness-body" className="relay-harness-body">
        {showActivity ? <div className="relay-agent-action-feed" role="log" aria-label="Latest sample agent actions">{visibleActivities.slice().sort((a, b) => b.updatedAt - a.updatedAt).map((activity) => <button key={activity.id} className="ar-agent-hue" style={agentColorStyle(activity.plantId, activity.tag)} {...pointAt(activity)} onClick={() => openAgent(activity)}><time>{formatTime(activity.updatedAt)}</time><span><strong><i className="agent-color-dot" aria-hidden="true" />{activity.equipmentName} <span>· {activity.tag}</span></strong><span>{activity.latestAction}</span><small>{displayChannel(activity.plantId)} · {activityLabels[activity.state]}</small></span><ArrowUpRight size={13} /></button>)}</div> : <div className="relay-agent-task-list" aria-label="Agent roles and current tasks">{visibleActivities.map((activity) => <button key={activity.id} className={`relay-agent-task-row ar-agent-hue ${activity.tag === selected && activity.plantId === plantId ? "relay-agent-task-selected" : ""}`} style={agentColorStyle(activity.plantId, activity.tag)} {...pointAt(activity)} onClick={() => openAgent(activity)} aria-label={`${activity.equipmentName} ${activity.tag}, ${displayChannel(activity.plantId)}, ${activityLabels[activity.state]}. View agent details.`}><span className="relay-agent-task-icon agent-avatar" aria-hidden="true"><EquipmentIcon tag={activity.tag} /></span><span className="relay-agent-task-content"><span className="relay-agent-task-heading"><strong>{activity.equipmentName} <span>· {activity.tag}</span></strong><ActivityChip state={activity.state} /></span><span className="relay-agent-task-meta">{displayRole(activity.role)} · {displayVendor(activity.vendor)}<span>{displayChannel(activity.plantId)}</span></span><span className="relay-agent-task-description" title={activity.task}>{activity.task}</span></span><ArrowUpRight className="relay-agent-open-icon" size={12} /></button>)}</div>}
      </div>}
      <footer className="relay-harness-footer"><button onClick={() => setShowActivity(!showActivity)}>{showActivity ? "Agent tasks" : "Latest actions"}<CaretRight size={12} /></button><span>Illustrative scenario activity</span><details className="relay-state-legend"><summary><span className="relay-legend-swatches" aria-hidden="true">{TAG_ORDER.map((tag) => <i key={tag} style={agentColorStyle(plantId, tag)} />)}</span>Legend</summary><div><AgentColorLegend plantId={plantId} /><strong>Sample agent states</strong>{(Object.keys(activityLabels) as AgentActivityState[]).map((state) => <p key={state}><ActivityChip state={state} /><span>{activityDescriptions[state]}</span></p>)}<small>Task progress describes this demo’s review steps.</small></div></details></footer>
    </section>
  </aside>;
}

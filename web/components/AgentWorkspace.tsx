"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowsClockwise, ArrowUpRight, CaretDown, ChatCircleDots, Check, Cpu, Drop, FileText, Gauge, Info, PaperPlaneTilt, ShieldCheck, UserCircle, WaveSine } from "@phosphor-icons/react";
import type { AgentActivity, AgentActivityState, AgentWorkspaceProps, ChatMessage, ComponentTag, PlantId } from "../lib/types";
import { agentColorStyle } from "../lib/agent-colors";
import { evidenceLabel, normalizeChatMessage, type NormalizedChatMessage } from "../lib/message-normalization";
import { controlTarget } from "../lib/controls";
import "./agent-workspace.css";

const displayChannel = (channel: string) => channel === "plant-a" ? "Plant A" : channel === "plant-b" ? "Plant B" : channel === "company" ? "Company" : channel;
const displayVendor = (vendor?: string) => vendor ? vendor.charAt(0).toUpperCase() + vendor.slice(1) : "Relay";
const formatTime = (at: number) => new Date(at).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const activityLabels: Record<AgentActivityState, string> = {
  monitoring: "Monitoring", thinking: "Thinking", reviewing: "Reviewing", waiting: "Waiting",
  blocked: "Blocked", ready: "Ready", observing: "Observing",
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
function EquipmentIcon({ tag, operator = false }: { tag?: ComponentTag; operator?: boolean }) {
  if (operator) return <UserCircle size={23} weight="light" />;
  if (tag === "P-100") return <Gauge size={23} weight="light" />;
  if (tag === "TK-101") return <Drop size={23} weight="light" />;
  if (tag === "E-101") return <WaveSine size={23} weight="light" />;
  if (tag === "TV-101") return <ShieldCheck size={23} weight="light" />;
  return <Cpu size={23} weight="light" />;
}

function ActivityChip({ state }: { state: AgentActivityState }) {
  return <span className={`agent-activity-chip agent-activity-${state}`} title={`Agent state: ${activityLabels[state]}`}><span aria-hidden="true" />{activityLabels[state]}</span>;
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
  message: NormalizedChatMessage; activity?: AgentActivity; fallbackPlant: PlantId; channelPlant?: PlantId;
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
      {activity && agentTag && <div className="agent-message-identity"><span>{displayVendor(message.vendor || activity.vendor)} · {displayRole(activity.role)}</span><ActivityChip state={activity.state} /><span className="agent-message-location">{activityLocation(activity)}</span></div>}
      {message.badge && <span className="agent-message-badge" data-decision={message.badge.toLowerCase()}>{message.badge}</span>}
      <MessageText text={message.text} plantId={messagePlant} onSelect={onSelect} onHighlight={onHighlight} onRestore={restore} />
      {!!message.facts?.length && <ul className="agent-message-facts">{message.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul>}
      {!!message.evidence?.length && <div className="agent-evidence-list">{message.evidence.map((id, index) => <button key={id} onClick={() => onEvidence(id)} className="agent-evidence-button" title={id}><FileText size={16} /><span>{evidenceLabel(id, index)}</span><ArrowUpRight size={12} /></button>)}</div>}
      {message.rawText && <details className="agent-message-original"><summary>Original message</summary><pre>{message.rawText}</pre></details>}
    </div>
  </article>;
}

export default function AgentWorkspace(props: AgentWorkspaceProps & { live?: boolean }) {
  const live = props.live ?? false;
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
  const [showContext, setShowContext] = useState(false);
  const [now, setNow] = useState(Date.now());
  const feed = useRef<HTMLDivElement>(null);
  const channelOptions = ["plant-a", "plant-b", "company"];
  const normalizedMessages = useMemo(() => messages.map(normalizeChatMessage), [messages]);
  const filteredMessages = normalizedMessages.filter((message) => message.channel.replace(/^#/, "") === channel.replace(/^#/, ""));
  const selectedActivity = activities.find((activity) => activity.tag === selected && activity.plantId === plantId);
  const vetoSeconds = proposal?.vetoDeadline ? Math.max(0, Math.ceil((proposal.vetoDeadline - now) / 1000)) : 0;
  const pendingReview = proposal?.status === "voting" || proposal?.status === "veto_window";
  const proposalControl = proposal ? controlTarget(proposal.proposerTag ?? "P-100", proposal.metric ?? "speedPct") : undefined;
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

  return <aside className="agent-workspace" aria-label="Agent conversation">
    <section className="agent-conversation" aria-labelledby="agent-heading">
      <header className="agent-section-header"><h2 id="agent-heading">Conversation</h2><div className="agent-channel-select"><label className="agent-sr-only" htmlFor="agent-channel">Agent channel</label><select id="agent-channel" value={channel} onChange={(event) => onChannelChange(event.target.value)}>{channelOptions.map((name) => <option key={name} value={name}>#{name}</option>)}</select><CaretDown size={14} aria-hidden="true" /></div><button className="agent-icon-button" title="Show selected agent context" aria-label="Toggle selected agent context" aria-expanded={showContext} onClick={() => setShowContext(!showContext)}><Cpu size={20} /></button></header>
      <div className="agent-chat-state"><span className="agent-connection-dot" /><span>{live ? "Live agent activity" : "Interactive agent demo"}</span><span>{live ? "From the actors" : "Sample activity"}</span></div>
      {selectedActivity && showContext && <section style={agentColorStyle(selectedActivity.plantId, selectedActivity.tag)} {...pointAt(selectedActivity)} className="agent-selected-context ar-agent-hue agent-context-compact" aria-label="Selected agent task and summary">
        <div className="agent-context-heading"><span className="agent-avatar" aria-hidden="true"><EquipmentIcon tag={selectedActivity.tag} /></span><button onClick={() => openAgent(selectedActivity)}><strong>{selectedActivity.equipmentName} <span>· {selectedActivity.tag}</span></strong><span>{displayRole(selectedActivity.role)} · {displayVendor(selectedActivity.vendor)}</span></button><ActivityChip state={selectedActivity.state} /></div>
        <p className="agent-context-location">{activityLocation(selectedActivity)}</p>
        <p className="agent-context-task" title={selectedActivity.task}><span>Current task</span>{selectedActivity.task}</p>
        <p className="agent-context-summary" title={selectedActivity.summary}>{selectedActivity.summary}</p>
        <div className="agent-context-progress"><span>Sample task progress</span><span>{progressValue(selectedActivity.progress)}%</span><div role="progressbar" aria-label={`${selectedActivity.equipmentName} sample task progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressValue(selectedActivity.progress)}><i style={{ width: `${progressValue(selectedActivity.progress)}%` }} /></div></div>
      </section>}
      <div ref={feed} className="agent-message-feed" role="log" aria-live="polite" aria-relevant="additions text" aria-label={`Messages in ${channel}`}>
        {filteredMessages.length ? filteredMessages.map((message) => <Message key={message.id} message={message} activity={activities.find((activity) => activity.tag === message.tag && activity.plantId === (message.plantId || channelPlant || plantId))} fallbackPlant={plantId} channelPlant={channelPlant} onEvidence={onEvidence} onAgentDetails={openAgent} onSelect={onSelect} onHighlight={onHighlight} />) : <div className="agent-empty"><ChatCircleDots size={32} weight="light" /><strong>Your equipment agents are ready</strong><p>Send a sample proposal to see each specialist review its equipment and explain its vote.</p><button onClick={quickReview} disabled={sending || pendingReview}>Run 65% review <ArrowUpRight size={14} /></button></div>}
      </div>
      {proposal?.status === "veto_window" && <div className="agent-veto-strip" role="status"><div><span className="agent-veto-label"><Check size={15} /> Consensus reached</span><span>{proposalControl?.loop ?? "P-100"} → {proposal.to} {proposalControl?.unit ?? "%"} · {vetoSeconds}s to execute</span></div><button onClick={onVeto} disabled={!vetoSeconds}>Veto change</button><div className="agent-veto-progress" style={{ width: `${Math.min(100, vetoSeconds * 10)}%` }} /></div>}
      <form className="agent-composer" onSubmit={send}>
        <div className="agent-composer-routing"><label htmlFor="agent-send-channel">To:</label><div><select id="agent-send-channel" value={channel} onChange={(event) => onChannelChange(event.target.value)}>{channelOptions.map((name) => <option key={name} value={name}>{displayChannel(name)}</option>)}</select><CaretDown size={12} /></div><span>{live ? "Live" : "Browser demo"}</span></div>
        <div className="agent-composer-input"><label className="agent-sr-only" htmlFor="agent-message">Message the agents</label><textarea id="agent-message" rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} placeholder={proposal?.status === "blocked" ? "Propose 65% instead…" : "Message your equipment agents…"} /><button type="submit" aria-label="Send message" title="Send message" disabled={sending || !draft.trim()}>{sending ? <ArrowsClockwise size={21} className="relay-spin" /> : <PaperPlaneTilt size={23} weight="fill" />}</button></div>
        <div className="agent-composer-quick-actions"><button type="button" onClick={quickReview} disabled={sending || pendingReview}><Check size={13} />Run 65% review</button><span>Enter to send · Shift + Enter for a new line</span></div>
        {sendError && <p className="agent-send-error" role="alert">{sendError}</p>}
        <p className="agent-composer-note">{live ? "Changes need equipment consensus and a 5 s veto window." : "Sample changes need equipment consensus and a 5s veto window."}</p>
      </form>
    </section>

  </aside>;
}

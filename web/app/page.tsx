"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import { ArrowClockwise, ArrowRight, ArrowsIn, ArrowsInLineHorizontal, ArrowsOut, ArrowsOutSimple, CaretDown, CaretRight, ChartLine, Check, Command, Cube, Cylinder, Fan, FileText, FunnelSimple, Info, MagnifyingGlass, Moon, SidebarSimple, SlidersHorizontal, Sun, Triangle, Waves, X } from "@phosphor-icons/react";
import AgentWorkspace from "../components/AgentWorkspace";
import AgentCommunicationFlow from "../components/AgentCommunicationFlow";
import PlantSchematic from "../components/PlantSchematic";
import PlantFloorPlan from "../components/PlantFloorPlan";
import TrendChart from "../components/TrendChart";
import CompanyOverview from "../components/CompanyOverview";
import EquipmentInspector from "../components/EquipmentInspector";
import EvidenceDialog from "../components/EvidenceDialog";
import ProposalReview from "../components/ProposalReview";
import ResizeHandle from "../components/ResizeHandle";
import AgentStateDialog from "../components/AgentStateDialog";
import { usePanelLayout } from "../lib/use-panel-layout";
import { useLive } from "../lib/use-live";
import { controlTarget, parseControlRequest, type ControlMetric } from "../lib/controls";
import { COMPONENTS, createDemoState, DEMO_EPOCH, demoReducer, PLANTS } from "../lib/demo";
import { demoAgentActivities } from "../lib/agent-activity";
import { agentColor, agentColorStyle } from "../lib/agent-colors";
import type { ComponentTag, PlantId, PlantScope, ViewMode } from "../lib/types";

const PlantScene = dynamic(() => import("../components/PlantScene"), { ssr: false, loading: () => <div className="spatial-loading"><Cube size={32} weight="light" /><span>Loading spatial view…</span></div> });
const time = (value: number) => new Date(value).toLocaleTimeString("en-GB", { timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const plantName = (scope: PlantScope) => scope === "company" ? "Company" : scope === "plant-a" ? "Plant A" : "Plant B";

function EquipmentIcon({ tag, size = 27 }: { tag: ComponentTag; size?: number }) {
  const Icon = tag === "P-100" ? Fan : tag === "TK-101" ? Cylinder : tag === "LV-101" ? ArrowsInLineHorizontal : tag === "E-101" ? Waves : FunnelSimple;
  return <Icon size={size} weight="light" aria-hidden="true" />;
}

function HelpDialog({ onClose, live = false }: { onClose: () => void; live?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; const previous = document.activeElement as HTMLElement | null; dialog?.showModal(); return () => { dialog?.close(); previous?.focus(); }; }, []);
  return <dialog ref={ref} className="workspace-help" aria-labelledby="help-title" onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <header><div><Info size={22} /><h2 id="help-title">Your plant workspace</h2></div><button onClick={onClose} aria-label="Close workspace guide"><X size={20} /></button></header>
    <p>Inspect connected equipment, review the evidence, and watch agents negotiate an operating change.</p>
    {live ? <div className="help-mode"><span>LIVE SYSTEM</span><p>Plant values come from the plant simulator; votes are made by the ten equipment agents through the durable actors. The plant is simulated; no physical equipment is connected.</p></div> : <div className="help-mode"><span>INTERACTIVE DEMO</span><p>Plant measurements, equipment agents, history, votes, and calibration are sample data running in this browser. No physical equipment or backend is connected.</p></div>}
    {live ? <ol><li>Send <strong>“Propose 85%”</strong> in the Plant A conversation (or use New proposal).</li><li>Watch the agents block it with evidence, counter-propose, and the 5-second veto window.</li><li>Switch to Plant B to see the shared rule.</li></ol> : <ol><li>Select equipment in the tree or either plant view.</li><li>Send <strong>“Propose 65%”</strong> in the Plant A conversation.</li><li>Review unanimous sample votes, then try the 5-second veto window.</li><li>Switch to Plant B or Company to explore shared knowledge.</li></ol>}
    <p className="help-relay">Open <strong>Agent flow</strong> to see review requests and votes between equipment agents across both plants. The conversation on the right shows their decisions and evidence. Select an agent to inspect its details. Use <strong>Show graph</strong> when you want to inspect the equipment trend.</p>
    <div className="help-shortcuts"><span><kbd>1</kbd> 2D view</span><span><kbd>2</kbd> 3D view</span><span><kbd>3</kbd> Agent flow</span><span><kbd>⌘ K</kbd> Equipment search</span><span><kbd>I</kbd> Inspect</span></div>
    <button className="primary-button" onClick={onClose}>Explore the workspace <ArrowRight size={17} /></button>
  </dialog>;
}

export default function Dashboard() {
  const [state, dispatch] = useReducer(demoReducer, DEMO_EPOCH, createDemoState);
  const live = useLive();
  const usingLive = live.status === "live" && live.state !== null;
  const data = usingLive ? live.state! : state;
  const liveRef = useRef(false);
  liveRef.current = usingLive;
  const [scope, setScope] = useState<PlantScope>("plant-a");
  const [view, setView] = useState<ViewMode | "agents">("2d");
  const [showTrend, setShowTrend] = useState(false);
  const [diagram, setDiagram] = useState(false);
  const PlanView = diagram ? PlantSchematic : PlantFloorPlan;
  const [selected, setSelected] = useState<ComponentTag>("LV-101");
  const [channel, setChannel] = useState("plant-a");
  const [expanded, setExpanded] = useState<Record<PlantId, boolean>>({ "plant-a": true, "plant-b": false });
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [compactSidebar, setCompactSidebar] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [agentDetailsOpen, setAgentDetailsOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [viewExpanded, setViewExpanded] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [highlighted, setHighlighted] = useState<{ tag: ComponentTag; plantId: PlantId } | null>(null);
  const layout = usePanelLayout();
  const workspace = useRef<HTMLElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const navigator = useRef<HTMLElement>(null);
  const navigatorVisible = !viewExpanded && (compactSidebar ? sidebarOpen : sidebarVisible);
  const plantId: PlantId = scope === "plant-b" ? "plant-b" : "plant-a";
  const components = data.components.filter((component) => component.plantId === plantId);
  const equipment = components.find((component) => component.tag === selected)!;
  const proposal = data.proposals.findLast((item) => item.plantId === plantId) ?? null;
  // Big banner when this plant refused a change because of a rule learned in the other plant (stays up for 2 minutes).
  const otherPlant = plantId === "plant-a" ? "Plant B" : "Plant A";
  const knowledgeBanner = scope !== "company" && data.proposals.some((p) => p.plantId === plantId && p.status === "blocked" && data.now - p.createdAt < 120_000
    && p.votes.some((v) => v.vote === "no" && v.reason.includes(`Learned in ${otherPlant}`))) ? `${plantName(plantId)} uses knowledge from ${otherPlant}` : null;
  const activities = useMemo(() => demoAgentActivities(data), [data]);
  const selectedActivity = activities.find((activity) => activity.plantId === plantId && activity.tag === selected)!;
  const evidence = data.evidence.find((item) => item.id === evidenceId) ?? null;
  const audit = data.audit.filter((event) => scope === "company" || event.plantId === scope || event.plantId === "company").toReversed();
  const latestAudit = audit[0];
  const latestDecision = data.proposals.findLast((p) => p.plantId === plantId && p.status === "blocked");
  const latestDecisionControl = latestDecision ? controlTarget(latestDecision.proposerTag ?? "P-100", latestDecision.metric ?? "speedPct") : undefined;
  const forecast = proposal?.status === "blocked" && (!proposal.metric || proposal.metric === "speedPct") ? { predicted: (usingLive ? proposal.votes.find((v) => v.tag === "LV-101")?.predicted : undefined) ?? proposal.to + 4, threshold: 81 } : null;

  useEffect(() => { dispatch({ type: "reset", now: Date.now() }); const timer = setInterval(() => { if (!liveRef.current) dispatch({ type: "tick", now: Date.now() }); }, 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("actorrelay-theme-v1");
      if (saved === "dark" || saved === "light") {
        setTheme(saved);
        document.documentElement.dataset.theme = saved;
      }
    } catch { /* The default light theme also works with storage disabled. */ }
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const update = () => { const active = document.fullscreenElement === workspace.current?.closest(".actorrelay-app"); setIsFullscreen(active); if (!document.fullscreenElement) setViewExpanded(false); };
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 4500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 940px)");
    const update = () => setCompactSidebar(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const separator = document.querySelector<HTMLElement>(".panel-resize-sidebar");
    if (separator) { separator.inert = !navigatorVisible || compactSidebar; separator.tabIndex = navigatorVisible && !compactSidebar ? 0 : -1; }
    if (!navigatorVisible && (navigator.current?.contains(document.activeElement) || separator === document.activeElement)) {
      document.querySelector<HTMLElement>(`.sidebar-toggle-${compactSidebar ? "mobile" : "desktop"}`)?.focus();
    }
  }, [navigatorVisible, compactSidebar]);
  useEffect(() => { if (searchOpen && navigatorVisible) searchInput.current?.focus(); }, [searchOpen, navigatorVisible]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); setSidebarOpen(true); setSidebarVisible(true); setViewExpanded(false); return; }
      const tag = (event.target as HTMLElement)?.tagName;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || document.querySelector("dialog[open]")) return;
      if (event.key === "1") setView("2d");
      if (event.key === "2") setView("3d");
      if (event.key === "3") setView("agents");
      if (event.key.toLowerCase() === "i") setInspectorOpen(true);
      if (event.key === "Escape") { setSidebarOpen(false); setSearchOpen(false); setQuery(""); setViewExpanded(false); }
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  const openScope = useCallback((next: PlantScope) => {
    setScope(next); setSidebarOpen(false);
    if (next !== "company") setExpanded((old) => ({ ...old, [next]: true }));
    setChannel(next);
  }, []);
  const selectEquipment = useCallback((tag: ComponentTag, targetPlant?: PlantId) => {
    setSelected(tag); setSidebarOpen(false);
    if (targetPlant) { setScope(targetPlant); setChannel(targetPlant); setExpanded((old) => ({ ...old, [targetPlant]: true })); }
  }, []);
  const highlight = useCallback((tag: ComponentTag | null, targetPlant?: PlantId) => {
    setHighlighted((current) => {
      if (!tag) return current ? null : current;
      const next = { tag, plantId: targetPlant ?? plantId };
      return current?.tag === next.tag && current.plantId === next.plantId ? current : next;
    });
  }, [plantId]);
  const highlightedTag = highlighted?.plantId === plantId ? highlighted.tag : null;
  const openAgentDetails = (tag: ComponentTag, targetPlant?: PlantId) => { selectEquipment(tag, targetPlant); setAgentDetailsOpen(true); };
  const changeChannel = (next: string) => {
    setChannel(next);
    if (next === "plant-a" || next === "plant-b") { setScope(next); setExpanded((old) => ({ ...old, [next]: true })); }
    if (next === "company") setScope("company");
  };
  const liveError = (caught: unknown) => setToast(caught instanceof Error ? caught.message : String(caught));
  const proposeOn = async (target: PlantId, to: number, metric: ControlMetric = "speedPct", tag: ComponentTag = "P-100") => {
    const control = controlTarget(tag, metric);
    try { await live.api.proposeControl(target, tag, metric, to, "Operator loop setpoint request from the dashboard"); setToast(`Proposed ${control?.loop ?? tag} → ${to} ${control?.unit ?? ""} on ${plantName(target)}. Equipment agents are reviewing.`); }
    catch (caught) { liveError(caught); }
  };
  const send = async (text: string, destination: string) => {
    if (!usingLive) { dispatch({ type: "send", text, channel: destination, now: Date.now() }); return; }
    const command = parseControlRequest(text);
    if (!command) { setToast("Try “Propose 85%” (pump), “Set tank temperature to 76”, or “Set tank level to 60%”."); return; }
    if (destination !== "plant-a" && destination !== "plant-b") { setToast("Select Plant A to propose a loop setpoint change."); return; }
    const control = controlTarget(command.tag, command.metric);
    if (control && (command.to < control.min || command.to > control.max)) { setToast(`${control.label} must be between ${control.min} and ${control.max} ${control.unit}.`); return; }
    await proposeOn(destination, command.to, command.metric, command.tag);
  };
  const propose = (to: number, metric: ControlMetric = "speedPct", tag: ComponentTag = "P-100") => {
    setChannel(plantId); setSelected(tag);
    if (usingLive) { void proposeOn(plantId, to, metric, tag); return; }
    dispatch({ type: "propose", plantId, to, metric, tag, now: Date.now() });
  };
  const veto = (proposalId: string) => {
    if (usingLive) { live.api.veto(proposalId).then(() => setToast("Change vetoed. No setpoint was applied."), liveError); return; }
    dispatch({ type: "veto", id: proposalId, now: Date.now() });
  };
  const reset = () => {
    setAuditOpen(false);
    if (usingLive) { live.api.reset().then(() => setToast("Live demo reset: simulator and actors back at the design point"), liveError); return; }
    dispatch({ type: "reset", now: Date.now() }); setToast("Demo reset. Both plants are back at their design point.");
  };
  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    try { localStorage.setItem("actorrelay-theme-v1", next); } catch { /* Theme preference is optional. */ }
  };
  const fitWorkspace = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (workspace.current?.closest<HTMLElement>(".actorrelay-app")?.requestFullscreen) { setViewExpanded(true); await workspace.current.closest<HTMLElement>(".actorrelay-app")!.requestFullscreen(); }
      else { setViewExpanded(true); setToast("Plant view expanded. Press Escape to restore the workspace."); }
    } catch { setViewExpanded(true); setToast("Plant view expanded. Press Escape to restore the workspace."); }
  };
  const panelStyle = { "--sidebar-width": `${layout.sidebarWidth}px`, "--chat-width": `${layout.chatWidth}px`, "--chart-height": `${layout.chartHeight}px` } as CSSProperties;
  const resetPanelSizes = () => layout.resetLayout();

  return <div className="actorrelay-app">
    <a className="skip-link" href="#plant-workspace">Skip to plant workspace</a>
    <header className="app-topbar">
      <div className="app-brand">
        <button className="icon-button sidebar-toggle sidebar-toggle-desktop" aria-label={sidebarVisible && !viewExpanded ? "Hide equipment navigator" : "Show equipment navigator"} title={sidebarVisible && !viewExpanded ? "Hide equipment navigator" : "Show equipment navigator"} aria-expanded={sidebarVisible && !viewExpanded} aria-controls="equipment-navigator" onClick={() => { setViewExpanded(false); setSidebarVisible((visible) => viewExpanded || !visible); }}><SidebarSimple size={22} /></button>
        <button className="icon-button sidebar-toggle sidebar-toggle-mobile" aria-label={sidebarOpen ? "Hide equipment navigator" : "Show equipment navigator"} title={sidebarOpen ? "Hide equipment navigator" : "Show equipment navigator"} aria-expanded={sidebarOpen} aria-controls="equipment-navigator" onClick={() => { setViewExpanded(false); setSidebarOpen((open) => !open); }}><SidebarSimple size={22} /></button>
        <Triangle weight="light" size={27} className="brand-mark" /><span>ActorRelay</span>
      </div>
          <div className="workspace-tools topbar-workspace-tools">
            <div className="view-switch" role="group" aria-label="Workspace view">
              <button className={view === "2d" && !diagram && scope !== "company" ? "is-active" : ""} aria-pressed={view === "2d" && !diagram && scope !== "company"} onClick={() => { if (scope === "company") openScope("plant-a"); setView("2d"); setDiagram(false); }}>2D Plan</button>
              <button className={view === "2d" && diagram && scope !== "company" ? "is-active" : ""} aria-pressed={view === "2d" && diagram && scope !== "company"} onClick={() => { if (scope === "company") openScope("plant-a"); setView("2d"); setDiagram(true); }}>P&amp;ID</button>
              <button className={view === "3d" && scope !== "company" ? "is-active" : ""} aria-pressed={view === "3d" && scope !== "company"} onClick={() => { if (scope === "company") openScope("plant-a"); setView("3d"); }}>3D Plant</button>
              <button className={view === "agents" ? "is-active" : ""} aria-pressed={view === "agents"} onClick={() => setView("agents")}>Agent flow</button>
            </div>
            {scope !== "company" && view !== "agents" && !viewExpanded && <button className="icon-button chart-toggle" onClick={() => setShowTrend((open) => !open)} title={showTrend ? "Hide graph" : "Show graph"} aria-label={showTrend ? "Hide graph" : "Show graph"} aria-expanded={showTrend} aria-controls={showTrend ? "equipment-trend" : undefined}><ChartLine size={18} /><span>Graph</span></button>}
            <button className="topbar-action topbar-agent-details" onClick={() => setAgentDetailsOpen(true)} title={`Agent details for ${selected}`} aria-label={`Agent details for ${selected}`}><SlidersHorizontal size={17} /><span>Agent details</span></button>
            {proposal && <button className="topbar-action topbar-review-proposal" onClick={() => setProposalOpen(true)} title="Review proposal and equipment votes" aria-label="Review proposal"><FileText size={16} /><span>Review</span></button>}
            <button className="topbar-action topbar-new-proposal" onClick={() => { if (scope === "company") openScope("plant-a"); setInspectorOpen(true); }} title="New proposal" aria-label="New proposal"><ArrowRight size={16} /><span>New proposal</span></button>
            <button className="icon-button reset-layout-button" onClick={resetPanelSizes} title="Reset panel sizes" aria-label="Reset panel sizes"><ArrowClockwise size={17} /></button>
            <button className="icon-button expand-view-button" onClick={() => setViewExpanded(!viewExpanded)} title={viewExpanded ? "Restore workspace (Escape)" : "Expand plant view"} aria-label={viewExpanded ? "Restore workspace" : "Expand plant view"} aria-pressed={viewExpanded}>{viewExpanded ? <ArrowsIn size={18} /> : <ArrowsOut size={18} />}</button>
            <button className="icon-button fullscreen-button" onClick={fitWorkspace} title={isFullscreen ? "Exit fullscreen" : "Fullscreen plant view"} aria-label={isFullscreen ? "Exit fullscreen plant view" : "Fullscreen plant view"}><ArrowsOutSimple size={18} /></button>
          </div>
      <div className="topbar-end"><time className="app-clock" dateTime={new Date(data.now).toISOString()}><span>{new Date(data.now).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" })}</span><span>{time(data.now)}</span></time><button className="icon-button theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`} title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}>{theme === "light" ? <Moon size={19} /> : <Sun size={19} />}</button><button className="demo-mode-button" onClick={() => setHelpOpen(true)}><span className="mode-dot" /><span className="desktop-mode-label">{usingLive ? "Live · simulator + agents" : live.status === "connecting" ? "Connecting…" : "Demo data"}</span><span className="mobile-mode-label">Simulated plant</span><Info size={14} /></button></div>
    </header>

    <div className={`workspace-grid ${!sidebarVisible ? "sidebar-is-collapsed" : ""} ${sidebarOpen ? "sidebar-is-open" : ""} ${viewExpanded ? "workspace-expanded" : ""} ${layout.isDragging ? "workspace-resizing" : ""}`} style={panelStyle}>
      <button className="sidebar-backdrop" aria-label="Close equipment navigator" aria-hidden={!compactSidebar || !sidebarOpen || viewExpanded} tabIndex={compactSidebar && sidebarOpen && !viewExpanded ? 0 : -1} onClick={() => setSidebarOpen(false)} />
      <aside id="equipment-navigator" ref={navigator} className="equipment-sidebar" aria-label="Equipment navigator" aria-hidden={!navigatorVisible} inert={!navigatorVisible}>
        <div className="sidebar-heading"><h2>Equipment</h2><button className="icon-button" title="Search equipment (⌘K)" aria-label="Search equipment" onClick={() => { setSearchOpen(!searchOpen); setQuery(""); }}><MagnifyingGlass size={20} /></button></div>
        {searchOpen && <div className="equipment-search"><MagnifyingGlass size={16} /><input ref={searchInput} aria-label="Filter equipment" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find equipment…" /><button onClick={() => { setQuery(""); setSearchOpen(false); }} aria-label="Clear equipment search"><X size={15} /></button></div>}
        <nav className="equipment-tree" aria-label="Company equipment">
          <button className={`company-tree-button ${scope === "company" ? "is-active" : ""}`} onClick={() => openScope("company")}><CaretRight size={15} /><span>Company</span><span className="tree-count">2</span></button>
          {PLANTS.map((plant) => {
            const matching = COMPONENTS.filter((component) => `${component.tag} ${component.name}`.toLowerCase().includes(query.toLowerCase()));
            return <div className="plant-tree-group" key={plant.id}>
              <div className="plant-tree-heading"><button className="tree-disclosure" aria-label={`${expanded[plant.id] ? "Collapse" : "Expand"} ${plant.name} equipment`} aria-expanded={expanded[plant.id]} onClick={() => setExpanded((old) => ({ ...old, [plant.id]: !old[plant.id] }))}>{expanded[plant.id] || query ? <CaretDown size={15} /> : <CaretRight size={15} />}</button><button className={scope === plant.id ? "selected-plant" : ""} onClick={() => openScope(plant.id)}>{plant.name}</button><span className="tree-plant-status" title="Sample data available" /></div>
              {(expanded[plant.id] || query) ? <div className="plant-equipment-list">{matching.map((component) => <button key={component.tag} className={`equipment-row ${scope === plant.id && selected === component.tag ? "is-selected" : ""}`} aria-pressed={scope === plant.id && selected === component.tag} onClick={() => { selectEquipment(component.tag, plant.id); setChannel(plant.id); }} onDoubleClick={() => setInspectorOpen(true)} onMouseEnter={() => highlight(component.tag, plant.id)} onMouseLeave={() => highlight(null)} onFocus={() => highlight(component.tag, plant.id)} onBlur={() => highlight(null)} title={`${component.tag} · ${component.name} · agent color ${agentColor(plant.id, component.tag)?.name ?? ""}`.trim()}><i className="equipment-agent-dot" style={agentColorStyle(plant.id, component.tag)} aria-hidden="true" /><EquipmentIcon tag={component.tag} /><span><strong>{component.tag}</strong><span>{component.name}</span></span>{scope === plant.id && selected === component.tag && <span className="selection-indicator" />}</button>)}{!matching.length && <p className="tree-no-results">No matching equipment</p>}</div> : <span className="collapsed-plant-summary">5 components</span>}
            </div>;
          })}
        </nav>
        <div className="sidebar-bottom"><button className="selected-equipment-summary" onClick={() => setInspectorOpen(true)}><EquipmentIcon tag={selected} size={21} /><span><strong>{selected}</strong><small>Equipment details</small></span><ArrowRight size={15} /></button><footer><span>10 equipment agents</span><button className="icon-button" aria-label="Workspace guide" title="Workspace guide" onClick={() => setHelpOpen(true)}><Info size={17} /></button></footer></div>
      </aside>

      <ResizeHandle kind="sidebar" label="Resize equipment navigator" value={layout.sidebarWidth} {...layout.bounds.sidebar} onPointerDown={layout.startResize} onResizeBy={layout.resizeBy} onReset={resetPanelSizes} />

      <main id="plant-workspace" className="plant-workspace" ref={workspace}>
        {knowledgeBanner && <div className="knowledge-banner" role="status" aria-live="polite">{knowledgeBanner}</div>}


        {scope === "company" && view !== "agents" ? <CompanyOverview plants={PLANTS.map((plant) => ({ ...plant, components: data.components.filter((component) => component.plantId === plant.id) }))} onOpenPlant={openScope} rules={data.evidence.filter((item) => item.kind === "rule")} onRuleClick={setEvidenceId} /> : <>
          <section className={`plant-viewport plant-viewport-${view}`} aria-label={view === "agents" ? "Equipment agent communication flow" : `${plantName(plantId)} ${view === "2d" ? "process schematic" : "3D plant model"}`}>
            {view === "agents" ? <AgentCommunicationFlow components={data.components} activities={activities} proposals={data.proposals} messages={data.messages} now={data.now} live={usingLive} selected={equipment.id} onSelect={(tag, target) => openAgentDetails(tag, target)} /> : view === "2d" ? <PlanView activities={activities} theme={theme} components={components} selected={selected} onSelect={setSelected} highlighted={highlightedTag} forecast={forecast} /> : <PlantScene activities={activities} theme={theme} components={components} selected={selected} onSelect={setSelected} highlighted={highlightedTag} forecast={forecast} />}
          </section>
          {showTrend && view !== "agents" && <>
          <ResizeHandle kind="chart" label="Resize timing chart" value={layout.chartHeight} {...layout.bounds.chart} onPointerDown={layout.startResize} onResizeBy={layout.resizeBy} onReset={resetPanelSizes} />
          <section id="equipment-trend" className="trend-section" aria-label="Equipment timing chart"><TrendChart points={data.trends[plantId]} threshold={81} label="Outlet valve" unit="%" paused={data.paused} onTogglePause={() => dispatch({ type: "pause" })} eventLabel={latestDecision ? `${latestDecision.to}${latestDecisionControl?.unit ?? "%"} ${latestDecisionControl && latestDecisionControl.tag !== "P-100" ? `${latestDecisionControl.loop} ` : ""}proposal blocked` : undefined} eventAt={latestDecision?.createdAt} /></section>
          </>}
        </>}

        <div className="audit-wrapper"><button className={`audit-latest ${auditOpen ? "audit-open" : ""}`} onClick={() => setAuditOpen(!auditOpen)} aria-expanded={auditOpen} aria-controls="audit-events"><FileText size={18} /><time>{latestAudit ? time(latestAudit.at) : "—"}</time><span>{latestAudit?.text ?? "No events in this plant yet"}</span>{audit.length > 1 && <span className="audit-count">{audit.length}</span>}<CaretRight size={17} /></button>{auditOpen && <section className="audit-events" id="audit-events" aria-label="Demo event history"><header><h2>Event history</h2><span>{usingLive ? "Live audit trail" : "Sample audit trail"}</span><button className="icon-button" aria-label="Close event history" onClick={() => setAuditOpen(false)}><X size={17} /></button></header>{audit.map((event) => <div className="audit-event" key={event.id}><time>{time(event.at)}</time><span className="audit-plant">{plantName(event.plantId)}</span><p>{event.text}</p>{event.evidenceId && <button onClick={() => setEvidenceId(event.evidenceId!)} aria-label={`View evidence for ${event.text}`}><ArrowRight size={15} /></button>}</div>)}</section>}</div>
        <footer className="workspace-footer"><span className="workspace-status"><span />{data.paused ? "Chart paused" : usingLive ? "Live system" : "Interactive demo"}<span className="footer-divider">/</span>{usingLive ? "Simulated plant · real agent votes" : "All values illustrative"}</span><button onClick={reset} title="Reset demo data"><ArrowClockwise size={13} />Reset demo</button></footer>
      </main>

      <ResizeHandle kind="chat" label="Resize agent conversation" value={layout.chatWidth} {...layout.bounds.chat} onPointerDown={layout.startResize} onResizeBy={layout.resizeBy} onReset={resetPanelSizes} />

      <AgentWorkspace live={usingLive} activities={activities} onAgentDetails={openAgentDetails} channel={channel} onChannelChange={changeChannel} selected={selected} plantId={plantId} onSelect={selectEquipment} messages={data.messages} proposal={scope === "company" ? null : proposal} onSend={send} onVeto={() => { if (proposal) veto(proposal.id); }} onEvidence={setEvidenceId} onHighlight={highlight} />
    </div>
    {inspectorOpen && <EquipmentInspector key={equipment.id} equipment={equipment} components={data.components} live={usingLive} onClose={() => setInspectorOpen(false)} onPropose={propose} />}
    <EvidenceDialog item={evidence} onClose={() => setEvidenceId(null)} onNavigate={setEvidenceId} />
    <AgentStateDialog live={usingLive} activity={agentDetailsOpen ? selectedActivity : null} onClose={() => setAgentDetailsOpen(false)} onEvidence={(id) => { setAgentDetailsOpen(false); setEvidenceId(id); }} />
    {proposalOpen && proposal && <ProposalReview proposal={proposal} onClose={() => setProposalOpen(false)} onVeto={() => veto(proposal.id)} onEvidence={(id) => { setProposalOpen(false); setEvidenceId(id); }} onCounter={(to) => propose(to, "speedPct", "P-100")} />}
    {helpOpen && <HelpDialog live={usingLive} onClose={() => setHelpOpen(false)} />}
    {toast && <div className="app-toast" role="status"><Check size={17} /><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast("")}><X size={15} /></button></div>}
  </div>;
}

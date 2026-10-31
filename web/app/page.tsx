"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import { ArrowClockwise, ArrowRight, ArrowsIn, ArrowsInLineHorizontal, ArrowsOut, ArrowsOutSimple, CaretDown, CaretRight, Check, Command, Cube, Cylinder, Fan, FileText, FunnelSimple, Info, MagnifyingGlass, Moon, SidebarSimple, SlidersHorizontal, Sun, Triangle, Waves, X } from "@phosphor-icons/react";
import AgentWorkspace from "../components/AgentWorkspace";
import PlantSchematic from "../components/PlantSchematic";
import TrendChart from "../components/TrendChart";
import CompanyOverview from "../components/CompanyOverview";
import EquipmentInspector from "../components/EquipmentInspector";
import EvidenceDialog from "../components/EvidenceDialog";
import ProposalReview from "../components/ProposalReview";
import ResizeHandle from "../components/ResizeHandle";
import AgentContextBar from "../components/AgentContextBar";
import AgentStateDialog from "../components/AgentStateDialog";
import { usePanelLayout } from "../lib/use-panel-layout";
import { COMPONENTS, createDemoState, DEMO_EPOCH, demoReducer, PLANTS } from "../lib/demo";
import { demoAgentActivities } from "../lib/agent-activity";
import { agentColor, agentColorStyle } from "../lib/agent-colors";
import type { ComponentTag, PlantId, PlantScope, ViewMode } from "../lib/types";

const PlantScene = dynamic(() => import("../components/PlantScene"), { ssr: false, loading: () => <div className="spatial-loading"><Cube size={32} weight="light" /><span>Loading spatial view…</span></div> });
const time = (value: number) => new Date(value).toLocaleTimeString("en-GB", { timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const plantName = (scope: PlantScope) => scope === "company" ? "Company" : scope === "plant-a" ? "Plant A" : "Plant B";
const statusName = { voting: "VOTING", blocked: "BLOCKED", veto_window: "VETO WINDOW", vetoed: "VETOED", executed: "EXECUTED", expired: "EXPIRED" };

function EquipmentIcon({ tag, size = 27 }: { tag: ComponentTag; size?: number }) {
  const Icon = tag === "P-100" ? Fan : tag === "TK-101" ? Cylinder : tag === "LV-101" ? ArrowsInLineHorizontal : tag === "E-101" ? Waves : FunnelSimple;
  return <Icon size={size} weight="light" aria-hidden="true" />;
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; const previous = document.activeElement as HTMLElement | null; dialog?.showModal(); return () => { dialog?.close(); previous?.focus(); }; }, []);
  return <dialog ref={ref} className="workspace-help" aria-labelledby="help-title" onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <header><div><Info size={22} /><h2 id="help-title">Your plant workspace</h2></div><button onClick={onClose} aria-label="Close workspace guide"><X size={20} /></button></header>
    <p>Inspect connected equipment, review the evidence, and watch agents negotiate an operating change.</p>
    <div className="help-mode"><span>INTERACTIVE DEMO</span><p>Plant measurements, equipment agents, history, votes, and calibration are sample data running in this browser. No physical equipment or backend is connected.</p></div>
    <ol><li>Select equipment in the tree or either plant view.</li><li>Send <strong>“Propose 65%”</strong> in the Plant A conversation.</li><li>Review unanimous sample votes, then try the 10-second veto window.</li><li>Switch to Plant B or Company to explore shared knowledge.</li></ol>
    <p className="help-relay">The <strong>Agent Relay</strong> panel shows each sample agent’s current task and state. Select an agent in chat, the harness, or either plant view to locate its equipment. Open Agent details to see its decision summary and evidence.</p>
    <div className="help-shortcuts"><span><kbd>1</kbd> 2D view</span><span><kbd>2</kbd> 3D view</span><span><kbd>⌘ K</kbd> Equipment search</span><span><kbd>I</kbd> Inspect</span></div>
    <button className="primary-button" onClick={onClose}>Explore the workspace <ArrowRight size={17} /></button>
  </dialog>;
}

export default function Dashboard() {
  const [state, dispatch] = useReducer(demoReducer, DEMO_EPOCH, createDemoState);
  const [scope, setScope] = useState<PlantScope>("plant-a");
  const [view, setView] = useState<ViewMode>("2d");
  const [selected, setSelected] = useState<ComponentTag>("LV-101");
  const [channel, setChannel] = useState("plant-a");
  const [expanded, setExpanded] = useState<Record<PlantId, boolean>>({ "plant-a": true, "plant-b": false });
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
  const [layoutResetVersion, setLayoutResetVersion] = useState(0);
  const [highlighted, setHighlighted] = useState<{ tag: ComponentTag; plantId: PlantId } | null>(null);
  const layout = usePanelLayout();
  const workspace = useRef<HTMLElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const plantId: PlantId = scope === "plant-b" ? "plant-b" : "plant-a";
  const components = state.components.filter((component) => component.plantId === plantId);
  const equipment = components.find((component) => component.tag === selected)!;
  const proposal = state.proposals.findLast((item) => item.plantId === plantId) ?? null;
  const activities = useMemo(() => demoAgentActivities(state), [state]);
  const selectedActivity = activities.find((activity) => activity.plantId === plantId && activity.tag === selected)!;
  const evidence = state.evidence.find((item) => item.id === evidenceId) ?? null;
  const audit = state.audit.filter((event) => scope === "company" || event.plantId === scope || event.plantId === "company").toReversed();
  const latestAudit = audit[0];
  const latestDecision = state.proposals.findLast((p) => p.plantId === plantId && p.status === "blocked");

  useEffect(() => { dispatch({ type: "reset", now: Date.now() }); const timer = setInterval(() => dispatch({ type: "tick", now: Date.now() }), 1000); return () => clearInterval(timer); }, []);
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
    const update = () => setIsFullscreen(document.fullscreenElement === workspace.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 4500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); setSidebarOpen(true); return; }
      const tag = (event.target as HTMLElement)?.tagName;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || document.querySelector("dialog[open]")) return;
      if (event.key === "1") setView("2d");
      if (event.key === "2") setView("3d");
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
  const send = async (text: string, destination: string) => {
    dispatch({ type: "send", text, channel: destination, now: Date.now() });
  };
  const propose = (to: number) => { dispatch({ type: "propose", plantId, to, now: Date.now() }); setChannel(plantId); };
  const reset = () => { dispatch({ type: "reset", now: Date.now() }); setAuditOpen(false); setToast("Demo reset. Both plants are back at their design point."); };
  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    try { localStorage.setItem("actorrelay-theme-v1", next); } catch { /* Theme preference is optional. */ }
  };
  const fitWorkspace = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (workspace.current?.requestFullscreen) await workspace.current.requestFullscreen();
      else { setViewExpanded(true); setToast("Plant view expanded. Press Escape to restore the workspace."); }
    } catch { setViewExpanded(true); setToast("Plant view expanded. Press Escape to restore the workspace."); }
  };
  const panelStyle = { "--sidebar-width": `${layout.sidebarWidth}px`, "--chat-width": `${layout.chatWidth}px`, "--chart-height": `${layout.chartHeight}px` } as CSSProperties;
  const resetPanelSizes = () => { layout.resetLayout(); setLayoutResetVersion((value) => value + 1); };

  return <div className="actorrelay-app">
    <a className="skip-link" href="#plant-workspace">Skip to plant workspace</a>
    <header className="app-topbar">
      <div className="app-brand"><button className="icon-button mobile-sidebar-toggle" aria-label="Toggle equipment navigator" onClick={() => setSidebarOpen(!sidebarOpen)}><SidebarSimple size={22} /></button><Triangle weight="light" size={27} className="brand-mark" /><span>ActorRelay</span></div>
      <span className="simulation-label">Simulated plant</span>
      <nav className="plant-tabs" aria-label="Plant views">{(["plant-a", "plant-b", "company"] as const).map((id) => <button key={id} className={scope === id ? "active" : ""} aria-current={scope === id ? "page" : undefined} onClick={() => openScope(id)}>{plantName(id)}</button>)}</nav>
      <div className="topbar-end"><time className="app-clock" dateTime={new Date(state.now).toISOString()}><span>{new Date(state.now).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" })}</span><span>{time(state.now)}</span></time><button className="icon-button theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`} title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}>{theme === "light" ? <Moon size={19} /> : <Sun size={19} />}</button><button className="demo-mode-button" onClick={() => setHelpOpen(true)}><span className="mode-dot" /><span className="desktop-mode-label">Demo data</span><span className="mobile-mode-label">Simulated plant</span><Info size={14} /></button></div>
    </header>

    <div className={`workspace-grid ${sidebarOpen ? "sidebar-is-open" : ""} ${viewExpanded ? "workspace-expanded" : ""} ${layout.isDragging ? "workspace-resizing" : ""}`} style={panelStyle}>
      {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close equipment navigator" onClick={() => setSidebarOpen(false)} />}
      <aside className="equipment-sidebar" aria-label="Equipment navigator">
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
        <div className="workspace-heading"><h1>{plantName(scope)}<span className="heading-separator">/</span><span className="workspace-subtitle">{scope === "company" ? "Connected plants" : "Process plant"}</span></h1><div className="workspace-tools">{scope !== "company" && <div className="view-switch" role="group" aria-label="Plant rendering mode"><button className={view === "2d" ? "is-active" : ""} aria-pressed={view === "2d"} onClick={() => setView("2d")}>2D P&amp;ID</button><button className={view === "3d" ? "is-active" : ""} aria-pressed={view === "3d"} onClick={() => setView("3d")}>3D Plant</button></div>}<button className="icon-button inspect-button" onClick={() => setInspectorOpen(true)} title="Inspect selected equipment (I)" aria-label="Inspect selected equipment"><SlidersHorizontal size={18} /></button><button className="icon-button reset-layout-button" onClick={resetPanelSizes} title="Reset panel sizes" aria-label="Reset panel sizes"><ArrowClockwise size={17} /></button><button className="icon-button expand-view-button" onClick={() => setViewExpanded(!viewExpanded)} title={viewExpanded ? "Restore workspace (Escape)" : "Expand plant view"} aria-label={viewExpanded ? "Restore workspace" : "Expand plant view"} aria-pressed={viewExpanded}>{viewExpanded ? <ArrowsIn size={18} /> : <ArrowsOut size={18} />}</button><button className="icon-button fullscreen-button" onClick={fitWorkspace} title={isFullscreen ? "Exit fullscreen" : "Fullscreen plant view"} aria-label={isFullscreen ? "Exit fullscreen plant view" : "Fullscreen plant view"}><ArrowsOutSimple size={18} /></button></div></div>

        {scope === "company" ? <CompanyOverview plants={PLANTS.map((plant) => ({ ...plant, components: state.components.filter((component) => component.plantId === plant.id) }))} onOpenPlant={openScope} rules={state.evidence.filter((item) => item.kind === "rule")} onRuleClick={setEvidenceId} /> : <>
          <div className="proposal-bar" aria-live="polite"><div className="proposal-summary"><span className="mono">P-100</span>{proposal ? <><span className="proposal-change mono">{Math.round(proposal.from)} <ArrowRight size={15} /> {proposal.to}%</span><span className="proposal-dot">·</span><button className={`proposal-status proposal-status-${proposal.status}`} onClick={() => setProposalOpen(true)} title="Review proposal and equipment votes" aria-label={`Review ${proposal.status.replaceAll("_", " ")} proposal`}>{proposal.status === "voting" && <span className="small-spinner" />}{statusName[proposal.status]}</button>{proposal.status === "voting" && <span className="proposal-context">Reviewing evidence</span>}{proposal.status === "veto_window" && <span className="proposal-context">5 / 5 votes · veto available</span>}{proposal.status === "executed" && <span className="proposal-context">{state.observation ? "Observing response" : "Observation recorded"}</span>}</> : <span className="proposal-context">No active proposal</span>}</div><button className="subtle-button" onClick={() => { setSelected("P-100"); setInspectorOpen(true); }} title="Create a sample proposal"><span>New proposal</span><ArrowRight size={14} /></button></div>
          <AgentContextBar activity={selectedActivity} onDetails={() => setAgentDetailsOpen(true)} />
          <section className={`plant-viewport plant-viewport-${view}`} aria-label={`${plantName(plantId)} ${view === "2d" ? "process schematic" : "3D plant model"}`}>
            {view === "2d" ? <PlantSchematic activities={activities} theme={theme} components={components} selected={selected} onSelect={setSelected} highlighted={highlightedTag} forecast={proposal?.status === "blocked" ? { predicted: proposal.to + 4, threshold: 81 } : null} /> : <PlantScene activities={activities} theme={theme} components={components} selected={selected} onSelect={setSelected} highlighted={highlightedTag} forecast={proposal?.status === "blocked" ? { predicted: proposal.to + 4, threshold: 81 } : null} />}
          </section>
          <ResizeHandle kind="chart" label="Resize timing chart" value={layout.chartHeight} {...layout.bounds.chart} onPointerDown={layout.startResize} onResizeBy={layout.resizeBy} onReset={resetPanelSizes} />
          <section className="trend-section" aria-label="Equipment timing chart"><TrendChart points={state.trends[plantId]} threshold={81} label="Outlet valve" unit="%" paused={state.paused} onTogglePause={() => dispatch({ type: "pause" })} eventLabel={latestDecision ? `${latestDecision.to}% proposal blocked` : undefined} eventAt={latestDecision?.createdAt} /></section>
        </>}

        <div className="audit-wrapper"><button className={`audit-latest ${auditOpen ? "audit-open" : ""}`} onClick={() => setAuditOpen(!auditOpen)} aria-expanded={auditOpen} aria-controls="audit-events"><FileText size={18} /><time>{latestAudit ? time(latestAudit.at) : "—"}</time><span>{latestAudit?.text ?? "No events in this plant yet"}</span>{audit.length > 1 && <span className="audit-count">{audit.length}</span>}<CaretRight size={17} /></button>{auditOpen && <section className="audit-events" id="audit-events" aria-label="Demo event history"><header><h2>Event history</h2><span>Sample audit trail</span><button className="icon-button" aria-label="Close event history" onClick={() => setAuditOpen(false)}><X size={17} /></button></header>{audit.map((event) => <div className="audit-event" key={event.id}><time>{time(event.at)}</time><span className="audit-plant">{plantName(event.plantId)}</span><p>{event.text}</p>{event.evidenceId && <button onClick={() => setEvidenceId(event.evidenceId!)} aria-label={`View evidence for ${event.text}`}><ArrowRight size={15} /></button>}</div>)}</section>}</div>
        <footer className="workspace-footer"><span className="workspace-status"><span />{state.paused ? "Chart paused" : "Interactive demo"}<span className="footer-divider">/</span>All values illustrative</span><button onClick={reset} title="Reset demo data"><ArrowClockwise size={13} />Reset demo</button></footer>
      </main>

      <ResizeHandle kind="chat" label="Resize agent conversation" value={layout.chatWidth} {...layout.bounds.chat} onPointerDown={layout.startResize} onResizeBy={layout.resizeBy} onReset={resetPanelSizes} />

      <AgentWorkspace activities={activities} onAgentDetails={openAgentDetails} layoutResetVersion={layoutResetVersion} channel={channel} onChannelChange={changeChannel} selected={selected} plantId={plantId} onSelect={selectEquipment} messages={state.messages} proposal={scope === "company" ? null : proposal} onSend={send} onVeto={() => { if (proposal) dispatch({ type: "veto", id: proposal.id, now: Date.now() }); }} onEvidence={setEvidenceId} onHighlight={highlight} />
    </div>
    {inspectorOpen && <EquipmentInspector key={equipment.id} equipment={equipment} onClose={() => setInspectorOpen(false)} onPropose={propose} />}
    <EvidenceDialog item={evidence} onClose={() => setEvidenceId(null)} onNavigate={setEvidenceId} />
    <AgentStateDialog activity={agentDetailsOpen ? selectedActivity : null} onClose={() => setAgentDetailsOpen(false)} onEvidence={(id) => { setAgentDetailsOpen(false); setEvidenceId(id); }} />
    {proposalOpen && proposal && <ProposalReview proposal={proposal} onClose={() => setProposalOpen(false)} onVeto={() => dispatch({ type: "veto", id: proposal.id, now: Date.now() })} onEvidence={(id) => { setProposalOpen(false); setEvidenceId(id); }} onCounter={propose} />}
    {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    {toast && <div className="app-toast" role="status"><Check size={17} /><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast("")}><X size={15} /></button></div>}
  </div>;
}

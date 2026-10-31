"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { ArrowsOutSimple, Minus, Pause, Play, Plus } from "@phosphor-icons/react";
import { CONTEXT_ROUTES, EQUIPMENT_CENTERS, EXCHANGER, FEED_VESSELS, HALL, MEZZANINE, PROCESS_ROUTES, PRODUCT_VESSELS, RACK, UTILITY, type PlantPoint } from "../lib/plant-layout";
import { agentColor } from "../lib/agent-colors";
import type { ComponentTag, PlantViewProps } from "../lib/types";
import "./plant-floor-plan.css";

const routes = [...CONTEXT_ROUTES, ...PROCESS_ROUTES];
const ink = { water: "#289fdf", steam: "#e7a24c", condensate: "#9a7150" };
const labelPositions: Record<ComponentTag, [number, number]> = {
  "P-100": [-5.3, 2.7], "TK-101": [-1.1, 3.15], "LV-101": [3.5, 2.65], "E-101": [-2.1, -3.15], "TV-101": [2.8, -2.65],
};

const pathOf = (points: PlantPoint[]) => points.map(([x, , z], i) => `${i ? "L" : "M"}${x},${z}`).join(" ");
const names: Record<ComponentTag, string> = { "P-100": "Feed pump", "TK-101": "Hold tank", "LV-101": "Outlet valve", "E-101": "Steam coil", "TV-101": "Steam valve" };

export default function PlantFloorPlan({ components, selected, onSelect, highlighted, activities = [], theme = "light" }: PlantViewProps) {
  const plantId = components[0]?.plantId ?? "plant-a";
  const tagColors = Object.fromEntries((Object.keys(EQUIPMENT_CENTERS) as ComponentTag[]).map((tag) => [tag, agentColor(plantId, tag)?.color ?? "#94a3b8"])) as Record<ComponentTag, string>;
  const svg = useRef<SVGSVGElement>(null);
  const id = useId().replaceAll(":", "");
  const [zoom, setZoom] = useState(1);
  const [paused, setPaused] = useState(false);
  useEffect(() => { if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setPaused(true); }, []);
  useEffect(() => { if (paused) svg.current?.pauseAnimations(); else svg.current?.unpauseAnimations(); }, [paused]);
  const metric = (tag: ComponentTag) => {
    const values = components.find((item) => item.tag === tag)?.metrics || {};
    const value = tag === "P-100" ? values.speedPct : tag === "TK-101" ? values.levelPct : tag === "E-101" ? values.dutyKw : values.positionPct;
    return `${Number.isFinite(value) ? value.toFixed(0) : "—"}${tag === "E-101" ? " kW" : "%"}`;
  };
  return <div className={`plant-floor-plan floor-theme-${theme}`}>
    <div className="floor-view-title"><strong>Process hall</strong><span>Top view · shared 2D / 3D layout</span></div>
    <svg ref={svg} className="floor-plan-svg" viewBox="-18 -14 36 28" role="group" aria-label="Interactive top-down process hall. Select equipment to inspect its agent.">
      <defs><pattern id={`${id}-grid`} width="1" height="1" patternUnits="userSpaceOnUse"><path d="M1 0H0V1" className="floor-grid" fill="none" strokeWidth=".012" /></pattern><pattern id={`${id}-deck`} width=".25" height=".25" patternUnits="userSpaceOnUse"><path d="M0 0V.25" className="floor-deck-hatch" strokeWidth=".025" /></pattern></defs>
      <g transform={`scale(${zoom})`}>
        <rect x={HALL.x0} y={HALL.z0} width={HALL.x1 - HALL.x0} height={HALL.z1 - HALL.z0} className="floor-slab" />
        <rect x={HALL.x0} y={HALL.z0} width={32} height={24} fill={`url(#${id}-grid)`} />
        <rect x={-14} y={-10} width={28} height={20} rx=".12" className="floor-walkway" />
        <rect x={-10.5} y={-3.8} width={22.3} height={9} rx=".14" className="floor-process-boundary" />
        <path d="M-14 7H14M-10.5-3.8V7M11.8-3.8V7" className="floor-aisle-line" />
        <path d="M-16 12V-12H16V12H8M4 12H-16" className="floor-wall" fill="none" />
        <path d="M4 12V10M8 12V10M4 10H8" className="floor-door" fill="none" />
        {[-15, -10, -5, 0, 5, 10, 15].flatMap((x) => [-11.6, 11.6].map((z) => <rect key={`${x}-${z}`} x={x - .16} y={z - .16} width=".32" height=".32" className="floor-column" />))}
        {[-8, -4, 0, 4, 8].flatMap((z) => [-15.6, 15.6].map((x) => <rect key={`${x}-${z}`} x={x - .16} y={z - .16} width=".32" height=".32" className="floor-column" />))}
        <text x={-14.4} y={-10.8} className="floor-zone-title">ENCLOSED LIQUID PROCESS HALL</text>
        <text x={-9.9} y={4.55} className="floor-zone-note">PROCESS AREA</text><text x={-12.9} y={8.2} className="floor-zone-note">CLEAR WALKWAY · KEEP OPEN</text>
        <g><rect x={MEZZANINE.x - MEZZANINE.width / 2} y={MEZZANINE.z - MEZZANINE.depth / 2} width={MEZZANINE.width} height={MEZZANINE.depth} className="floor-platform" /><rect x={MEZZANINE.x - MEZZANINE.width / 2} y={MEZZANINE.z - MEZZANINE.depth / 2} width={MEZZANINE.width} height={MEZZANINE.depth} fill={`url(#${id}-deck)`} /><text x={MEZZANINE.x} y={MEZZANINE.z - .25} textAnchor="middle" className="floor-context-name">SERVICE MEZZANINE</text><text x={MEZZANINE.x} y={MEZZANINE.z + .4} textAnchor="middle" className="floor-context-detail">+3.1 m platform</text>{Array.from({ length: 9 }, (_, i) => <path key={i} d={`M${MEZZANINE.x + 2.65},${MEZZANINE.z - 1.4 + i * .28}h1.3`} className="floor-step" />)}</g>
        <g><rect x={RACK.x0} y={RACK.z - .45} width={RACK.x1 - RACK.x0} height=".9" rx=".06" className="floor-rack" />{Array.from({ length: 10 }, (_, i) => <path key={i} d={`M${RACK.x0 + i * 3},${RACK.z - .45}v.9`} className="floor-step" />)}<text x={0} y={RACK.z - .8} textAnchor="middle" className="floor-context-detail">OVERHEAD UTILITY RACK · +5.4 m</text></g>
        <g><rect x={UTILITY.x - 1.55} y={UTILITY.z - 1.5} width="3.1" height="3" rx=".12" className="floor-skid" /><circle cx={UTILITY.x - .6} cy={UTILITY.z} r=".62" className="floor-vessel" /><rect x={UTILITY.x + .25} y={UTILITY.z - .75} width=".85" height="1.5" rx=".1" className="floor-machine" /><text x={UTILITY.x} y={UTILITY.z + 2.1} textAnchor="middle" className="floor-context-name">STEAM UTILITY</text></g>
        <g><rect x={EXCHANGER.x - 1.25} y={EXCHANGER.z - .45} width="2.5" height=".9" rx=".42" className="floor-machine" />{[-.7, -.35, 0, .35, .7].map((x) => <path key={x} d={`M${EXCHANGER.x + x} ${EXCHANGER.z - .38}v.76`} className="floor-step" />)}<text x={EXCHANGER.x} y={EXCHANGER.z + .95} textAnchor="middle" className="floor-context-detail">HX-201</text></g>
        {[...FEED_VESSELS, ...PRODUCT_VESSELS].map((vessel) => <g key={vessel.id}><circle cx={vessel.x} cy={vessel.z} r={vessel.radius + .12} className="floor-vessel-base" /><circle cx={vessel.x} cy={vessel.z} r={vessel.radius} className="floor-vessel" /><circle cx={vessel.x} cy={vessel.z} r=".2" className="floor-hatch" /><text x={vessel.x} y={vessel.z + vessel.radius + .65} textAnchor="middle" className="floor-context-detail">{vessel.id}</text></g>)}
        {routes.map((route, index) => { const path = pathOf(route.points); return <g key={route.id} aria-label={`${route.service} route ${route.id}`}><path d={path} fill="none" stroke={route.service === "steam" ? "#a8afb5" : "#60717a"} strokeWidth={route.service === "steam" ? .23 : .18} strokeLinejoin="round" strokeLinecap="round" opacity=".65" /><path d={path} fill="none" stroke={ink[route.service]} strokeWidth={route.service === "steam" ? .11 : .10} strokeLinecap="round" strokeLinejoin="round" />{[0, 1, 2].map((particle) => <circle key={particle} r=".07" fill={route.service === "water" ? "#a9ecff" : route.service === "steam" ? "#fff0c3" : "#e7c29d"}><animateMotion dur={`${5 + index % 4}s`} begin={`${-(particle * 2 + index * .23)}s`} repeatCount="indefinite" path={path} /></circle>)}</g>; })}
        <g className="floor-main-equipment"><circle cx={0} cy={0} r="1.42" className="floor-tank-footprint" /><circle cx={0} cy={0} r="1.2" className="floor-tank-top" /><circle cx=".12" cy="-.42" r=".28" className="floor-hatch" /><path d="M-1.2 0H1.2M0-1.2V1.2" className="floor-tank-brace" /><rect x="-3.45" y="-.1" width="1.45" height=".9" rx=".14" className="floor-pump-base" /><circle cx={EQUIPMENT_CENTERS["P-100"][0]} cy={EQUIPMENT_CENTERS["P-100"][2]} r=".4" className="floor-pump" /><path d="M-2.95 .05L-2.47 .32L-2.95 .6Z" className="floor-pump-rotor" /><path d="M2.32 .2L3.02 .84V.2L2.32 .84Z" className="floor-valve" /><path d="M1.1-.85L1.82-.22V-.85L1.1-.22Z" className="floor-steam-valve" /><path d="M-.7-.62Q.8-.45-.7-.28Q.8-.11-.7.06Q.8.23-.7.4Q.8.57-.7.74" className="floor-coil" fill="none" /></g>
        {(Object.keys(EQUIPMENT_CENTERS) as ComponentTag[]).map((tag) => { const [x, , z] = EQUIPMENT_CENTERS[tag]; const [lx, lz] = labelPositions[tag]; const activity = activities.find((item) => item.tag === tag && item.plantId === plantId); const active = selected === tag || highlighted === tag; return <g key={tag} className={`floor-agent-target ${active ? "floor-agent-selected" : ""} ${activity?.state === "thinking" || activity?.state === "reviewing" ? "floor-agent-working" : ""}`} role="button" tabIndex={0} aria-pressed={selected === tag} aria-label={`${names[tag]} ${tag}, ${metric(tag)}, ${activity?.state || "monitoring"}. Select equipment.`} onClick={() => onSelect(tag)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(tag); } }} style={{ "--floor-agent-color": tagColors[tag] } as CSSProperties}><circle cx={x} cy={z} r={tag === "TK-101" ? 1.62 : tag === "E-101" ? .9 : .65} className="floor-agent-halo" /><path d={`M${x},${z}L${lx + 1.1},${lz - .15}`} className="floor-tag-leader" /><g transform={`translate(${lx},${lz})`}><rect x="-.12" y="-.58" width="2.75" height="1.12" rx=".12" className="floor-agent-tag" /><circle cx=".1" cy="-.15" r=".09" fill={tagColors[tag]} /><text x=".3" y="-.03" className="floor-agent-id">{tag}</text><text x="2.4" y="-.03" textAnchor="end" className="floor-agent-metric">{metric(tag)}</text><text x=".1" y=".35" className="floor-agent-state">{activity?.state || "monitoring"}</text></g><title>{activity ? `${names[tag]} — ${activity.task}. ${activity.summary}` : names[tag]}</title></g>; })}
        <g className="floor-scale"><path d="M-14 10h5m-5-.15v.3m5-.3v.3" /><text x={-11.5} y={10.65} textAnchor="middle">5 m</text><path d="M14-10v-1m-.2.3.2-.3.2.3" /><text x={14} y={-9.5} textAnchor="middle">N</text></g>
      </g>
    </svg>
    <div className="floor-service-legend" aria-label="Pipe services"><span><i className="floor-key-water" />Process water</span><span><i className="floor-key-steam" />Steam</span><span><i className="floor-key-condensate" />Condensate</span><span className="floor-demo-note">Simulated plant</span></div>
    <div className="floor-controls" aria-label="Floor plan controls"><button onClick={() => setZoom(Math.min(3, zoom + .25))} aria-label="Zoom in floor plan" title="Zoom in"><Plus size={16} /></button><button onClick={() => setZoom(Math.max(.7, zoom - .25))} aria-label="Zoom out floor plan" title="Zoom out"><Minus size={16} /></button><button onClick={() => setZoom(1)} aria-label="Fit floor plan" title="Fit hall"><ArrowsOutSimple size={16} /></button><button onClick={() => setPaused(!paused)} aria-label={paused ? "Resume floor plan flow" : "Pause floor plan flow"} title={paused ? "Resume flow" : "Pause flow"}>{paused ? <Play size={16} /> : <Pause size={16} />}</button></div>
  </div>;
}

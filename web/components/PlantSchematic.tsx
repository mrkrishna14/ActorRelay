"use client";

import { useEffect, useId, useState, type CSSProperties } from "react";
import { ArrowsOutSimple, Minus, Pause, Play, Plus } from "@phosphor-icons/react";
import type { AgentActivity, ComponentTag, PlantViewProps } from "../lib/types";
import { agentColorStyle } from "../lib/agent-colors";
import "./plant-views.css";
import "./pid-color.css";

const COIL_PATH = "M525 186 H568 Q573 186 573 192 Q573 198 568 198 L500 205 Q491 208 500 211 L568 220 Q576 223 568 226 L500 235 Q491 238 500 241 H573 V248 H600";
const CONDENSATE_PATH = "M600 248 H615 V414 C632 420 632 440 615 446 V486 H699";
const PIPES = {
  feedIn: "M40 317 V390 H181",
  feedOut: "M239 390 H450",
  outletIn: "M600 430 H752",
  outletOut: "M793 430 H1000",
  steamIn: "M115 100 H321",
  steamOut: "M360 100 H525 V186",
} as const;
/** Instrument signal routes, written in the direction the signal travels. */
const SIGNALS = [
  { key: "ti", d: "M600 270 H735 V116", begin: 0 },
  { key: "tic-out", d: "M735 62 V43 H378", begin: 1.6 },
  { key: "li", d: "M660 430 V316 H708", begin: 3.1 },
  { key: "lic-out", d: "M762 316 H774 V407", begin: 4.6 },
] as const;

const roundedRect = (x: number, y: number, w: number, h: number, r = 7) =>
  `M${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} H${x + r} Q${x} ${y + h} ${x} ${y + h - r} V${y + r} Q${x} ${y} ${x + r} ${y} Z`;

/** Outline of each equipment group, used for agent halos and chat highlight beacons. */
const AGENT_SHAPES: Record<ComponentTag, string> = {
  "TK-101": "M439 174 C460 122 590 122 611 174 V454 C590 492 460 492 439 454 Z",
  "E-101": `${roundedRect(484, 181, 93, 72)} ${roundedRect(617, 173, 106, 88)}`,
  "P-100": roundedRect(164, 309, 104, 157),
  "TV-101": roundedRect(289, 8, 116, 119),
  "LV-101": roundedRect(737, 397, 100, 138),
};
/** Short underline beneath each equipment tag in its agent color. */
const TAG_UNDERLINE: Record<ComponentTag, [number, number, number]> = {
  "TK-101": [493, 289, 64], "E-101": [625, 197, 53], "P-100": [184, 332, 53], "TV-101": [308, 29, 64], "LV-101": [742, 477, 64],
};

function FlowParticles({ pathId, duration, count, kind, active }: { pathId: string; duration: number; count: number; kind: "water" | "steam" | "condensate"; active: boolean }) {
  if (!active) return null;
  return <g className={`pid-motion pid-particles pid-particles-${kind}`} aria-hidden="true" pointerEvents="none">
    {Array.from({ length: count }, (_, index) => <circle key={index} r={kind === "water" ? 2.5 : kind === "steam" ? 2.2 : 1.8}>
      <animateMotion dur={`${duration.toFixed(2)}s`} begin={`${(-index * duration / count).toFixed(2)}s`} repeatCount="indefinite" calcMode="paced"><mpath href={`#${pathId}`} /></animateMotion>
    </circle>)}
  </g>;
}

/** A process line drawn as a pipe shell with the fluid core and a moving sheen on top. */
function ProcessPipe({ id, d, kind, flowing, sheenSeconds }: { id: string; d: string; kind: "water" | "steam" | "condensate"; flowing: boolean; sheenSeconds: number }) {
  return <g className={`pid-process pid-process-${kind} ${flowing ? "is-flowing" : ""}`} fill="none">
    <path className="pid-pipe-shell" d={d} />
    <path className="pid-pipe-core" id={id} d={d} />
    <path className="pid-pipe-sheen pid-anim" d={d} style={{ "--pid-sheen-dur": `${sheenSeconds.toFixed(2)}s` } as CSSProperties} />
  </g>;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const finite = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? value : fallback;

export default function PlantSchematic({ components, selected, onSelect, forecast, activities = [], highlighted = null }: PlantViewProps) {
  const uid = useId().replaceAll(":", "");
  const [zoom, setZoom] = useState(1);
  const [flowPaused, setFlowPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const focus: Record<ComponentTag, [number, number]> = { "P-100": [230, 370], "TK-101": [525, 300], "LV-101": [770, 400], "E-101": [580, 220], "TV-101": [350, 100] };
  const [focusX, focusY] = focus[selected];
  const viewWidth = 1100 / zoom, viewHeight = 620 / zoom;
  const viewX = Math.max(0, Math.min(1100 - viewWidth, focusX - viewWidth / 2));
  const viewY = Math.max(0, Math.min(620 - viewHeight, focusY - viewHeight / 2));
  const plantId = components[0]?.plantId;
  const equipment = (tag: ComponentTag) => components.find((item) => item.tag === tag);
  const activityFor = (tag: ComponentTag): AgentActivity | undefined => activities.find((entry) => entry.tag === tag && entry.plantId === (equipment(tag)?.plantId ?? plantId));
  const value = (tag: ComponentTag, key: string, precision = 0) => {
    const metric = equipment(tag)?.metrics[key];
    return typeof metric === "number" && Number.isFinite(metric) ? metric.toFixed(precision) : "—";
  };
  const level = Math.max(0, Math.min(100, finite(equipment("TK-101")?.metrics.levelPct)));
  const liquidHeight = (level / 100) * 294;
  const liquidY = 472 - liquidHeight;
  const pumpSpeed = Math.max(0, finite(equipment("P-100")?.metrics.speedPct));
  const steamFlow = equipment("TV-101")?.metrics.steamKgH;
  const steamPosition = clamp01(finite(equipment("TV-101")?.metrics.positionPct) / 100);
  const outletPosition = clamp01(finite(equipment("LV-101")?.metrics.positionPct) / 100);
  const heat = clamp01((finite(equipment("E-101")?.metrics.dutyKw) - 300) / 1500);
  const waterFactor = pumpSpeed / 50;
  const steamFactor = typeof steamFlow === "number" && Number.isFinite(steamFlow) ? Math.max(0, steamFlow / 1533) : steamPosition * 2;
  const moving = !flowPaused && !reducedMotion;
  const waterDuration = Math.max(2.8, 8 / Math.max(.1, waterFactor));
  const steamDuration = Math.max(2.5, 7 / Math.max(.1, steamFactor));
  // Sheen dashes repeat every 40 px; match the particle speed on the 211 px feed line.
  const waterSheen = waterDuration * 40 / 211;
  const steamSheen = steamDuration * 40 / 230;
  const outletOpen = outletPosition > 0;
  const waterFlowing = waterFactor > 0;
  const steamFlowing = steamFactor > 0;
  const impellerSeconds = 1.6 / Math.max(.15, waterFactor);
  const lvTravel = outletPosition * 7;

  const interactive = (tag: ComponentTag) => {
    const state = activityFor(tag)?.state ?? "monitoring";
    return {
      role: "button" as const,
      tabIndex: 0,
      "aria-label": `Select ${tag}, ${equipment(tag)?.name ?? "equipment"}`,
      "aria-pressed": selected === tag,
      className: `pid-equipment agent-${state} ${selected === tag ? "is-selected" : ""} ${highlighted === tag ? "is-highlighted" : ""}`,
      style: agentColorStyle(plantId, tag),
      onClick: () => onSelect(tag),
      onKeyDown: (event: React.KeyboardEvent<SVGGElement>) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(tag); }
      },
    };
  };
  /** Halo behind the equipment (selection + agent activity) — first child of the group. */
  const agentHalo = (tag: ComponentTag) => <g className="pid-agent-aura" aria-hidden="true" pointerEvents="none">
    <path className="pid-agent-halo pid-anim" d={AGENT_SHAPES[tag]} filter={`url(#${uid}-halo)`} />
    <path className="pid-agent-outline" d={AGENT_SHAPES[tag]} />
  </g>;
  /** Beacon drawn when chat or the harness points at this equipment — last child of the group. */
  const agentBeacon = (tag: ComponentTag) => highlighted === tag ? <g className="pid-agent-beacon" aria-hidden="true" pointerEvents="none">
    <path className="pid-beacon-ring pid-anim" d={AGENT_SHAPES[tag]} />
    <path className="pid-beacon-outline pid-anim" d={AGENT_SHAPES[tag]} />
  </g> : null;
  const tagUnderline = (tag: ComponentTag) => {
    const [x, y, width] = TAG_UNDERLINE[tag];
    return <rect className="pid-tag-underline" x={x} y={y} width={width} height="2.4" rx="1.2" />;
  };
  const gauge = (x: number, y: number, width: number, fraction: number) => <g className="pid-gauge" aria-hidden="true">
    <rect className="pid-gauge-track" x={x} y={y} width={width} height="2.6" rx="1.3" />
    <rect className="pid-gauge-fill" x={x} y={y} height="2.6" rx="1.3" style={{ width: `${Math.max(0, width * clamp01(fraction))}px` }} />
  </g>;

  return (
    <div className={`plant-schematic engineering-viewport ${moving ? "pid-live" : "pid-still"}`}>
      <svg viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`} className="pid-drawing" aria-label="Interactive piping and instrumentation diagram of the heated hold tank" role="group">
        <defs>
          <linearGradient id={`${uid}-tank`} x1="0" x2="1">
            <stop offset="0" style={{ stopColor: "var(--pid-tank-1)" }} /><stop offset=".22" style={{ stopColor: "var(--pid-tank-2)" }} /><stop offset=".5" style={{ stopColor: "var(--pid-tank-3)" }} /><stop offset=".82" style={{ stopColor: "var(--pid-tank-4)" }} /><stop offset="1" style={{ stopColor: "var(--pid-tank-5)" }} />
          </linearGradient>
          <linearGradient id={`${uid}-liquid`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" style={{ stopColor: "var(--pid-liquid-top)" }} /><stop offset=".35" style={{ stopColor: "var(--pid-liquid-mid)" }} /><stop offset="1" style={{ stopColor: "var(--pid-liquid-bottom)" }} />
          </linearGradient>
          <linearGradient id={`${uid}-liquid-shade`} x1="0" x2="1">
            <stop offset="0" stopColor="#000" stopOpacity=".22" /><stop offset=".3" stopColor="#000" stopOpacity="0" /><stop offset=".72" stopColor="#fff" stopOpacity=".08" /><stop offset="1" stopColor="#000" stopOpacity=".25" />
          </linearGradient>
          <filter id={`${uid}-halo`} x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="9" /></filter>
          <filter id={`${uid}-glow`} x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3.2" /></filter>
          <clipPath id={`${uid}-tank-clip`}>
            <path d="M450 178 C470 137 580 137 600 178 V450 C579 479 471 479 450 450 Z" />
          </clipPath>
          <clipPath id={`${uid}-water-clip`}><rect x="450" y={liquidY - 4} width="150" height={liquidHeight + 4} /></clipPath>
          <marker id={`${uid}-arrow-water`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M1 1 L8 5 L1 9 Z" className="pid-marker-water" /></marker>
          <marker id={`${uid}-arrow-steam`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M1 1 L8 5 L1 9 Z" className="pid-marker-steam" /></marker>
          <marker id={`${uid}-arrow-condensate`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M1 1 L8 5 L1 9 Z" className="pid-marker-condensate" /></marker>
          <marker id={`${uid}-control-arrow`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M1 2 L8 5 L1 8" fill="none" className="pid-marker-signal" strokeWidth="1.2" /></marker>
          {SIGNALS.map((signal) => <path key={signal.key} id={`${uid}-signal-${signal.key}`} d={signal.d} />)}
        </defs>

        <g className="pid-campus-zones" pointerEvents="none">
          <rect x="8" y="186" width="290" height="348" rx="6" /><rect x="417" y="124" width="198" height="372" rx="6" /><rect x="809" y="186" width="281" height="348" rx="6" />
          <path d="M98 121 V5 H795 V121" fill="none" /><text x="825" y="36">UTILITIES / STEAM HEADER</text><text x="825" y="53" className="pid-context-note">Shared across both plants</text>
          <text x="23" y="207">01 / FEED &amp; STORAGE</text><text x="431" y="143">02 / HEATED PROCESS</text><text x="825" y="207">03 / PRODUCT &amp; CONTROL</text>
          <g className="pid-context-shapes" strokeWidth="1.2"><path d="M23 248 C23 229 112 229 112 248 V307 C112 325 23 325 23 307 Z" /><ellipse cx="67.5" cy="248" rx="44.5" ry="13" /><path d="M23 290 H112 M40 318 V332 M96 318 V332" /><path d="M1000 375 C1000 357 1081 357 1081 375 V463 C1081 481 1000 481 1000 463 Z" /><ellipse cx="1040.5" cy="375" rx="40.5" ry="12" /><path d="M1000 437 H1081 M1016 475 V488 M1064 475 V488" />
            <rect x="832" y="229" width="48" height="44" rx="2" /><rect x="886" y="229" width="48" height="44" rx="2" /><path d="M839 237 H873 V248 H839 Z M893 237 H927 V248 H893 Z M869 255 V265 M923 255 V265" />
          </g>
          <g className="pid-context-fluid"><path d="M24 291 H111 V307 C111 324 24 324 24 307 Z" /><path d="M1001 438 H1080 V463 C1080 480 1001 480 1001 463 Z" /></g>
          <g className="pid-cabinet-leds pid-anim"><circle cx="845" cy="262" r="1.8" /><circle cx="853" cy="262" r="1.8" /><circle cx="899" cy="262" r="1.8" /><circle cx="907" cy="262" r="1.8" /></g>
          <text x="67" y="270" textAnchor="middle" className="pid-context-equipment">Feed</text><text x="67" y="286" textAnchor="middle" className="pid-context-equipment">storage</text><text x="1040" y="404" textAnchor="middle" className="pid-context-equipment">Product</text><text x="1040" y="420" textAnchor="middle" className="pid-context-equipment">receiver</text>
          <text x="832" y="286" className="pid-context-note">Control cabinets · context</text>
          <path d="M20 557 H371 M702 557 H1080" className="pid-walkway" strokeWidth="1" strokeDasharray="3 5" /><text x="20" y="576" className="pid-context-note">Service walkway / facilities shown as schematic context</text>
        </g>

        <ProcessPipe id={`${uid}-feed-in`} d={PIPES.feedIn} kind="water" flowing={waterFlowing} sheenSeconds={waterSheen * .65} />
        <ProcessPipe id={`${uid}-feed-out`} d={PIPES.feedOut} kind="water" flowing={waterFlowing} sheenSeconds={waterSheen} />
        <ProcessPipe id={`${uid}-outlet-in`} d={PIPES.outletIn} kind="water" flowing={waterFlowing && outletOpen} sheenSeconds={waterSheen * .72} />
        <ProcessPipe id={`${uid}-outlet-out`} d={PIPES.outletOut} kind="water" flowing={waterFlowing && outletOpen} sheenSeconds={waterSheen * .72} />
        <ProcessPipe id={`${uid}-steam-in`} d={PIPES.steamIn} kind="steam" flowing={steamFlowing} sheenSeconds={steamSheen} />
        <ProcessPipe id={`${uid}-steam-out`} d={PIPES.steamOut} kind="steam" flowing={steamFlowing} sheenSeconds={steamSheen * 1.2} />
        <g fill="none" strokeWidth="2.1">
          <path className="pid-arrow-water" d="M112 390 H130 M340 390 H355 M660 430 H680 M913 430 H932" markerEnd={`url(#${uid}-arrow-water)`} />
          <path className="pid-arrow-steam" d="M225 100 H250 M525 125 V145" markerEnd={`url(#${uid}-arrow-steam)`} />
        </g>

        <g className="pid-condensate-pipe" fill="none">
          <path className="pid-trap-gap" d="M615 414 C632 420 632 440 615 446" strokeWidth="7" />
          <ProcessPipe id={`${uid}-condensate`} d={CONDENSATE_PATH} kind="condensate" flowing={steamFlowing} sheenSeconds={steamSheen * 1.6} />
          <path className="pid-arrow-condensate" d="M678 486 H698" strokeWidth="1.8" markerEnd={`url(#${uid}-arrow-condensate)`} />
          <circle className="pid-trap" cx="624" cy="430" r="5.5" />
        </g>
        <FlowParticles pathId={`${uid}-feed-in`} duration={waterDuration * .65} count={7} kind="water" active={moving && waterFlowing} />
        <FlowParticles pathId={`${uid}-feed-out`} duration={waterDuration} count={10} kind="water" active={moving && waterFlowing} />
        <FlowParticles pathId={`${uid}-outlet-in`} duration={waterDuration * .72} count={7} kind="water" active={moving && waterFlowing && outletOpen} />
        <FlowParticles pathId={`${uid}-outlet-out`} duration={waterDuration * .72} count={9} kind="water" active={moving && waterFlowing && outletOpen} />
        <FlowParticles pathId={`${uid}-steam-in`} duration={steamDuration} count={9} kind="steam" active={moving && steamFlowing} />
        <FlowParticles pathId={`${uid}-steam-out`} duration={steamDuration * 1.2} count={10} kind="steam" active={moving && steamFlowing} />
        <FlowParticles pathId={`${uid}-condensate`} duration={steamDuration * 1.35} count={11} kind="condensate" active={moving && steamFlowing} />

        <g className="pid-label">
          <text x="54" y="347">Feed</text><text x="54" y="370" className="pid-mono pid-water-text">{value("P-100", "feedM3h", 1)} m³/h</text>
          <text x="115" y="63">Steam header</text><text x="115" y="86" className="pid-mono pid-steam-text">{value("TV-101", "headerBarg", 1)} barg</text>
          <text x="625" y="508" className="pid-small pid-muted">Condensate</text><text x="625" y="526" className="pid-small pid-muted">return</text>
        </g>

        <g {...interactive("TK-101")}>
          <title>{`TK-101 hold tank · ${value("TK-101", "levelPct", 1)}% level · ${value("TK-101", "tempC", 1)}°C`}</title>
          {agentHalo("TK-101")}
          <path className="pid-selection-fill" d="M439 174 C460 122 590 122 611 174 V454 C590 492 460 492 439 454 Z" />
          <path className="pid-tank-shell" d="M450 178 C470 137 580 137 600 178 V450 C579 479 471 479 450 450 Z" fill={`url(#${uid}-tank)`} strokeWidth="2.3" />
          <g clipPath={`url(#${uid}-tank-clip)`}>
            <rect x="450" y={liquidY} width="150" height={liquidHeight} fill={`url(#${uid}-liquid)`} className="pid-liquid" />
            <rect x="450" y={liquidY} width="150" height={liquidHeight} fill={`url(#${uid}-liquid-shade)`} pointerEvents="none" />
            {level > 0 && <path className="pid-liquid-surface" d={`M450 ${liquidY} H600`} strokeWidth="1.4" />}
            <g clipPath={`url(#${uid}-water-clip)`} className="pid-motion" pointerEvents="none">
              <g>
                {moving && <animateTransform attributeName="transform" type="translate" values="0 0;0 -1.4;0 0.6;0 0" dur="3.6s" repeatCount="indefinite" />}
                {[0, 7, 14].map((offset) => <path key={offset} className="pid-wave" d={`M390 ${liquidY + offset} q15 -4 30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0 t30 0`} fill="none" strokeWidth={offset ? ".7" : "1.4"} opacity={offset === 0 ? ".85" : offset === 7 ? ".3" : ".16"}>
                  {moving && <animateTransform attributeName="transform" type="translate" from={offset === 7 ? "60 0" : "0 0"} to={offset === 7 ? "0 0" : "60 0"} dur={`${(4 + offset * .25) / Math.max(.3, waterFactor)}s`} repeatCount="indefinite" />}
                </path>)}
              </g>
              {moving && waterFlowing && Array.from({ length: 9 }, (_, index) => <circle key={index} className="pid-bubble" r={index % 3 === 0 ? 1.8 : 1.3}><animateMotion dur={`${(6 + index * .22) / Math.max(.3, waterFactor)}s`} begin={`${-index * .9}s`} repeatCount="indefinite" path={`M${468 + index * 12} 448 C${460 + index * 11} ${liquidY + 18} ${498 + index * 7} ${liquidY + 12} ${580 - index * 8} 447 Z`} /></circle>)}
            </g>
            <path d="M456 178 V450 C476 474 575 474 594 450 V178" fill="none" className="pid-tank-inner" />
          </g>
          <path className="pid-tank-highlight" d="M462 190 C466 170 478 160 492 154" fill="none" strokeWidth="2.4" strokeLinecap="round" />
          <text x="525" y="283" className="pid-tag" textAnchor="middle">TK-101</text>
          {tagUnderline("TK-101")}
          <text x="525" y="306" className="pid-label" textAnchor="middle">Hold tank</text>
          <text x="525" y="365" className="pid-value pid-on-liquid" textAnchor="middle">{value("TK-101", "levelPct", 1)} %</text>
          <path d="M465 379 H585" className="pid-divider" />
          <text x="525" y="405" className="pid-value pid-on-liquid" textAnchor="middle">{value("TK-101", "tempC", 1)} °C</text>
          <g transform="translate(525 438)" className="pid-agitator" fill="none" opacity=".8" pointerEvents="none"><path d="M0 -18 V0" strokeWidth="1.4" /><ellipse rx="22" ry="5" strokeWidth=".8" opacity=".45" /><g><path d="M-17 0 H17 M-11 -5 L11 5 M-11 5 L11 -5" strokeWidth="1.4" />{moving && waterFlowing && <animateTransform attributeName="transform" type="scale" values="1 1;.25 1;1 1" dur={`${1.4 / Math.max(.3, waterFactor)}s`} repeatCount="indefinite" />}</g></g>
          {agentBeacon("TK-101")}
        </g>

        <g {...interactive("E-101")} style={{ ...agentColorStyle(plantId, "E-101"), "--pid-heat": heat.toFixed(3) } as CSSProperties}>
          <title>{`E-101 steam coil · ${value("E-101", "dutyKw")} kW`}</title>
          {agentHalo("E-101")}
          <rect x="482" y="183" width="91" height="78" rx="6" className="pid-selection-fill" />
          <path d={COIL_PATH} className="pid-coil-glow" fill="none" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" filter={`url(#${uid}-glow)`} opacity={(heat * .85).toFixed(3)} />
          <path id={`${uid}-coil`} d={COIL_PATH} className="pid-coil" fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          <path d={COIL_PATH} className="pid-coil-hot" fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" opacity={(.2 + heat * .8).toFixed(3)} />
          <FlowParticles pathId={`${uid}-coil`} duration={steamDuration * 1.2} count={13} kind="steam" active={moving && steamFlowing} />
          {moving && steamFlowing && <g className="pid-motion pid-steam-puffs" aria-hidden="true" pointerEvents="none">
            {[0, 1, 2, 3].map((index) => {
              const dur = 2.2 / Math.max(.45, steamFactor);
              return <circle key={index} cx="530" cy="184" r="1.5">
                <animate attributeName="r" values="1.2;6.5" dur={`${dur.toFixed(2)}s`} begin={`${(-index * dur / 4).toFixed(2)}s`} repeatCount="indefinite" />
                <animate attributeName="opacity" values=".85;0" dur={`${dur.toFixed(2)}s`} begin={`${(-index * dur / 4).toFixed(2)}s`} repeatCount="indefinite" />
                <animate attributeName="cx" values={`530;${541 + index * 3}`} dur={`${dur.toFixed(2)}s`} begin={`${(-index * dur / 4).toFixed(2)}s`} repeatCount="indefinite" />
                <animate attributeName="cy" values={`184;${172 - index * 2}`} dur={`${dur.toFixed(2)}s`} begin={`${(-index * dur / 4).toFixed(2)}s`} repeatCount="indefinite" />
              </circle>;
            })}
          </g>}
          <text x="625" y="191" className="pid-tag">E-101</text>{tagUnderline("E-101")}<text x="625" y="216" className="pid-label">Steam coil</text>
          <rect x="624" y="223" width="91" height="32" rx="2" className="pid-value-box" /><text x="669" y="244" className="pid-value" textAnchor="middle">{value("E-101", "dutyKw")} kW</text>
          {gauge(627, 249, 85, finite(equipment("E-101")?.metrics.dutyKw) / 1800)}
          {agentBeacon("E-101")}
        </g>

        <g {...interactive("P-100")}>
          <title>{`P-100 feed pump · ${value("P-100", "speedPct")}% speed`}</title>
          {agentHalo("P-100")}
          <rect x="164" y="309" width="104" height="157" rx="6" className="pid-selection-fill" />
          <circle cx="210" cy="390" r="29" className="pid-equip-body" strokeWidth="2" />
          <circle cx="210" cy="390" r="24.5" className="pid-pump-casing" strokeWidth="1" />
          <g transform="translate(210 390)" className="pid-impeller" aria-hidden="true">
            <g>
              {[0, 72, 144, 216, 288].map((angle) => <path key={angle} d="M0 0 C5 -3 11 -4 15 -1" transform={`rotate(${angle})`} fill="none" strokeWidth="1.7" strokeLinecap="round" />)}
              <circle r="3" className="pid-impeller-hub" />
              {moving && waterFlowing && <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur={`${impellerSeconds.toFixed(2)}s`} repeatCount="indefinite" />}
            </g>
          </g>
          <path d="M197 367 L234 390 L197 413 Z" fill="none" className="pid-pump-symbol" strokeWidth="2" />
          <text x="184" y="326" className="pid-tag">P-100</text>{tagUnderline("P-100")}<text x="184" y="350" className="pid-label">Feed pump</text>
          <rect x="177" y="428" width="68" height="33" rx="2" className="pid-value-box" /><text x="211" y="450" className="pid-value" textAnchor="middle">{value("P-100", "speedPct")} %</text>
          {gauge(180, 455, 62, pumpSpeed / 100)}
          {agentBeacon("P-100")}
        </g>

        <g {...interactive("TV-101")}>
          <title>{`TV-101 steam valve · ${value("TV-101", "positionPct")}% open`}</title>
          {agentHalo("TV-101")}
          <rect x="289" y="10" width="116" height="117" rx="6" className="pid-selection-fill" />
          <text x="308" y="23" className="pid-tag">TV-101</text>{tagUnderline("TV-101")}<text x="308" y="46" className="pid-label">Steam valve</text>
          <rect x="307" y="53" width="68" height="31" rx="2" className="pid-value-box" /><text x="341" y="73" className="pid-value" textAnchor="middle">{value("TV-101", "positionPct")} %</text>
          {gauge(310, 78, 62, steamPosition)}
          <path d="M321 85 V115 L360 85 V115 Z" className="pid-equip-body" strokeWidth="2" />
          <path d="M321 85 V115 L360 85 V115 Z" className="pid-valve-open pid-valve-open-steam" opacity={(.12 + steamPosition * .7).toFixed(3)} />
          {agentBeacon("TV-101")}
        </g>

        <g className={`pid-instrument ${moving ? "pid-signal-active" : ""}`} fill="none" strokeWidth="1.4">
          <path d="M735 59 V43 H378" strokeDasharray="5 4" markerEnd={`url(#${uid}-control-arrow)`} />
          <path d="M735 116 V270 H600" strokeDasharray="5 4" />
          <path d="M660 430 V316 H704 M761 316 H774 V407" strokeDasharray="5 4" markerEnd={`url(#${uid}-control-arrow)`} />
          <circle className="pid-instrument-bubble" cx="735" cy="89" r="27" />
          <circle className="pid-instrument-bubble" cx="735" cy="316" r="27" />
        </g>
        {moving && <g className="pid-motion pid-signal-pulses" aria-hidden="true" pointerEvents="none">
          {SIGNALS.map((signal) => <circle key={signal.key} r="3.2" opacity="0">
            <animateMotion dur="6.4s" begin={`${signal.begin}s`} repeatCount="indefinite" keyPoints="0;1;1" keyTimes="0;.3;1" calcMode="linear"><mpath href={`#${uid}-signal-${signal.key}`} /></animateMotion>
            <animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;.03;.27;.3;1" dur="6.4s" begin={`${signal.begin}s`} repeatCount="indefinite" />
          </circle>)}
        </g>}
        <g className="pid-instrument-text"><text x="735" y="85" textAnchor="middle">TIC</text><text x="735" y="101" textAnchor="middle">101</text><text x="735" y="312" textAnchor="middle">LIC</text><text x="735" y="328" textAnchor="middle">101</text></g>

        <g {...interactive("LV-101")}>
          <title>{`LV-101 outlet valve · ${value("LV-101", "positionPct")}% open`}</title>
          {agentHalo("LV-101")}
          <rect x="737" y="397" width="100" height="120" rx="6" className="pid-selection-fill" />
          <path className="pid-valve pid-equip-body" d="M752 414 V446 L793 414 V446 Z" strokeWidth={selected === "LV-101" ? "2.9" : "2"} />
          <path className="pid-valve-open pid-valve-open-water" d="M752 414 V446 L793 414 V446 Z" opacity={(.12 + outletPosition * .7).toFixed(3)} />
          <path className="pid-valve-stem" d={`M772.5 414 V${(404 - lvTravel).toFixed(1)} M765 ${(404 - lvTravel).toFixed(1)} H780`} fill="none" strokeWidth="1.8" />
          <text x="742" y="471" className="pid-tag">LV-101</text>{tagUnderline("LV-101")}<text x="742" y="494" className="pid-label">Outlet valve</text>
          <rect x="742" y="499" width="68" height="32" rx="2" className="pid-value-box" /><text x="776" y="520" className="pid-value" textAnchor="middle">{value("LV-101", "positionPct")} %</text>
          {gauge(745, 525, 62, outletPosition)}
          {agentBeacon("LV-101")}
        </g>

        {forecast && <g className="pid-forecast">
          <path d="M810 377 L802 397 L836 377" />
          <rect x="817" y="292" width="174" height="88" rx="4" />
          <text x="830" y="315" className="pid-small pid-muted">Proposal forecast</text><text x="830" y="339" className="pid-small">{forecast.predicted}% predicted /</text><text x="830" y="361" className="pid-small">{forecast.threshold}% safety threshold.</text>
        </g>}
        <g className="pid-agent-badges">
          {([{ tag: "P-100", x: 165, y: 480 }, { tag: "TK-101", x: 420, y: 539 }, { tag: "E-101", x: 810, y: 116 }, { tag: "TV-101", x: 423, y: 30 }, { tag: "LV-101", x: 814, y: 540 }] as const).map(({ tag, x, y }) => {
            const activity = activityFor(tag);
            if (!activity) return null;
            const isSelected = selected === tag;
            const height = isSelected ? 57 : 41;
            return <g key={tag} transform={`translate(${x} ${y})`} role="button" tabIndex={0} aria-label={`${activity.equipmentName}, ${activity.vendor}, ${activity.role}, ${activity.state}`} onClick={() => onSelect(tag)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(tag); } }} className={`pid-agent-badge agent-${activity.state} ${isSelected ? "is-selected" : ""} ${highlighted === tag ? "is-highlighted" : ""}`} style={agentColorStyle(activity.plantId, tag)}>
              <title>{`${activity.equipmentName} · ${activity.vendor} · ${activity.role} · ${activity.state}: ${activity.task}`}</title>
              <rect width="218" height={height} rx="4" /><rect className="pid-agent-bar" width="3.5" height={height} rx="1.5" />
              <circle cx="14" cy="12" r="5.5" className="pid-agent-indicator-ring pid-anim" /><circle cx="14" cy="12" r="3" className={`pid-agent-indicator state-${activity.state}`} />
              <text x="24" y="17" className="pid-agent-tag">{tag}<tspan dx="7" className={`pid-agent-state state-${activity.state}`}>{activity.state}</tspan></text>
              <text x="11" y="31" className="pid-agent-role">{activity.vendor} · {activity.role.replaceAll("_", " ")}</text>
              {isSelected && <text x="11" y="47" className="pid-agent-name">{activity.equipmentName}</text>}
            </g>;
          })}
        </g>
      </svg>
      <div className="pid-flow-legend"><span className="pid-legend-swatch is-water" /> LIQUID <span className="pid-legend-swatch is-steam" /> STEAM <span className="pid-legend-swatch is-condensate" /> CONDENSATE <span className="pid-legend-swatch is-signal" /> SIGNAL <button type="button" onClick={() => setFlowPaused((paused) => !paused)} disabled={reducedMotion} aria-label={moving ? "Pause flow animation" : "Play flow animation"} aria-pressed={!moving}>{moving ? <Pause size={11} /> : <Play size={11} />}{reducedMotion ? "Reduced motion · paused" : moving ? "Flow animation" : "Flow paused"}</button></div>
      <div className="plant-view-caption"><span className="plant-caption-dot" /> Piping &amp; instrumentation <span>SELECT EQUIPMENT TO INSPECT</span></div>
      <div className="scene-controls" role="group" aria-label="Schematic zoom controls"><button aria-label="Zoom schematic in" title="Zoom into selected equipment" disabled={zoom >= 3} onClick={() => setZoom((value) => Math.min(3, value + .5))}><Plus size={16} /></button><button aria-label="Zoom schematic out" title="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value - .5))}><Minus size={16} /></button><button aria-label="Fit schematic to view" title="Show whole diagram" onClick={() => setZoom(1)}><ArrowsOutSimple size={16} /></button></div>
    </div>
  );
}

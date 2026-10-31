"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { metricLevel, tagOf, TAGS, type Caption, type Outline } from "@/lib/derive";
import { ageText, formatMetric, metricLabel, seconds } from "@/lib/format";
import { enforceMinimumText, loadDrawing, measureTags, PID_URL, type Box, type Drawing } from "@/lib/pid";
import type { ComponentView, PlantId } from "@/lib/types";
import { TONE_TEXT, type Tone } from "./ui";

const LEVEL_TONE: Record<string, Tone> = { warning: "warn", critical: "bad" };

/**
 * What each plate shows and where it sits. `dx` and `dy` are drawing units from the slot the drawing reserves for the tag,
 * `transform` says which edge of the plate is on that point, so a redrawn P&ID moves the plates with it.
 */
type Plate = { key: string; tag: string; metrics: string[]; dx: number; dy: number; transform: string };

const PLATES: Plate[] = [
  { key: "P-100", tag: "P-100", metrics: ["speedPct", "feedM3h"], dx: 0, dy: 0, transform: "translate(-50%, -50%)" },
  { key: "TK-101", tag: "TK-101", metrics: ["levelPct", "tempC"], dx: 0, dy: 0, transform: "translate(-50%, -50%)" },
  { key: "E-101", tag: "E-101", metrics: ["dutyKw"], dx: 0, dy: 0, transform: "translate(-50%, -50%)" },
  { key: "LV-101", tag: "LV-101", metrics: ["positionPct"], dx: 0, dy: 0, transform: "translate(-50%, -50%)" },
  { key: "TV-101", tag: "TV-101", metrics: ["positionPct", "steamKgH"], dx: 0, dy: 0, transform: "translate(-50%, -50%)" },
];

/** The shared header has no group of its own. Its pressure is read from TV-101 and sits on the header line. */
const HEADER_PLATE = { x: 2200, y: 200, transform: "translate(-100%, -50%)" };

const OUTLINE_PAD = 16;
const CHIP_BELOW = new Set(["TV-101"]);

const VOTE_CHIP: Record<string, string> = {
  voting: "border-vote text-ink bg-lift",
  yes: "border-ok text-ok bg-panel",
  no: "border-bad text-bad bg-panel",
  "no vote": "border-rule text-ink-2 bg-lift",
  proposer: "border-ice text-ice bg-panel",
};

const percent = (value: number, total: number) => `${(value / total) * 100}%`;

function Reading({ component, metric }: { component: ComponentView | undefined; metric: string }) {
  const value = component?.metrics[metric];
  const limit = component?.limits[metric];
  const level = value !== undefined && limit !== undefined ? metricLevel(value, limit) : "ok";
  return (
    <div className="flex items-baseline justify-between gap-3 whitespace-nowrap leading-[24px]">
      <span className="text-ink-2">{metricLabel(metric)}</span>
      <span className={`num font-medium ${level === "ok" ? "text-ink" : TONE_TEXT[LEVEL_TONE[level] ?? "off"]}`}>
        {value === undefined ? "--" : formatMetric(metric, value)}
        {level === "ok" ? null : ` ${level}`}
      </span>
    </div>
  );
}

export function CaptionBand({ caption, now }: { caption: Caption; now: number }) {
  const voter = tagOf(caption.vote.componentId);
  return (
    <div key={caption.proposal.id} className="caption-in absolute bottom-3 left-3 z-20 w-[640px] border-l-[6px] border-ice bg-panel/95 py-2 pl-5 pr-4 shadow-[0_0_0_1px_var(--color-rule)]">
      <div className="text-[52px] font-bold leading-[58px] tracking-tight text-ink">{caption.text}</div>
      {caption.kind === "it-learned" ? (
        <div className="text-lg text-ink-2">
          {voter} cited the run from {ageText(Date.parse(caption.event.at), now)} as evidence {caption.evidenceNumber}, its latest observation, not proof.
          {caption.blockedInMs === null ? null : ` Blocked in ${seconds(caption.blockedInMs)}.`}
          {caption.firstBlockedInMs === null ? null : ` First block took ${seconds(caption.firstBlockedInMs)}.`}
        </div>
      ) : (
        <div className="text-lg text-ink-2">
          {voter} refused on a company rule first learned in <span className="num">{caption.source}</span>, seen {caption.rule.timesSeen} times.
        </div>
      )}
    </div>
  );
}

/** The live level, drawn inside the vessel's own outline. */
function LevelFill({ box, levelPct }: { box: Box; levelPct: number | undefined }) {
  if (levelPct === undefined) return null;
  const inset = 4;
  const top = box.y + box.height * (1 - Math.max(0, Math.min(100, levelPct)) / 100);
  const bottom = box.y + box.height - inset;
  return (
    <g>
      <clipPath id="pid-vessel">
        <rect x={box.x + inset} y={box.y + inset} width={box.width - inset * 2} height={box.height - inset * 2} rx={38} />
      </clipPath>
      <rect x={box.x} y={top} width={box.width} height={Math.max(0, bottom - top + inset)} clipPath="url(#pid-vessel)" fill="rgb(90 169 230 / 0.17)" />
      <line x1={box.x + inset} x2={box.x + box.width - inset} y1={top} y2={top} stroke="#5aa9e6" strokeWidth={3} />
    </g>
  );
}

export function PidStage({
  plantId,
  components,
  outlines,
  proposer,
  selected,
  onSelect,
  caption,
  now,
}: {
  plantId: PlantId;
  components: Record<string, ComponentView>;
  outlines: Map<string, Outline>;
  proposer: string | null;
  selected: string;
  onSelect: (componentId: string) => void;
  caption: Caption | null;
  now: number;
}) {
  const [drawing, setDrawing] = useState<Drawing | "missing" | "pending">("pending");
  const [problem, setProblem] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<Record<string, Box> | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = () => {
      loadDrawing()
        .then((result) => {
          if (cancelled) return;
          if (result === null) {
            setDrawing("missing");
            timer = setTimeout(attempt, 3000);
          } else {
            setProblem(null);
            setDrawing(result);
          }
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setProblem(error instanceof Error ? error.message : String(error));
          setDrawing("missing");
          timer = setTimeout(attempt, 3000);
        });
    };
    attempt();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  const loaded = typeof drawing === "object" ? drawing : null;
  const markup = useMemo(() => (loaded === null ? undefined : { __html: loaded.markup }), [loaded]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null || loaded === null) return;
    enforceMinimumText(host, loaded.width);
    setBoxes(measureTags(host));
  }, [loaded]);

  // The drawing's own groups select components too.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const onClick = (event: MouseEvent) => {
      const group = (event.target as Element).closest?.("g[data-tag]");
      const tag = group?.getAttribute("data-tag");
      if (tag) onSelect(`${plantId}/${tag}`);
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
  }, [plantId, onSelect, loaded]);

  if (loaded === null) {
    return (
      <div className="pid-field relative flex h-full flex-col items-center justify-center gap-3 text-center">
        {drawing === "pending" ? (
          <div className="text-xl text-ink-2">Loading the P&amp;ID drawing</div>
        ) : (
          <>
            <div className="text-2xl font-semibold">P&amp;ID drawing not available</div>
            <div className="num text-ink-2">{PID_URL}</div>
            <div className="max-w-[640px] text-ink-3">{problem ?? "The file has not been delivered yet. Checking again every 3 seconds. All other panels are live."}</div>
          </>
        )}
        {caption ? <CaptionBand caption={caption} now={now} /> : null}
      </div>
    );
  }

  const { width, height, anchors } = loaded;
  const valve = components[`${plantId}/TV-101`];
  const tank = boxes?.["TK-101"];

  return (
    <div className="pid-field relative flex h-full items-center justify-center overflow-hidden [container-type:size]">
      <div className="relative shrink-0" style={{ width: `min(100cqw, calc(100cqh * ${width / height}))`, aspectRatio: `${width} / ${height}` }}>
        <div ref={hostRef} className="pid-host" dangerouslySetInnerHTML={markup} />

        {boxes ? (
          <>
            <svg viewBox={`0 0 ${width} ${height}`} className="pointer-events-none absolute inset-0 size-full" aria-hidden>
              {tank ? <LevelFill box={tank} levelPct={components[`${plantId}/TK-101`]?.metrics.levelPct} /> : null}
              {TAGS.map((tag) => {
                const box = boxes[tag];
                if (box === undefined) return null;
                const outline = outlines.get(tag);
                const isProposer = proposer === tag;
                const isSelected = selected === `${plantId}/${tag}`;
                if (outline === undefined && !isProposer && !isSelected) return null;
                const pad = outline || isProposer ? OUTLINE_PAD : 10;
                const state = outline ? `is-${outline.state === "no vote" ? "idle" : outline.state}` : isProposer ? "is-proposer" : "is-selected";
                return <rect key={tag} x={box.x - pad} y={box.y - pad} width={box.width + pad * 2} height={box.height + pad * 2} rx={14} className={`voter-outline ${state} ${outline?.pulsing ? "pulsing" : ""}`} />;
              })}
            </svg>

            {PLATES.map((plate) => {
              const box = boxes[plate.tag];
              const anchor = anchors[plate.tag] ?? (box ? { x: box.x + box.width / 2, y: box.y + box.height + 40 } : null);
              if (anchor === null) return null;
              const id = `${plantId}/${plate.tag}`;
              return (
                <button
                  key={plate.key}
                  onClick={() => onSelect(id)}
                  aria-label={`Select ${plate.tag}`}
                  style={{ left: percent(anchor.x + plate.dx, width), top: percent(anchor.y + plate.dy, height), transform: plate.transform }}
                  className={`absolute z-10 min-w-[150px] border bg-panel/95 px-2 py-[2px] text-left ${selected === id ? "border-ice" : "border-rule hover:border-ink-3"}`}
                >
                  {plate.metrics.map((metric) => (
                    <Reading key={metric} component={components[id]} metric={metric} />
                  ))}
                </button>
              );
            })}

            <button
              onClick={() => onSelect(`${plantId}/TV-101`)}
              aria-label="Select TV-101, steam header pressure"
              style={{ left: percent(HEADER_PLATE.x, width), top: percent(HEADER_PLATE.y, height), transform: HEADER_PLATE.transform }}
              className="absolute z-10 min-w-[170px] border border-rule bg-panel/95 px-2 py-[2px] text-left hover:border-ink-3"
            >
              <Reading component={valve} metric="headerBarg" />
            </button>

            {TAGS.map((tag) => {
              const box = boxes[tag];
              if (box === undefined) return null;
              const outline = outlines.get(tag);
              const word = outline?.state ?? (proposer === tag ? "proposer" : null);
              if (word === null) return null;
              const below = CHIP_BELOW.has(tag);
              return (
                <div
                  key={tag}
                  style={{ left: percent(box.x - OUTLINE_PAD, width), top: percent(below ? box.y + box.height + OUTLINE_PAD : box.y - OUTLINE_PAD, height) }}
                  className={`absolute z-10 whitespace-nowrap border-2 px-2 font-bold uppercase tracking-wider ${below ? "" : "-translate-y-full"} ${VOTE_CHIP[word] ?? ""}`}
                >
                  {word}
                  {outline && outline.fromPlant !== plantId ? <span className="ml-2 font-medium normal-case tracking-normal">for {outline.fromPlant}</span> : null}
                </div>
              );
            })}
          </>
        ) : null}
      </div>
      {caption ? <CaptionBand caption={caption} now={now} /> : null}
    </div>
  );
}

import { simStatus } from "@/lib/derive";
import type { Snapshot } from "@/lib/store";
import type { PlantId, View } from "@/lib/types";
import { ageText } from "@/lib/format";
import { Word, type Tone } from "./ui";

/** A valve bow-tie between two relay ticks: the only mark the product needs. */
function Mark() {
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden className="shrink-0">
      <path d="M4 7 L17 17 L4 27 Z M30 7 L17 17 L30 27 Z" fill="none" stroke="var(--color-ice)" strokeWidth="2.4" strokeLinejoin="round" />
      <circle cx="17" cy="17" r="3.4" fill="var(--color-ice)" />
    </svg>
  );
}

const VIEWS: View[] = ["plant-a", "plant-b", "company"];

function connWord(glue: Snapshot, now: number): { word: string; tone: Tone } {
  if (glue.conn === "live") return { word: "glue live", tone: "ok" };
  if (glue.conn === "reconnecting") {
    return { word: `reconnecting, data ${glue.lastOkAt === null ? "none" : ageText(glue.lastOkAt, now)}`, tone: "warn" };
  }
  if (glue.conn === "connecting") return { word: "connecting", tone: "off" };
  return { word: "DISCONNECTED", tone: "warn" };
}

export function TopBar({ glue, view, onView, now }: { glue: Snapshot; view: View; onView: (view: View) => void; now: number }) {
  const focus: PlantId = view === "company" ? "plant-a" : view;
  const plant = glue.plants[focus];
  const sim = simStatus(plant, glue.tickAdvancedAt[focus], now);
  const conn = connWord(glue, now);
  const live = glue.conn === "live" || glue.conn === "reconnecting";

  return (
    <header className="relative z-20 flex h-[64px] shrink-0 items-center gap-8 border-b border-rule bg-panel px-5">
      <div className="flex min-w-[420px] items-center gap-3">
        <Mark />
        <h1 className="m-0 whitespace-nowrap text-2xl font-semibold tracking-tight">
          ActorRelay <span className="font-normal text-ink-2">· simulated plant</span>
        </h1>
      </div>

      <nav aria-label="Plant switcher" className="flex border border-rule">
        {VIEWS.map((item) => {
          const active = item === view;
          return (
            <button
              key={item}
              aria-pressed={active}
              onClick={() => onView(item)}
              className={`num h-[42px] min-w-[132px] px-4 text-lg ${active ? "bg-ice font-semibold text-ground" : "text-ink-2 hover:bg-raised hover:text-ink"}`}
            >
              {item}
            </button>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-8">
        {glue.meta?.mode && glue.meta.mode !== "live" ? <Word tone="warn">glue mode {glue.meta.mode}</Word> : null}
        <div className="flex items-baseline gap-2" title="Plant actor tick">
          <span className="plate">tick</span>
          <span className="num min-w-[86px] text-xl font-medium">{live && plant ? plant.tick.toLocaleString("en-US") : "--"}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="plate">sim</span>
          {live ? <Word tone={sim.tone}>{sim.word}</Word> : <Word tone="off">unknown</Word>}
        </div>
        <Word tone={conn.tone}>{conn.word}</Word>
      </div>
    </header>
  );
}

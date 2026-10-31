import { clockTime } from "@/lib/format";
import type { AuditEntry } from "@/lib/types";
import { Plate, TONE_TEXT, type Tone } from "./ui";

function describe(entry: AuditEntry): { word: string; tone: Tone } {
  switch (entry.kind) {
    case "proposal":
      return { word: "proposal", tone: "off" };
    case "vote": {
      const voted = / voted (yes|no)\b/.exec(entry.summary)?.[1];
      if (voted === "yes") return { word: "vote yes", tone: "ok" };
      if (voted === "no") return { word: "vote no", tone: "bad" };
      return { word: "vote", tone: "off" };
    }
    case "block":
      return { word: "blocked", tone: "bad" };
    case "veto":
      return { word: "vetoed", tone: "bad" };
    case "execute":
      return { word: "executed", tone: "ok" };
    case "incident":
      return { word: "incident", tone: "warn" };
    case "rule_learned":
      return { word: "rule learned", tone: "ice" };
    case "calibration":
      return { word: "calibration", tone: "off" };
  }
}

/** Actors write raw floats into summaries. Only the display is rounded. */
function tidy(summary: string): string {
  return summary.replace(/\d+\.\d{3,}/g, (value) => Number(value).toFixed(2));
}

type Row = AuditEntry & { more: number };

/** One execution writes a calibration per voter per metric. They share a row so a burst does not push the outcome off screen. */
function collapse(entries: AuditEntry[]): Row[] {
  const rows: Row[] = [];
  for (const entry of entries) {
    const last = rows[rows.length - 1];
    if (last !== undefined && entry.kind === "calibration" && last.kind === "calibration" && last.refId === entry.refId && last.plantId === entry.plantId) {
      const headline = entry.summary.includes("LV-101 positionPct");
      rows[rows.length - 1] = { ...(headline ? entry : last), more: last.more + 1 };
    } else {
      rows.push({ ...entry, more: 0 });
    }
  }
  return rows;
}

export function EventsFeed({ entries }: { entries: AuditEntry[] }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Plate right={<span className="text-ink-3">newest first</span>}>Events</Plate>
      {entries.length === 0 ? (
        <div className="px-4 py-3 text-ink-3">Nothing recorded in this session yet.</div>
      ) : (
        <ol className="scroll m-0 min-h-0 flex-1 list-none p-0">
          {collapse(entries).slice(0, 60).map((entry) => {
            const { word, tone } = describe(entry);
            return (
              <li key={`${entry.at}|${entry.kind}|${entry.refId}|${entry.summary}`} className="flex items-baseline gap-3 border-b border-hairline px-4 py-[3px]" title={entry.summary}>
                <span className="num shrink-0 text-ink-3">{clockTime(entry.at)}</span>
                <span className="num w-[76px] shrink-0 text-ink-2">{entry.plantId}</span>
                <span className={`w-[108px] shrink-0 font-medium ${TONE_TEXT[tone]}`}>{word}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2">{tidy(entry.summary)}</span>
                {entry.more > 0 ? <span className="shrink-0 text-ink-3">+{entry.more} more</span> : null}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

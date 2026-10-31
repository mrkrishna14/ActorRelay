import type { ReactNode } from "react";
import type { ComponentView, Proposal } from "@/lib/types";

/** Every colour on screen comes through a tone, and every tone is rendered next to its word. */
export type Tone = "ok" | "warn" | "bad" | "ice" | "off";

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  ice: "text-ice",
  off: "text-ink-3",
};

const TONE_DOT: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  ice: "bg-ice",
  off: "bg-ink-3",
};

const TONE_STAMP: Record<Tone, string> = {
  ok: "stamp-ok",
  warn: "stamp-warn",
  bad: "stamp-bad",
  ice: "stamp-ice",
  off: "stamp-off",
};

export const statusTone = (status: ComponentView["status"]): Tone =>
  status === "ok" ? "ok" : status === "warning" ? "warn" : status === "critical" ? "bad" : "off";

export const PROPOSAL_TONE: Record<Proposal["status"], Tone> = {
  voting: "warn",
  veto_window: "warn",
  blocked: "bad",
  vetoed: "bad",
  executed: "ok",
  expired: "off",
};

export const PROPOSAL_WORD: Record<Proposal["status"], string> = {
  voting: "voting",
  veto_window: "veto window",
  blocked: "blocked",
  vetoed: "vetoed",
  executed: "executed",
  expired: "expired",
};

export function Stamp({ tone, children, className = "" }: { tone: Tone; children: ReactNode; className?: string }) {
  return <span className={`stamp ${TONE_STAMP[tone]} ${className}`}>{children}</span>;
}

export function Word({ tone, children, dot = true }: { tone: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2 whitespace-nowrap font-medium ${TONE_TEXT[tone]}`}>
      {dot ? <i aria-hidden className={`inline-block size-[10px] shrink-0 ${TONE_DOT[tone]}`} /> : null}
      {children}
    </span>
  );
}

export function Plate({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex h-[38px] shrink-0 items-center justify-between gap-4 border-b border-hairline px-4">
      <span className="plate truncate">{children}</span>
      {right}
    </div>
  );
}

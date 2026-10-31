"use client";

import { useEffect, useRef, useState } from "react";
import {
  blockedInMs,
  findEvent,
  findRule,
  isSessionEvent,
  latestThread,
  plantOf,
  refusalThreshold,
  tagOf,
  voteOf,
  voterState,
  type Plants,
  type ProposalNode,
} from "@/lib/derive";
import { ageText, formatMetric, formatNumber, formatTarget, metricLabel, seconds, shortDate } from "@/lib/format";
import { GlueError, veto } from "@/lib/glue";
import { glueStore } from "@/lib/store";
import type { CompanyState, ComponentView, PlantState, Proposal, Vote } from "@/lib/types";
import { Plate, PROPOSAL_TONE, PROPOSAL_WORD, Stamp, Word, type Tone } from "./ui";

export type EvidenceRef = { type: "event" | "rule"; id: string };

const VOTE_TONE: Record<string, Tone> = { yes: "ok", no: "bad", voting: "warn", "no vote": "off" };
const VETO_MS = 10_000;

/** The deadline comes from the actor's clock. If the two clocks disagree, count ten seconds from first sight instead of showing nonsense. */
function useVetoRemaining(proposal: Proposal): number {
  const deadline = useRef<{ id: string; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  if (deadline.current?.id !== proposal.id) {
    const stated = proposal.vetoDeadline === null ? Number.NaN : Date.parse(proposal.vetoDeadline);
    const remaining = stated - Date.now();
    const believable = remaining <= VETO_MS + 1000 && remaining >= -3000;
    deadline.current = { id: proposal.id, at: believable ? stated : Date.now() + VETO_MS };
  }
  return Math.max(0, deadline.current.at - now);
}

function VetoBar({ proposal }: { proposal: Proposal }) {
  const remaining = useVetoRemaining(proposal);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  async function onVeto() {
    setBusy(true);
    setRefused(null);
    try {
      await veto(proposal.id, "operator");
    } catch (error) {
      setRefused(error instanceof GlueError ? `Glue refused (${error.status}): ${error.message}` : String(error));
    } finally {
      setBusy(false);
      glueStore.refresh();
    }
  }

  return (
    <div className="border-y border-warn bg-[var(--tint-warn)] px-3 py-2">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-warn">Unanimous yes. Veto window open.</div>
          <div className="num text-3xl font-semibold text-ink">{remaining > 0 ? seconds(remaining) : "executing"}</div>
        </div>
        <button disabled={busy} onClick={() => void onVeto()} className="h-[56px] w-[150px] border-2 border-bad bg-[var(--tint-bad)] text-xl font-bold uppercase tracking-wider text-bad hover:bg-bad hover:text-ground disabled:opacity-60">
          Veto
        </button>
      </div>
      <div className="mt-2 h-[8px] bg-lift">
        <div className="h-full bg-warn" style={{ width: `${Math.min(100, (remaining / VETO_MS) * 100)}%` }} />
      </div>
      {refused ? <Word tone="warn">{refused}</Word> : null}
    </div>
  );
}

function headlinePrediction(vote: Vote, component: ComponentView | undefined): { metric: string; value: number } | null {
  const entries = Object.entries(vote.predicted);
  if (entries.length === 0) return null;
  const limits = component?.limits ?? {};
  const ranked = [...entries].sort(([a, x], [b, y]) => {
    const limitA = limits[a];
    const limitB = limits[b];
    return (limitB ? y / limitB.critical : -1) - (limitA ? x / limitA.critical : -1);
  });
  const top = ranked[0];
  return top === undefined ? null : { metric: top[0], value: top[1] };
}

function Evidence({
  vote,
  plants,
  company,
  now,
  compact,
  onEvidence,
}: {
  vote: Vote;
  plants: Plants;
  company: CompanyState | null;
  now: number;
  compact: boolean;
  onEvidence: (ref: EvidenceRef) => void;
}) {
  const rules = vote.evidenceRuleIds.map((id) => {
    const rule = findRule(plants, company, id);
    return (
      <button key={id} onClick={() => onEvidence({ type: "rule", id })} className="chip">
        {rule?.scope === "company" ? "company rule" : "rule"}
        {rule ? <span className="num text-ink-3">seen {rule.timesSeen}</span> : null}
      </button>
    );
  });
  return (
    <div className={`mt-1 flex flex-wrap gap-[6px] ${compact ? "max-h-[64px] overflow-hidden" : ""}`}>
      {compact ? rules : null}
      {vote.evidenceEventIds.map((id, index) => {
        const event = findEvent(plants, id);
        const session = event !== undefined && isSessionEvent(plants, event);
        const label =
          event === undefined
            ? `run ${id.slice(-8)}`
            : session
              ? `this session, ${ageText(Date.parse(event.at), now)}`
              : `${shortDate(event.at)} → ${formatTarget(event.metric, event.after)}`;
        return (
          <button key={id} onClick={() => onEvidence({ type: "event", id })} className={`chip ${session ? "chip-session" : ""}`}>
            <span className="num text-ink-3">{index + 1}</span>
            {label}
            {event?.incident ? <span className="font-semibold text-warn">incident</span> : null}
          </button>
        );
      })}
      {compact ? null : rules}
      {vote.evidenceEventIds.length === 0 && vote.evidenceRuleIds.length === 0 ? <span className="text-ink-3">Cited no evidence, {vote.similarCount} similar runs found.</span> : null}
    </div>
  );
}

function VoterRow({
  proposal,
  voterId,
  compact,
  components,
  plants,
  company,
  now,
  onEvidence,
  onSelect,
}: {
  proposal: Proposal;
  voterId: string;
  compact: boolean;
  components: Record<string, ComponentView>;
  plants: Plants;
  company: CompanyState | null;
  now: number;
  onEvidence: (ref: EvidenceRef) => void;
  onSelect: (id: string) => void;
}) {
  const state = voterState(proposal, voterId);
  const vote = voteOf(proposal, voterId);
  const component = components[voterId];
  const headline = vote ? headlinePrediction(vote, component) : null;
  const limit = headline ? component?.limits[headline.metric] : undefined;
  const foreign = plantOf(voterId) !== proposal.plantId;
  const [open, setOpen] = useState(false);
  const expanded = open || state === "no";

  return (
    <li className="border-b border-hairline py-[6px]">
      <div className="flex items-baseline gap-3">
        <span className={`w-[92px] shrink-0 font-bold uppercase tracking-wider ${state === "yes" ? "text-ok" : state === "no" ? "text-bad" : state === "voting" ? "text-warn" : "text-ink-3"}`}>{state}</span>
        <button onClick={() => onSelect(voterId)} className="num shrink-0 font-medium hover:text-ice">
          {tagOf(voterId)}
        </button>
        {foreign ? <span className="num shrink-0 text-ink-3">{plantOf(voterId)}</span> : null}
        <span className="min-w-0 flex-1 truncate text-right text-ink-3">
          {headline ? (
            <>
              predicted <span className="num text-ink">{formatMetric(headline.metric, headline.value)}</span>
              {limit && vote ? (
                <>
                  , limit <span className="num text-ink-2">{formatNumber(headline.metric, refusalThreshold(limit, vote.marginPct))}</span>
                </>
              ) : null}
            </>
          ) : state === "voting" ? (
            "reading its memory"
          ) : null}
        </span>
      </div>
      {vote ? (
        <div>
          <button onClick={() => setOpen(!open)} className={`block w-full text-left text-ink-2 hover:text-ink ${expanded ? (compact && !open ? "line-clamp-3" : "") : "truncate"}`}>
            {vote.reason}
          </button>
          {expanded ? <Evidence vote={vote} plants={plants} company={company} now={now} compact={compact && !open} onEvidence={onEvidence} /> : null}
        </div>
      ) : null}
    </li>
  );
}

function ProposalCard({
  node,
  depth,
  plant,
  components,
  plants,
  company,
  now,
  onEvidence,
  onSelect,
}: {
  node: ProposalNode;
  depth: number;
  plant: PlantState;
  components: Record<string, ComponentView>;
  plants: Plants;
  company: CompanyState | null;
  now: number;
  onEvidence: (ref: EvidenceRef) => void;
  onSelect: (id: string) => void;
}) {
  const { proposal, children } = node;
  const superseded = children.length > 0;
  const [reopened, setReopened] = useState(false);
  const collapsed = superseded && !reopened;
  const blockedIn = proposal.status === "blocked" ? blockedInMs(plant, proposal) : null;
  const voters = [...proposal.requiredVoters]
    .sort((a, b) => {
      const rank = (id: string) => ({ no: 0, yes: 1, voting: 2, "no vote": 3 })[voterState(proposal, id)];
      return rank(a) - rank(b);
    })
    .filter((id) => !collapsed || voterState(proposal, id) === "no");

  return (
    <section className={depth > 0 ? "ml-3 border-l-2 border-ice pl-3" : ""}>
      {depth > 0 ? <div className="plate pt-2 text-ice">Counter-proposal</div> : null}
      <button onClick={() => setReopened(!reopened)} disabled={!superseded} className="block w-full py-2 text-left">
        <div className="flex items-center gap-3">
          <Stamp tone={PROPOSAL_TONE[proposal.status]}>{PROPOSAL_WORD[proposal.status]}</Stamp>
          <span className="num min-w-0 flex-1 truncate text-xl font-semibold">
            {tagOf(proposal.proposerComponentId)} {metricLabel(proposal.metric).toLowerCase()} {proposal.from} → {formatTarget(proposal.metric, proposal.to)}
          </span>
          <span className="whitespace-nowrap text-ink-3">{blockedIn === null ? ageText(Date.parse(proposal.at), now) : `in ${seconds(blockedIn)}`}</span>
        </div>
        {collapsed ? null : (
          <div className="mt-1 text-ink-2">
            {proposal.rationale}
            {proposal.crossPlant ? <span className="text-ink-3"> Shared steam header: the other plant votes too.</span> : null}
          </div>
        )}
      </button>

      {proposal.status === "veto_window" ? <VetoBar proposal={proposal} /> : null}

      <ul className="m-0 list-none border-t border-hairline p-0">
        {voters.map((voterId) => (
          <VoterRow key={voterId} proposal={proposal} voterId={voterId} compact={collapsed} components={components} plants={plants} company={company} now={now} onEvidence={onEvidence} onSelect={onSelect} />
        ))}
      </ul>

      {children.map((child) => (
        <ProposalCard key={child.proposal.id} node={child} depth={depth + 1} plant={plant} components={components} plants={plants} company={company} now={now} onEvidence={onEvidence} onSelect={onSelect} />
      ))}
    </section>
  );
}

export function ProposalPanel({
  plant,
  components,
  plants,
  company,
  now,
  onEvidence,
  onSelect,
}: {
  plant: PlantState | undefined;
  components: Record<string, ComponentView>;
  plants: Plants;
  company: CompanyState | null;
  now: number;
  onEvidence: (ref: EvidenceRef) => void;
  onSelect: (id: string) => void;
}) {
  const thread = plant ? latestThread(plant) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-rule">
      <Plate right={thread ? <span className="text-ink-3">{plant?.proposals.length} this session</span> : null}>Proposal</Plate>
      <div className="scroll min-h-0 flex-1 px-4 pb-3">
        {thread === null || plant === undefined ? (
          <div className="py-4 text-ink-3">
            No proposals in this session. Every setpoint change starts here, and nothing moves until the connected components agree.
          </div>
        ) : (
          <ProposalCard key={thread.proposal.id} node={thread} depth={0} plant={plant} components={components} plants={plants} company={company} now={now} onEvidence={onEvidence} onSelect={onSelect} />
        )}
      </div>
    </div>
  );
}

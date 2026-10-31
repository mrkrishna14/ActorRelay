import { findEvent, findRule, isSessionEvent, ruleCitations, ruleSourcePlant, tagOf, type Plants } from "@/lib/derive";
import { ageText, clockTime, formatMetric, metricLabel, shortDate } from "@/lib/format";
import type { CompanyState, HistoryEvent, LearnedRule } from "@/lib/types";
import type { EvidenceRef } from "./ProposalPanel";
import { Plate, Stamp, Word } from "./ui";

function EventBody({ event, plants, now }: { event: HistoryEvent; plants: Plants; now: number }) {
  const session = isSessionEvent(plants, event);
  return (
    <>
      <div className="flex items-center gap-3">
        {session ? <Stamp tone="ice">this session</Stamp> : <Stamp tone="off">plant history</Stamp>}
        <span className="text-ink-2">{session ? `${clockTime(event.at)}, ${ageText(Date.parse(event.at), now)}` : shortDate(event.at)}</span>
      </div>
      <div className="num mt-3 text-xl font-semibold">
        {tagOf(event.componentId)} {formatMetric(event.metric, event.before)} → {formatMetric(event.metric, event.after)}
      </div>
      <div className="mt-1 text-ink-2">
        <span className="num">{event.plantId}</span>, {metricLabel(event.metric).toLowerCase()} change
        {event.operator ? `, operator ${event.operator}` : ""}
      </div>
      {event.incident ? (
        <div className="mt-3 border border-warn bg-[var(--tint-warn)] px-3 py-2">
          <Word tone="warn">incident</Word>
          <div>{event.incident}</div>
        </div>
      ) : (
        <div className="mt-3 text-ink-3">No incident recorded on this run.</div>
      )}
      <div className="plate mt-4">Observed effects</div>
      <table className="mt-1 w-full border-collapse">
        <thead>
          <tr className="text-left text-ink-3">
            <th className="font-normal">Component</th>
            <th className="text-right font-normal">Before</th>
            <th className="text-right font-normal">After</th>
            <th className="text-right font-normal">Ticks</th>
          </tr>
        </thead>
        <tbody>
          {event.effects.map((effect) => (
            <tr key={`${effect.componentId}|${effect.metric}`} className="border-t border-hairline">
              <td>
                <span className="num">{tagOf(effect.componentId)}</span> <span className="text-ink-3">{metricLabel(effect.metric).toLowerCase()}</span>
              </td>
              <td className="num text-right text-ink-2">{formatMetric(effect.metric, effect.before)}</td>
              <td className="num text-right">{formatMetric(effect.metric, effect.after)}</td>
              <td className="num text-right text-ink-2">{effect.ticksToSettle}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function RuleBody({ rule, plants, now }: { rule: LearnedRule; plants: Plants; now: number }) {
  const source = ruleSourcePlant(rule, plants);
  const citations = ruleCitations(rule, plants);
  return (
    <>
      <div className="flex items-center gap-3">
        <Stamp tone="ice">{rule.scope} rule</Stamp>
        <span className="num text-ink-2">seen {rule.timesSeen}</span>
      </div>
      <div className="mt-3 text-xl font-medium">{rule.text}</div>
      <div className="mt-3 text-ink-2">
        {source ? (
          <>
            First learned in <span className="num">{source}</span>.{" "}
          </>
        ) : null}
        Last seen {ageText(Date.parse(rule.lastSeenAt), now)}.
      </div>
      <div className="plate mt-4">Cited by</div>
      {citations.length === 0 ? <div className="text-ink-3">No vote has cited this rule in this session.</div> : null}
      {citations.map((citation) => (
        <div key={`${citation.proposalId}-${citation.componentId}`} className="flex justify-between border-t border-hairline py-1">
          <span className="num">{citation.componentId}</span>
          <Word tone={citation.vote === "yes" ? "ok" : "bad"}>voted {citation.vote}</Word>
        </div>
      ))}
      <div className="plate mt-4">Support</div>
      <div className="text-ink-2">{rule.supportEventIds.length} recorded runs back this rule.</div>
      <div className="mt-1 flex flex-col gap-1">
        {rule.supportEventIds.slice(0, 6).map((id) => {
          const event = findEvent(plants, id);
          return (
            <div key={id} className="flex justify-between gap-3 border-t border-hairline py-1">
              <span className="num truncate text-ink-2">{event ? `${shortDate(event.at)} ${event.plantId}` : id}</span>
              {event ? <span className="num">→ {formatMetric(event.metric, event.after)}</span> : null}
            </div>
          );
        })}
      </div>
    </>
  );
}

export function EvidenceDrawer({
  evidence,
  plants,
  company,
  now,
  onClose,
}: {
  evidence: EvidenceRef;
  plants: Plants;
  company: CompanyState | null;
  now: number;
  onClose: () => void;
}) {
  const event = evidence.type === "event" ? findEvent(plants, evidence.id) : undefined;
  const rule = evidence.type === "rule" ? findRule(plants, company, evidence.id) : undefined;
  return (
    <div className="absolute inset-0 z-30 flex flex-col border-l border-ice bg-panel">
      <Plate
        right={
          <button onClick={onClose} className="px-2 text-ink-2 hover:text-ink">
            Close
          </button>
        }
      >
        Evidence
      </Plate>
      <div className="scroll min-h-0 flex-1 p-4">
        {event ? <EventBody event={event} plants={plants} now={now} /> : null}
        {rule ? <RuleBody rule={rule} plants={plants} now={now} /> : null}
        {event === undefined && rule === undefined ? (
          <div className="text-ink-2">
            <div className="num break-all">{evidence.id}</div>
            <div className="mt-2 text-ink-3">The vote cites this id, but glue's trimmed /state does not include it.</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

import { crossPlantFeed, isOpen, otherPlant, outlinesFor, PLANT_IDS, plantHealth, PLANT_LABEL, tagOf, voterState, type Plants } from "@/lib/derive";
import { ageText, formatMetric, formatTarget, metricLabel } from "@/lib/format";
import type { CompanyState, ComponentView, PlantId, View } from "@/lib/types";
import { PROPOSAL_TONE, PROPOSAL_WORD, Plate, statusTone, Word, type Tone } from "./ui";

const VOTE_TONE: Record<string, Tone> = { yes: "ok", no: "bad", voting: "warn", "no vote": "off" };

function Row({
  level,
  active,
  onClick,
  children,
  right,
}: {
  level: 0 | 1 | 2;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active ?? false}
      style={{ paddingLeft: 16 + level * 18 }}
      className={`relative flex h-[34px] w-full items-center justify-between gap-2 pr-4 text-left ${
        active ? "bg-lift text-ink" : "text-ink-2 hover:bg-raised hover:text-ink"
      }`}
    >
      {active ? <i aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-ice" /> : null}
      <span className="flex min-w-0 items-center gap-2 truncate">{children}</span>
      {right}
    </button>
  );
}

export function EquipmentTree({
  plants,
  components,
  view,
  selected,
  onView,
  onSelect,
}: {
  plants: Plants;
  components: Record<string, ComponentView>;
  view: View;
  selected: string;
  onView: (view: View) => void;
  onSelect: (componentId: string) => void;
}) {
  return (
    <div className="shrink-0">
      <Plate>Equipment</Plate>
      <div className="py-1">
        <Row level={0} active={view === "company"} onClick={() => onView("company")}>
          <span className="font-semibold">Company</span>
        </Row>
        {PLANT_IDS.map((plantId) => {
          const plant = plants[plantId];
          const health = plantHealth(plantId, components);
          const outlines = outlinesFor(plantId, plants);
          return (
            <div key={plantId}>
              <Row
                level={1}
                active={view === plantId}
                onClick={() => onView(plantId)}
                right={health === null ? <Word tone="off">no data</Word> : <Word tone={statusTone(health)}>{health}</Word>}
              >
                <span className="num font-medium">{plantId}</span>
              </Row>
              {(plant?.components ?? []).map((id) => {
                const component = components[id];
                const outline = outlines.get(tagOf(id));
                return (
                  <Row
                    key={id}
                    level={2}
                    active={view === plantId && selected === id}
                    onClick={() => onSelect(id)}
                    right={
                      outline ? (
                        <Word tone={VOTE_TONE[outline.state] ?? "off"}>{outline.state === "yes" || outline.state === "no" ? `voted ${outline.state}` : outline.state}</Word>
                      ) : component ? (
                        <Word tone={statusTone(component.status)}>{component.status}</Word>
                      ) : (
                        <Word tone="off">no data</Word>
                      )
                    }
                  >
                    <span className="num">{tagOf(id)}</span>
                  </Row>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The other plant, always in view: status, what it is doing on the shared header, and the cross-plant feed. */
export function OtherPlantCard({
  view,
  plants,
  components,
  company,
  onView,
  now,
}: {
  view: PlantId;
  plants: Plants;
  components: Record<string, ComponentView>;
  company: CompanyState | null;
  onView: (view: View) => void;
  now: number;
}) {
  const other = otherPlant(view);
  const plant = plants[other];
  const health = plantHealth(other, components);
  const valve = components[`${other}/TV-101`];
  const crossVote = plants[view]?.proposals.find((proposal) => isOpen(proposal) && proposal.requiredVoters.includes(`${other}/TV-101`));
  const feed = crossPlantFeed(company, plants).slice(0, 2);

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-hairline">
      <Plate>{PLANT_LABEL[other]}</Plate>
      <div className="scroll flex min-h-0 flex-1 flex-col gap-2 px-4 py-2">
        <button onClick={() => onView(other)} className="flex items-center justify-between text-left hover:text-ice">
          <span className="num">{other}</span>
          {health === null ? <Word tone="off">no data</Word> : <Word tone={statusTone(health)}>{health}</Word>}
        </button>
        <div className="flex items-center justify-between text-ink-2">
          <span>{plant?.connected ? "connected" : "not connected"}</span>
          <span className="num">tick {plant?.tick.toLocaleString("en-US") ?? "--"}</span>
        </div>
        {valve ? (
          <div className="flex items-center justify-between">
            <span className="num text-ink-2">TV-101</span>
            <span className="num">{formatMetric("steamKgH", valve.metrics.steamKgH ?? 0)}</span>
          </div>
        ) : null}
        {crossVote ? (
          <div className="border border-warn bg-[var(--tint-warn)] px-2 py-1">
            <Word tone={VOTE_TONE[voterState(crossVote, `${other}/TV-101`)] ?? "off"}>TV-101 {voterState(crossVote, `${other}/TV-101`)}</Word>
            <div className="text-ink-2">shared steam header</div>
          </div>
        ) : null}
        <div className="plate mt-1">Cross-plant</div>
        {feed.length === 0 ? <div className="text-ink-3">No cross-plant proposals yet</div> : null}
        {feed.map((proposal) => (
          <div key={proposal.id} className="flex items-center justify-between gap-2">
            <span className="truncate">
              <span className="num">{proposal.plantId}</span> {metricLabel(proposal.metric).toLowerCase()} {formatTarget(proposal.metric, proposal.to)}
            </span>
            <span title={ageText(Date.parse(proposal.at), now)}>
              <Word tone={PROPOSAL_TONE[proposal.status]} dot={false}>
                {PROPOSAL_WORD[proposal.status]}
              </Word>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

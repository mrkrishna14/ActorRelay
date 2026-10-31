"use client";

import { useEffect, useRef } from "react";
import {
  byTime,
  crossPlantFeed,
  headerBarg,
  openCrossPlantProposals,
  PLANT_IDS,
  plantHealth,
  PLANT_LABEL,
  ruleCitations,
  ruleSourcePlant,
  tagOf,
  voteOf,
  type Plants,
} from "@/lib/derive";
import { ageText, formatMetric, formatTarget, metricLabel } from "@/lib/format";
import type { CompanyState, ComponentView, PlantId, Proposal, View } from "@/lib/types";
import { Plate, PROPOSAL_TONE, PROPOSAL_WORD, Stamp, statusTone, Word } from "./ui";

function Reading({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-ink-3">{label}</span>
      <span className="num font-medium">{value}</span>
    </div>
  );
}

function PlantCard({
  id,
  plants,
  components,
  onView,
  now,
}: {
  id: PlantId;
  plants: Plants;
  components: Record<string, ComponentView>;
  onView: (view: View) => void;
  now: number;
}) {
  const plant = plants[id];
  const health = plantHealth(id, components);
  const reading = (tag: string, metric: string) => {
    const value = components[`${id}/${tag}`]?.metrics[metric];
    return value === undefined ? "--" : formatMetric(metric, value);
  };
  const latest = plant ? byTime(plant.proposals).at(-1) : undefined;

  return (
    <button onClick={() => onView(id)} className="panel flex h-full flex-col border border-hairline p-4 text-left hover:border-rule">
      <div className="flex items-center justify-between">
        <span className="text-2xl font-semibold">{PLANT_LABEL[id]}</span>
        {health === null ? <Word tone="off">no data</Word> : <Word tone={statusTone(health)}>{health}</Word>}
      </div>
      <div className="mt-1 flex items-center justify-between text-ink-2">
        <span>{plant?.connected ? "connected" : "not connected"}</span>
        <span className="num">tick {plant?.tick.toLocaleString("en-US") ?? "--"}</span>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-[2px]">
        <Reading label="P-100 speed" value={reading("P-100", "speedPct")} />
        <Reading label="LV-101 position" value={reading("LV-101", "positionPct")} />
        <Reading label="TK-101 level" value={reading("TK-101", "levelPct")} />
        <Reading label="TK-101 temperature" value={reading("TK-101", "tempC")} />
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 pt-3">
        {latest ? (
          <>
            <span className="num truncate text-ink-2">
              {tagOf(latest.proposerComponentId)} {latest.from} → {formatTarget(latest.metric, latest.to)}
            </span>
            <Word tone={PROPOSAL_TONE[latest.status]}>{PROPOSAL_WORD[latest.status]}</Word>
          </>
        ) : (
          <span className="text-ink-3">No proposals in this session</span>
        )}
      </div>
      <span className="sr-only">{ageText(now, now)}</span>
    </button>
  );
}

function SteamHeader({
  company,
  plants,
  components,
}: {
  company: CompanyState | null;
  plants: Plants;
  components: Record<string, ComponentView>;
}) {
  const resource = company?.sharedResources[0];
  const pressure = resource ? headerBarg(components, resource.components) : null;
  const open = openCrossPlantProposals(plants);
  const voteOpen = open.length > 0;
  const stroke = voteOpen ? "var(--color-warn)" : "var(--color-ink-3)";
  const flow = (plantId: PlantId) => components[`${plantId}/TV-101`]?.metrics.steamKgH;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-2 text-center">
      <span className="num text-ink-2">{resource?.id ?? "steam-header-1"}</span>
      <div className="flex items-baseline gap-2">
        <span className="num text-3xl font-semibold">{pressure === null ? "--" : pressure.toFixed(2)}</span>
        <span className="text-lg text-ink-2">barg</span>
      </div>
      <svg width="100%" height="56" viewBox="0 0 380 56" aria-hidden>
        <line x1="0" y1="20" x2="380" y2="20" stroke={stroke} strokeWidth={voteOpen ? 8 : 6} />
        <line x1="72" y1="20" x2="72" y2="54" stroke={stroke} strokeWidth="4" />
        <line x1="308" y1="20" x2="308" y2="54" stroke={stroke} strokeWidth="4" />
        <path d="M60 34 L72 42 L60 50 Z M84 34 L72 42 L84 50 Z" fill="var(--color-panel)" stroke={stroke} strokeWidth="2" />
        <path d="M296 34 L308 42 L296 50 Z M320 34 L308 42 L320 50 Z" fill="var(--color-panel)" stroke={stroke} strokeWidth="2" />
      </svg>
      <div className="flex w-full justify-between">
        {PLANT_IDS.map((plantId) => {
          const value = flow(plantId);
          return (
            <span key={plantId} className="num text-ink-2">
              {value === undefined ? "--" : formatMetric("steamKgH", value)}
            </span>
          );
        })}
      </div>
      {voteOpen ? <Stamp tone="warn">cross-plant vote open</Stamp> : <span className="text-ink-3">No cross-plant vote open</span>}
    </div>
  );
}

function RuleLibrary({ company, plants }: { company: CompanyState | null; plants: Plants }) {
  // A rule that arrives while the page is open slides in. Rules already there on first read do not animate.
  const known = useRef<Set<string> | null>(null);
  const rules = company?.rules ?? [];
  const fresh = known.current === null ? new Set<string>() : new Set(rules.filter((rule) => !known.current?.has(rule.id)).map((rule) => rule.id));
  useEffect(() => {
    if (company !== null) known.current = new Set(company.rules.map((rule) => rule.id));
  }, [company]);

  const ordered = [...rules].sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));

  return (
    <div className="panel flex min-h-0 flex-col border-r border-hairline">
      <Plate right={<span className="text-ink-3">{rules.length} rules</span>}>Company rule library</Plate>
      {ordered.length === 0 ? <div className="p-4 text-ink-3">No rule has reached three sightings yet.</div> : null}
      <ul className="scroll m-0 min-h-0 flex-1 list-none p-0">
        {ordered.map((rule) => {
          const source = ruleSourcePlant(rule, plants);
          const citations = ruleCitations(rule, plants);
          const refusedIn = [...new Set(citations.filter((citation) => citation.vote === "no").map((citation) => citation.plantId))];
          return (
            <li key={rule.id} className={`border-b border-hairline px-4 py-2 ${fresh.has(rule.id) ? "rule-in" : ""}`}>
              <div className="flex items-start justify-between gap-4">
                <span className="min-w-0 text-lg">{rule.text}</span>
                <span className="num shrink-0 text-lg font-medium">seen {rule.timesSeen}</span>
              </div>
              <div className="mt-[2px] flex flex-wrap gap-x-6 text-ink-3">
                <span>{rule.model}</span>
                {source ? (
                  <span>
                    learned in <span className="num text-ink-2">{source}</span>
                  </span>
                ) : null}
                {refusedIn.length > 0 ? (
                  <span>
                    refused on it in <span className="num text-ice">{refusedIn.join(", ")}</span>
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CrossPlantRow({ proposal, now }: { proposal: Proposal; now: number }) {
  const foreign = proposal.requiredVoters.filter((id) => !id.startsWith(`${proposal.plantId}/`));
  return (
    <li className="border-b border-hairline px-4 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="num truncate font-medium">
          {proposal.plantId} {tagOf(proposal.proposerComponentId)} {proposal.from} → {formatTarget(proposal.metric, proposal.to)}
        </span>
        <Word tone={PROPOSAL_TONE[proposal.status]}>{PROPOSAL_WORD[proposal.status]}</Word>
      </div>
      <div className="mt-[2px] flex justify-between gap-3 text-ink-3">
        <span className="truncate">
          {metricLabel(proposal.metric)}, {foreign.map((id) => `${id} ${voteOf(proposal, id)?.vote ?? "no vote yet"}`).join(", ")}
        </span>
        <span className="shrink-0">{ageText(Date.parse(proposal.at), now)}</span>
      </div>
    </li>
  );
}

export function CompanyView({
  company,
  plants,
  components,
  onView,
  now,
}: {
  company: CompanyState | null;
  plants: Plants;
  components: Record<string, ComponentView>;
  onView: (view: View) => void;
  now: number;
}) {
  const feed = crossPlantFeed(company, plants);
  return (
    <div className="col-span-2 grid min-h-0 grid-rows-[300px_1fr] border-l border-hairline">
      <div className="grid min-h-0 grid-cols-[1fr_420px_1fr] gap-0 border-b border-rule p-4">
        <PlantCard id="plant-a" plants={plants} components={components} onView={onView} now={now} />
        <SteamHeader company={company} plants={plants} components={components} />
        <PlantCard id="plant-b" plants={plants} components={components} onView={onView} now={now} />
      </div>
      <div className="grid min-h-0 grid-cols-[3fr_2fr]">
        <RuleLibrary company={company} plants={plants} />
        <div className="panel flex min-h-0 flex-col">
          <Plate right={<span className="text-ink-3">{feed.length}</span>}>Cross-plant proposals</Plate>
          {feed.length === 0 ? <div className="p-4 text-ink-3">No proposal has reached across the shared header yet.</div> : null}
          <ul className="scroll m-0 min-h-0 flex-1 list-none p-0">
            {feed.map((proposal) => (
              <CrossPlantRow key={proposal.id} proposal={proposal} now={now} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

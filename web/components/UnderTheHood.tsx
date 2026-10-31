"use client";

import type { AuditEntry, CompanyState, ComponentView, PlantState } from "@/lib/types";
import { plainName } from "./StoryCard";

const MESSAGE_KINDS = new Set(["proposal", "vote", "execute", "block", "rule_learned", "calibration"]);

/** The systems doing the work: each durable actor's live state, and the agents' decisions as recorded in the audit trail. */
export function UnderTheHood({ plants, company, components, audit }: { plants: PlantState[]; company: CompanyState | null; components: ComponentView[]; audit: AuditEntry[] }) {
  const trail = audit.filter((entry) => MESSAGE_KINDS.has(entry.kind)).slice(0, 40);
  return (
    <div className="grid h-full min-h-0 grid-cols-2 gap-px bg-hairline text-lg">
      <section className="min-h-0 overflow-auto bg-panel p-5">
        <h2 className="text-2xl font-semibold text-ink">Durable actors</h2>
        <p className="mb-3 text-ink-2">One Terse actor per machine, plant and company. This memory survives a crash.</p>
        <ul className="divide-y divide-hairline">
          {company ? (
            <li className="flex justify-between gap-4 py-2">
              <span className="font-semibold">Company</span>
              <span className="num text-ink-2">{company.rules.length} shared rules</span>
            </li>
          ) : null}
          {plants.map((plant) => (
            <li key={plant.id} className="flex justify-between gap-4 py-2">
              <span className="font-semibold">{plant.name}</span>
              <span className="num text-ink-2">
                {plant.history.length} memories, {plant.proposals.length} proposals, tick {plant.tick}
              </span>
            </li>
          ))}
          {components.map((component) => (
            <li key={component.id} className="flex justify-between gap-4 py-2">
              <span>
                {plainName(component.id)} <span className="num text-ink-3">{component.id}</span>
              </span>
              <span className="num text-ink-2">margin {component.marginPct}%, {component.status}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="min-h-0 overflow-auto bg-panel p-5">
        <h2 className="text-2xl font-semibold text-ink">Agent decisions</h2>
        <p className="mb-3 text-ink-2">Agents negotiate over Agent Relay. This is the recorded trail of what they decided.</p>
        {trail.length === 0 ? <p className="text-ink-3">Nothing recorded yet. Press Increase throughput.</p> : null}
        <ul className="divide-y divide-hairline">
          {trail.map((entry, index) => (
            <li key={`${entry.at}-${entry.refId}-${index}`} className="py-2">
              <div className="flex justify-between gap-4">
                <span className="num font-medium text-ink">{entry.by}</span>
                <span className="num text-ink-3">{entry.at.slice(11, 19)}</span>
              </div>
              <div className="text-ink-2">{entry.summary}</div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

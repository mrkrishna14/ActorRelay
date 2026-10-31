"use client";

import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { activeProposer, captionFor, mergedAudit, outlinesFor, PLANT_IDS, plantOf, tagOf, type Tag } from "@/lib/derive";
import { seriesKey, useGlue } from "@/lib/store";
import type { ComponentView, PlantId, View } from "@/lib/types";
import { ComponentPanel } from "./ComponentPanel";
import { CompanyView } from "./CompanyView";
import { Disconnected } from "./Disconnected";
import { EquipmentTree, OtherPlantCard } from "./EquipmentTree";
import { EventsFeed } from "./EventsFeed";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { OperatorStrip } from "./OperatorStrip";
import { Stage } from "./Stage";
import { StoryCard } from "./StoryCard";
import { UnderTheHood } from "./UnderTheHood";
import { ProposalPanel, type EvidenceRef } from "./ProposalPanel";
import { TimingChart } from "./TimingChart";
import { TopBar } from "./TopBar";
import { Plate } from "./ui";

const STAGE_WIDTH = 1920;
const MIN_STAGE_HEIGHT = 640;

const KEY_METRIC: Record<Tag, string> = {
  "P-100": "speedPct",
  "TK-101": "levelPct",
  "LV-101": "positionPct",
  "E-101": "dutyKw",
  "TV-101": "positionPct",
};

function useStage() {
  const [stage, setStage] = useState({ scale: 1, height: 1080 });
  useLayoutEffect(() => {
    const update = () => {
      const scale = window.innerWidth / STAGE_WIDTH;
      setStage({ scale, height: Math.max(window.innerHeight / scale, MIN_STAGE_HEIGHT) });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return stage;
}

function chartMetrics(component: ComponentView | undefined): string[] {
  if (component === undefined) return [];
  const limited = Object.keys(component.limits);
  const plain = Object.keys(component.metrics).filter((metric) => !limited.includes(metric));
  return [...limited, ...plain];
}

export function Dashboard() {
  const glue = useGlue();
  const stage = useStage();
  const [details, setDetails] = useState(false);
  const [view, setView] = useState<View>("plant-a");
  const [selected, setSelected] = useState("plant-a/LV-101");
  const [metricChoice, setMetricChoice] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<EvidenceRef | null>(null);
  const now = glue.lastOkAt === null ? 0 : Date.now();

  const changeView = useCallback((next: View) => {
    setView(next);
    setEvidence(null);
    if (next !== "company") setSelected((current) => `${next}/${tagOf(current)}`);
  }, []);

  const select = useCallback((componentId: string) => {
    setSelected(componentId);
    setView(plantOf(componentId));
  }, []);

  const { plants, company, components } = glue;
  const plantView: PlantId | null = view === "company" ? null : view;
  const plant = plantView ? plants[plantView] : undefined;
  const component = components[selected];
  const metrics = chartMetrics(component);
  const metric = metricChoice[selected] ?? KEY_METRIC[tagOf(selected) as Tag] ?? metrics[0] ?? "";

  const outlines = useMemo(() => (plantView ? outlinesFor(plantView, plants) : new Map()), [plantView, plants]);
  const caption = useMemo(() => (plantView ? captionFor(plantView, plants, company) : null), [plantView, plants, company]);
  const audit = useMemo(() => mergedAudit(plants, company), [plants, company]);
  const showData = glue.conn === "live" || glue.conn === "reconnecting";

  return (
    <div className="stage" style={{ transform: `scale(${stage.scale})`, height: stage.height }}>
      <TopBar glue={glue} view={view} onView={changeView} now={Date.now()} />
      {showData ? (
        <main className={`grid min-h-0 flex-1 ${details ? "grid-cols-[18%_52%_30%] grid-rows-[minmax(0,1fr)_216px]" : "grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]"} ${glue.conn === "reconnecting" ? "opacity-60" : ""}`}>
          <aside className={`panel min-h-0 flex-col border-r border-hairline ${details ? "flex" : "hidden"}`}>
            <EquipmentTree plants={plants} components={components} view={view} selected={selected} onView={changeView} onSelect={select} />
            {plantView ? <OtherPlantCard view={plantView} plants={plants} components={components} company={company} onView={changeView} now={now} /> : null}
          </aside>

          {plantView ? (
            <>
              <section className="panel flex min-h-0 flex-col">
                <OperatorStrip plantId={plantView} plant={plant} pump={components[`${plantView}/P-100`]} live={glue.conn === "live"} />
                <div className="min-h-0 flex-1">
                  <Stage plantId={plantView} components={components} outlines={outlines} proposer={activeProposer(plantView, plants)} selected={selected} onSelect={select} caption={caption} now={now} hood={<UnderTheHood plants={PLANT_IDS.flatMap((id) => plants[id] ?? [])} company={company} components={Object.values(components)} audit={audit} />} />
                </div>
                <StoryCard view={plantView} plants={plants} components={components} now={now} details={details} onDetails={() => setDetails((value) => !value)} />
              </section>

              <aside className={`panel relative min-h-0 flex-col border-l border-hairline ${details ? "flex" : "hidden"}`}>
                <div className="flex max-h-[42%] min-h-0 flex-col">
                  <ComponentPanel component={component} />
                </div>
                <ProposalPanel plant={plant} components={components} plants={plants} company={company} now={now} onEvidence={setEvidence} onSelect={select} />
                {evidence ? <EvidenceDrawer evidence={evidence} plants={plants} company={company} now={now} onClose={() => setEvidence(null)} /> : null}
              </aside>
            </>
          ) : (
            <CompanyView company={company} plants={plants} components={components} onView={changeView} now={now} />
          )}

          <div className={`col-span-3 min-h-0 grid-cols-[60%_40%] border-t border-rule ${details ? "grid" : "hidden"}`}>
            <section className="panel min-h-0 border-r border-hairline">
              <TimingChart component={component} metric={metric} metrics={metrics} onMetric={(next) => setMetricChoice((choice) => ({ ...choice, [selected]: next }))} samples={glue.series[seriesKey(selected, metric)] ?? []} audit={audit} now={now} />
            </section>
            <section className="panel min-h-0">
              <EventsFeed entries={audit} />
            </section>
          </div>
        </main>
      ) : (
        <Disconnected glue={glue} now={Date.now()} />
      )}
    </div>
  );
}

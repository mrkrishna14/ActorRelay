// PURE FUNCTION CHECKS, NOT THE REAL RUNTIME. They reproduce, on actor/src/logic only, the state a crash leaves
// behind, so a defect can be reported before a live server is available. Real-runtime evidence is in REPORT.md.
import { VETO_WINDOW_MS } from "../../../src/config";
import { planSweep } from "../../../src/logic/proposals";
import { mergeCompanyRule, toCompanyRule } from "../../../src/logic/rules";

const now = Date.parse("2026-10-31T12:40:00.000Z");
const iso = (offset: number) => new Date(now + offset).toISOString();

const proposal = (deadlineOffsetMs: number): any => ({
  id: "plant-a-p00001-abcd1234",
  at: iso(-60_000),
  plantId: "plant-a",
  proposerComponentId: "plant-a/P-100",
  proposerAgentId: "agent:plant-a/P-100",
  metric: "speedPct",
  from: 50,
  to: 65,
  rationale: "fixture",
  requiredVoters: ["plant-a/LV-101"],
  votes: [{ componentId: "plant-a/LV-101", vote: "yes" }],
  status: "veto_window",
  vetoDeadline: iso(deadlineOffsetMs),
  parentProposalId: null,
  crossPlant: false,
});

// An outage of an hour covers the whole window, and the first sweep after restart still executes.
const lapsed = planSweep([proposal(-3_600_000)], { "plant-a/P-100": { speedPct: 50 } }, now);
console.log(`L1 veto window lapsed during a 1h outage: first sweep toExecute=${JSON.stringify(lapsed.toExecute)} deadline moved=${lapsed.proposals[0].vetoDeadline !== iso(-3_600_000)} window=${VETO_WINDOW_MS}ms`);

const plantRule: any = {
  id: "rule:plant-a/P-100:speedPct:plant-a/LV-101:positionPct:high",
  scope: "plant",
  model: "outlet-valve-A",
  text: "P-100 speedPct ≥ 85 → LV-101 positionPct ≥ 90 within 3 ticks, seen 3 times",
  condition: { componentId: "plant-a/P-100", metric: "speedPct", op: ">=", value: 85 },
  consequence: { componentId: "plant-a/LV-101", metric: "positionPct", op: ">=", value: 90, withinTicks: 3 },
  supportEventIds: ["e1", "e2", "e3"],
  timesSeen: 3,
  createdAt: iso(0),
  lastSeenAt: iso(0),
};

// The outbox removes a rule only after Company answered, so a crash in that gap re-sends the identical rule.
const company = toCompanyRule(plantRule, "plant-a");
const once = mergeCompanyRule([], company, iso(1));
const replayed = mergeCompanyRule(once.rules, company, iso(2));
console.log(`L2 identical rule delivered twice: rules=${replayed.rules.length} timesSeen ${once.rule.timesSeen} -> ${replayed.rule.timesSeen}, distinct support ids=${replayed.rule.supportEventIds.length}`);

// Seeded scenario generator. One proposal expands to one voter scenario per required voter.
// Retrieved history is sampled from the same truth functions the expected outcome uses, plus observation noise.
import { plantSeed, round, stepEffects, setpointEffects, steadyMetrics, voterTruth, expectedVote } from "./plant.mjs";

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const between = (rng, lo, hi) => lo + rng() * (hi - lo);
const intBetween = (rng, lo, hi) => Math.floor(between(rng, lo, hi + 1));
const noise = (rng, size) => (rng() * 2 - 1) * size;

const NOISE = { positionPct: 1, steamKgH: 25, dutyKw: 15, levelPct: 0.5, tempC: 0.4, headerBarg: 0.03, speedPct: 0 };
const NOW = Date.parse("2026-10-31T19:30:00.000Z");
const OTHER = { "plant-a": "plant-b", "plant-b": "plant-a" };
const LOCAL_VOTERS = ["TK-101", "LV-101", "E-101", "TV-101"];

const TEMP_VOTERS = ["P-100", "LV-101", "E-101", "TV-101"];

const componentOf = (plantId, tag) =>
  structuredClone(plantSeed.plants.find((p) => p.id === plantId).components.find((c) => c.tag === tag));

function incidentFor(rng, after, sc) {
  if (sc.proposerTag !== "P-100") return null;
  if (after >= 88) return "LV-101 saturated at 100%, TK-101 high-level alarm LAH-101";
  if (after >= 80) return rng() < 0.5 ? "LV-101 no control headroom" : null;
  return null;
}

function makeEvent(rng, sc, after, used, opts = {}) {
  const pump = sc.proposerTag === "P-100";
  const before = opts.before ?? (pump ? pick(rng, [40, 45, 50, 50, 50, 55, 60]) : 75);
  const otherSpeed = pick(rng, [45, 50, 50, 50, 55]);
  const fx = sc.effects(before, after, otherSpeed);
  const speed = pump ? before : sc.speed;
  const start = steadyMetrics(speed, otherSpeed);
  const effects = [];
  for (const [tag, metrics] of Object.entries(fx)) {
    for (const [metric, value] of Object.entries(metrics)) {
      effects.push({
        componentId: `${sc.historyPlant}/${tag}`,
        metric,
        before: start[tag][metric],
        after: round(value + noise(rng, NOISE[metric]), metric === "headerBarg" ? 2 : 1),
        ticksToSettle: intBetween(rng, 2, 5),
      });
    }
  }
  let n;
  do n = intBetween(rng, 1, 9999);
  while (used.has(n));
  used.add(n);
  const id = `evt-${sc.historyPlant.slice(-1)}-${String(n).padStart(4, "0")}`;
  return {
    id,
    at: new Date(opts.at ?? NOW - intBetween(rng, 2, 1000) * 86400000).toISOString(),
    plantId: sc.historyPlant,
    componentId: `${sc.historyPlant}/${sc.proposerTag}`,
    metric: sc.metric,
    before,
    after,
    upstreamSnapshot: { feedM3h: round(0.3 * speed, 2), headerBarg: start["TV-101"].headerBarg, feedTempC: 25 },
    effects,
    incident: incidentFor(rng, after, sc),
    approvedBy: [],
    operator: pick(rng, ["M. Okafor", "L. Tran", "S. Rivera", "J. Novak"]),
    proposalId: opts.proposalId ?? null,
  };
}

const RULES = {
  lv85: {
    id: "rule-lv-85",
    scope: "company",
    model: "outlet-valve-A",
    text: "P-100 speedPct >= 80 -> LV-101 positionPct >= 85 within 3 ticks, seen 4 times",
    condition: { componentId: null, metric: "speedPct", op: ">=", value: 80 },
    consequence: { componentId: null, metric: "positionPct", op: ">=", value: 85, withinTicks: 3 },
    supportEventIds: ["evt-a-0101", "evt-a-0102", "evt-a-0103", "evt-a-0104"],
    timesSeen: 4,
    createdAt: "2026-10-31T18:00:00.000Z",
    lastSeenAt: "2026-10-31T19:00:00.000Z",
  },
  steam90: {
    id: "rule-tv-2650",
    scope: "plant",
    model: "steam-valve-A",
    text: "P-100 speedPct >= 88 -> TV-101 steamKgH >= 2650 within 5 ticks, seen 3 times",
    condition: { componentId: null, metric: "speedPct", op: ">=", value: 88 },
    consequence: { componentId: "plant-a/TV-101", metric: "steamKgH", op: ">=", value: 2650, withinTicks: 5 },
    supportEventIds: ["evt-a-0201", "evt-a-0202", "evt-a-0203"],
    timesSeen: 3,
    createdAt: "2026-10-31T18:00:00.000Z",
    lastSeenAt: "2026-10-31T19:00:00.000Z",
  },
};

function pickMargin(rng) {
  const r = rng();
  return r < 0.6 ? 10 : r < 0.75 ? 5 : r < 0.9 ? 15 : r < 0.95 ? 20 : 25;
}

const near = (rng, to, spread) => Math.min(100, Math.max(20, Math.round(to + between(rng, -spread, spread))));

// Spec for one proposal. Each family stresses a different way a vote can go wrong.
const FAMILIES = {
  sweep(rng) {
    const to = intBetween(rng, 20, 100);
    const depth = intBetween(rng, 3, 5);
    return { to, depth, afters: Array.from({ length: depth }, () => near(rng, to, 4)) };
  },
  boundary(rng) {
    const to = near(rng, pick(rng, [73.8, 77.8, 84.2, 86.2, 89.3, 91.4]), 3);
    const depth = intBetween(rng, 3, 5);
    return { to, depth, afters: Array.from({ length: depth }, () => near(rng, to, 3)) };
  },
  thin(rng) {
    const to = intBetween(rng, 55, 95);
    const depth = intBetween(rng, 0, 2);
    return { to, depth, afters: Array.from({ length: depth }, () => near(rng, to, 4)) };
  },
  // similar() drops events more than 15% of range from the target, so these sit just inside that cutoff.
  farSafe(rng) {
    const to = intBetween(rng, 78, 98);
    const depth = intBetween(rng, 3, 5);
    return { to, depth, afters: Array.from({ length: depth }, () => to - intBetween(rng, 5, 10)) };
  },
  farUnsafe(rng) {
    const to = intBetween(rng, 40, 80);
    const depth = intBetween(rng, 3, 5);
    return { to, depth, afters: Array.from({ length: depth }, () => to + intBetween(rng, 5, 10)) };
  },
  drift(rng) {
    const to = intBetween(rng, 66, 92);
    const depth = intBetween(rng, 3, 5);
    const bias = pick(rng, [{ "LV-101.positionPct": 6 }, { "LV-101.positionPct": -5 }, { "TV-101.steamKgH": 220 }, { "E-101.dutyKw": 160 }]);
    return { to, depth, bias, afters: Array.from({ length: depth }, () => near(rng, to, 2)) };
  },
  rule(rng) {
    const to = intBetween(rng, 60, 95);
    const depth = intBetween(rng, 3, 5);
    return { to, depth, ruleKeys: ["lv85", "steam90"], afters: Array.from({ length: depth }, () => near(rng, to, 5)) };
  },
  demoBlock() {
    return { plantId: "plant-a", from: 50, to: 85, fixedMargin: 10, ruleKeys: ["lv85"], depth: 5, afters: [85, 84, 86, 83, 88] };
  },
  demoCounter() {
    return { plantId: "plant-a", from: 50, to: 65, fixedMargin: 10, ruleKeys: ["lv85"], depth: 5, afters: [65, 64, 66, 63, 68] };
  },
  demoRepeat() {
    return { plantId: "plant-a", from: 65, to: 85, fixedMargin: 10, ruleKeys: ["lv85"], depth: 5, afters: [85, 84, 86, 83, 88], recentRun: { before: 50, after: 65 } };
  },
  demoPlantB() {
    return { plantId: "plant-b", from: 50, to: 85, fixedMargin: 10, ruleKeys: ["lv85"], depth: 0, afters: [] };
  },
  demoPlantBNoRule() {
    return { plantId: "plant-b", from: 50, to: 85, fixedMargin: 10, depth: 0, afters: [] };
  },
  tempSetpoint(rng) {
    const to = intBetween(rng, 70, 90);
    const depth = intBetween(rng, 0, 5);
    return { kind: "temp", to, from: 75, speed: pick(rng, [50, 50, 65, 80, 84]), depth, afters: Array.from({ length: depth }, () => near(rng, to, 3)) };
  },
};

const WEIGHTS = [
  ["sweep", 28], ["boundary", 20], ["thin", 10], ["farSafe", 10], ["farUnsafe", 8], ["drift", 8], ["rule", 4], ["tempSetpoint", 6],
  ["demoBlock", 2], ["demoCounter", 2], ["demoRepeat", 2], ["demoPlantB", 1], ["demoPlantBNoRule", 1],
];
const DECK = WEIGHTS.flatMap(([name, w]) => Array(w).fill(name));

function expand(index, family, rng) {
  const spec = FAMILIES[family](rng);
  const plantId = spec.plantId ?? pick(rng, ["plant-a", "plant-a", "plant-b"]);
  const from = spec.from ?? pick(rng, [30, 40, 50, 50, 50, 60, 65, 70]);
  const to = spec.to;
  const otherSpeed = pick(rng, [50, 50, 50, 40, 60, 65]);
  const temp = spec.kind === "temp";
  const bias = spec.bias ?? {};
  const sc = {
    historyPlant: plantId,
    proposerTag: temp ? "TK-101" : "P-100",
    metric: temp ? "tempC" : "speedPct",
    speed: spec.speed,
    effects: (before, after, other) => temp ? setpointEffects({ speed: spec.speed, to: after, otherSpeed: other }) : stepEffects({ from: before, to: after, otherSpeed: other, bias }),
  };
  const used = new Set();
  const events = spec.afters.map((after) => makeEvent(rng, sc, after, used));
  if (spec.recentRun) {
    events.unshift(makeEvent(rng, sc, spec.recentRun.after, used, { before: spec.recentRun.before, at: NOW - 40000, proposalId: `prop-${index}-prior` }));
  }
  const rules = (spec.ruleKeys ?? []).map((k) => structuredClone(RULES[k]));
  for (const r of rules) if (r.scope === "plant") r.consequence.componentId = `${plantId}/TV-101`;
  const band = temp ? 1.5 : 10.5;
  const similarCount = events.filter((e) => Math.abs(e.after - to) <= band).length;
  const changeNearCritical = to >= (temp ? 85 : 95) * 0.85;
  const proposalId = `prop-${String(index).padStart(5, "0")}`;
  const otherPlant = OTHER[plantId];
  const voters = [...(temp ? TEMP_VOTERS : LOCAL_VOTERS).map((tag) => ({ plant: plantId, tag })), { plant: otherPlant, tag: "TV-101", crossPlant: true }];
  const requiredVoters = voters.map((v) => `${v.plant}/${v.tag}`);
  const speed = temp ? spec.speed : from;
  const start = steadyMetrics(speed, otherSpeed);
  const otherStart = steadyMetrics(otherSpeed, speed);
  const fx = sc.effects(from, to, otherSpeed);
  const proposal = {
    id: proposalId,
    at: new Date(NOW).toISOString(),
    plantId,
    proposerComponentId: `${plantId}/${sc.proposerTag}`,
    proposerAgentId: `agent:${plantId}/${sc.proposerTag}`,
    metric: sc.metric,
    from,
    to,
    rationale: temp ? "Adjust hold temperature" : to >= from ? "Increase throughput" : "Reduce feed rate",
    requiredVoters,
    votes: [],
    status: "voting",
    vetoDeadline: null,
    parentProposalId: null,
    crossPlant: true,
  };
  const newest = events.reduce((a, b) => (a && a.at > b.at ? a : b), null);
  return voters.map((v) => {
    const component = componentOf(v.plant, v.tag);
    component.metrics = { ...component.metrics, ...(v.crossPlant ? otherStart : start)[v.tag] };
    component.marginPct = spec.fixedMargin ?? pickMargin(rng);
    const truth = voterTruth({ tag: v.tag, crossPlant: v.crossPlant, otherSpeed, fx });
    return {
      id: `${proposalId}/${v.plant}/${v.tag}`,
      group: proposalId,
      family,
      crossPlant: Boolean(v.crossPlant),
      proposal,
      component,
      events,
      rules,
      truth,
      similarCount,
      proposer: componentOf(plantId, sc.proposerTag),
      steamValve: componentOf(plantId, "TV-101"),
      expected: expectedVote(component, truth, similarCount, { changeNearCritical, rules, proposal }),
      newestEventId: spec.recentRun ? newest.id : null,
    };
  });
}

export function generate({ proposals, seed }) {
  const rng = mulberry32(seed);
  const scenarios = [];
  for (let i = 0; i < proposals; i++) scenarios.push(...expand(i, pick(rng, DECK), rng));
  return scenarios;
}

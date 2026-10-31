// Checks a history file against the HistoryEvent type in shared/types.ts, every hard requirement in
// TASK2.MD, and what the demo needs from similar(). Works on the stand-in and on the real file.
// Run: node actor/tests/fixtures-gen/validate-history.mjs [path]   Exit 1 if any check fails.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const TARGET = resolve(process.argv[2] ?? join(HERE, "history.json"));

const SATURATED = "LV-101 saturated at 100%, TK-101 high-level alarm LAH-101";
const HEADROOM = "LV-101 no control headroom";
const EVENT_KEYS = ["id", "at", "plantId", "componentId", "metric", "before", "after", "upstreamSnapshot", "effects", "incident", "approvedBy", "operator", "proposalId"];
const EFFECT_KEYS = ["componentId", "metric", "before", "after", "ticksToSettle"];
const UPSTREAM_KEYS = ["feedM3h", "headerBarg", "feedTempC"];
const OTHER_TAGS = ["TK-101", "LV-101", "E-101", "TV-101"];
const DESIGN_UPSTREAM = { feedM3h: 15, headerBarg: 6, feedTempC: 25 };
const AFTER_65_UPSTREAM = { feedM3h: 19.5, headerBarg: 5.78, feedTempC: 25 };
const PLANT_B_DEMO_UPSTREAM = { feedM3h: 15, headerBarg: 5.78, feedTempC: 25 }; // plant-a is already at 65.

const results = [];
let section = "";
function check(name, ok, detail = "") {
  results.push({ section, name, ok, detail });
}
const num = (x) => typeof x === "number" && Number.isFinite(x);
const str = (x) => typeof x === "string";
const strOrNull = (x) => x === null || str(x);
const sameKeys = (o, keys) => o !== null && typeof o === "object" && Object.keys(o).length === keys.length && keys.every((k) => k in o);
const lv = (e) => e.effects.find((r) => r.componentId === `${e.plantId}/LV-101` && r.metric === "positionPct");
const sample = (ids) => (ids.length ? ` e.g. ${ids.slice(0, 3).join(", ")}` : "");
const between = (x, lo, hi) => x >= lo && x <= hi;

function eventProblems(e) {
  const bad = [];
  if (!sameKeys(e, EVENT_KEYS)) return ["keys differ from HistoryEvent"];
  if (!str(e.id) || !e.id) bad.push("id");
  if (!str(e.at) || Number.isNaN(Date.parse(e.at))) bad.push("at");
  if (e.plantId !== "plant-a" && e.plantId !== "plant-b") bad.push("plantId");
  if (!str(e.componentId) || !e.componentId.startsWith(`${e.plantId}/`)) bad.push("componentId");
  if (!str(e.metric)) bad.push("metric");
  if (!num(e.before)) bad.push("before");
  if (!num(e.after)) bad.push("after");
  if (e.upstreamSnapshot === null || typeof e.upstreamSnapshot !== "object" || !Object.values(e.upstreamSnapshot).every(num)) bad.push("upstreamSnapshot");
  if (!Array.isArray(e.effects)) bad.push("effects");
  else for (const r of e.effects) {
    if (!sameKeys(r, EFFECT_KEYS) || !str(r.componentId) || !str(r.metric) || !num(r.before) || !num(r.after) || !num(r.ticksToSettle) || r.ticksToSettle < 0) bad.push("effects row");
  }
  if (!strOrNull(e.incident)) bad.push("incident");
  if (!Array.isArray(e.approvedBy) || !e.approvedBy.every(str)) bad.push("approvedBy");
  if (!strOrNull(e.operator)) bad.push("operator");
  if (!strOrNull(e.proposalId)) bad.push("proposalId");
  return bad;
}

// Fails if shared/types.ts moves away from the field list this validator checks.
function typeFields() {
  const source = readFileSync(join(REPO, "shared/types.ts"), "utf8");
  const body = source.match(/export type HistoryEvent = \{([\s\S]*?)\n\};/)?.[1] ?? "";
  const nested = body.match(/effects:\s*\{([^}]*)\}\[\]/)?.[1] ?? "";
  const names = (s) => [...s.matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
  return { event: names(body.replace(/\{[^}]*\}\[\]/, "").replace(/Record<[^>]*>/g, "")), effect: names(nested) };
}

// Real compiler check against shared/types.ts. Set TSC to a tsc path to override. Without a compiler
// this reports SKIP, never a pass.
function compileCheck(list) {
  const tsc = [process.env.TSC, join(REPO, "actor/tests/contract/node_modules/typescript/bin/tsc")].find((p) => p && existsSync(p));
  if (!tsc) return { ok: null, detail: "no tsc found, set TSC" };
  const dir = mkdtempSync(join(tmpdir(), "history-types-"));
  const file = join(dir, "history-check.ts");
  const typesPath = join(REPO, "shared/types").replaceAll("\\", "/");
  writeFileSync(file, `import type { HistoryEvent } from ${JSON.stringify(typesPath)};\nexport const history: HistoryEvent[] = ${JSON.stringify(list)};\n`);
  const run = spawnSync(process.execPath, [tsc, "--noEmit", "--strict", "--skipLibCheck", "--target", "esnext", "--module", "esnext", "--moduleResolution", "bundler", file], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}${run.error?.message ?? ""}`.trim();
  return { ok: run.status === 0, detail: run.status === 0 ? "tsc --strict, 0 errors" : output.split("\n").slice(0, 2).join(" ").slice(0, 300) };
}

// Reference similar() from TASK1.MD: |after - to|/range + 0.5 x mean normalized upstream distance.
// How the actor normalizes is its own choice, so the demo checks hold across all of these.
const UPSTREAM_NORMS = {
  "keyrange": (a, b, span) => (span ? Math.abs(a - b) / span : 0),
  "relative": (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9),
};
const SPEED_RANGES = [70, 75, 100];

function similar(events, plantId, to, upstream, range, norm, k = 5) {
  const pool = events.filter((e) => e.plantId === plantId && e.componentId === `${plantId}/P-100` && e.metric === "speedPct");
  const spans = Object.fromEntries(UPSTREAM_KEYS.map((key) => {
    const values = pool.map((e) => e.upstreamSnapshot[key]).filter(num);
    return [key, values.length ? Math.max(...values) - Math.min(...values) : 0];
  }));
  const distance = (e) => {
    const parts = UPSTREAM_KEYS.filter((key) => key in e.upstreamSnapshot && key in upstream).map((key) => norm(e.upstreamSnapshot[key], upstream[key], spans[key]));
    return Math.abs(e.after - to) / range + 0.5 * (parts.reduce((a, b) => a + b, 0) / (parts.length || 1));
  };
  return pool.map((e) => ({ e, d: distance(e) })).sort((x, y) => x.d - y.d || x.e.id.localeCompare(y.e.id)).slice(0, k).map(({ e }) => e);
}

function overThreshold(limits, plantId, row) {
  const tag = row.componentId.split("/")[1];
  const limit = limits[`${plantId}/${tag}`]?.[row.metric];
  return limit ? row.after >= limit.critical * 0.9 : false;
}

let events;
try {
  events = JSON.parse(readFileSync(TARGET, "utf8"));
} catch (error) {
  console.log(`FAIL cannot read ${TARGET}: ${error.message}`);
  process.exit(1);
}

section = "TYPES";
const declared = typeFields();
check("validator field list matches HistoryEvent in shared/types.ts", declared.event.join() === EVENT_KEYS.join() && declared.effect.join() === EFFECT_KEYS.join(), `${declared.event.length} event fields, ${declared.effect.length} effect fields`);
check("top level is a HistoryEvent[] array", Array.isArray(events));
if (!Array.isArray(events)) {
  finish();
}
const malformed = events.map((e) => ({ e, bad: eventProblems(e) })).filter((x) => x.bad.length);
check("every event matches the HistoryEvent shape", malformed.length === 0, malformed.length ? `${malformed.length} bad: ${malformed.slice(0, 3).map((x) => `${x.e?.id}: ${x.bad.join("/")}`).join("; ")}` : `${events.length} events`);
if (malformed.length) {
  finish();
}
const compiled = compileCheck(events);
check("assignable to HistoryEvent[] under tsc --strict", compiled.ok, compiled.detail);

section = "COUNT AND PROVENANCE";
const ids = new Set(events.map((e) => e.id));
const years = events.map((e) => new Date(e.at).getUTCFullYear());
const withOperator = events.filter((e) => e.operator !== null).length;
check("about 300 events (250-350)", between(events.length, 250, 350), `${events.length}`);
check("ids are unique", ids.size === events.length);
check("dates fall in 2024-2026", years.every((y) => between(y, 2024, 2026)), `${Math.min(...years)}-${Math.max(...years)}`);
check("all dates are in the past", events.every((e) => Date.parse(e.at) < Date.parse("2026-10-31T00:00:00Z")));
check("provenance filled in (operator on at least 80% of events)", withOperator / events.length >= 0.8, `${withOperator}/${events.length}`);

section = "EVENT CONTENT";
const nonPump = events.filter((e) => e.componentId !== `${e.plantId}/P-100` || e.metric !== "speedPct");
const badUpstream = events.filter((e) => !UPSTREAM_KEYS.every((k) => k in e.upstreamSnapshot));
const badFeed = events.filter((e) => Math.abs(e.upstreamSnapshot.feedM3h - 0.3 * e.before) > 0.2);
const missingEffects = events.filter((e) => !OTHER_TAGS.every((tag) => e.effects.some((r) => r.componentId === `${e.plantId}/${tag}`)));
const missingHeader = events.filter((e) => !e.effects.some((r) => r.componentId === `${e.plantId}/TV-101` && r.metric === "headerBarg"));
check("every event is a P-100 speedPct change", nonPump.length === 0, sample(nonPump.map((e) => e.id)));
check("upstreamSnapshot has feedM3h, headerBarg, feedTempC", badUpstream.length === 0, sample(badUpstream.map((e) => e.id)));
check("feedM3h is 0.3 x before", badFeed.length === 0, sample(badFeed.map((e) => e.id)));
check("effects cover TK-101, LV-101, E-101, TV-101", missingEffects.length === 0, sample(missingEffects.map((e) => e.id)));
check("effects include TV-101 headerBarg, the only row a cross-plant voter can read", missingHeader.length === 0, `${missingHeader.length} missing${sample(missingHeader.map((e) => e.id))}`);
const unrounded = events.filter((e) => [e.before, e.after].some((x) => Math.abs(x * 100 - Math.round(x * 100)) > 1e-6));
check("speeds have at most 2 decimals, since prompts and the dashboard print them raw", unrounded.length === 0, `${unrounded.length} not rounded${sample(unrounded.map((e) => `${e.id} after ${e.after}`))}`);

section = "TASK2 HARD REQUIREMENTS";
const pumpEvents = events.filter((e) => e.componentId === `${e.plantId}/P-100` && e.metric === "speedPct");
const plantA = pumpEvents.filter((e) => e.plantId === "plant-a");
const plantB = pumpEvents.filter((e) => e.plantId === "plant-b");
const incidents =plantA.filter((e) => between(e.after, 88, 100) && lv(e) && lv(e).after >= 90 && lv(e).ticksToSettle <= 3 && e.incident === SATURATED);
const band80 = plantA.filter((e) => between(e.after, 80, 87.999) && lv(e) && between(lv(e).after, 85, 91) && (e.incident === null || e.incident === HEADROOM));
const band80All = plantA.filter((e) => between(e.after, 80, 87.999));
const band60 = plantA.filter((e) => between(e.after, 60, 70) && lv(e) && between(lv(e).after, 60, 73) && e.incident === null);
const band60All = plantA.filter((e) => between(e.after, 60, 70));
const bHigh = plantB.filter((e) => e.before >= 80 || e.after >= 80);
const bMid = plantB.filter((e) => between(e.after, 40, 65));
check("plant-a: >=3 events after 88-100, LV-101 >=90 within 3 ticks, incident text", incidents.length >= 3, `${incidents.length}`);
check("plant-a: >=3 more events after 80-87, LV-101 85-91, incident null or headroom", band80.length >= 3, `${band80.length} of ${band80All.length} in band`);
check("plant-a: >=5 events 60-70, LV-101 60-73, incident null", band60.length >= 5, `${band60.length} of ${band60All.length} in band`);
check("plant-b: zero events with P-100 at or above 80 (before or after)", bHigh.length === 0, `${bHigh.length}${sample(bHigh.map((e) => e.id))}`);
check("plant-b: several events at 40-65 (at least 5)", bMid.length >= 5, `${bMid.length}`);

section = "RULE SUPPORT";
const atOrAbove80 = plantA.filter((e) => e.after >= 80);
const supports = atOrAbove80.filter((e) => lv(e) && lv(e).after >= 85 && lv(e).ticksToSettle <= 3);
const counter = atOrAbove80.filter((e) => !supports.includes(e));
check("rule P-100 >=80 -> LV-101 >=85 within 3 ticks has >=3 supports", supports.length >= 3, `${supports.length} supports`);
check("that rule has no counterexample in plant-a", counter.length === 0, `${counter.length}${sample(counter.map((e) => e.id))}`);

section = "DEMO RETRIEVAL (reference similar() from TASK1.MD, k=5, not the actor's code)";
const components = Object.fromEntries(JSON.parse(readFileSync(join(REPO, "shared/plants.json"), "utf8")).plants.flatMap((p) => p.components.map((c) => [c.id, c])));
const limits = Object.fromEntries(Object.values(components).map((c) => [c.id, c.limits]));
const combos =SPEED_RANGES.flatMap((range) => Object.entries(UPSTREAM_NORMS).map(([name, norm]) => ({ label: `${name}/${range}`, range, norm })));
function acrossCombos(name, plantId, to, upstream, test) {
  const failed = combos.filter(({ range, norm }) => !test(similar(events, plantId, to, upstream, range, norm))).map((c) => c.label);
  const top = similar(events, plantId, to, upstream, combos[0].range, combos[0].norm).map((e) => e.after).join(" ");
  check(name, failed.length === 0, `${failed.length ? `fails on ${failed.join(", ")}` : `${combos.length} scorings`}, after ${top}`);
}
const allHigh = (top) => top.length === 5 && top.every((e) => e.after >= 80 && lv(e)?.after >= 85);
const threeIncidents = (top) => top.filter((e) => e.incident === SATURATED).length >= 3;
const onlyLvOver = (plantId) => (top) => top.every((e) => e.effects.filter((r) => overThreshold(limits, plantId, r)).every((r) => r.componentId.endsWith("/LV-101")));
const safe = (plantId) => (top) => top.length === 5 && top.every((e) => e.incident === null && !e.effects.some((r) => overThreshold(limits, plantId, r)));
acrossCombos("plant-a to 85 from design: all 5 are >=80 with LV-101 >=85 (TASK1 test)", "plant-a", 85, DESIGN_UPSTREAM, allHigh);
acrossCombos("plant-a to 85 from design: >=3 of 5 carry the incident (demo step 3)", "plant-a", 85, DESIGN_UPSTREAM, threeIncidents);
acrossCombos("plant-a to 85 from design: only LV-101 crosses its vote threshold", "plant-a", 85, DESIGN_UPSTREAM, onlyLvOver("plant-a"));
acrossCombos("plant-a to 85 from speed 65: all 5 are >=80 with LV-101 >=85 (demo step 5)", "plant-a", 85, AFTER_65_UPSTREAM, allHigh);
acrossCombos("plant-a to 85 from speed 65: >=3 of 5 carry the incident (demo step 5)", "plant-a", 85, AFTER_65_UPSTREAM, threeIncidents);
acrossCombos("plant-a to 65 from design: all 5 clean, nothing over a vote threshold (demo step 4)", "plant-a", 65, DESIGN_UPSTREAM, safe("plant-a"));
acrossCombos("plant-b to 85: all 5 below 80 (demo step 6)", "plant-b", 85, PLANT_B_DEMO_UPSTREAM, (top) => top.every((e) => e.after < 80));
acrossCombos("plant-b to 65: all 5 clean, nothing over a vote threshold", "plant-b", 65, PLANT_B_DEMO_UPSTREAM, safe("plant-b"));
const bLvHigh = plantB.filter((e) => lv(e) && (lv(e).after > 80 || lv(e).before > 80));
check("plant-b: LV-101 has never run above 80 (demo step 6)", bLvHigh.length === 0, `${bLvHigh.length}${sample(bLvHigh.map((e) => e.id))}`);

section = "REAL CODE (actor/src/logic and agent/retrieval.ts, no LLM)";
const realModules = await Promise.all(["actor/src/logic/similar.ts", "actor/src/logic/rules.ts", "actor/src/logic/validate.ts", "agent/retrieval.ts"].map((file) => import(pathToFileURL(join(REPO, file)).href).catch(() => null)));
if (realModules.includes(null)) {
  check("real actor and agent modules load", null, "module missing or not loadable, nothing below ran");
} else {
  const [{ rankSimilar }, { deriveRules }, { assertHistoryEvent }, { evidenceEstimates, relevantEvents, ownRows }] = realModules;
  const speedLimit = limits["plant-a/P-100"].speedPct;
  // agent/vote.ts sends feedM3h and headerBarg only, so feedTempC plays no part in the real ranking.
  const rank = (plantId, to, { feedM3h, headerBarg }, live = null) => rankSimilar({
    history: [...pumpEvents.filter((e) => e.plantId === plantId), ...(live ? [live] : [])],
    componentId: `${plantId}/P-100`, metric: "speedPct", to, upstreamSnapshot: { feedM3h, headerBarg }, k: 5, limit: speedLimit, liveEventIds: live ? [live.id] : [],
  });
  // Metrics whose voter estimate lands on or past critical x 0.9, the forced-no line at margin 10.
  const overLines = (plantId, top, to) => OTHER_TAGS.flatMap((tag) => {
    const own = components[`${plantId}/${tag}`];
    const estimates = evidenceEstimates(relevantEvents(top, to, speedLimit), own, to);
    return Object.entries(estimates).filter(([metric, value]) => own.limits[metric] && value >= own.limits[metric].critical * 0.9).map(([metric]) => `${tag}.${metric}`);
  });
  const afters = (top) => top.map((e) => e.after).join(" ");

  const rejected = events.flatMap((e) => {
    try {
      assertHistoryEvent(e);
      return [];
    } catch (error) {
      return [`${e.id}: ${error.message}`];
    }
  });
  check("assertHistoryEvent, which loadSeed runs, accepts every event", rejected.length === 0, rejected.slice(0, 2).join("; "));

  const step3 = rank("plant-a", 85, DESIGN_UPSTREAM);
  check("step 3: to 85 from design returns 5 at >=80 with LV-101 >=85", allHigh(step3), `after ${afters(step3)}`);
  check("step 3: >=3 of those carry the incident", threeIncidents(step3), `${step3.filter((e) => e.incident === SATURATED).length}`);
  check("step 3: voter estimates cross the line on LV-101 only", overLines("plant-a", step3, 85).join() === "LV-101.positionPct", overLines("plant-a", step3, 85).join(", ") || "none");

  const step4 = rank("plant-a", 65, DESIGN_UPSTREAM);
  check("step 4: to 65 from design returns 5 clean events", safe("plant-a")(step4), `after ${afters(step4)}`);
  check("step 4: no voter estimate crosses a line", overLines("plant-a", step4, 65).length === 0, overLines("plant-a", step4, 65).join(", ") || "none");

  const live = { ...step4[0], id: "live-step-4", at: "2026-10-31T20:00:00.000Z", proposalId: "live-step-4" };
  const step5 = rank("plant-a", 85, AFTER_65_UPSTREAM, live);
  const step5Seeded = step5.slice(1);
  check("step 5: the live 65 run comes first, then 4 seeded >=80 with LV-101 >=85", step5[0]?.id === live.id && step5Seeded.length === 4 && step5Seeded.every((e) => e.after >= 80 && lv(e)?.after >= 85), `after ${afters(step5)}`);
  check("step 5: >=3 of the seeded ones carry the incident", threeIncidents(step5Seeded), `${step5Seeded.filter((e) => e.incident === SATURATED).length}`);

  const step6 = rank("plant-b", 85, PLANT_B_DEMO_UPSTREAM);
  check("step 6: plant-b to 85 returns under 3 events, so insufficient history fires", step6.length < 3, `${step6.length} returned, plant-b tops out at ${Math.max(...plantB.map((e) => e.after))}`);
  const bAt65 = rank("plant-b", 65, PLANT_B_DEMO_UPSTREAM);
  check("plant-b to 65 returns 5 clean events", safe("plant-b")(bAt65), `after ${afters(bAt65)}`);

  check("cross-plant voter plant-b/TV-101 finds its row in plant-a events", step3.every((e) => ownRows(e, components["plant-b/TV-101"]).length > 0));

  const topology = Object.fromEntries(Object.values(components).map((c) => [c.id, c]));
  const rulesA = deriveRules(plantA, topology, "2026-10-31T00:00:00.000Z");
  const rulesB = deriveRules(plantB, topology, "2026-10-31T00:00:00.000Z");
  const lvRule = rulesA.find((r) => r.consequence.componentId === "plant-a/LV-101" && r.consequence.op === ">=");
  check("deriveRules gives P-100 >=80 -> LV-101 >=85 within 3 ticks in plant-a", lvRule?.condition.value === 80 && lvRule?.consequence.value === 85 && lvRule?.consequence.withinTicks <= 3, lvRule?.text ?? `none of ${rulesA.length}`);
  const blocksCounter = rulesA.filter((r) => r.condition.op === ">=" && r.condition.value <= 65);
  check("deriveRules gives no plant-a rule that fires at the 65 counter-proposal", blocksCounter.length === 0, blocksCounter.map((r) => r.text).join("; ") || `${rulesA.length} rules, lowest condition ${Math.min(...rulesA.map((r) => r.condition.value))}`);
  check("deriveRules gives plant-b no LV-101 rule of its own", !rulesB.some((r) => r.consequence.componentId === "plant-b/LV-101"), `${rulesB.length} plant-b rules`);
}

section = "PHYSICS COHERENCE (fit from TASK2.MD and CLAUDE.MD)";
const row = (e, tag, metric) => e.effects.find((r) => r.componentId === `${e.plantId}/${tag}` && r.metric === metric);
const heat = (e) => (75 - e.upstreamSnapshot.feedTempC) / 50;
const fitSteam = (e) => Math.min(3000, 29.7 * e.after * heat(e) + 48);
const fitDuty = (e) => 17.43 * ((fitSteam(e) - 48) / 29.7) + 27;
const within = (x, target, pct) => Math.abs(x - target) <= target * pct;
const metricRows = (tag, metric) => events.filter((e) => row(e, tag, metric));
const coverage = (list, test) => {
  const bad = list.filter((e) => !test(e));
  return [bad.length === 0, `${list.length - bad.length}/${list.length} within${sample(bad.map((e) => e.id))}`];
};
check("LV-101 before tracks P-100 before (+/-3)", ...coverage(metricRows("LV-101", "positionPct"), (e) => Math.abs(row(e, "LV-101", "positionPct").before - e.before) <= 3));
// A step down undershoots in the model, so the floor is lower there.
check("LV-101 after is near speed (-3 up, -6 down) and capped at 100", ...coverage(metricRows("LV-101", "positionPct"), (e) => between(row(e, "LV-101", "positionPct").after, Math.min(e.after, 100) - (e.after > e.before ? 3 : 6), 100)));
check("TV-101 steamKgH after within 12% of the fit", ...coverage(metricRows("TV-101", "steamKgH"), (e) => within(row(e, "TV-101", "steamKgH").after, fitSteam(e), 0.12)));
check("E-101 dutyKw after within 12% of the fit", ...coverage(metricRows("E-101", "dutyKw"), (e) => within(row(e, "E-101", "dutyKw").after, fitDuty(e), 0.12)));
check("TK-101 tempC stays 60-85", ...coverage(metricRows("TK-101", "tempC"), (e) => between(row(e, "TK-101", "tempC").after, 60, 85)));
check("headerBarg falls when steam rises", ...coverage(metricRows("TV-101", "headerBarg"), (e) => {
  const steam = row(e, "TV-101", "steamKgH");
  const header = row(e, "TV-101", "headerBarg");
  return Math.sign(steam.after - steam.before) * (header.after - header.before) <= 0.011;
}));

finish();

function finish() {
  console.log(`Validating ${TARGET}`);
  let current = null;
  for (const r of results) {
    if (r.section !== current) {
      current = r.section;
      console.log(`\n${current}`);
    }
    console.log(`  ${r.ok === null ? "SKIP" : r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  [${r.detail}]` : ""}`);
  }
  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.ok === null);
  console.log(`\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  process.exit(failed.length ? 1 : 0);
}

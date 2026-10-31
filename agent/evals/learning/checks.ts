// Deterministic checks on the open learning items, using a stub Llm. No OpenAI calls, so they are free to re-run.
//   bun run agent/evals/learning/checks.ts
// Exit code 1 if any check fails.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Vote } from "../../../shared/types.ts";
import type { Llm, LlmRequest } from "../../llm.ts";
import { learnFromExecution } from "../../learn.ts";
import { RetrievalCache } from "../../retrieval.ts";
import { castVote } from "../../vote.ts";
import { WorldGlue } from "./real.ts";
import { ROOT, World } from "./world.ts";

const answer = (vote: "yes" | "no", positionPct: number) => ({
  text: JSON.stringify({
    vote,
    reason: "stub",
    predicted: { positionPct, levelPct: 50, tempC: 74, dutyKw: 1150, steamKgH: 1950, headerBarg: 5.8 },
    evidenceEventIds: [],
    evidenceRuleIds: [],
  }),
  provider: "openai" as const,
  model: "stub",
  fallback: false,
});

const down: Llm = { complete: async () => { throw new Error("openai 429: Rate limit reached"); } };
const safe: Llm = { complete: async () => answer("yes", 67) };
const predicts = (positionPct: number): Llm => ({ complete: async () => answer("no", positionPct) });

// A short limit window: instant retries land inside it, a retry after a backoff lands past it.
function limitedFor(ms: number, reply: Llm): Llm & { calls: number } {
  const started = Date.now();
  return {
    calls: 0,
    async complete(request: LlmRequest) {
      this.calls++;
      if (Date.now() - started < ms) throw new Error(`openai 429: Rate limit reached. Please try again in ${ms}ms.`);
      return reply.complete(request);
    },
  };
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

let failed = 0;
function check(name: string, ok: boolean, v?: Vote) {
  if (!ok) failed++;
  const detail = v ? ` vote ${v.vote}, evidence[0] ${v.evidenceEventIds[0] ?? "none"}, rules ${v.evidenceRuleIds.length}: ${v.reason.slice(0, 150)}` : "";
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${v ? " |" + detail : ""}`);
}

function demoWorld(shape: "as-is" | "settled" = "as-is") {
  const world = new World(31337, 65, "auto", shape);
  world.deriveAfterRecord("plant-a");
  world.deriveAfterRecord("plant-b");
  return { world, glue: new WorldGlue(world), cache: new RetrievalCache() };
}

async function executeSafeRun({ world, glue, cache }: ReturnType<typeof demoWorld>) {
  const counter = world.proposal("plant-a", 65, 50, "Counter-proposal");
  counter.votes = await Promise.all(counter.requiredVoters.map((id) => castVote({ glue, llm: safe, cache }, counter, id)));
  const event = world.execute(counter, counter.votes);
  await learnFromExecution({ glue, cache }, event, new Set(world.components.keys()));
  return event;
}

// LLM down: code alone already proves both moments, so a failed model must not lose the evidence.
{
  const w = demoWorld();
  const event = await executeSafeRun(w);
  const a = await castVote({ ...w, llm: down }, w.world.proposal("plant-a", 85, 65, "Repeat"), "plant-a/LV-101");
  check("outage: repeat 85 keeps newest evidence", a.vote === "no" && a.evidenceEventIds[0] === event.id && a.reason.includes("not proof"), a);
  const b = await castVote({ ...w, llm: down }, w.world.proposal("plant-b", 85, 50, "Throughput"), "plant-b/LV-101");
  check("outage: plant-b keeps the rule", b.vote === "no" && b.evidenceRuleIds.length > 0, b);
}

// Item 6b: a yes vote has no evidence path, so a short limit window must not turn it into a safe no.
{
  const w = demoWorld();
  const proposal = w.world.proposal("plant-a", 65, 50, "Counter-proposal");
  const llm = limitedFor(400, safe);
  const v = await castVote({ ...w, llm }, proposal, "plant-a/TK-101");
  check("429: a 400 ms limit window does not lose a yes vote", v.vote === "yes", v);
}

// Item 5: settled rows give a rule floor of 80, under threshold 81.
{
  const w = demoWorld("settled");
  const rule = w.world.companyRules.find((r) => r.model === "outlet-valve-A");
  check(`cliff setup: rule floor below threshold (${rule?.consequence.value})`, rule?.consequence.value === 80);
  const plantB = w.world.proposal("plant-b", 85, 50, "Throughput");
  const v = await castVote({ ...w, llm: predicts(88) }, plantB, "plant-b/LV-101");
  check("cliff: prediction past threshold rests on the rule", v.vote === "no" && v.reason.includes(rule?.id ?? "?") && !/^(\[[^\]]*\] )?insufficient history/i.test(v.reason), v);
  const plantB2 = w.world.proposal("plant-b", 85, 50, "Throughput");
  const quiet = await castVote({ ...w, llm: down }, plantB2, "plant-b/LV-101");
  check("cliff: LLM down still names the rule", quiet.vote === "no" && quiet.reason.includes(rule?.id ?? "?"), quiet);
}

// Item 8: company rules have null component ids by contract, so the caption must read the source plant from the text.
{
  const w = demoWorld();
  const rule = w.world.companyRules.find((r) => r.model === "outlet-valve-A")!;
  check("caption: company rule ids are null, as the contract test pins", rule.condition.componentId === null);
  check("caption: source plant is in the rule text", rule.text.match(/first learned in (plant-[ab])/)?.[1] === "plant-a");
  const pages = sourceFiles(join(ROOT, "web")).filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));
  const gated = pages.filter((f) => /condition\??\.componentId/.test(readFileSync(f, "utf8")));
  if (!pages.length) console.log("SKIP caption: web/ has not landed");
  else check(`caption: no web source gates on condition.componentId (${pages.length} files)`, gated.length === 0);

  // Both captions from the real dashboard logic, over the state a real demo leaves behind.
  const derivePath = join(ROOT, "web", "lib", "derive.ts");
  if (!existsSync(derivePath)) console.log("SKIP caption: web/lib/derive.ts has not landed");
  else {
    const { captionFor } = await import(derivePath);
    const event = await executeSafeRun(w);
    const blocked = async (plant: "plant-a" | "plant-b", from: number, parent: string | null) => {
      w.world.clock += 40_000;
      const p = w.world.proposal(plant, 85, from, "Throughput", parent);
      p.votes = await Promise.all(p.requiredVoters.map((id) => castVote({ ...w, llm: predicts(88), fastNoMs: 100 }, p, id)));
      p.status = p.votes.some((v) => v.vote === "no") ? "blocked" : "veto_window";
      return p;
    };
    await blocked("plant-a", 65, null);
    await blocked("plant-b", 50, null);
    const plants = { "plant-a": await w.glue.plant("plant-a"), "plant-b": await w.glue.plant("plant-b") };
    const company = { plants: ["plant-a", "plant-b"], sharedResources: [], rules: w.world.companyRules, crossPlantProposals: [], audit: [] };
    const b = captionFor("plant-b", plants, company);
    check(`caption: plant-b view reads "${b?.text ?? "nothing"}"`, b?.kind === "plant-learned" && b.text === "Plant B learned from Plant A." && b.rule.id === rule.id);
    const a = captionFor("plant-a", plants, company);
    check(`caption: plant-a view reads "${a?.text ?? "nothing"}" on evidence #${a?.evidenceNumber ?? "?"}`, a?.kind === "it-learned" && a.event.id === event.id && a.evidenceNumber === 1);
  }

  // The "not proof" note and the rule only reach the audience if the panel renders the reason.
  const views = [...sourceFiles(join(ROOT, "web", "components")), ...sourceFiles(join(ROOT, "web", "app"))];
  if (!views.length) console.log("SKIP display: web/components and web/app have not landed");
  else {
    check(`display: a view renders vote.reason (${views.length} files)`, views.some((f) => /\.reason\b/.test(readFileSync(f, "utf8"))));
    check("display: the It learned caption says the safe run is not proof", views.some((f) => /not proof/.test(readFileSync(f, "utf8"))));
  }
}

console.log(failed ? `${failed} checks failed` : "all checks passed");
process.exit(failed ? 1 : 0);

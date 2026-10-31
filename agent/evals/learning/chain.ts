// Repeated safe executions with no reset, as in rehearsals: do margins stay sane, and do both moments survive?
// Real vote.ts, learn.ts, LLM and applyCalibration, observed on the real tank model.
//   bun run agent/evals/learning/chain.ts [chains]
import { OPENAI_EFFORT, OPENAI_MODEL } from "../../llm.ts";
import { pace, usage } from "./llm.ts";
import { load } from "./real.ts";
import { World } from "./world.ts";

const chains = Number(process.argv[2] ?? 4);
const WALK = [65, 60, 68, 62, 70, 64];
const model = { model: OPENAI_MODEL, effort: OPENAI_EFFORT };
const pipe = await load(model, { fastNoMs: 60000 });

async function chain(index: number) {
  const world = new World(70000 + index * 7919, 65, "auto", "as-is", true);
  world.deriveAfterRecord("plant-a");
  world.deriveAfterRecord("plant-b");
  let speed = 50;
  let executed = 0;
  const blocked: string[] = [];
  const history: string[] = [];
  let lastEvent = "";
  for (const to of WALK) {
    const p = world.proposal("plant-a", to, speed, `Rehearsal step to ${to}`);
    await pace(p.requiredVoters.length);
    const recs = await Promise.all(p.requiredVoters.map((id) => pipe.cast(p, id, world)));
    p.votes = recs.map((r) => r.vote);
    const refusals = p.votes.filter((v) => v.vote === "no");
    if (refusals.length) {
      p.status = "blocked";
      blocked.push(...refusals.map((v) => `${speed}->${to} ${v.componentId.split("/")[1]}: ${v.reason.slice(0, 90)}`));
      continue;
    }
    const event = world.execute(p, p.votes);
    await pipe.learn(p, p.votes, event, world);
    lastEvent = event.id;
    speed = to;
    executed++;
    const c = (tag: string) => world.components.get(`plant-a/${tag}`)!.marginPct;
    history.push(`${to}:${c("LV-101")}/${c("TK-101")}/${c("E-101")}/${c("TV-101")}`);
  }
  await pace(2);
  const repeat = world.proposal("plant-a", 85, speed, "Operator forces 85");
  const a = await pipe.cast(repeat, "plant-a/LV-101", world);
  const plantB = world.proposal("plant-b", 85, 50, "Throughput");
  const b = await pipe.cast(plantB, "plant-b/LV-101", world);
  const margins = Object.fromEntries([...world.components].map(([id, c]) => [id.replace("plant-", ""), c.marginPct]));
  return {
    index,
    executed,
    blocked,
    history,
    margins,
    repeatNo: a.vote.vote === "no",
    newestFirst: a.vote.evidenceEventIds[0] === lastEvent,
    notProof: a.vote.reason.includes("not proof"),
    plantBNo: b.vote.vote === "no",
    ruleCited: b.vote.evidenceRuleIds.some((id) => id.startsWith("company-rule")),
  };
}

const results = await Promise.all(Array.from({ length: chains }, (_, i) => chain(i)));
for (const r of results) {
  console.log(`chain ${r.index}: executed ${r.executed}/${WALK.length}, margins LV/TK/E/TV after each run ${r.history.join(" ")}`);
  for (const line of r.blocked) console.log(`  blocked ${line}`);
  console.log(`  repeat 85 no ${r.repeatNo}, newest first ${r.newestFirst}, not-proof note ${r.notProof}; plant-b no ${r.plantBNo}, rule cited ${r.ruleCited}`);
}
const moved = results.flatMap((r) => Object.entries(r.margins).filter(([, m]) => m !== 10).map(([id, m]) => `${id}=${m}`));
console.log(`margins that moved: ${moved.length ? moved.join(", ") : "none"}`);
console.log(`OpenAI: ${usage.calls} calls, ${usage.tokens} tokens, peak ${Math.round(usage.peak)} in any 60 s, ${usage.rateLimited} 429s`);

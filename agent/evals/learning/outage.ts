// Both never-fake moments with the LLM failing instantly (a 429 burst or a bad key). No LLM calls, stub Llm only.
//   bun run agent/evals/learning/outage.ts
import type { Llm } from "../../llm.ts";
import { learnFromExecution } from "../../learn.ts";
import { RetrievalCache } from "../../retrieval.ts";
import { castVote } from "../../vote.ts";
import { WorldGlue } from "./real.ts";
import { World } from "./world.ts";

const failing: Llm = { complete: async () => { throw new Error("openai 429: rate limited"); } };
const world = new World(31337);
world.deriveAfterRecord("plant-a");
world.deriveAfterRecord("plant-b");
const glue = new WorldGlue(world);
const cache = new RetrievalCache();

const safe = world.proposal("plant-a", 65, 50, "Counter-proposal");
const fine: Llm = {
  complete: async () => ({ text: JSON.stringify({ vote: "yes", reason: "stub", predicted: { positionPct: 67, levelPct: 50, tempC: 74, dutyKw: 1150, steamKgH: 1950, headerBarg: 5.8 }, evidenceEventIds: [], evidenceRuleIds: [] }), provider: "openai", model: "stub", fallback: false }),
};
safe.votes = await Promise.all(safe.requiredVoters.map((id) => castVote({ glue, llm: fine, cache }, safe, id)));
const event = world.execute(safe, safe.votes);
await learnFromExecution({ glue, cache }, event, new Set(world.components.keys()));

const repeat = world.proposal("plant-a", 85, 65, "Operator forces 85 again");
const a = await castVote({ glue, llm: failing, cache }, repeat, "plant-a/LV-101");
const plantB = world.proposal("plant-b", 85, 50, "Increase throughput");
const b = await castVote({ glue, llm: failing, cache }, plantB, "plant-b/LV-101");

const show = (name: string, ok: boolean, v: typeof a) =>
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: vote ${v.vote}, evidence[0] ${v.evidenceEventIds[0] ?? "none"}, rules ${v.evidenceRuleIds.length}, reason: ${v.reason.slice(0, 160)}`);
show("repeat 85 with LLM down", a.vote === "no" && a.evidenceEventIds[0] === event.id, a);
show("plant-b 85 with LLM down", b.vote === "no" && b.evidenceRuleIds.length > 0, b);

// Applies candidate fixes to the frozen copy of agent/ under ~/ar-vendors, never to the shared checkout.
// Usage: bun run roundtrip/patch.ts rules-once fast-no-0   (run from the frozen agent folder)
import { readFileSync, writeFileSync } from "node:fs";

type Edit = { file: string; find: string; replace: string };

const PATCHES: Record<string, Edit[]> = {
  // One rules read per plant per proposal instead of two per voter.
  "rules-once": [
    {
      file: "vote.ts",
      find: "  const fetched = (await Promise.all([glue.rules(componentId, own.model), glue.rules(proposer.id, proposer.model)])).flat();\n",
      replace: "  const fetched = (await Promise.all([...new Set([own.plantId, proposal.plantId])].map((plantId) => sharedRules(deps, proposal.id, plantId)))).flat();\n",
    },
    {
      file: "vote.ts",
      find: "async function gatherContext(deps: VoteDeps, notified: Proposal, componentId: ComponentId): Promise<VoteContext> {\n",
      replace:
        "const ruleReads = new Map<string, Promise<LearnedRule[]>>();\n\n/** All rules a plant can see, read once per proposal. ruleApplies filters them per voter. */\nfunction sharedRules(deps: VoteDeps, proposalId: string, plantId: string): Promise<LearnedRule[]> {\n  const key = `${proposalId}|${plantId}`;\n  const cached = ruleReads.get(key);\n  if (cached) return cached;\n  const read = deps.glue.rules(`${plantId}/*`, \"*\");\n  ruleReads.set(key, read);\n  read.catch(() => ruleReads.delete(key));\n  if (ruleReads.size > 64) ruleReads.delete(ruleReads.keys().next().value as string);\n  return read;\n}\n\nasync function gatherContext(deps: VoteDeps, notified: Proposal, componentId: ComponentId): Promise<VoteContext> {\n",
    },
  ],
  // A proven no on a repeat is posted as soon as the reads finish.
  "fast-no-0": [{ file: "vote.ts", find: "export const FAST_NO_MS = 1500;", replace: "export const FAST_NO_MS = 0;" }],
  // The proposer checks less often while a proposal is open.
  "watch-2s": [{ file: "runtime.ts", find: "const BLOCK_POLL_MS = 800;", replace: "const BLOCK_POLL_MS = 2000;" }],
};

for (const name of process.argv.slice(2)) {
  const edits = PATCHES[name];
  if (!edits) throw new Error(`unknown patch ${name}`);
  for (const { file, find, replace } of edits) {
    const text = readFileSync(file, "utf8");
    if (!text.includes(find)) throw new Error(`${name}: ${file} no longer contains the expected line`);
    writeFileSync(file, text.replace(find, replace));
  }
  console.log(`patched ${name}`);
}

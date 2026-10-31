// Lets Node load agent/*.ts unchanged, because Bun in WSL cold-starts for minutes from /mnt/c.
// Usage: node --import ./agent/evals/vote/node-ts.mjs agent/evals/vote/real.ts ...
// EVAL_FIX=slope,thin,contradicted applies a candidate code change in memory, so it can be measured before anyone edits agent/.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const FIXES = {
  slope: [["retrieval.ts", "t.sum += row.after * weight;", 'const slope = event.metric === "speedPct" ? ({ "LV-101.positionPct": 1, "TV-101.steamKgH": 29.7, "TV-101.positionPct": 0.36, "E-101.dutyKw": 17.43 } as Record<string, number>)[`${own.tag}.${row.metric}`] ?? 0 : 0;\n      t.sum += (row.after + slope * (to - event.after)) * weight;']],
  thin: [["vote.ts", "const nearLimit = nearCritical(context, predicted) || changeNearCritical(context);", "const nearLimit = nearCritical(context, predicted) || nearCritical(context, context.estimates) || changeNearCritical(context);"]],
  contradicted: [["vote.ts", "const rows = context.retrieved.flatMap((e) => ownRows(e, context.own)).filter((r) => r.metric === metric);", "const rows = context.retrieved.filter((e) => e.after >= context.proposal.to).flatMap((e) => ownRows(e, context.own)).filter((r) => r.metric === metric);"]],
};
const active = (process.env.EVAL_FIX ?? "").split(",").filter(Boolean).flatMap((name) => FIXES[name]);

registerHooks({
  resolve(specifier, context, next) {
    const relative = specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier);
    return next(relative && context.parentURL?.endsWith(".ts") ? `${specifier}.ts` : specifier, context);
  },
  load(url, context, next) {
    if (!url.endsWith(".ts") || url.includes("node_modules")) return next(url, context);
    let source = readFileSync(fileURLToPath(url), "utf8").replaceAll("import.meta.dir", "import.meta.dirname");
    for (const [file, from, to] of active) {
      if (!url.endsWith(file)) continue;
      if (!source.includes(from)) throw new Error(`fix no longer applies to ${file}: ${from}`);
      source = source.replace(from, to);
    }
    return { format: "module-typescript", shortCircuit: true, source };
  },
});

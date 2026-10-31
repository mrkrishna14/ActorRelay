# Dashboard handoff

## Start
From web/: `bun install`, then `bun run dev` (http://127.0.0.1:3000).
Production: `bun run build`, then `bun run start`.
`NEXT_PUBLIC_GLUE_URL` optionally overrides http://127.0.0.1:7200. This variable is browser-visible; never put secrets in it.

## Integration
Polls GET /state?plantId=plant-a (or plant-b) every second. Expects {plant, components, company, mode}; filters all-ten-component arrays by selected plant. POST /propose, /counter, /veto, /reset follow TASK3.MD. Controls disabled if disconnected or plant response is stale after switching.

## Included
Equipment tree, native interactive SVG schematic, two plant views and company view, metrics and limits, prediction calibration, proposal/vote/evidence inspection, countdown veto, 120-second measurement samples, audit feed, and responsive layout.

## Honest fallbacks
Static web/mock/state.json is a disconnected preview fixture; always prominently labeled and controls disabled. Mock integration states are explicitly labeled. Dashboard never generates votes or conversational reasoning. Native SVG is a labeled schematic preview, pending the final diagram from Person 2. No backup video recording or external submission performed.

## Verification
Production build and strict TypeScript compilation. Parent owns final browser QA and integrated tests.

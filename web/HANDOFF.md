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
`bun x tsc --noEmit` and `bun run build` pass. Browser walkthrough at 1920x1080 against the mock API on 7200: Reset demo, Increase throughput to blocked (LV-101 no), Propose 65% to veto countdown to executed, plant-b block, and company view during a veto window and with a test rule. Not verified: the live-mode learning captions (mock mode never shows them), the reduced-motion rendering (CSS rule present, not emulated), and the final P&ID overlay (file absent).

## Completed UI contract details
All CSS UI text has an 18px minimum; process SVG retains a 950px minimum drawing width with horizontal scrolling so labels are readable. Equipment rows include status words. Proposal panel includes proposer identity and original/counter family. Voters have pulsing gray/green/red schematic outlines with reduced-motion support. Operator buttons: Increase throughput, Force P-100 → 85% (normal review, never bypasses votes), Propose 65% (kept because mock mode has no automatic counterproposal), Reset demo. The "It learned" caption appears only in live mode, only when a blocked proposal cites an execution recorded in this browser session, and links that event id; "Plant B learned from Plant A" is also live-only and links the cited company rule. Counterproposal cards nest under their parent with their own voters, status pill, and veto countdown.

Fixture preview dropdown explicitly selects static examples for all six proposal statuses; controls are disabled and no fixtures are sent upstream. When `/pid-tk-101.svg` becomes available it is used automatically on next page load, as sanitized inline SVG with tag-group selection, live labels, and voter outlines, plus equipment value/selection controls below. Script/event handlers, foreign content, embedded resources, style blocks, animation elements, and external references are removed before insertion. Until then the labeled interactive native schematic remains visible. Trends use actual sample timestamps across a fixed 120-second window, with maximum and critical limits.

The bottom layout pairs the timestamp-based 120-second trend with the operations timeline. SVG labels retain readable minimum widths and horizontal scrolling. Company rules show only source plants confirmed by included evidence records; unavailable provenance is explicitly marked.

Verification performed: production compilation and TypeScript pass; fixture JSON has all six Proposal.status values. The final external P&ID is absent, so its runtime overlay appearance remains unverified; fallback and loader source path are implemented.

Each plant view shows the other plant as a card (status and reporting count derived from the ten `components`, plus its shared-steam vote) and a cross-plant feed. /state returns only the requested plant's proposals, so rows for the other plant are built from `company.crossPlantProposals` and `company.audit`; a row with no outcome after 45 seconds reads "unresolved", and a veto window on the other plant reads "voting". The events feed merges plant and company audit with a plant badge on each row. The timing chart samples every component's key metric on each poll (P-100 speedPct, TK-101 levelPct, LV-101 positionPct, E-101 dutyKw, TV-101 steamKgH), so switching selection keeps its 120 seconds. A rule card slides into the company library the first time it is shown, with reduced-motion support.

Colour: red only for no/critical/blocked/vetoed, green for yes/ok/executed, amber for warning/voting/veto window, neutral grey for everything else. Schematic tags carry the vote word. Steam lines use lavender so they do not read as amber.

# Person 4 — Dashboard (web/)

You own `web/`. Read CLAUDE.md and shared/types.ts first. Do not touch actor/, bridge/, agent/, glue/. Use your design tools freely; the judges see only this.

## Layout (mirror the reference screenshot: project tree left, P&ID center, attributes right, timing chart and events bottom)
Next.js + Tailwind, one page, 1920×1080, dark control-room look. Top bar: "ActorRelay · simulated plant", plant switcher (plant-a / plant-b / company), tick counter, sim status.

- **Left (18%)**: tree. Company → plant-a → components; plant-b → components. Status dot and word per component. Clicking selects.
- **Center (52%)**: P&ID. Use `public/pid-tk-101.svg` from Person 2: the TK-101 drawing with `<g id>` on P-100, TK-101, LV-101, E-101, TV-101 (bare tags; the same SVG serves both plants, the switcher picks the data). Overlay live values next to each tag. Voters on an active proposal get a pulsing outline: grey while voting, green on yes, red on no. Below the P&ID a strip with operator buttons: "Increase throughput" (P-100 50 → 85), "Force P-100 → 85%", "Reset demo".
- **Right (30%)**: attributes and proposal panel. Top: selected component's metrics with limit bars, marginPct, last 5 calibration entries (predicted vs observed). Below: active proposal card: proposer, metric, from → to, rationale, each voter's row (vote word, predicted value, reason, evidence chips linking to events and rules). Status pill. Veto button with 10s countdown when in `veto_window`. Counter-proposal cards nest under their parent.
- **Bottom (20%)**: left, timing chart: last 120s of the selected component's key metric with limit lines; right, events feed from `audit` (proposal, vote, block, execute, rule_learned, calibration) newest first, each with plant badge.
- **Company view**: two plant cards with status and connection, shared resources (`steam-header-1` with live `headerBarg`, highlighted when a cross-plant vote is open), company rule library (text, timesSeen, which plants), cross-plant proposals feed.

## Design rules
Red only for no/critical/blocked/vetoed. Green for yes/ok/executed. Amber for warning/voting. Every color paired with a word. Smallest text 18px. Motion only with meaning: voter outline pulse, veto countdown, a rule card sliding into the company library, "It learned" caption when a block cites an event from the current session.

## Data flow
- By 13:00: renders entirely from shared/plants.json, shared/history.json, and a `web/mock/state.json` you write (one proposal in each status).
- By 14:30: `usePlant(id)`, `useComponent(id)`, `useCompany()` hooks over the Terse generated client (URL and key from actor/HANDOFF.md). Replace state on each broadcast. Operator buttons POST to glue (`/propose`, `/veto`, `/reset`). If live isn't ready at 14:30, poll glue `/state` JSON and tell Person 5.
- Never depend on fields outside types.ts.

## Demo assets (by 15:50)
- Three slides in the dashboard's visual language: problem (interconnected equipment, isolated agents, forgotten incidents), product (negotiate, remember, refuse, across plants), why both tools (Durable Actor per component = memory and serialized writes; Agent Relay = negotiation and cross-plant learning). Pitch line verbatim.
- Record the 90s backup video with Person 5 after the 14:30 run.
- Submit on Builderbase with Person 5 by 15:50.

## Do not
No actors, agents, or sim code. No extra screens. If stuck on design at 13:00, ship plain and iterate after live wiring.
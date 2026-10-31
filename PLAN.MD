# ActorRelay implementation plan

## What we are building
Two connected simulated plants where every equipment component has durable memory and an agent. Equipment agents review proposed operating changes using history, negotiate safer alternatives, and share learned rules across plants.

The demonstration must show an unsafe pump increase blocked with evidence, a safer counterproposal executed after a human veto window, measured results recorded, and a second plant benefiting from the shared knowledge.

## Three owners
| Owner | Builds | Owns |
|---|---|---|
| Person 1 | Durable actors and agents: state, limits, votes, retrieval, counterproposals, calibration, rules, and Relay conversations | actor/, agent/, shared/types.ts |
| Person 2 | Two running plant simulations, controls, live measurements, seed history, and diagram preparation | bridge/, shared/plants.json, shared/history.json, P&ID source |
| Person 3 | Dashboard and integration: service endpoints, live wiring, end-to-end tests, demo operations, and submission | web/, glue/, final diagram placement |

## Scope and technical contract
- Two plants, five components each: P-100 pump, TK-101 tank, LV-101 outlet valve, E-101 coil, TV-101 steam valve.
- The two plants share a steam header; affected equipment in the other plant must vote.
- Component, Plant, and Company actors persist state, history, calibration, proposals, and learned rules.
- Ten agents exchange proposals, votes, counterproposals, execution observations, and rules over Relay.
- All required votes must be yes before a 10-second human veto window. A no blocks the proposal. Missing votes expire after 30 seconds.
- Only the approved execution path may dispatch simulation writes. Validate the current proposal and limits immediately before dispatch; record acceptance separately from observed results.
- Agents retrieve evidence for every vote. Validate outputs and enforce safety thresholds in code. Learning means retrieval, calibration, and evidence-backed rule promotion.
- Python simulation on port 7300; Bun integration API on port 7200; Next.js dashboard. CLAUDE.MD defines fields, component limits, actor methods, and message contracts.
- This is a simulated plant demonstration. Keep that label visible.

## Build sequence
1. Contract and fixtures: Person 1 establishes the shared types; Person 2 supplies plant and history fixtures; Person 3 uses them for dashboard and API mocks. Agree on payloads before live wiring.
2. Parallel implementation: Person 1 builds actors and agents together; Person 2 proves meaningful simulation responses and reset; Person 3 builds the dashboard and integration service together.
3. First live path: Person 3 connects simulation snapshots to actors and dashboard, then connects proposals and Relay votes. Person 1 and Person 2 fix defects in their modules.
4. Complete execution: blocked proposal -> safer counterproposal -> unanimous approval -> veto window -> simulation write -> observed effects -> calibration and shared rules.
5. Integration gate: Person 3 runs headless tests and the full dashboard demo. Every owner supplies HANDOFF.md with commands, configuration names, contract examples, and known limitations.
6. Delivery: Person 3 coordinates final merges, reset/startup instructions, slides, recording, and submission.

## Interfaces and handoffs
- Person 1 -> Person 3: actor client, method signatures, Relay participants, agent startup, and error semantics. Keep credentials out of committed files.
- Person 2 -> Person 3: snapshot, setpoint, reset, and observed-effects endpoints, diagram, tick timing, and measured response ranges.
- Person 2 -> Person 1: generated history, plant limits, and verified physics summary for agent predictions.
- Person 3 -> both: endpoint URLs, validated request/response examples, integration failures, and final startup order.
- Changes to shared types need agreement from all three owners. Own your module; coordinate changes across boundaries.

## Acceptance gate
- Reset produces all ten component snapshots and clears prior pending work.
- Pump 50 -> 85 is blocked with real evidence and includes the other plant's steam-valve vote.
- A safer target, approximately 65, passes review and executes after the veto window; observed metrics settle within verified ranges.
- A repeated unsafe proposal cites the newest relevant observation without treating a safe run alone as proof of an unsafe outcome.
- Plant B cites a supported company rule from Plant A, or explicitly reports insufficient history until that rule exists.
- Invalid votes, duplicate votes, stale proposals, and unapproved writes are rejected. Retries must not duplicate a simulation command.
- Dashboard, actor state, command result, and measured trends agree. Do not mark recovery from command acceptance alone.
- No scripted conversation is presented as live agent reasoning. Any fallback is visibly labeled.

## Writing convention
Plans and product material describe ActorRelay's behavior and our module interfaces without naming underlying source projects or their origins. Follow the product writing rule in CLAUDE.MD.

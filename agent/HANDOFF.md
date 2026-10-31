# agent/ — HANDOFF (Person 1)

Ten component agents (one per component, both plants) that vote on proposals, counter-propose when blocked, and calibrate after execution. They talk over Agent Relay and read/write only through the Plant/Component/Company actors (never `setMetric`).

## Run
```sh
cd actor && terse actor dev            # local actors (or use the cloud: TERSE_ACTOR_URL + TERSE_API_KEY)
cd agent && bun install && bun run generate && bun src/spawn.ts
```
- `bun test tests`: 11 tests (fake backend): no on 85 with evidence, yes on 65, cross-plant header-pressure vote, insufficient history → company rule, malformed LLM → retry → safe no, calibration margin, counter = 65, newest run cited first, enforced no.
- `bun scripts/demo-check.ts`: live end-to-end check with the agents running (stands in for glue + simulator). Last run: **9/9 passed**. 85 blocked in 2.2 s with 6 events + 2 rules → counter 65 → unanimous → veto window → dispatch → executed → LV-101 predicted 66.6 / observed 67 → re-block in 2.2 s citing the new run first → plant-b blocked citing the plant-a company rule.

## Env (`agent/.env`, gitignored)
| Name | Meaning |
|---|---|
| `RELAY_WORKSPACE_KEY` | Agent Relay workspace (created for this project; ask Person 1 for the value) |
| `ANTHROPIC_API_KEY` | Claude agents (TK-101, E-101, TV-101) use `claude-opus-5-5` via the Anthropic SDK (structured output + server fallback) |
| `OPENAI_API_KEY` | Codex agents (P-100, LV-101) use the OpenAI Responses API (`CODEX_MODEL`, default `gpt-6.1-sol`) |
| `GLUE_URL` | If set, agents use glue routes (`/component/:id`, `/state`, `/similar`, `/rules`, `/vote`, `/counter`, `/calibration`) instead of the actors, and votes go Relay → glue |
| `AGENT_SUBMIT` | `actors` (default without glue: post vote on Relay **and** submit to Plant) or `relay` (post only; glue forwards) |
| `AGENT_COMPONENTS` | Comma list to run a subset; default all 10 |
| `AGENT_LLM=off` | Force the baseline |

Without an LLM key an agent runs the **baseline**, labelled `[baseline: no LLM configured]` in every vote reason: predictions fitted from the retrieved similar events (+ the newest run), raised to any applicable learned-rule floor, physics priors only where history is silent.

## Relay protocol (CLAUDE.MD)
One Relay participant per component (`ar-plant-a-lv-101`, …) on `#plant-a`, `#plant-b`, `#company`; JSON in the message text: `proposal`, `vote`, `counter`, `executed`, `rule`. Cross-plant votes go to `#company`. Glue should publish `proposal` and `executed`; agents publish `vote` and `counter`.
- Startup does not wait for Relay: agents vote from the first poll; Relay connects in the background. Tokens and joined channels are saved in `agent/.relay-agents.json`, so later starts only reconnect.
- The hosted Relay service intermittently returns `503 database_overloaded` / `429 write capacity busy`; all calls retry with its retry-after. When it is slow, the 2 s poll of the Plant actors keeps the agents voting.

## Contract enforced in code (`src/predict.ts`)
- `similar()` is called with the proposer's component + metric; "similar" = within ±15 of the target; `similarCount` = that count.
- `< 3` similar events and a prediction within 15 % of critical → `no` ("insufficient history"). Prediction ≥ `critical × (1 − margin)` → `no`. The Plant actor enforces the same again.
- Evidence ids only from retrieved events (newest run first) and applicable rules; LLM output validated with zod, one re-request, then a safe `no` ("malformed prediction").

## Known limits
- No LLM keys on this machine yet → every vote is the labelled baseline.
- `shared/history.json` not in the repo yet; tests and demo-check use `actor/tests/fixtures.ts`.
- In the 9/9 run the agents' Relay connection was still being set up (service overloaded), so votes reached the Plant by polling + direct submit; the Relay message round trip itself was verified separately.

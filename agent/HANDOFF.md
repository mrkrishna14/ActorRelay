# Agent handoff (Person 1)

Ten component agents on Relay. Each agent retrieves evidence, asks a model for a prediction, and has that prediction checked in code before it votes. Agents never touch `setMetric` or the simulator. The only things an agent can send are a vote, a counter, a calibration entry and a rule proposal.

## What runs

| File | Job |
|---|---|
| `spawn.ts` | Process entry. Registers 10 agent identities and the system participant, joins `plant-a`, `plant-b`, `company`, serves `/publish` and `/health`. |
| `system.ts` | System participant. `POST /publish` takes glue's `{type, payload, channels}`. Forwards agents' votes and counters to glue after checking the sender. |
| `runtime.ts` | What agents do with each Relay message. Transport is injected. |
| `vote.ts` | Vote pipeline and every safety rule. |
| `counter.ts` | Counter-proposals. |
| `learn.ts` | Calibration and rule proposals. |
| `retrieval.ts` | Relevance band, effect rows, rule matching, cache. |
| `llm.ts` | Model calls, vendor routing, labelled fallback. |
| `glue.ts` | Typed glue client. `schemas.ts` holds zod schemas for `shared/types.ts`. |
| `roles/*.md`, `physics.md` | Four role prompts, the shared contract, the physics summary. Edit `physics.md` if live values differ from `CLAUDE.MD`. |

## Commands

Run the agents inside WSL, because Relay answers on `127.0.0.1:8787` there and not from Windows. Start order: Relay, actors, adapter, simulator, glue, then agents.

```bash
wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/relay/start-relay.sh"
```

```bash
wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/run-wsl.sh"
```

`run-wsl.sh` copies the code to `~/.actorrelay/agent-run` because loading `node_modules` from `/mnt/c` takes minutes. Re-run it to pick up code changes. Ready line: `ready: 10 agents on plant-a, plant-b, company; RELAY_PUBLISH_URL=http://127.0.0.1:7201/publish`.

Tests, from `agent/`:

```bash
bun test --timeout 30000 tests/vote.enforce.test.ts tests/learn.test.ts tests/counter.test.ts tests/runtime.test.ts tests/vote.real.test.ts
```

Proof over real Relay, inside WSL, from the repo root. It starts the agents itself against an in-process fake glue:

```bash
bun run agent/tests/live-relay-proof.ts
```

## Environment

| Name | Default | Meaning |
|---|---|---|
| `GLUE_URL` | `http://127.0.0.1:7200` | Glue service |
| `RELAY_URL` | `http://127.0.0.1:8787` | Relay server. `RELAY_BASE_URL` also works. |
| `RELAY_WORKSPACE_KEY` | unset | Join this workspace. Unset: reuse the stored one, or create one. |
| `RELAY_TOKENS_FILE` | `agent/.relay-tokens.json` in the run directory | Stored workspace key and agent tokens, gitignored. Use your own file for a separate run. |
| `SYSTEM_PORT` | `7201` | `/publish` and `/health` |
| `RELAY_TOKEN` | unset | If set, `/publish` requires it as a bearer token. Glue sends the same variable. |
| `OPENAI_API_KEY` | from repo `.env` | Model calls |
| `AGENT_OPENAI_MODEL`, `AGENT_OPENAI_EFFORT` | `gpt-6-luna`, `none` | Model for OpenAI calls |
| `AGENT_CLAUDE_MODEL`, `CLAUDE_BIN` | `haiku`, auto | Claude CLI model and binary |

Glue needs `RELAY_PUBLISH_URL=http://127.0.0.1:7201/publish`.

## Relay wire format

The text of every message is one JSON object:

```
{"type":"proposal","proposal":Proposal}
{"type":"vote","vote":Vote}
{"type":"counter","parentProposalId":id,"proposal":{plantId,proposerComponentId,metric,to,rationale}}
{"type":"executed","proposalId":id,"event":HistoryEvent}
{"type":"rule","rule":LearnedRule}
```

Relay names are the ComponentId with `/` replaced by `-`, for example `plant-a-LV-101`. `Vote.agentId` stays `agent:plant-a/LV-101`. The system identity is `actorrelay-system`.

- `proposal`, `executed` and `rule` are only obeyed from the system identity.
- A vote is forwarded only from its own component's identity, once per proposal and component.
- A cross-plant voter posts on `company`. Everyone else posts on the proposal's plant channel.
- There is no `blocked` message, so the proposer polls `GET /state` every 800 ms until its proposal settles.

Glue routes used: `GET /component/:id`, `GET /similar?componentId&metric&to&k&upstreamSnapshot` (JSON string), `GET /rules?componentId&model`, `GET /state?plantId` (reads `plant.proposals`, `plant.history`), `POST /vote`, `/counter`, `/calibration`, `/rule`. `/similar` and `/rules` may return a bare array or `{events}` / `{rules}`.

## Decisions a reader needs

**similarCount.** `similar()` is k-nearest with no cutoff, so plant-b at 85 gets five events from 40 to 65. An event counts only if its `after` is within 15% of the changed metric's range of the proposed `to` (10.5 points for P-100). `similarCount` is the length of that list, which is exactly what the model is shown.

**Newest run.** `similar()` never returns a safe 65 run when asked about 85, so the newest execution is read from `plant.history` (`proposalId` not null). It is `evidenceEventIds[0]`, it is shown to the model as context, and it is not counted in `similarCount`, so `evidenceEventIds` can be one longer than `similarCount`. A `no` rests on the prediction and on runs that reached the limit; the reason says the newest run is not proof when it was safe.

**Force-no order.** A binding rule cites the rule. Otherwise fewer than 3 similar events with a prediction, or the change itself, within 15% of critical gives `insufficient history`. Otherwise a prediction at or past `critical × (1 − marginPct/100)` gives a threshold `no`. Evidence and binding rules raise the prediction, so a model that predicts low cannot pass a change history already shows as unsafe. Code never turns a `no` into a `yes`.

**Malformed.** Bad JSON, a missing limited metric, an implausible value, or a `no` with no prediction behind it gets one re-request, then `{vote:"no", reason:"malformed prediction", predicted:{}}`.

**Slow models.** A `no` already proven by evidence or a rule is posted at 6 s on a first block and 1.5 s when a live execution exists, whether or not the model has answered. The reason then starts `[decided from retrieved evidence; the model did not answer in time]`. A `yes` always waits for the model.

**Counters.** The ceiling is `threshold × (1 − margin/100)`, 72.9 for LV-101 at margin 10. Candidates are multiples of 5 between `from` and `to` whose highest observed row stays under the ceiling. The model picks from those; if it fails twice, code picks the largest one with at least 3 safe runs and says so in the rationale. Max 2 per root proposal. A forced repeat of a target already countered gets no counter.

**Rules.** After a `no` backed by at least 3 evidence ids, and after any execution that crosses a limit, an agent looks for at least 3 runs sharing the crossing and posts a rule through `/rule`, with an id derived from its content. Rule ids and support ids come only from retrieved data.

**Reset.** `plant.history` and `/rules` are the truth whenever they can be read. The local cache is used only if those reads fail, so a reset between demo takes needs no signal to agents.

## Vendor truth

`vote.reason` always ends `[answered by <provider> <model>]`, and the same goes for counter rationales. Mechanic roles run on OpenAI (`gpt-6-luna`, effort `none`). Claude roles call the installed Claude Code CLI headless. Its login has expired here and cannot be renewed without the user, so every Claude role currently votes through OpenAI with the reason prefix `[GPT fallback: Claude CLI unavailable]`. The CLI is retried every 60 s, so a fresh login takes effect without a restart. **No Claude-role vote has actually run on Claude yet, and no Claude CLI latency has been measured.** `GET :7201/health` reports `claudeCli`.

## Verified, and what is stubbed

- `tests/*.test.ts` run on a fake glue built from `shared/plants.json`. History is `shared/history.json` if it exists, otherwise the labelled stand-in `actor/tests/fixtures-gen/history.json`. `shared/history.json` has not landed, so every result here is on the stand-in.
- `tests/vote.real.test.ts` and `tests/live-relay-proof.ts` make real OpenAI calls. The proof also uses a real Relay server. Neither touches real actors, glue or the simulator.
- `tests/scripted-llm.ts` is a test double and exists only under `tests/`. Production code has no stub flag.

## Known limits

- Margin trap: TK-101 `tempC` critical 85 means a `marginPct` of 12 or more puts the threshold under the 75 °C setpoint, so TK-101 then votes `no` on every proposal until reset. This is the literal rule, kept on purpose.
- Plant-b voters other than LV-101 vote `insufficient history` on 85 until they have 3 similar events, so they block too. That is correct per `CLAUDE.MD`.
- A cross-plant voter's `steamKgH` prediction is replaced by its live value, because its own controller holds that flow.
- `Vote` has no vendor field, so the label lives in `reason`.

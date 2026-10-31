# Agent handoff (Person 1)

Ten component agents on Relay. Each agent retrieves evidence, asks a model for a prediction, and has that prediction checked in code before it votes. Agents never touch `setMetric` or the simulator. The only things an agent can send are a vote, a counter, a calibration entry and a rule proposal.

## What runs

| File | Job |
|---|---|
| `spawn.ts` | Process entry. Registers 10 agent identities, joins `plant-a`, `plant-b`, `company`, serves `/health`. |
| `wire.ts` | Relay message format shared with `glue/relay.ts`. |
| `workspace.ts` | The Relay workspace key glue and the agents share. |
| `runtime.ts` | What agents do with each Relay message. Transport is injected. |
| `vote.ts` | Vote pipeline and every safety rule. |
| `counter.ts` | Counter-proposals. |
| `learn.ts` | Calibration and rule proposals. |
| `retrieval.ts` | Relevance band, effect rows, rule matching, cache. |
| `llm.ts` | Model calls, vendor routing, labelled fallback. |
| `glue.ts` | Typed glue client. `schemas.ts` holds zod schemas for `shared/types.ts`. |
| `roles/*.md`, `physics.md` | Four role prompts, the shared contract, the physics summary. Edit `physics.md` if live values differ from `CLAUDE.MD`. |

Glue owns the Relay system participant (`glue/relay.ts`). Agents do not run one.

## Commands

Run the agents inside WSL, because Relay answers on `127.0.0.1:8787` there and not from Windows. Start order: Relay, actors, adapter, simulator, workspace key, glue, agents.

```bash
wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/relay/start-relay.sh"
```

Create the shared workspace once, inside WSL, after `run-wsl.sh` has installed dependencies:

```bash
cd ~/.actorrelay/agent-run/agent && bun run workspace.ts
```

Start glue with the same workspace, inside WSL:

```bash
RELAY_WORKSPACE_KEY="$(cat ~/.actorrelay/relay-workspace-key)" RELAY_BASE_URL=http://127.0.0.1:8787 GLUE_MODE=live bun run glue/server.ts
```

Start the agents:

```bash
wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/run-wsl.sh"
```

`run-wsl.sh` copies the code to `~/.actorrelay/agent-run` because loading `node_modules` from `/mnt/c` takes minutes. Re-run it to pick up code changes. Ready line: `ready: 10 agents on plant-a, plant-b, company; health on 127.0.0.1:7201`.

Tests, from `agent/`:

```bash
bun test --timeout 30000 tests/vote.enforce.test.ts tests/learn.test.ts tests/counter.test.ts tests/runtime.test.ts tests/vote.real.test.ts
```

Proof over real Relay, inside WSL, from the repo root. It starts the agents itself and uses glue's real `RelayBridge`, in its own workspace:

```bash
bun run agent/tests/live-relay-proof.ts
```

## Environment

| Name | Default | Meaning |
|---|---|---|
| `GLUE_URL` | `http://127.0.0.1:7200` | Glue service |
| `RELAY_URL` | `http://127.0.0.1:8787` | Relay server. `RELAY_BASE_URL` also works. |
| `RELAY_WORKSPACE_KEY` | from `RELAY_KEY_FILE` | Workspace shared with glue. |
| `RELAY_KEY_FILE` | `~/.actorrelay/relay-workspace-key` | Where the key lives. Created if missing. |
| `RELAY_TOKENS_FILE` | `.relay-tokens.json` next to `spawn.ts` | Stored agent tokens, gitignored. Use your own file for a separate run. |
| `RELAY_SYSTEM_NAME` | `actorrelay-system` | Must match glue's. |
| `AGENT_HEALTH_PORT` | `7201` | `/health` |
| `OPENAI_API_KEY` | from repo `.env` | Model calls |
| `AGENT_OPENAI_MODEL`, `AGENT_OPENAI_EFFORT` | `gpt-6-luna`, `none` | Model for OpenAI calls |
| `AGENT_CLAUDE_MODEL`, `CLAUDE_BIN` | `haiku`, auto | Claude CLI model and binary |

## Relay wire format

The text of every message is `{"type": ..., "payload": ...}`, as `glue/relay.ts` sends and expects:

```
{"type":"proposal","payload":{"proposal":Proposal}}
{"type":"vote","payload":{"vote":Vote}}
{"type":"counter","payload":{"parentProposalId":id,"proposal":{plantId,proposerComponentId,metric,to,rationale}}}
{"type":"executed","payload":{"proposalId":id,"event":HistoryEvent}}
{"type":"rule","payload":{"rule":LearnedRule}}
```

Relay names are exactly `agent:<componentId>`, for example `agent:plant-a/LV-101`, because glue checks the sender against that. Relay accepts this format; it was tested.

- `proposal`, `executed` and `rule` are only obeyed from the system identity. The payload is validated first, and anything else is dropped.
- A cross-plant voter posts on `company`. Everyone else posts on the proposal's plant channel.
- If a Relay post fails, the vote or counter goes to glue directly over HTTP. A duplicate vote is rejected by the actors.
- There is no `blocked` message, so the proposer polls `GET /state` every 800 ms until its proposal settles.
- Calibration entries and rule proposals go over HTTP: `POST /calibration`, `POST /rule`.

Glue routes used: `GET /component/:id`, `GET /similar?componentId&metric&to&k&upstreamSnapshot` (JSON string), `GET /rules?componentId&model`, `GET /state?plantId` (reads `plant.proposals`, `plant.history`), `POST /vote`, `/counter`, `/calibration`, `/rule`. `/similar` and `/rules` may return a bare array or `{events}` / `{rules}`.

## Decisions a reader needs

**similarCount.** `similar()` is k-nearest with no cutoff, so plant-b at 85 gets five events from 40 to 65. An event counts only if its `after` is within 15% of the changed metric's range of the proposed `to` (10.5 points for P-100) and it has rows for this voter. A cross-plant voter has no rows of its own, so its events count without them. `similarCount` is the length of that list, which is exactly what the model is shown.

**Newest run.** `similar()` never returns a safe 65 run when asked about 85, so the newest execution is read from `plant.history` (`proposalId` not null). It is `evidenceEventIds[0]`, it is shown to the model as context, and it is not counted in `similarCount`, so `evidenceEventIds` can be one longer than `similarCount`. A `no` rests on the prediction and on runs that reached the limit; the reason says the newest run is not proof when it was safe.

**Direction.** Evidence for peaks only comes from runs that moved the way the proposal does. In the real history a step down heats the tank past 76.5 °C, and that says nothing about a step up. The table shown to the model marks such runs.

**Force-no order.**
1. A binding rule: its consequence is at or past this voter's threshold. The reason cites the rule.
2. Insufficient history: no similar event for an increase; or fewer than 3 similar events with a prediction, or the change itself, within 15% of critical. For a change near critical, only runs within 5% of the range of the target count as close.
3. A prediction at or past `critical × (1 − marginPct/100)`, or under the metric's `min`.

History raises the prediction: if a run that went no further than the target reached the threshold, or the nearest runs average past it, that value stands whatever the model says. Code never turns a `no` into a `yes`. The model's `no` can be sent back once, either because no prediction supports it, or because every similar run contradicts it.

**Malformed.** Bad JSON, a missing limited metric, an implausible value, or a `no` with no prediction behind it gets one re-request. After that, a `no` that evidence already proves is posted with the evidence, labelled `malformed prediction from the model`. Otherwise it is `{vote:"no", reason:"malformed prediction", predicted:{}}`. A failed read of `/component`, `/similar` or `/rules` gives `reason:"retrieval failed"`.

**Slow models.** A `no` already proven by evidence or a rule is posted at 6 s on a first block and 1.5 s when a live execution exists, whether or not the model has answered. The reason then starts `[decided from retrieved evidence; the model did not answer in time]`. A `yes` always waits for the model.

**Counters.** The ceiling is `threshold × (1 − margin/100)`, 72.9 for LV-101 at margin 10. A metric that normally runs above that line, like TK-101 `tempC`, uses its threshold instead. Candidates are multiples of 5 between `from` and `to` whose highest observed row stays under the ceiling. A candidate needs at least 3 safe runs that reached it, because runs stopping just short of 70 say nothing about 70. Code fixes the target as the largest such candidate, because a free choice sometimes landed on 60 and the demo needs about 65. With none, there is no counter. The model confirms it and writes the rationale; if it fails twice, the rationale says code chose. Max 2 per root proposal. A forced repeat of a target already countered gets no counter.

**Rules.** After a `no` backed by at least 3 evidence ids, and after any execution that crosses a limit, an agent looks for at least 3 runs sharing the crossing, with no safe run in the same range, and posts a rule through `/rule`, with an id derived from its content. Rule ids and support ids come only from retrieved data.

**Reset.** `plant.history` and `/rules` are the truth. The local cache only covers a failed history read, so a reset between demo takes needs no signal to agents.

**Proposal copy.** When the actors hold the proposal, their copy is what gets voted on, not the Relay message.

## Vendor truth

`vote.reason` ends `[answered by <provider> <model>]`, and the same goes for counter rationales. Mechanic roles run on OpenAI (`gpt-6-luna`, effort `none`). Claude roles call the installed Claude Code CLI headless. Its login has expired here and cannot be renewed without the user, so every Claude role currently votes through OpenAI with the reason prefix `[GPT fallback: Claude CLI unavailable]`. The CLI is retried every 60 s, so a fresh login takes effect without a restart. `claude` is not installed inside WSL, so a login also needs `CLAUDE_BIN` or an install there. **No Claude-role vote has actually run on Claude yet, no Claude CLI latency has been measured, and while this lasts the system runs on one vendor.** `GET :7201/health` reports `claudeCli`.

## Verified, and what is stubbed

- `tests/*.test.ts` run on a fake glue built from `shared/plants.json`. History is `AGENT_TEST_HISTORY` if set, then `shared/history.json` if it exists, otherwise the labelled stand-in `actor/tests/fixtures-gen/history.json`. Suites were run on both the stand-in and Person 2's history from `origin/person2-simulation`.
- `tests/vote.real.test.ts` makes real OpenAI calls. `tests/live-relay-proof.ts` adds a real Relay server and glue's real `RelayBridge`. Neither touches real actors, glue's HTTP server or the simulator.
- `tests/scripted-llm.ts` is a test double and exists only under `tests/`. Production code has no stub flag.
- Measured on the Relay proof, with the machine under heavy load from other sessions (load average about 17): repeat 85, publish to LV-101's `no` at glue's bridge 1.8 s, leaving the sweep to finish inside 5 s. One Relay hop is about 120 ms unloaded. Under this load, posts from other voters took 1 to 4 s to reach glue, so stop sweeps before the demo.
- Restart with stored tokens reconnects without `name_conflict`; that was run. Losing the tokens file while keeping the workspace does give `name_conflict`, because registration is create-only. Delete `~/.actorrelay/relay-workspace-key` to start a fresh workspace, then restart glue too.

## Known limits

- Rate limits: model failures become safe votes, so an OpenAI 429 shows up as `malformed prediction`. Stop eval sweeps on this key during e2e and the demo.
- Margin trap: TK-101 `tempC` critical 85 means a `marginPct` of 12 or more puts the threshold under the 75 °C setpoint, so TK-101 then votes `no` on every proposal until reset. This is the literal rule, kept on purpose.
- Plant-b voters other than LV-101 vote `insufficient history` on 85 until they have 3 close events, so they block too. That is correct per `CLAUDE.MD`.
- A cross-plant voter's `steamKgH` prediction is replaced by its live value, because its own controller holds that flow.
- `Vote` has no vendor field, so the label lives in `reason`.
- A `no` from a voter with no usable prediction (`malformed prediction`) gives the counter nothing to bound, so no counter follows it.

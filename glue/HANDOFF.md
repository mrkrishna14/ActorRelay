# Glue handoff

## Run
From glue/: `bun install`, then `bun run server.ts`. Defaults: 127.0.0.1:7200, GLUE_MODE=mock. Dashboard polls GET /state?plantId=plant-a every second. State is `{plant, components, company, mode, integrations, mockNotice?}`. Components includes both plants to support company cards. POST /propose and /counter return `{proposal, mode}`. Errors are `{error, details?}` with non-2xx status.

## Current capability
Mock mode is an explicit interactive fixture for dashboard wiring, not agent reasoning, durable actors, or a physical simulation. Bad pump proposals receive fixture votes after 900ms. Safe proposals reach a ten-second veto window, then fixture execution values. Counterproposals are explicit POST /counter, not automatic agent output. Reset invalidates pending fixture timers. Seed values match the shared component contract. The local mock fixture was copied from the current plant fixture and does not modify shared/.

Live mode is fail-closed and needs an actor port from Person 1. Set GLUE_MODE=live and either ACTOR_CLIENT_MODULE (a path to a module exporting `createActorPort()` or a default `{read, call}`; it wins if both are set) or ACTOR_API_URL (plus optional ACTOR_API_TOKEN, sent as `Authorization: Bearer`).

The `/rpc` actor contract: glue sends `POST <ACTOR_API_URL>/rpc` with `{operation:"read", kind, id}` or `{operation:"call", kind, id, method, args}`. `kind` is Component, Plant, or Company. Reply 2xx with `{result: value}` or the bare value; reply non-2xx with `{error}`. A 5xx or an unreachable service becomes 503 from glue; other statuses pass through. The timeout is 8 seconds.

POST /execute-callback requires `Authorization: Bearer <EXECUTION_CALLBACK_TOKEN>`. If that variable is unset, every callback gets 401.

Glue reads actor state and runs the execution path in live.ts: it checks unanimous votes, the elapsed veto deadline, and current limits, calls `Plant.authorizeExecution(proposalId)`, which must return `{authorized:true, token, expiresAt, proposalId}`, dispatches to the simulation, then calls `Component.setMetric(metric, value, proposalId, token)`. `authorizeExecution` and the token argument are additions to the actor methods in CLAUDE.MD, so Person 1 must implement them. Only `plant-*/P-100` `speedPct` writes are allowed. The local command journal (GLUE_JOURNAL_PATH, a SQLite file, default `.runtime/glue.sqlite`) prevents duplicate dispatch and must survive restarts. It also holds the Relay outbox and any registered Relay agent token, so keep it out of git. A retry after acceptance never redispatches. A failed or unconfirmed dispatch, or a crash mid-dispatch, is left for manual reconciliation and gets 409. If `setMetric` fails after the simulation accepted, the callback returns 502 with `details.accepted:true`, and retrying it reconciles without redispatch. A retry skips `setMetric` if the mirrored value already matches, so Person 1 must not rely on a retried `setMetric` for proposal status changes.

Simulation contract on SIM_URL (default `http://127.0.0.1:7300`): `GET /snapshot?plantId=` returns `{componentId: metrics}` for that plant, `POST /reset` takes `{}`, and `POST /setpoint` takes `{componentId, metric, value, proposalId, commandId}` and must acknowledge the applied value as a number or as `value`, `applied`, `appliedValue`, or `valueApplied`. Before dispatch, glue saves `feedM3h`, `headerBarg`, and `feedTempC` from the plant snapshot, using whichever are present, and records them as the observed event's `upstreamSnapshot`. Those are the keys history.json uses.

Mirroring: in live mode glue polls the simulation into actors every GLUE_TICK_MS (default 1000, minimum 100). A slow tick never overlaps the next one, and concurrent `/tick` calls, such as from a Plant alarm, share the one in flight. Failures are logged, once per distinct error, and polling continues. If the bridge pushes `/mirror`, set BRIDGE_PUSHES_MIRROR=1: the poller stays off and `/tick` becomes a no-op. The bridge must still post `/observed` after execution, because glue does not schedule that. `/observed` requires an accepted command, returns 409 otherwise, and does not record twice on retry.

Live reset reads shared/plants.json and shared/history.json from the checkout.

Relay uses `@agent-relay/sdk` in relay.ts. Set RELAY_WORKSPACE_KEY to register the system participant or RELAY_AGENT_TOKEN to reconnect; RELAY_BASE_URL and RELAY_SYSTEM_NAME are optional. Glue joins `plant-a`, `plant-b`, and `company`, and sends and receives JSON `{type, payload}` messages. Inbound vote, counter, calibration, and rule messages are accepted only when the authenticated sender name is `agent:<componentId>` and, for votes, equals `vote.agentId`. Whether Relay accepts that name format has not been tested. If Relay publish fails after the actor accepted `/propose`, `/counter`, `/observed`, or `/rule`, glue returns 502 with body `{error, details:{accepted:true, ...}}`; for `/propose` and `/counter`, `details.proposal` holds the accepted proposal. Do not resubmit. Unsent messages stay in the journal outbox, and a 5-second retry sends them once Relay is initialized. Relay startup runs once, so if it fails at boot, restart glue to connect. This has only been tested with fakes, not a real Relay workspace.

GET /health and live GET /state report `integrations`: `actors` means configured and is not verified, `relay` means connected, and `simulation` means a one-second `/snapshot` probe succeeded (cached for two seconds). /health also reports `simulationUrl` and `mirrorDriver`.

## Routes
GET /health; /state?plantId=; /component/:encodedId; /similar?componentId=&metric=&to=&k=; /rules?componentId=&model=.
POST /mirror, /tick, /propose, /vote, /counter, /veto, /execute-callback, /observed, /calibration, /rule, /reset. Shapes are documented by schemas.ts and TASK3.MD. Empty-body operations require JSON `{}`. All POST input is validated. Invalid JSON/fields return 400; missing callback token 401; conflicts 409; accepted upstream with a failed follow-up 502 (`details.accepted:true`); unavailable live upstream 503. CORS allows http://localhost:3000 and http://127.0.0.1:3000 by default (set CORS_ORIGIN for a single different frontend origin).

## Remaining handoffs
1. Person 1: real actor client/HTTP adapter, token flow, registered Relay participant, durable event dispatch, live startup commands.
2. Person 2: live snapshot/reset/setpoint and observed-effect callbacks; connect them through Person 1's authorized actor execution path.
3. Integration owner: set live config, run e2e.ts --live, and confirm no mock notice remains before claiming the live demo works.

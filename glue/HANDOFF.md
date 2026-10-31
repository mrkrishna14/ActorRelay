# Glue handoff

## Run
From glue/: `bun install`, then `bun run server.ts`. Defaults: 127.0.0.1:7200, GLUE_MODE=mock. Dashboard polls GET /state?plantId=plant-a every second. State is `{plant, components, company, mode, integrations, mockNotice?}`. Components includes both plants to support company cards. POST /propose and /counter return `{proposal, mode}`. Errors are `{error, details?}` with non-2xx status.

## Current capability
Mock mode is an explicit interactive fixture for dashboard wiring, not agent reasoning, durable actors, or a physical simulation. Bad pump proposals receive fixture votes after 900ms. Safe proposals reach a ten-second veto window, then fixture execution values. Counterproposals are explicit POST /counter, not automatic agent output. Reset invalidates pending fixture timers. Seed values match the shared component contract. The local mock fixture was copied from the current plant fixture and does not modify shared/.

Live mode is fail-closed and requires an actor HTTP adapter supplied by Person 1. Set GLUE_MODE=live and ACTOR_API_URL (plus optional ACTOR_API_TOKEN). The adapter must implement the same GET/POST paths as this API, including returning the state envelope, authorizing the callback with a one-time token, checking plan version and fresh measurements, durable command deduplication, one-time token handling, simulation dispatch, seed reset, and measured observation recording. The public /execute-callback is forwarded to that actor adapter; glue never directly writes to the simulation. This is a proposed integration boundary, not a claim the actor SDK exposes these REST paths.

Relay publishing is an HTTP transport boundary in relay.ts. Set RELAY_PUBLISH_URL to Person 1's registered system-participant publishing endpoint. It accepts `{type, payload, channels}`. Optional RELAY_TOKEN stays server-side. SDK registration, channel subscriptions and inbound Relay delivery are not implemented here; inbound vote/counter/calibration/rule HTTP routes are ready. Until that transport is supplied, live proposal/event publication returns 503. Publication failure after actor acceptance returns 502 with accepted:true; reconcile actor state rather than blindly retry. A durable outbox is still required in the actor adapter for production recovery.

## Routes
GET /health; /state?plantId=; /component/:encodedId; /similar?componentId=&metric=&to=&k=; /rules?componentId=&model=.
POST /mirror, /tick, /propose, /vote, /counter, /veto, /execute-callback, /observed, /calibration, /rule, /reset. Shapes are documented by schemas.ts and TASK3.MD. Empty-body operations require JSON `{}`. All POST input is validated. Invalid JSON/fields return 400; conflicts 409; unavailable live upstream 503. CORS allows http://localhost:3000 and http://127.0.0.1:3000 by default (set CORS_ORIGIN for a single different frontend origin).

## Remaining handoffs
1. Person 1: real actor client/HTTP adapter, token flow, registered Relay participant, durable event dispatch, live startup commands.
2. Person 2: live snapshot/reset/setpoint and observed-effect callbacks; connect them through Person 1's authorized actor execution path.
3. Integration owner: set live config, run e2e.ts --live, and confirm no mock notice remains before claiming the live demo works.

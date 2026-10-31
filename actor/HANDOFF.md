# actor/ — HANDOFF (Person 1)

Three durable actors: `Component`, `Plant`, `Company`. Source: `src/actors.ts` (actors), `src/logic.ts` (pure decision logic), `src/schemas.ts` (input validation), `src/types.ts` (exact copy of `shared/types.ts`).

## What runs
| | Where |
|---|---|
| Deployed (Terse Cloud) | `TERSE_ACTOR_URL=https://api.useterse.ai/cmvws418j00rbjy2a1uh73h7l/actors` (project `cmvws418j00rbjy2a1uh73h7l`) |
| Local | `cd actor && bun install && terse actor dev` → `http://127.0.0.1:7100`, project `local`, no key |

Commands (from `actor/`):
- `bun run test` — regenerates the client, then 24 tests: pure logic + real actors in an isolated local runtime.
- `bun run deploy` — copies `shared/types.ts` → `src/types.ts`, type-checks, deploys (keeps local dev state out of the upload).
- `bun run sync-types` — after an agreed change to `shared/types.ts`. A test fails if the copy drifts.
- `cd client && bun install && bun smoke.ts` — smoke test (local by default; cloud with the env below). Seeds both plants and proposes P-100 → 85.

## API key (cloud)
Create one at https://app.useterse.ai/app/api-tokens?name=terse_actorrelay-actor (Terse dashboard → API tokens). Put it in the calling app's `.env.local` (gitignored), never in git:
```
TERSE_ACTOR_URL=https://api.useterse.ai/cmvws418j00rbjy2a1uh73h7l/actors
TERSE_API_KEY=<your key>
```

## Generated client (glue, agents)
In the calling project: `bun add terse-sdk zod`, then `terse actor generate --language typescript` (with `TERSE_ACTOR_URL`/`TERSE_API_KEY` set for cloud, or with `terse actor dev` running for local). Use the server side only; browsers get state over WebSocket grants (`actors.Plant.prepareWebsocket(...)`).
```ts
import { actors } from "./generated/index.js"
const plant = actors.Plant.get("plant-a")
```

## Actor ids (important)
Actor ids may only contain letters, digits, `.`, `_`, `-`. So:
| Actor | id |
|---|---|
| Component | ComponentId with `/` → `.`: `plant-a/LV-101` → **`plant-a.LV-101`** |
| Plant | PlantId: `plant-a`, `plant-b` |
| Company | `company` |

All method arguments and results use the real ComponentId (`plant-a/LV-101`); only the `get(...)` id is dotted.

## State (what the dashboard renders)
- Socket state is exactly the types in `shared/types.ts` **minus `id`** (the base actor class reserves `id`; it is the actor id you connected to). `Component` adds `calibration: CalibrationEntry[]`.
- `read()` on each actor returns the exact type including `id`: `ComponentState & {calibration}`, `PlantState`, `CompanyState`.
- Every mutation pushes a state update to connected sockets automatically (`@Emittable`).

## Methods
All inputs are validated with zod (`src/schemas.ts`); a bad input throws `invalid <thing>: <field>: <problem>` and changes nothing.

### Component (`actors.Component.get("plant-a.LV-101")`)
| Method | Notes |
|---|---|
| `read(): ComponentState & {calibration}` | |
| `loadSeed(state: ComponentState & {calibration?})` | Plant.loadSeed calls this for you. |
| `mirror(metrics: Record<string, number>): status` | Merge live values; status = `warning` at `limit.max`, `critical` at `limit.critical`; sets `lastTick`. Call every tick. |
| `setMetric(metric, value, proposalId, token)` | Only works with the one-time token Plant mints after the veto window. Anything else is rejected. |
| `addCalibration(entry: CalibrationEntry)` | Keeps last 50; `absError` recomputed. Once ≥ 5 entries: mean error of last 5 > 10 % of range → `marginPct + 5` (max 25); < 3 % → `− 2` (min 5). |
| `setMargin(pct): number` | Clamped to 5..25. |

### Plant (`actors.Plant.get("plant-a")`)
| Method | Notes |
|---|---|
| `read(): PlantState` | |
| `loadSeed(plant: {id, name, components: ComponentState[]}, history: HistoryEvent[], options?: {vetoWindowMs?, voteTimeoutMs?, clock?})` | Full reset of this plant: seeds its 5 Components, registers models with Company, keeps events where `plantId` matches, replays them to build rules, shares rules with Company, starts the 1 s clock (`clock: false` to not). Defaults: veto 10 000 ms, vote timeout 30 000 ms. |
| `propose(p: {id?, proposerComponentId, proposerAgentId?, metric, from?, to, rationale, parentProposalId?}): Proposal` | `requiredVoters` = every other component reachable via upstream/downstream + other-plant components on a shared resource (`crossPlant`). `from` defaults to the current value. `to` must be within `[limit.min, limit.critical]`. Max 2 counters per parent. Re-sending the same `id` returns the existing proposal. |
| `vote(v: Vote): Proposal` | Rejects: unknown proposal, not `voting`, non-voter, duplicate voter, unknown evidence ids (same-plant voters). **Enforced in code:** a `yes` whose prediction ≥ `critical × (1 − marginPct/100)` of the voter, or with `similarCount < 3` and a prediction within 15 % of critical, is recorded as `no` with an `[enforced] …` reason. Any `no` → `blocked`; unanimous `yes` → `veto_window` (deadline now + 10 s) unless another window is open on the same proposer component (then it waits in `voting`). |
| `veto(proposalId, by): Proposal` | Only inside an open veto window. |
| `sweep(): Proposal[]` | Runs every 2 s on the clock: expires proposals missing votes after 30 s, opens queued windows, calls `execute` when a window passes. Callable by hand. |
| `execute(proposalId): DispatchView \| null` | Only after the window passed with unanimous yes. Re-checks: not stale (no newer execution on that component), `to` ≤ critical − margin. Creates one **pending dispatch**. Does not write to the simulation. Idempotent. |
| `pendingDispatches(): DispatchView[]` | Approved writes not yet reported. Durable: poll this. Also pushed as a socket message `{type: "dispatch", …}`. |
| `confirmDispatch(proposalId, result: {ok, applied?, error?}): DispatchView` | Glue reports the simulation write. `ok` → Component.setMetric (with token), proposal `executed`. Not ok → proposal `blocked` with the error. Idempotent. |
| `recordEvent(e: HistoryEvent): {event, rules}` | Observed effects (or any event). Idempotent by `e.id`. Promotes rules: ≥ 3 events of the same change at ≥ the 10-point bucket whose effect on one component crosses its `limit.max`. Shares rules with Company. |
| `promoteRule(r: LearnedRule): LearnedRule` | Agent-proposed rule; upsert by condition + consequence; shared with Company if the model exists in the other plant. |
| `similar(componentId, metric, to, upstreamSnapshot, k = 5): HistoryEvent[]` | **Call with the proposer's component and metric** (`plant-a/P-100`, `speedPct`); read your own rows in `effects`. Score `\|after − to\|/range + 0.5 × mean normalized upstream distance`; ties → most recent. |
| `heartbeat(): true` | Call when you mirror; `connected` stays true while heartbeats are < 3 s old. |
| `advanceTick(): number` | The tick (`tick` is a state field, so the method has another name). Runs on the clock; POSTs `GLUE_URL/tick` if that env var is set on the actor host (it is not, in the cloud). |
| `setClock(on: boolean)` | Start/stop the 1 s tick + 2 s sweep. |

### Company (`actors.Company.get("company")`)
| Method | Notes |
|---|---|
| `read(): CompanyState` | |
| `loadSeed({plants, sharedResources, rules?})` | Pass `plants.json`'s `company` object. Seed Company first. |
| `registerPlant(id, models?)` | Plant.loadSeed calls it. Rules waiting for a second plant are re-checked here. |
| `requiredCrossPlantVoters(proposal): ComponentId[]` | Records the id in `crossPlantProposals` when non-empty. |
| `promoteRule(r): LearnedRule \| null` | Kept only if `r.model` exists in another plant. Dedupe by tags of condition + consequence across plants; `timesSeen` = distinct supporting events; text starts "Learned in plant-a: …". |
| `recordAudit(a: AuditEntry)` | |

## Reset (glue `POST /reset`)
```ts
await actors.Company.get("company").loadSeed(plants.company)
for (const p of plants.plants) await actors.Plant.get(p.id).loadSeed(p, history)   // history = shared/history.json
```
Takes ~1–2 s per plant. Order does not matter for company rules.

## Execute flow (one-time token)
1. Unanimous `yes` → `veto_window`, `vetoDeadline` = now + 10 s. `veto()` works until then.
2. The 2 s sweep after the deadline calls `execute()` → re-checks → one pending dispatch `{proposalId, componentId, metric, value}`. Nothing is written yet; proposal stays `veto_window`.
3. Glue sees it (socket message or `pendingDispatches()`), sends `POST bridge /setpoint {componentId, metric, value, proposalId}` **once per proposalId**, then calls `confirmDispatch(proposalId, {ok: true, applied})` (or `{ok: false, error}`).
4. `confirmDispatch` mints an HMAC token for exactly `(proposalId, componentId, metric, value)`, calls `Component.setMetric(…, token)`, marks the dispatch `accepted` and the proposal `executed`. The Component refuses any other token and any reuse of a proposal id.
5. After the bridge observes 5 ticks, glue calls `recordEvent(event)` with `proposalId` set → rules update → glue broadcasts `executed`.
The token secret is `ACTORRELAY_EXECUTE_SECRET` on the actor host, with a demo default; glue never sees tokens.

## Examples
SDK:
```ts
import plants from "../shared/plants.json"
import history from "../shared/history.json"
import { actors } from "./generated/index.js"

// loadSeed
await actors.Company.get("company").loadSeed(plants.company)
await actors.Plant.get("plant-a").loadSeed(plants.plants[0], history)

// propose
const p = await actors.Plant.get("plant-a").propose({
  proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 85, rationale: "Increase throughput",
})
// p.requiredVoters = [plant-a/TK-101, plant-a/LV-101, plant-a/E-101, plant-a/TV-101, plant-b/TV-101], p.crossPlant = true

// vote
const evidence = await actors.Plant.get("plant-a").similar("plant-a/P-100", "speedPct", 85, { feedM3h: 15, headerBarg: 6 }, 5)
await actors.Plant.get("plant-a").vote({
  proposalId: p.id, componentId: "plant-a/LV-101", agentId: "agent:plant-a/LV-101", vote: "no",
  reason: "LV-101 would sit at ~89 %, past 81 % (critical 90 − margin 10 %)", predicted: { positionPct: 89 }, marginPct: 10,
  evidenceEventIds: evidence.map(e => e.id), evidenceRuleIds: [], similarCount: evidence.length,
})
```
curl (local runtime; for cloud use the SDK client, which handles the cloud routing and auth). Each call is `POST /v1/projects/local/actors/<Actor>/<id>/invoke` with `{"requestId": "<uuid>", "method": "<name>", "args": [ ... ]}`:
```sh
U=http://127.0.0.1:7100/v1/projects/local/actors
rid() { uuidgen | tr A-Z a-z; }
# loadSeed (Company)
curl -s -XPOST $U/Company/company/invoke -H 'content-type: application/json' \
  -d "{\"requestId\":\"$(rid)\",\"method\":\"loadSeed\",\"args\":[$(jq -c .company shared/plants.json)]}"
# propose
curl -s -XPOST $U/Plant/plant-a/invoke -H 'content-type: application/json' \
  -d "{\"requestId\":\"$(rid)\",\"method\":\"propose\",\"args\":[{\"proposerComponentId\":\"plant-a/P-100\",\"metric\":\"speedPct\",\"to\":85,\"rationale\":\"Increase throughput\"}]}"
# vote
curl -s -XPOST $U/Plant/plant-a/invoke -H 'content-type: application/json' \
  -d "{\"requestId\":\"$(rid)\",\"method\":\"vote\",\"args\":[{\"proposalId\":\"plant-a-p0001\",\"componentId\":\"plant-a/LV-101\",\"agentId\":\"agent:plant-a/LV-101\",\"vote\":\"no\",\"reason\":\"past threshold\",\"predicted\":{\"positionPct\":89},\"marginPct\":10,\"evidenceEventIds\":[],\"evidenceRuleIds\":[],\"similarCount\":0}]}"
```
Reply: `{"outcome":{"type":"completed","result":…}}` or `{"outcome":{"type":"failed","code":"actor_error","message":"…"}}`.

## Verified
- 24 tests pass (`bun run test`), including all six TASK1 tests, plus: enforced no on a yes past threshold, invented evidence rejected, block → counter → veto window → dispatch → accepted with single-use token, veto, non-voter/closed-proposal rejection, malformed input rejection, seeded plant-a rule reaching the company library.
- Local runtime: clock ticks once per second; unanimous yes → dispatch approved by the alarm sweep at ~12 s with the real 10 s window; confirmDispatch → `executed`, P-100 speedPct = 65.
- Cloud: deploys cleanly. Cloud smoke test (`client/smoke.ts` with the cloud env) still needs an API key run; see below.

## Known limits / stubbed
- `shared/history.json` is not in the repo yet; tests use `tests/fixtures.ts`, shaped like TASK2's requirements.
- Cloud actors cannot reach a laptop: `GLUE_URL` tick pull only works for local actors. Glue should push (`mirror` + `heartbeat`) and poll `pendingDispatches()`.
- `status` is high-side only (per spec); `offline` is the value before the first seed.

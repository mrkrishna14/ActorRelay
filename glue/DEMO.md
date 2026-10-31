# Person 3 startup and demo runbook

## Current status
The dashboard and integration service can run locally in labeled mock mode. Mock results verify the interface and request contracts; they do not verify durable actors, real agent reasoning, messaging delivery, or physical simulation responses. Live operation needs Persons 1 and 2's handoffs. Slides, backup video, final full-live rehearsal, and submission are pending until actually completed.

## Local mock preview
Run each server in a separate PowerShell session from the isolated `Factoryio-person3` checkout.

Session A — integration service:
```powershell
Set-Location glue
bun install
$env:GLUE_MODE = 'mock'
bun run start
```

Session B — dashboard:
```powershell
Set-Location web
bun install
bun run dev
```

Open `http://127.0.0.1:3000`. The API listens at `http://127.0.0.1:7200`. Keep the mock indicator visible. Use the dashboard's configured API URL if you change ports; see `web/HANDOFF.md` when supplied.

Session C — validation, from the checkout root:
```powershell
bun run glue/e2e.ts --smoke
bun run glue/e2e.ts --mock-journey
```

The first command checks state shape, malformed requests, reset, and proposal visibility. The optional mock journey checks the fixture block and safer counter through its ten-second veto window. These are mock checks, never live acceptance.

## Live startup order
1. Start actors using the exact command and deployed configuration in `actor/HANDOFF.md`. That handoff must define the integration adapter's supported routes or supply a client adapter. A URL alone is insufficient proof that the contract matches.
2. Start the simulation using `bridge/HANDOFF.md`; it must serve port 7300, accept validated simulation setpoints, report observed effects, and support reset.
3. Start glue with its documented live settings from `glue/HANDOFF.md` and `glue/.env.example`. Set these, with values from the owners; do not invent credentials:
   - `GLUE_MODE=live`
   - `ACTOR_CLIENT_MODULE` or `ACTOR_API_URL` (plus `ACTOR_API_TOKEN` if needed)
   - `EXECUTION_CALLBACK_TOKEN`, which the Plant actor sends as a bearer token on `/execute-callback`
   - `RELAY_WORKSPACE_KEY` or `RELAY_AGENT_TOKEN`, plus optional `RELAY_BASE_URL` and `RELAY_SYSTEM_NAME`
   - `SIM_URL` if the simulation is not on port 7300
   - `BRIDGE_PUSHES_MIRROR=1` if the bridge pushes `/mirror`; otherwise glue polls the simulation every `GLUE_TICK_MS`
   - `GLUE_JOURNAL_PATH`, kept across restarts during a run

   Check `http://127.0.0.1:7200/health` before continuing. `integrations.simulation` and `integrations.relay` must be true. `integrations.actors` only means configured, so confirm actors by loading `/state`.
4. Start the ten agent workers using `agent/HANDOFF.md`.
5. Start the dashboard and inspect connection status. Verify actual mode before operating.

Live acceptance, from the checkout root:
```powershell
bun run glue/e2e.ts --live
```
This command resets the simulated demo and proposes operating changes. It refuses to certify a mock API. It waits for actual votes and an agent-generated counterproposal; missing services or missing behavior must be fixed by the owning person.

Exit codes: `0` means the selected smoke checks passed, `1` means a check failed, and `2` means live acceptance or a required capability remains unverified. Read the printed mode and skipped checks. HTTP state alone cannot prove transport delivery, restart recovery, or command-journal durability.

## Reset
PowerShell, while glue is running:
```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7200/reset -ContentType 'application/json' -Body '{}'
```
Reset affects both plants. Confirm that active proposals clear and all ten components return before another take.

## Ninety-second walkthrough
- Show the simulated-plant label, mode, both plants, and normal measurements.
- Request pump speed 85 in Plant A; inspect the blocking vote, evidence, and shared-header reviewer.
- Show the safer counterproposal and unanimous votes. Explain the veto countdown, then observe the measured response.
- Repeat the unsafe request and inspect recent evidence alongside unsafe historical support.
- Switch to Plant B and inspect its cited company rule. If insufficient history is the actual result, say so; do not claim rule transfer.
- Show the audit timeline and calibration entries. Only call the run live if the live checks have established the integrations.

## Failure recovery
| Failure | Operator response |
|---|---|
| Dashboard stops | Restart web; inspect API health before retrying an action. A refresh must not submit another proposal. |
| Glue stops | Restart glue in the same explicit mode with the same `GLUE_JOURNAL_PATH`. Reconcile pending live commands with actor/gateway state before retries. Mock state is ephemeral. |
| Request returns 502 with `details.accepted: true` | The change was accepted and a follow-up step failed. Do not resubmit. Check `/state`. Queued messages retry automatically once Relay is connected; if Relay failed at startup, restart glue. |
| Actor service unavailable | Stop supervisory requests; restore the actor service, inspect current proposals, and reconcile outstanding execution before resuming. |
| Agent or messaging unavailable | Leave pending review unresolved. Restart workers and inspect deduplication; do not manufacture votes. |
| Simulation stops | Stop new execution; restore the simulation, refresh measurements, and reconcile command outcomes. Reset only as an explicit new demo run. |
| Command accepted but no response observed | Report outcome unknown; never mark measured recovery from acknowledgment alone. |
| Diagram asset missing | Use the clearly labeled schematic fallback until Person 2 supplies the final SVG. |

## Final delivery checklist
- Run the live acceptance checks, resolve failed checks, and separately verify skipped delivery/recovery capabilities.
- Rehearse the live dashboard three times and time it.
- Prepare three slides, record the backup video, and verify playback.
- Submit repository, description, slides, and video only when those artifacts exist. No recording or submission is implied by this runbook.

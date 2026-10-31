# Plant Mesh

## Product

Plant Mesh is an autonomous supervisory layer for an industrial plant. Each meaningful asset has a durable supervisory actor. Four specialist agents communicate directly, revise proposals, and agree on a recovery plan while the PLC continues deterministic control.

The demonstration must show communication changing decisions, commands reaching the plant, and measured recovery afterward.

This is the product brief. The current repository contains the working Terse counter starter and project-scoped Agent Relay MCP setup; the plant actors, application agents, gateway, and dashboard still need implementation.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| Factory I/O | Plant visualization and physical process simulation |
| PLC / SoftPLC | PID, interlocks, permissives, sequences, alarms, and final physical control |
| Plant Gateway | Read telemetry and submit permitted supervisory commands through the controller interface |
| Terse Durable Actors | Own durable supervisory state, constraints, pending requests, and command decisions for each asset |
| Agent Relay | Carry targeted requests, objections, revised proposals, agreements, and recovery messages between agents |
| OpenAI | Reasoning inside each independently running specialist agent |
| React dashboard | Plant view, agent activity, proposals, accepted commands, and recovery timeline |

The PLC remains authoritative for physical control. Actors own supervisory decisions and record observed plant state. Agents submit requests through actors and do not write PLC tags directly.

Core stack: Factory I/O + PLC + Modbus, Terse, Agent Relay, OpenAI, and React. No separate database or additional orchestration framework is planned.

## Assets

Use three actor classes with four asset instances:

- `TankActor("T101")`
- `PumpActor("P101")` — primary pump
- `PumpActor("P102")` — backup pump
- `ValveActor("XV101")` — bypass / control valve

Each asset retains telemetry with observation timestamps, supervisory constraints and their sources, pending requests, accepted targets, and command acknowledgements. Pump state also includes health, maintenance limits, operating role, and relationships to the tank and backup pump.

Proposed actor operations are `observe`, `getState`, `setConstraint`, `requestCommand`, `commitCommand`, and `getPendingRequests`.

## Independent agents

| Agent | Information | Responsibility |
| --- | --- | --- |
| `production` | Tank level, flow, demand, production target | Maintain throughput and tank inventory |
| `maintenance` | Equipment condition, runtime, maintenance restrictions | Protect equipment and impose asset limits |
| `energy` | Pump power, demand bands, energy cost | Propose efficient contributions within operating constraints |
| `quality` | Process quality, bypass limits, process operating envelope | Protect quality and process limits |

Each agent has a scoped view and tools appropriate to its role. Agents learn other specialties' information through Relay messages. They stay alive concurrently rather than running as a fixed sequence of prompts.

The existing Relay MCP configuration connects development tools. The application also needs these four runtime identities and their Relay clients.

Use `#plant-t101` for incident announcements, proposed plans, commitments, and recovery confirmation. Use DMs for meaningful targeted exchanges, including maintenance talking directly to energy.

## Demonstration

1. Start normally: T101 at approximately 72%, P101 at 60%, P102 off, and XV101 at 40%.
2. Inject increased demand and a P101 maintenance restriction. The tank begins falling.
3. TankActor exposes the falling trend and estimated time to the critical threshold.
4. Production proposes raising P101 to 82% and asks maintenance about constraints.
5. Maintenance rejects that proposal and communicates a 65% limit. Production abandons its initial plan.
6. Production and maintenance discuss backup-pump options with energy. Quality evaluates additional bypass contribution.
7. The agents converge on an alternative plan, illustrated by P101 at 65%, P102 at 32%, and a 12 percentage-point valve increase.
8. Actors validate the requests against current constraints. The gateway submits the permitted commands, and the PLC accepts or rejects them according to its controls.
9. Observed pump, valve, and flow values change. Tank level stops falling and begins recovering.
10. Agents verify the outcome against their respective goals. The system reports recovery only after telemetry supports it.

The example percentages and flow gains are illustrative. The implementation must derive expected recovery from the configured plant model or measured calibration. Valve position, incremental position, flow, tank inventory, and time-to-critical must have explicit units.

## Dashboard

The frontend reference is the linked P&ID / 3D engineering workspace in the supplied Outerport video. See [reference observations and frontend direction](frontend-reference.md).

One screen:

- Left, approximately 60%: Factory I/O stream or a clearly identified simulated plant view, with tank, pumps, valve, and flow.
- Right, approximately 40%: four agent cards, their distinct concerns, and visible Relay exchanges.
- Bottom: a timestamped timeline linking observations, messages, rejected and revised proposals, accepted commands, acknowledgements, and recovery.

Primary action: **Inject incident**. The visible result is a recovering plant and evidence that communication changed the accepted plan.

## Command and recovery semantics

Serial execution within an asset actor does not by itself make a multi-asset plan atomic. Track a shared plan identifier and asset state versions so each asset's acceptance, dispatch, and acknowledgement can be reconciled.

Command delivery needs idempotency and a durable record of pending work so a retry or restart does not produce duplicate physical actions. Distinguish requested targets, accepted targets, and observed values. Do not mark a command applied before gateway / controller acknowledgement.

Track telemetry freshness and constraint validity. Missing or stale information must be visible rather than silently presented as current. Expiring a maintenance observation must not silently authorize a higher pump speed.

## Implementation stages

1. Build the asset actors, gateway contract, and a deterministic simulated plant adapter.
2. Run the four scoped OpenAI agents using actual Relay messages, with an auditable proposal and command trail.
3. Build the dashboard and demonstrate incident-to-recovery end to end.
4. Connect the same gateway boundary to the Windows-hosted Factory I/O + PLC setup, then verify the scenario against its actual tags and operating envelope.

A simulated demonstration must be labeled as simulated. The final Factory I/O demonstration needs the actual plant / controller connection and observed recovery, not a prewritten conversation or an animation presented as live telemetry.

## Inputs needed for the live plant

- Windows host and access method for Factory I/O and PLC / SoftPLC.
- Controller / Modbus endpoint and confirmed tag or register map.
- Units, pump and valve response, tank capacity, demand model, and operating limits.
- Gateway command permissions and controller acknowledgement behavior.
- Factory I/O video or remote-view source, if available.

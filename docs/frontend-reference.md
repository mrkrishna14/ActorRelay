# ActorRelay frontend design brief

Scope: frontend implementation, authorized after approval of the two 2D and 3D mockups. The supplied video is a reference for the engineering workspace and its interactions. Backend implementation remains outside this task.

Source: [Towaki Takikawa / Outerport LinkedIn video](https://www.linkedin.com/feed/update/urn:li:activity:7518717781094162432/).

Reviewed the full 44.5-second clip in the browser.

## Observed in the video

- Compact blue application toolbar, a light working surface, and a project / sheet tree on the left.
- A 2D P&ID and a 3D plant model visible side by side.
- Selecting equipment or piping focuses the 3D view and fades surrounding geometry. A selected pipe is also highlighted on the schematic.
- An inspector shows the selected entity's route, live process flow, and where it appears in the diagram and model.
- A controls pane includes searchable loops, process values, setpoints, outputs, units, and operating modes.
- A bottom timing chart and event log remain visible while interacting with the plant.
- Near the end, the FIC-114 setpoint changes from 10 to 6 m³/h. The LIC-101 level setpoint changes to 1.03 m. Live values and the event log show the response, and simulation speed changes to 10×.

## Current product contract

The main-branch documents reviewed at `2e230cc` supersede the earlier four-asset concept: `CLAUDE.MD`, `PLAN.MD`, and `TASK1.MD` through `TASK3.MD` define ActorRelay, two simulated plants, and ten equipment agents. Each plant contains P-100, TK-101, LV-101, E-101, and TV-101; both plants share a steam header.

The central story is proposal → evidence-backed votes → blocked or unanimous approval → 10-second human veto window → execution → observed effects → calibration and shared learning. Command acceptance and observed results must remain distinct.

## Visual direction

Use black, white, and neutral gray. Use Geist Sans for interface text and Geist Mono for tags, values, timestamps, and logs. The user's monochrome requirement supersedes the colored status suggestions in TASK3.MD and the blue reference toolbar. Show status through explicit words, symbols, outlines, and line styles.

References inform interaction and information hierarchy only. Create original layouts and assets. The two approved generated images establish the engineering workspace. Later user requests add light mode, a full plant environment, resizable panels, and visible equipment-agent context.

## Working layout

1. Top bar: ActorRelay, persistent "Simulated plant" label, plant-a / plant-b / company selector, a light/dark theme control and demo clock.
2. Left: Company → plants → equipment tree. Selection stays synchronized across the schematic, model, and inspector.
3. Center: switchable, linked 2D P&ID and 3D views of the same selected plant. Show sample values with units and highlight the component participating in a proposal. The 3D view represents the same simulated equipment; it does not imply a separate physics engine or imported CAD implementation.
4. Right: Inspector, Agents, and Proposals views. Keep the operator chat composer available with an explicit recipient: selected equipment, plant-a, plant-b, or company. Show participant identity, plant, vendor, message time, proposal references, votes, and evidence links. Keep an active veto countdown and veto control visible even when switching panel views.
5. Directly beneath the chat composer: an expandable "Agent Relay" harness panel. Its compact state shows a demo label, agent count, and current activity. Expanded rows show equipment name, tag, specialist role, plant location, vendor, current task, state, and latest action. Selecting a row focuses that agent's conversation and its component in both plant views.
6. Bottom: selected metrics with limits over time and an audit/event feed. Company view emphasizes shared steam pressure, cross-plant votes, and rules learned in one plant and used in the other.

The harness panel is part of the app's own interface and currently runs from explicit browser demo state. The app opens directly, without sign-in, passwords, tokens, connection controls, or external services. A future backend integration is outside this frontend task.

## Future runtime capabilities and limits

The installed Agent Relay packages are version `15.0.1-next.0`. The SDK supplies messaging, delivery, actions, and event listeners. The harness packages supervise local agent processes and expose session activity.

Display only events the selected runtime actually supports. Terminal sessions currently provide exact startup/failure and inferred busy/idle boundaries; detailed tool activity is unavailable there. Native adapters expose richer structured events but are experimental. Preserve exact/inferred provenance, show unavailable or disconnected states clearly, and keep raw model reasoning out of the standard UI. Relay runtime logs are operational telemetry; the actors remain the audit authority.

Sources: [SDK contract](https://github.com/AgentWorkforce/relay/blob/main/packages/sdk/README.md), [harness observability](https://github.com/AgentWorkforce/relay/blob/main/packages/harnesses/README.md).

## Demo emphasis

Make equipment memory and live agent negotiation visible together: the blocking vote cites history, a safer proposal executes after the veto window, measurements change, and the second plant cites a supported shared rule. The chat composer can initiate a proposal; it cannot bypass voting or the veto window to write a setpoint.

The frontend implements linked equipment selection, animated 2D flow, a complete monochrome 3D process yard, sample proposal/veto/observation flow, evidence and agent-state inspectors, and an in-app demo Relay harness. Review votes arrive in stages, followed by the 10-second veto window. The retained SDK adapter is unused by the application and reserved for later integration. Sample plant and agent states are explicitly labeled. The frontend does not implement the external plant, durable actors, or ten running equipment agents.

# ActorRelay frontend

Frontend-only implementation on branch `frontend`. The visual targets are the approved 2D P&ID and 3D Plant mockups. The application uses Next.js static export, React, self-hosted Geist Sans/Mono, Phosphor icons, and a lazily loaded Three.js viewport.

## Run

From the repository root:

```sh
bun install --cwd web
bun run web:dev
```

Open http://127.0.0.1:3000 directly into the plant workspace. There is no sign-in, token entry, connection wizard, or service configuration. From `web/`, `bun run build` emits a standalone static frontend in `out/`; `bun run start` serves that export on the same local port. Stop the development preview before starting the production preview.

```sh
bun run web:check
bun run web:test
bun run web:build
```

No API routes, server actions, application backend, external backend calls, actor changes, simulator changes, provider calls, or automatic agent spawning are part of this frontend.

## Working interface

- Plant A / Plant B / Company navigation, searchable equipment tree, and linked component selection.
- 2D P&ID with values, instrument links, selection, proposal forecast, directed liquid/steam/condensate particles, and tank circulation. The flow control pauses these illustrative animations; reduced-motion preferences disable them automatically.
- Interactive 3D tank skid with orbit, zoom, fit/reset, projected equipment labels, and selection. A generated local plant image provides a clearly marked fallback when WebGL is unavailable.
- Equipment details with measurements, supplied limits, safety margin, and a validated P-100 proposal form.
- Agent conversation, channel selection, composer, evidence links, proposal review, and human veto countdown.
- Human-friendly agent context in 2D, 3D, and chat: equipment location, specialist role, vendor, current task, state, decision summary, latest action, and evidence. The state inspector defines monitoring, thinking, reviewing, waiting, blocked, ready, and observing.
- Agent Relay harness directly beneath the chat composer, showing browser-demo sessions, task progress, and expandable activity details. It does not connect to a live harness.
- Metric chart with pause/resume, threshold, proposal event, and pointer inspection; expandable audit history.
- History/rule dialogs and company view showing the two plants and shared steam header.
- Responsive layout, native modal focus handling, reduced motion, keyboard access, and shortcuts: 1/2 for views, I for equipment details, Command/Ctrl K for search.

## Workspace controls

- Light mode is the default. The sun/moon button switches between light and dark; the versioned `actorrelay-theme-v1` preference is remembered locally. Theme switching still works when browser storage is unavailable.
- Drag the equipment and conversation dividers to change their widths. Drag the bottom chart divider down to shrink the chart and extend the plant view, or up to enlarge the chart. The conversation/harness divider adjusts their relative heights.
- Focus a divider and use its arrow keys; hold Shift for larger steps. Double-click an equipment/conversation/chart divider to reset panel sizes. Double-click the conversation/harness divider to reset that split. The toolbar's **Reset panel sizes** control resets every split. Panel sizes are session-only.
- **Expand plant view** hides the equipment navigator, agent panel, chart, and audit area. Use the restore button or Escape to return to the workspace. The separate **Fullscreen plant view** button requests native browser fullscreen; Escape exits it. Where fullscreen is unavailable, it falls back to the expanded view.
- Flow animation pause and chart pause are separate controls. Animated paths illustrate direction and activity; they are not a calibrated flow simulation.

## Demo data

The default mode is an interactive frontend demo. Measurements, history, messages, votes, and observation/calibration are illustrative fixtures. They are not live agent reasoning or a physics model. The mode is labeled in the header, conversation, harness, measurements, and evidence dialogs.

Initial state: Plant A's 50 → 85% pump proposal is blocked by the outlet-valve limit. Send `Propose 65%` or create a P-100 proposal in equipment details. Votes arrive in stages over about six seconds; an unsafe proposal stops as soon as a refusal arrives. All five required yes votes, including the other plant's steam valve, open a ten-second veto window. Veto leaves values unchanged. Otherwise the UI applies the sample target and animates a five-second observation separately from command acceptance. A single proposal runs at a time across both sample plants. Reset clears session-only observations and restores both plants.

Agent context is derived deterministically from this scenario. State changes, task progress, and decision summaries explain the sample workflow; they do not represent live LLM execution, tool calls, or private model reasoning. Latest-action times use America/Los_Angeles, matching the workspace clock.

All plant demo state stays in React memory. Reloading resets it; the saved theme preference is separate. The sample rule has three high-feed support records; a safe observation is not represented as proof of an unsafe higher-speed outcome.

## Agent Relay boundary

The visible harness and conversations run entirely from browser demo state. The application does not authenticate, request tokens, connect to external services, create a Relay workspace, or launch harness processes.

`lib/relay-client.ts` retains an unused `@relaycast/sdk` adapter for subsequent integration. Its transport and credential boundaries are exercised by in-memory service tests; the current application does not instantiate it or make its network calls. Enabling a live runtime is a separate integration task.

## Future service handoff

`lib/types.ts` defines the UI projection of equipment, proposals, votes, evidence, and Relay activity. `lib/demo.ts` is isolated sample state. Replace its data/action boundary with the agreed actor and integration-service clients when those modules are supplied. Preserve the distinction between proposed, accepted, and observed values. Never route a chat message directly to a physical setpoint.

For a future live integration, `lib/relay-client.ts` supplies the independent transport boundary. Runtime observation is operational telemetry; authoritative plant audit history must come from the external actor service.

## Validation

TypeScript and nineteen tests pass, with 164 assertions reported. Tests cover staged equipment votes and derived agent activity, the proposal/veto/observation lifecycle, cross-plant serialization, cross-plant voters, client permissions, message normalization/deduplication, WebSocket delivery, errors, credential boundaries, and disconnect races. Focused layout checks also covered forty viewport combinations and short-window chart bounds.

Production static export and TypeScript pass. Browser verification covers direct entry without setup, both themes, the modeled plant yard, cross-plant agent identity, staged votes, veto/observation, agent details, panel resizing, and expanded/fullscreen views. Visual evidence and responsive checks are recorded in the repository’s `design-qa.md`.

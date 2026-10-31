# ActorRelay frontend design QA

final result: passed.

Reviewed on 31 October 2026 against the approved 1672 × 941 2D and 3D images and the user's later requests for light mode, a complete monochrome plant environment, agent context, direct entry, and adjustable panels.

## Visual comparison

- Source references: `web/design/target-2d.png`, `web/design/target-3d.png`.
- Combined source/implementation comparison inputs: `web/design/qa/comparison-2d.png`, `web/design/qa/comparison-3d.png`.
- Final desktop captures: `light-2d.png`, `dark-2d.png`, `light-3d.png`, `dark-3d.png` in `web/design/qa/`.
- Expanded workspace: `web/design/qa/light-3d-expanded.png`.
- Mobile captures: `web/design/qa/mobile-light.png`, `web/design/qa/mobile-3d.png`.

Preserved the original engineering workbench hierarchy: equipment tree, linked plant view, proposal status, bottom trend/audit, conversation, and harness directly below its composer. Geist Sans/Mono, neutral surfaces, thin borders, and explicit state labels remain consistent in both themes.

The broader plant yard, context strip, edge-docked agent badges, role/task rows, state inspector, theme toggle, and resize controls intentionally extend the approved references in response to the user's subsequent requests. The 3D model is interactive Three.js geometry. Supporting storage, buildings, pipe racks, cabinets, paths, and railings are labeled as schematic context; they do not imply additional operational agents or a physics backend.

## Functional and browser verification

- Production static export opens at `http://127.0.0.1:3000/` without sign-in, passwords, tokens, connection buttons, or service setup. No external backend is used by the app.
- Desktop reviewed at 1672 × 941; compact layout reviewed at 390 × 844. Neither layout has horizontal page overflow.
- Mobile 3D uses compact agent badges. The detailed forecast remains available from proposal review and agent details without covering the small model view.
- Light/dark switch changes both interface and actual WebGL background/floor/labels. The 3D scene uses grayscale geometry and lighting.
- 2D feed, pump discharge, outlet, steam admission, coil, condensate return, and tank circulation animate. There are 83 SVG motion elements in the running sample. Pausing removes active motion; reduced-motion preferences stop it automatically.
- Tree, chat, harness, 2D, and 3D equipment selections remain linked. Plant B's LV-101 reports Plant B monitoring activity rather than Plant A's blocked proposal.
- Agent badges identify equipment, vendor, specialist role, and state. Agent details display location, task, public decision summary, latest action/time, evidence, workflow, and all seven state definitions.
- The 65% sample review visibly moves from Thinking through individual votes to Waiting during the full 10-second human veto window, then Observing and a separately recorded sample observation. Veto, blocked targets, and reset were checked.
- Equipment/chat widths, chart height, and chat/harness split respond to pointer and keyboard resizing. Drag cleanup restores cursor and selection. The default desktop harness fits all five current-plant agents. Reset restores panel sizes.
- 3D supports whole-plant overview, process-unit fit, selected-equipment focus, orbit, zoom, expanded workspace, and native fullscreen. Escape restores the expanded workspace.
- Evidence, proposal review, company view, equipment inspector, and agent details were checked in the browser. Agent details preserve focus and support Escape/backdrop close.
- Fresh production console check reported no new errors or warnings.

## Build and tests

- `bun run check`: passed.
- `bun run test`: 19 passed, 0 failed, 164 assertions.
- `bun run build`: passed; `/` is exported as static content.
- Focused layout bounds checks covered forty viewport combinations; chart bounds include the selected-agent context strip.

## Product boundaries

This is a frontend demo with deterministic sample plant values, agent activity, votes, memory, and observations. Public decision summaries describe the visible scenario; they do not expose or claim private model reasoning. The unused browser Relay adapter remains available for a separately scoped future integration and is not imported by the application. No backend, external workspace, or agent process is started by the frontend.

All work remains on the `frontend` branch. Nothing was pushed to `main`.

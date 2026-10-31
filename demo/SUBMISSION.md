# Builderbase submission draft

Not submitted. Status below was written at 12:35 on Oct 31 and is mock-only until someone updates it.

## UPDATE AT SUBMISSION TIME
Run `bun run glue/e2e.ts --live` from the checkout root, then pick exactly one status paragraph below and delete the other.
- Exit code `0` with the printed mode `live`: use **Status A**, and only for the steps the run really passed.
- Anything else, including exit code `2`: use **Status B**.

## Paste: description

Digital twins predict. ActorRelay makes the components negotiate, remember, and refuse, across every plant you own.

Every pump, tank, valve, and coil in a simulated process plant gets its own agent and durable memory, and no setpoint changes until the connected components agree. A Durable Actor per component holds memory and serializes writes, while Agent Relay carries the votes, evidence, and counter-proposals between components and across plants.

**Status B (use until live passes):** This submission shows the dashboard and integration service in labeled mock mode. Votes, measurements, and events in the video are fixtures, not agent reasoning, and the durable actors, messaging, and plant simulation are not yet connected end to end. The plant is simulated.

**Status A (use only if live passes):** The video shows a live run on a simulated plant, verified by our end-to-end acceptance check. Not exercised in this run: [list any skipped checks, or delete this sentence].

## Paste: links

| Field | Value |
|---|---|
| Repo | https://github.com/mrkrishna14/Factoryio |
| Slides | `demo/output/ActorRelay.pptx` in the repo (browser viewer: `demo/slides.html`) |
| Video | **[BLANK: not recorded yet. Paste the link after recording.]** |

The slides path only works for judges once `demo/` is merged and pushed, so check it on GitHub before submitting.

## Before you click submit
- [ ] One status paragraph is left, and it matches what the last run really did.
- [ ] The video link is filled in and plays in a private window.
- [ ] The video's mode matches the status paragraph.
- [ ] `demo/output/ActorRelay.pptx` opens from the GitHub repo.
- [ ] All bracketed placeholders are gone.

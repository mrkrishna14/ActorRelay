# ActorRelay demo and submission

| File | What it is |
|---|---|
| `slides.html` | Browser viewer. Use arrow keys, Previous/Next, or Fullscreen. Print gives one slide per landscape page. |
| `output/ActorRelay.pptx` | The editable three-slide deck. |
| `output/slide-1.png` to `slide-3.png` | Rendered slides used by the viewer. |
| `SUBMISSION.md` | Builderbase draft, not yet submitted. It has a status line to update and a blank video link. |
| `VIDEO-SCRIPT.md` | Timed 90-second shot list with live and mock variants, plus a pre-record checklist. |

- Slides: 1 is the problem (connected equipment, isolated agents, forgotten incidents), 2 is the product (negotiate, remember, refuse, across plants), and 3 is why both tools.
- The exact pitch line appears on slide 3.
- Slide 2 shows the target demo flow, and it says so on the slide. No slide claims that live integration has passed.
- No backup video has been recorded. Record the actual dashboard with its mode indicator visible, and do not replace agent output with scripted conversation.

## Rebuild
The generator is `create-slides.mjs`. It renders the PNGs, validates the deck in the ignored `build/` folder, and copies the result to `output/ActorRelay.pptx`.

1. Copy `create-slides.mjs` to `build/create.mjs`, because the presentation runtime resolves from `build/node_modules`.
2. Set `RUNTIME_NODE_MODULES` to that runtime's `node_modules` folder.
3. Create `build/final/` and delete any old `build/final/ActorRelay.pptx`, because the validator will not overwrite it.
4. Run `node demo/build/create.mjs` from the `Factoryio-person3` folder.

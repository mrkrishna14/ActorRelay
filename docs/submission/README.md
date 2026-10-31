# ActorRelay submission pack

Prepared for the solo Builderbase entry. **Nothing has been submitted or posted.**

**Status at 13:56 PT: not ready to submit, but close.** All four never-fake moments passed in one recorded full-stack run at 13:42, 26 of 26. It was the only clean run of four, the code has moved since, it was driven by a test script, and the dashboard has not been seen working. Every file here marks what has been seen and what has not.

| File | What it holds |
|---|---|
| [description.md](description.md) | Pitch line plus two sentences, with evidence for each claim |
| [deck-outline.md](deck-outline.md) | Three slides |
| [demo-script.md](demo-script.md) | 90-second script, written against what the code does |
| [real-vs-stand-in.md](real-vs-stand-in.md) | What is real, what is a stand-in, and what must not be claimed |

## What must be true before submitting
| Check | Status |
|---|---|
| Unsafe change blocked with cited evidence, on the full stack | Passed in [the 13:42 run](evidence/e2e-run-134157.md) |
| Counter executes after the veto window, on the full stack | Passed, one simulator write |
| Second block cites the first run, on the full stack | Passed, 2.2 s. Earlier runs missed the target |
| Plant B cites Plant A's rule, on the full stack | Passed |
| The same on the final code, repeatably | **Not done** |
| All of it seen on the dashboard, including captions | **Not done** |
| A veto click on the full stack | **Not done** |
| A person rehearses the script against a clock | **Not done** |
| Root `README.md` fixed | **Not done** |

## Decisions only Zubair can make
1. **Solo credit.** Git shows only teammates as authors of `CLAUDE.MD`, `PLAN.MD` and the task files. See "Who did what" in [real-vs-stand-in.md](real-vs-stand-in.md). The entry should not present those as solo work.
2. **Repo link.** The only remote is `github.com/mrkrishna14/Factoryio`, and `zubair` carries teammates' commits. Decide what the entry links to.
3. **Plant B's automatic counter.** After Plant B's block, its pump agent counters with 65 and the plant moves unless vetoed, and the card holding the rule citation collapses about 2 s after the block. Keep it and script around it, as [demo-script.md](demo-script.md) does now, or suppress it so the citation stays on screen.

## How this pack stays honest
- A claim goes in only with evidence: a file, a run table or a measured result.
- "Seen" names the layers that really ran. A result with fake layers says so.
- When a layer lands, its rows are updated from a real run, not from its code.

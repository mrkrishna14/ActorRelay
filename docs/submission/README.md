# ActorRelay submission pack

Prepared for the solo Builderbase entry. **Nothing has been submitted or posted.**

**Status at 15:49 PT: the pack is ready to use. Nothing has been submitted.** All four never-fake moments passed in three recorded full-stack runs, all 26 of 26, the latest two on the final backend code, and the dashboard was seen showing the 15:41 run. Two decisions remain.

| File | What it holds |
|---|---|
| [description.md](description.md) | Pitch line plus two sentences, with evidence for each claim |
| [deck-outline.md](deck-outline.md) | Three slides |
| [demo-script.md](demo-script.md) | 90-second script, written against what the code does |
| [real-vs-stand-in.md](real-vs-stand-in.md) | What is real, what is a stand-in, and what must not be claimed |

## Before submitting
| Check | Status |
|---|---|
| All four moments on the full stack | **Passed** at [13:42](evidence/e2e-run-134157.md), [14:09](evidence/e2e-run-140851.md) and [15:41](evidence/e2e-run-154135.md) |
| Dashboard working on live data | **Seen** showing the 15:41 run, [screenshot](evidence/dashboard-live-154228.jpg). Plant A and Plant B walks, including both captions, also seen at 15:47 in a scripted browser run. No person has driven it on a clock |
| Veto click on the full stack | **Passed** at 15:44:58, per main. It was a scripted click in a test browser, not a person. I did not see it myself |
| Stack ticking | **Check before judging:** `/health` `ticks` must rise between two reads, and the laptop must not sleep. See [demo-script.md](demo-script.md) |
| Slides | Built: [ActorRelay-slides.pdf](ActorRelay-slides.pdf) |
| Backup video | **Not recorded yet.** Only Zubair can record it |

## Decisions only Zubair can make
1. **Solo credit.** Git shows only teammates as authors of `CLAUDE.MD`, `PLAN.MD` and the task files. See "Who did what" in [real-vs-stand-in.md](real-vs-stand-in.md). The entry should not present those as solo work.
2. **Repo link.** The repo moved to `github.com/mrkrishna14/ActorRelay`, and `zubair` carries teammates' commits. Decide what the entry links to.

## How this pack stays honest
- A claim goes in only with evidence: a file, a run table or a measured result.
- "Seen" names the layers that really ran. A result with fake layers says so.
- When a layer lands, its rows are updated from a real run, not from its code.

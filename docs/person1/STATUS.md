# Status

**13:36 PT. Not demo-ready yet. Three of the four never-fake items pass on real Terse and real model calls, but with a fake glue and fake plant. The fourth, the repeat block, fails its timing under load. I have not seen a run with every real service together.** Submission is at 16:00.

| Area | State | Proof | As of |
|---|---|---|---|
| Agents | Works on a fake glue | Mine: 76 of 76 on `ca68d98`; code changed since | 13:00 |
| Actor logic | Works | Mine: 32 of 32, pure, same run | 13:02 |
| Property and attack tests | **Failures open at my run;** owners report fixes | Mine: property 84 of 97, attacks 267 of 298 (2 were timeouts I set) | 13:03 |
| Real Terse, full demo walk | **20 of 24 rows** on fake glue and plant | Generated report, not rerun by me | 13:29 |
| Repeat block on real Terse | **Fails:** 14 s, then a 25 s timeout; target 5 s | Same report; Plant queueing near load 38 | 13:29 |
| Glue | Built; unit tests reported pass | Read only | 13:28 |
| Simulator and `shared/history.json` | Built by us | Read only; history not in my suite run | 13:27 |
| Dashboard | **In progress** | No handoff yet | 13:26 |
| Every real service together | ar-glue reported steps 1 to 3 passing at 13:28 | **Not seen by me** | 13:28 |

## Never-fake items
| Item | State |
|---|---|
| Evidence-cited block | Passes on real Terse, fake glue and plant |
| Counter-proposal executing | Passes the same way, with no real simulator write |
| Second block citing the first run | **Fails timing** |
| Plant B citing Plant A's rule | Passes on real Terse, fake glue and plant |

## Requirements
45 met, 74 partial, 2 missing of 121. Missing: `actor/HANDOFF.md`, and `terse deploy` with a generated client. [traceability.md](traceability.md) has every row.

## Blocking a clean demo
1. Plant queueing on real Terse under load.
2. No recorded pass with every real service together.
3. All `met` rows need one rerun on current code. WSL runs are on hold until main says go.

[RUNBOOK.md](RUNBOOK.md) has the start order.

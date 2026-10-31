# Property tests for the actor decision logic

Generated cases against `similar`, calibration, status, the proposal lifecycle, votes,
`requiredVoters`, rule promotion, the company outbox, dispatch and actor mailboxes. Expected
behaviour comes from `TASK1.MD`, `CLAUDE.MD` and the comments in `actor/src`.

```bash
bun install
bun test .                                   # real logic, 5000 cases per property
PROP_RUNS=20000 PROP_WORLD_RUNS=2000 bun test .   # more cases
PROP_SEED=<seed> bun test ./<file>           # replay a seed printed by a failure
PROP_TARGET=reference bun test .             # spec reference, validates the tests only
BUN=bun bash mutants.sh                      # known bugs in the reference, each must be caught
bun run mutants-real.ts                      # known bugs in a copy of actor/src, likewise
```

What a run proves depends on the target, and the suite name in the output says which:

- `real logic, fake runtime` runs `actor/src/logic` and the real `Plant`, `Company` and
  `Component` classes on `fake-runtime.ts`. The outbox, dispatch and mailbox suites add one
  serial mailbox per actor, wire copies of every argument and result, and calls that fail,
  lose their reply, hang or stall. This proves decision logic and call ordering. It says
  nothing about Terse persistence, alarms, eviction or crash recovery; `actor/tests/chaos`
  covers those.
- `reference` runs `reference.ts`, a plain reading of the spec. A pass there only shows a
  property is satisfiable, and never counts as a pass of the product.

`real-adapter.ts` is the only file bound to the real code. Documented departures from the
plain spec are the `Traits` in `harness.ts`, so each one stays checked exactly.
`repro.test.ts` holds one-case reproductions of reported findings; a red test there is an
open finding, not a flaky test.

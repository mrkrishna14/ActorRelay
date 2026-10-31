# Property tests for the actor decision logic

Generated cases against `similar`, calibration, status, the proposal lifecycle, votes,
`requiredVoters` and rule promotion. Expected behaviour comes from `TASK1.MD` and `CLAUDE.MD`.

```bash
bun install
bun test .                                   # real logic, 5000 cases per property
PROP_RUNS=20000 bun test .                   # more cases
PROP_SEED=<seed> bun test ./<file>           # replay a seed printed by a failure
PROP_TARGET=reference bun test .             # spec reference, validates the tests only
BUN=bun bash mutants.sh                      # injects known bugs, each must be caught
```

What a run proves depends on the target, and the suite name in the output says which:

- `real logic, fake runtime` runs `actor/src/logic` and the real `Plant` and `Company` classes
  on an in-memory actor base. It proves decision logic. It says nothing about Terse
  persistence, alarms, mailboxes or crash recovery; `actor/tests/chaos` covers those.
- `reference` runs `reference.ts`, a plain reading of the spec. A pass there only shows a
  property is satisfiable, and never counts as a pass of the product.

`real-adapter.ts` is the only file bound to the real code. Documented departures from the
plain spec are the `Traits` in `harness.ts`, so each one stays checked exactly.
`repro.test.ts` holds one-case reproductions of reported findings; a red test there is an
open finding, not a flaky test.

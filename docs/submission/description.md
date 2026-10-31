# Builderbase description

Not submitted. Use the text only after the checks below pass.

## Text

> Digital twins predict. ActorRelay makes the components negotiate, remember, and refuse, across every plant you own.
>
> On a simulated heated-tank unit, every component has a durable actor and its own agent, and a setpoint change goes ahead only if every connected component votes yes, citing past runs. A no blocks the change with its evidence, the agent offers a safer target, and a rule learned in one plant is cited in the other.

The first paragraph is the pitch line from `CLAUDE.MD`, word for word.

## Can each claim be made yet?
Status at 15:49 PT: yes. "Seen" means in the [13:42](evidence/e2e-run-134157.md), [14:09](evidence/e2e-run-140851.md) and [15:41](evidence/e2e-run-154135.md) full-stack runs, all 26 of 26: real actors, glue, Relay, simulator and agents, driven by a test script.

| Claim | Status | Evidence |
|---|---|---|
| Simulated heated-tank unit | Seen | Two plants on `bridge/live_sim.ts`. It is a new model fitted to the numbers in `CLAUDE.MD` |
| Every component has a durable actor | Seen | Step 1: 10 components mirrored |
| Every component has its own agent | Seen | `ready: 10 agents`, 25 votes logged |
| A change goes ahead only on unanimous yes | Seen | Step 3: 5 of 5 yes, exactly one simulator write |
| Voters cite past runs | Seen | Step 2: 5 seeded events retrieved from the actors. Their numbers come from the model. Their operators, dates and incident text are invented |
| A no blocks with its evidence | Seen | Step 2 |
| The agent offers a safer target | Seen | Step 3: 50 to 65. Code picks the target, and the model writes the reason |
| A rule learned in one plant is cited in the other | Seen | Step 5. The rule comes from Plant A's seeded history |

**Before submitting:** the two decisions in [README.md](README.md).

## Do not add
No claim of two model vendors, a hosted deployment, a stack that survives any crash, or a guarantee that no unsafe change can pass. [real-vs-stand-in.md](real-vs-stand-in.md) has the reasons.

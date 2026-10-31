# ActorRelay

Digital twins predict. ActorRelay makes the components negotiate, remember, and refuse, across every plant you own.

ActorRelay is an agentic control layer on a **simulated** two-plant process unit. Every machine has a durable actor for its memory and its own AI agent. A setpoint changes only if every connected machine votes yes, citing past runs, and a human gets a 10-second veto. One no blocks the change with its evidence, the pump's agent offers a safer target, and a rule learned in one plant is cited in the other.

## How a change moves through the system
1. An operator asks for more throughput: pump 50% to 85%.
2. The Plant actor works out who must vote, including the other plant's steam valve, because both draw on one steam header.
3. Agents read past runs from their actors, predict the effect on their own machine, and vote over Agent Relay.
4. The outlet valve refuses: at 85% it would reach 89%, past its 81% line. The change is blocked.
5. The pump's agent counters with 65%. All five vote yes, and the 10-second veto window opens.
6. The change is written to the simulator once. Each voter is scored against what happened.
7. Force 85% again and it is refused, citing the run from moments ago first.
8. Plant B has never run that high. Its outlet valve refuses too, citing the rule from Plant A's runs.

## Why both tools are load-bearing
- **Durable Actors (Terse):** one actor per component, plant and company. They hold state, history, calibration and rules, and they enforce the vote. Only `Plant.execute` can change a metric.
- **Agent Relay:** ten component agents on `plant-a`, `plant-b` and `company`. Proposals, votes, counters and results travel as messages.

## Layout
| Folder | What it holds |
|---|---|
| `actor/` | `Component`, `Plant` and `Company` actors, plus test suites |
| `agent/` | Relay agents, retrieval, voting, counters, calibration, evals |
| `bridge/` | The live plant simulator and history generator |
| `glue/` | The HTTP service joining actors, Relay, simulator and dashboard, plus the end-to-end test |
| `web/` | The dashboard: 3D plant, process diagram, live system view, guided tour |
| `shared/` | The type contract, plant definition and seeded history |

## Run it
The stack runs in WSL (Ubuntu) and needs Bun, the Terse CLI, a local Agent Relay server and an OpenAI key in `.env` at the repo root. Paths in `scripts/` are written for the machine this was built on.

```bash
bash scripts/start-all.sh
```

This starts Relay, the dashboard on `http://localhost:3000`, then actors, simulator, glue and agents, and runs the end-to-end test. `scripts/demo-restart.sh` restarts the stack alone. Before a demo, read `http://localhost:7200/health` twice: `ticks` must rise. If it does not, run the restart.

Full instructions are in [glue/DEMO.md](glue/DEMO.md) and [glue/HANDOFF.md](glue/HANDOFF.md).

## What has been shown
- **Full stack, final code:** 26 of 26 end-to-end checks on real Terse, real Relay, real model calls, the simulator and glue, at 14:09 and 15:42 ([table](docs/submission/evidence/e2e-run-154135.md)). The test script drives the routes.
- **Crash tests:** 32 of 33 scenarios passed on their latest run on real Terse with `kill -9`, with glue and the simulator faked. No acknowledged write was lost and no proposal sent a second simulation command across 37 server kills. Limits and open items are in [the report](actor/tests/chaos/REPORT.md).

[What is real and what is a stand-in](docs/submission/real-vs-stand-in.md) lists every limit. The main ones: the plant and its history are simulated, actors run on a local dev server, and every vote so far ran on OpenAI models, with Claude roles on a labelled fallback.

## Credits
The tank model design follows an MIT-licensed project credited in [bridge/NOTICE.md](bridge/NOTICE.md). The original design documents are [CLAUDE.MD](CLAUDE.MD) and [PLAN.MD](PLAN.MD), and git history shows their authors.

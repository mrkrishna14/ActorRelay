# ActorRelay

An agentic control layer for simulated process plants. Equipment agents negotiate operating changes, cite evidence, reject unsafe proposals, and share what they learn across plants.

## Plan and ownership
- [Implementation plan](PLAN.MD)
- [Technical contract and working rules](CLAUDE.MD)
- [Person 1: durable actors and agents](TASK1.MD)
- [Person 2: simulation](TASK2.MD)
- [Person 3: dashboard and integration](TASK3.MD)

## Demo
Propose a pump increase, see connected equipment block it with evidence, negotiate a safer target, observe the result, and apply shared knowledge in the second plant.

## Person 3 local development
From PowerShell, run `./START-PERSON3.ps1 -Install` to install dependencies and launch the dashboard on port 3000 and the integration API on port 7200. The default mode is explicitly labeled mock data. Existing listeners are left untouched; check `/health` to confirm the API mode.

Run `bun run glue/e2e.ts --mock-journey` for the interactive mock checks. Live configuration, integration contracts, and startup/recovery instructions are in [glue/HANDOFF.md](glue/HANDOFF.md) and [glue/DEMO.md](glue/DEMO.md). Mock checks do not certify live actors, messaging, or process dynamics.

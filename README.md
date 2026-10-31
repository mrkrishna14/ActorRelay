# Factoryio — ActorRelay

Haunted Hacks @ YC, 2026-10-31. An agentic control layer on a simulated process plant: every component (pump, tank, valves, steam coil) is a Durable Actor (Terse) with its own agent. Agents negotiate setpoint changes over Agent Relay, refuse unsafe ones with cited evidence, and learn across plants.

> Digital twins predict. ActorRelay makes the components negotiate, remember, and refuse, across every plant you own.

- **Plan and frozen contract:** [CLAUDE.MD](CLAUDE.MD)
- **Per-person tasks:** [TASK1.MD](TASK1.MD) actors · [TASK2.MD](TASK2.MD) live plant, seed data, P&ID · [TASK3.MD](TASK3.MD) agents · [TASK4.MD](TASK4.MD) dashboard · [TASK5.MD](TASK5.MD) glue, e2e, demo

## Built on open source
| Project | License | What we use |
|---|---|---|
| [HistorianSim](https://github.com/ScottDuncanAI/HistorianSim) by Scott Duncan | MIT | The `heated_stirred_tank` plant model and its PI controllers, run live by `bridge/live_sim.py` |
| [HistorianRCA](https://github.com/ScottDuncanAI/HistorianRCA) by Scott Duncan | CC BY 4.0 | The TK-101 P&ID (`tk-101-hold-tank.svg`, modified: element ids added) and tag dictionary |
| [PlantCraft](https://github.com/PlantCraft/PlantCraft) | Apache 2.0 | Optional historian/trend view only. Its simulator is read-only and its loops aren't connected, so it isn't our plant |

Fictional, simulated plant only. No real plant or PLC.

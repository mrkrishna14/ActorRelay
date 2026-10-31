# Notice

`tank_model.ts` follows the heated-tank model design of **HistorianSim** by Scott Duncan.

- Project: https://github.com/ScottDuncanAI/HistorianSim
- Licence: MIT. Copyright (c) 2026 Scott Duncan. Full text: https://github.com/ScottDuncanAI/HistorianSim/blob/main/LICENSE

What follows that design: a two-state tank (level and temperature), the loop structure and PI tuning (TIC-101 cascaded onto FIC-201, LIC-101), an equal-percentage steam valve, and RK4 at 1 s substeps under a 10 s controller scan. These reached this repository as the Model notes and Physics summary in `CLAUDE.MD`.

The TypeScript in `bridge/` was written for ActorRelay at YC Haunted Hacks on 2026-10-31. No source file from that project is included here, and none was read to write it. The vessel constants in `tank_model.ts` were fitted to the numbers in `CLAUDE.MD`.

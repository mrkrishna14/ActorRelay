# ActorRelay — live demo runbook

Simulated plant only. Keep the "Simulated plant" label visible.

## Prerequisites (once per laptop)
- `bun` ≥ 1.4.2, `python3`, `terse` CLI logged in (`terse auth status`).
- `agent/.env` (gitignored) with `OPENAI_API_KEY` and `RELAY_WORKSPACE_KEY` (names only here; values from the team).
- `cd actor && bun install`, `cd agent && bun install && bun run generate`, `cd glue && bun install`. `scripts/demo-up.sh` creates `bridge/.venv` and installs `web/` itself.

## Start
```sh
scripts/demo-up.sh          # starts actors → simulator → glue → agents → dashboard, resets, prints status
scripts/demo-status.sh      # one line per service + latest proposals
scripts/demo-down.sh        # stops everything demo-up started
```
`demo-up.sh --check` reports what is up without starting anything; `--no-reset` keeps the current demo state. Logs: `.runtime/logs/<service>.log`.
Ports: actors 7100 · glue 7200 · agents 7201 · simulator 7300 · dashboard 3000. Open **http://127.0.0.1:3000**.

## The 90-second click path (CLAUDE.MD Demo steps)
| # | Do | Expect / say |
|---|---|---|
| 1 | Dashboard on Plant A | "Every component has an agent and a durable memory." Live values from the simulator. |
| 2 | Plant A → propose P-100 **85 %** ("Increase throughput") | Voters light up: TK-101, LV-101, E-101, TV-101 + Plant B's TV-101 (shared steam header). |
| 3 | Wait ~4–6 s | **BLOCKED.** LV-101: predicted ~89 % vs 81 % threshold (critical 90 − margin 10 %), citing past runs and the learned rule. |
| 4 | Wait — no click | P-100's agent counter-proposes **≈70 %** (evidence-backed from the real history), all YES, **10 s veto window**, then executes; the simulator moves (LV-101 settles ~70 %). Calibration appears: predicted vs observed. |
| 5 | Plant A → propose **85 %** again | Blocked faster; evidence #1 is the run that just executed. Say: **"It learned."** |
| 6 | Switch to Plant B → propose **85 %** | Plant B has never run above 80, yet LV-101 votes NO citing the **company rule learned in Plant A**. Say: **"Plant B learned from Plant A."** |
| 7 | Close | "Every component has a voice, every change needs consensus, and every plant learns from every other." |

Optional: during step 4's veto window press **Veto** to show the human override (proposal → VETOED, no setpoint written).

## Reset between runs
Dashboard **Reset** button, or `curl -s -X POST http://127.0.0.1:7200/reset -H 'content-type: application/json' -d '{}'`. Both plants return to the design point (P-100 50 %) with the seeded history and rules.

## Troubleshooting
| Symptom | Fix |
|---|---|
| A service shows DOWN in `demo-status.sh` | Re-run `scripts/demo-up.sh` (it only starts what is down); check `.runtime/logs/<service>.log`. |
| glue returns 503 / dashboard shows no data | Actors are down → `cd actor && terse actor dev`, then `scripts/demo-up.sh`. |
| agents `relay connecting` | OK — votes go through glue, not Relay. Relay messages resume when the hosted service recovers. |
| A vote reason starts with `[openai:… timed out → baseline]` | OpenAI was slow; the agent voted on the evidence-grounded baseline within 15 s (labelled). |
| Proposal stuck in VOTING > 30 s | It expires automatically; check `agents` is up, then propose again. |
| Counter-proposal value differs from 65 | Expected: the agents pick the highest value the real history shows safe (≈70). |
| Veto window passes but nothing executes | Glue must be reachable from the actors: `demo-up.sh` configures it; re-run it. |

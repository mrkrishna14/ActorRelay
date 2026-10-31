# Running the demo

Everything runs in WSL: Terse has no Windows runtime, and WSL cannot reach services on Windows. A Windows browser reaches them on `localhost`. Commands below are for PowerShell unless they say otherwise.

Before you start, stop anything else using the OpenAI key. A rate limit turns a real vote into a safe `no`, which blocks for the wrong reason.

## Start order

| # | Service | Port | Command | Ready when |
|---|---|---|---|---|
| 1 | Relay | 8787 | `wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/relay/start-relay.sh"` | inside WSL, `curl http://127.0.0.1:8787/health` gives 200 |
| 2 | Actors | 7100 | see below | `curl http://127.0.0.1:7100/healthz` gives 200 |
| 3 | Simulator | 7300 | `wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/bridge/run-wsl.sh"` | log line `live sim on http://127.0.0.1:7300` |
| 4 | Glue | 7200 | `wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/glue/run-wsl.sh"` | log line `relay: connected as actorrelay-system` |
| 5 | Agents | 7201 health | `wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/run-wsl.sh"` | log line `ready: 10 agents` |
| 6 | Dashboard | 3000 | see `web/HANDOFF.md` | page loads on `http://localhost:3000` |

Glue must come up before the agents: it owns the Relay identity `actorrelay-system`, and the agents listen for it. Glue and the agents share the workspace key in `~/.actorrelay/relay-workspace-key`; whichever starts first creates it.

Actors, inside WSL. The copy step is needed after any change to `actor/` or `shared/`. The first build takes a minute or more:

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:$PATH"
mkdir -p ~/actorrelay/app && tar -C "/mnt/c/Users/zubai/Haunted Hacks/Factoryio" --exclude=node_modules --exclude=tests --exclude=.durable-actors -cf - actor shared | tar -C ~/actorrelay/app -xf - && cd ~/actorrelay/app/actor && bun install
DURABLE_ACTORS_DATA_DIR=$HOME/actorrelay/data GLUE_URL=http://127.0.0.1:7200 ~/terse-probe/node_modules/.bin/terse actor dev --port 7100
```

## Seed

Run this inside WSL after everything is up, and again between takes. The first reset after a start is slower because it starts each actor's host process, so do one before anyone is watching.

```bash
curl -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:7200/reset
```

It answers `{"ok":true,...}` with the history it loaded. It seeds Company, then the Plants, then the Components, and puts both plants back at the design steady state. `seed.standIn: true` in the reply means the real history file was missing, and the dashboard shows that label.

Check the stack: `curl http://127.0.0.1:7200/health`. `mode` should be `live`, with `services` all true.

## Rehearse

```bash
bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/glue/stack-wsl.sh"
```

That starts a private copy on side ports (Terse 7176, glue 7276, agents 7279, simulator 7376), warms it, runs `glue/e2e.ts`, prints the pass/fail table, and stops. It needs only Relay running, and it does not touch a live demo's state. To run the e2e against the real ports instead, which resets them:

```bash
cd ~/.actorrelay/glue-run/glue && ~/.bun/bin/bun run e2e.ts
```

## If something dies mid-demo

| What died | What you see | What to do |
|---|---|---|
| Dashboard | Page stops updating | Reload. All state is in the actors |
| Agents | Votes stop, proposals expire after 30 s | Re-run the agents command. Start the proposal again |
| Simulator | `connected` goes false within seconds, values stop moving | Re-run the simulator command, then the reset. It keeps no state, so the plants return to design |
| Glue | Dashboard shows disconnected | Re-run the glue command. A Plant retries an execution callback for about 12 s, and all state is in the actors. A reset is not needed |
| Actors | Glue reports `actors` false and `mode` `degraded` | Restart with the `terse actor dev` line, which keeps the data directory. It takes 25 to 50 s. Glue reads both Plants every second, and that restarts their alarms |
| Relay | `relay` false on `/health`, no votes arrive | Start it again. Stop it first with SIGTERM, then SIGKILL after a few seconds, because it does not exit while clients are connected. Glue and agents reconnect. A proposal in flight may expire, so start it again |

Reset only if the demo state itself has gone wrong. A reset waits for any running dispatch and refuses new ones until it has finished.

If nothing recovers within a minute, play the backup video.

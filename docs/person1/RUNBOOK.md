# ActorRelay runbook

How to start the whole stack on this machine. Last checked 13:04 PT.

**Not runnable end to end yet.** `bridge/` and `glue/` are still being written, and `web/` is empty. Steps marked *not built* give only the agreed port. `STATUS.md` says what works now.

Run everything in WSL (`wsl.exe -d Ubuntu`). Terse has no Windows runtime, and WSL cannot reach services running on Windows. Windows browsers reach WSL services on `localhost`.

| Service | Port | Command starts | State |
|---|---|---|---|
| Relay | 8787 | `agent/spikes/relay/start-relay.sh` | Works |
| Actors | 7100 | `terse actor dev` | Runs; Plant was slow in my run |
| Simulator | 7300 | `bridge/live_sim.py` | *Not built* |
| Glue | 7200 | `glue/` | *Not built* |
| Agents | 7201 health | `agent/run-wsl.sh` | Works with a fake glue |
| Dashboard | 3000 | `web/` | *Not built* |

## First time only
These paths are for this machine. Put `OPENAI_API_KEY` in the repo's `.env`, then install the Relay runtime, which takes about 2 minutes:

```bash
wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/relay/setup-runtime.sh"
```

Copy the actors to the Linux filesystem and install them, inside WSL. Repeat this after any change to `actor/` or `shared/`:

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:$PATH"
mkdir -p ~/actorrelay/app && tar -C "/mnt/c/Users/zubai/Haunted Hacks/Factoryio" --exclude=node_modules --exclude=tests --exclude=.durable-actors -cf - actor shared | tar -C ~/actorrelay/app -xf - && cd ~/actorrelay/app/actor && bun install
```

Do not run actor code on Windows Bun. Version 1.3.14 mixes up private methods between actor classes.

## Start, in this order

**1. Relay**, in its own terminal:
```bash
wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/relay/start-relay.sh"
```

**2. Actors**, in its own WSL terminal. Keep the data directory on the Linux filesystem:
```bash
cd ~/actorrelay/app/actor && DURABLE_ACTORS_DATA_DIR=$HOME/actorrelay/data GLUE_URL=http://127.0.0.1:7200 ~/terse-probe/node_modules/.bin/terse actor dev --port 7100
```
The first build takes a minute or more. Terse loses alarms on restart, so Plants tick again only once something calls them. Glue must do that at startup.

**3. Simulator** on 7300: *not built*.

**4. Workspace key.** Glue and the agents must share one Relay workspace. Run this once, inside WSL. It needs the agents' dependencies, so run step 6 once first if `~/.actorrelay/agent-run` is missing:
```bash
cd ~/.actorrelay/agent-run/agent && ~/.bun/bin/bun run workspace.ts
```
It writes `~/.actorrelay/relay-workspace-key`. Glue reads it through `RELAY_WORKSPACE_KEY`. Never commit or print that value.

**5. Glue** on 7200: *not built*. Glue owns the Relay identity `actorrelay-system`, so it must start before the agents.

**6. Agents**, in its own terminal. It copies the code to Linux first, so rerun it to pick up changes:
```bash
wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/run-wsl.sh"
```
Ready line: `ready: 10 agents on plant-a, plant-b, company; health on 127.0.0.1:7201`.

**7. Dashboard** on 3000: *not built*.

## Stop other model traffic first
Stop evals and review sweeps before a run. OpenAI rate limits turn real votes into safe `no` votes that block for the wrong reason, and CPU load delays voters.

## Stop
Stop in reverse order. Relay does not exit on SIGTERM while clients are connected, so follow it with SIGKILL after a few seconds.

## When something fails
| Symptom | Cause | Fix |
|---|---|---|
| Actor build fails on `process` or `@types/node` | `bun install` was skipped | Repeat the copy and install |
| `not_seeded` from an actor | Reset has not run | Reset through glue |
| Plant call takes many seconds | Mailbox queue under load | Stop other traffic; check `queueWaitMs` in the reply |
| Every voter says `malformed prediction` or `retrieval failed` | OpenAI 429, or glue route down | Stop evals; check glue |
| Agents exit with `name_conflict` | Tokens file lost for an existing workspace | Delete the key file and tokens, then repeat steps 4 to 6 |
| Windows gets connection refused on 8787 | Relay listens on `localhost` only from Windows | Use `http://localhost:8787` |
| Claude roles vote as `[GPT fallback: Claude CLI unavailable]` | Claude CLI not logged in | Expected; it stays labelled |

# ActorRelay runbook

How to start the whole stack on this machine. Commands are for PowerShell unless they say WSL. `glue/DEMO.md` covers what to do when a service dies mid-demo.

**Checked 13:35 PT.** I ran the actor copy, install and start myself, on a private port. The other commands come from each module's own script and handoff, and I have not run them together. See `STATUS.md` for what works.

Everything runs in WSL. Terse has no Windows runtime, and WSL cannot reach services running on Windows. A Windows browser reaches them on `localhost`.

## First time only
Put `OPENAI_API_KEY` in the repo's `.env`, then install the Relay runtime, which takes about 2 minutes:

```bash
wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/relay/setup-runtime.sh"
```

## Before a run
Stop evals and review sweeps. OpenAI rate limits turn real votes into safe `no` votes, and CPU load delays Plant calls and voters.

## Start, in this order
Give each service its own terminal.

| # | Service | Port | Ready when |
|---|---|---|---|
| 1 | Relay | 8787 | In WSL, `curl http://127.0.0.1:8787/health` answers |
| 2 | Actors | 7100 | In WSL, `curl http://127.0.0.1:7100/healthz` answers |
| 3 | Simulator | 7300 | Log line starts `live sim on http://127.0.0.1:7300` |
| 4 | Glue | 7200 | Log line `relay: connected as actorrelay-system` |
| 5 | Agents | 7201 health | Log line starts `ready: 10 agents` |
| 6 | Dashboard | 3000 | `http://localhost:3000` loads |

**1. Relay**
```bash
wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/relay/start-relay.sh"
```

**2. Actors**, inside WSL. Repeat the copy after any change to `actor/` or `shared/`. The first build takes a minute or more.
```bash
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:$PATH"
mkdir -p ~/actorrelay/app && tar -C "/mnt/c/Users/zubai/Haunted Hacks/Factoryio" --exclude=node_modules --exclude=tests --exclude=.durable-actors -cf - actor shared | tar -C ~/actorrelay/app -xf - && cd ~/actorrelay/app/actor && bun install
DURABLE_ACTORS_DATA_DIR=$HOME/actorrelay/data GLUE_URL=http://127.0.0.1:7200 ~/terse-probe/node_modules/.bin/terse actor dev --port 7100
```

**3. Simulator**
```bash
wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/bridge/run-wsl.sh"
```

**4. Glue.** It owns the Relay identity `actorrelay-system`, so it must start before the agents.
```bash
wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/glue/run-wsl.sh"
```

**5. Agents**
```bash
wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/run-wsl.sh"
```

Glue and the agents share the key in `~/.actorrelay/relay-workspace-key`. Whichever starts first creates it. Never print or commit it.

**6. Dashboard**, from `web/`. It reads glue at `http://localhost:7200`. `web/HANDOFF.md` isn't written yet, so I have not checked this command.
```bash
bun install
```

```bash
bun run dev
```

## Seed
Do this inside WSL after everything is up, and between takes. The first reset is slow because it starts each actor's host process, so do one before anyone is watching.

```bash
curl -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:7200/reset
```

Then check the stack. `mode` should be `live`, with every service true:

```bash
curl http://127.0.0.1:7200/health
```

A reply with `seed.standIn: true` means `shared/history.json` was missing.

## Rehearse
This starts a private copy on side ports, runs the five-step `glue/e2e.ts`, prints a pass/fail table and stops. It needs only Relay running.

```bash
wsl.exe -d Ubuntu --cd /tmp -- bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/glue/stack-wsl.sh"
```

## Stop
Stop in reverse order. Relay does not exit on SIGTERM while clients are connected, so send SIGKILL a few seconds later.

## When something fails
| Symptom | Cause | Fix |
|---|---|---|
| Actor build fails on `process` or missing types | `bun install` skipped | Repeat the copy and install |
| `not_seeded` from an actor | No reset yet | Run the seed step |
| Plant call takes many seconds | Mailbox queue under load | Stop other work; `queueWaitMs` in a raw Terse reply shows the wait |
| Votes say `malformed prediction` or `retrieval failed` | OpenAI 429, or a glue route is down | Stop evals; check `/health` |
| Agents exit with `name_conflict` | Tokens file lost for an existing workspace | Delete `~/.actorrelay/relay-workspace-key`, then restart glue and the agents |
| Windows refused on port 8787 | Relay is not reachable on `127.0.0.1` from Windows | Use `http://localhost:8787` |
| Actor code misbehaves on Windows | Windows Bun 1.3.14 mixes up private methods | Run it in WSL |
| Claude roles show `[GPT fallback: Claude CLI unavailable]` | Claude CLI is not logged in | Expected; the label stays on the vote |

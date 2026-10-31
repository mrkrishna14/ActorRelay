# Relay spike

Proof that Agent Relay works for ActorRelay on this machine: a real local server, real identities and real kills. Nothing here is mocked unless a line says so. Reports are in `results/`.

## Verdict

Run the Relay server in WSL, on port 8787, from the Linux filesystem. Relay carries the proposal and vote conversation reliably and recovers from a server kill by itself. Keep identities in a persisted token file, keep channels small, and dedupe at the application level.

## Start

From PowerShell. The first line is needed once per machine and takes about two minutes, because `better-sqlite3` compiles from source.

```powershell
wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/relay/setup-runtime.sh"
wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/relay/start-relay.sh" --detach
wsl.exe -d Ubuntu --exec bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/relay/stop-relay.sh"
```

`--detach` returns once the server is healthy, and the server keeps running after the shell exits. Without it the server stays in the foreground. Code lives in `~/.actorrelay/relay-runtime`, data in `~/.actorrelay/relay-8787`. `RELAY_PORT` and `RELAY_DATA_DIR` override them.

Always stop it with `stop-relay.sh`. A plain SIGTERM hangs while any client is connected: the server closes its database first, then waits forever on open WebSockets, and clients stay attached to the dead process.

## Minimal client

```ts
import { AgentRelay } from '@agent-relay/sdk';

const baseUrl = 'http://127.0.0.1:8787';
const ws = { reconnectBaseDelayMs: 250, reconnectMaxDelayMs: 1500 };
const admin = await AgentRelay.createWorkspace({ name: 'actorrelay', baseUrl }); // persist admin.workspaceKey

const relay = new AgentRelay({ workspaceKey, baseUrl, agentClientOptions: { ws } });
const me = token
  ? await relay.workspace.reconnect({ apiToken: token })
  : await relay.workspace.register({ name: 'agent:plant-a/LV-101', type: 'agent' }); // persist me.token

await me.channels.join('plant-a');
relay.addListener('message.created', ({ message, envelope }) => { /* envelope.channel?.name, envelope.from?.name */ });
relay.addListener('thread.reply', ({ message, envelope }) => { /* envelope.parent is the original messageId */ });

const { messageId } = await me.sendMessage({ to: '#plant-a', text: JSON.stringify(payload) });
await me.reply({ messageId, text: JSON.stringify(answer) });
```

`relay-lib.mjs` is the same thing with persistence: `openWorkspace`, `openIdentity`, `ensureChannel`.

## Results

Two full runs of `proof.mjs` against a real server, each with 11 identities on `plant-a`, `plant-b` and `company`.

| Run | Result | Report |
|---|---|---|
| Bun 1.4.4, final harness | 38 passed, 1 failed | `results/proof-bun-2026-10-31T19-59-01-763Z.json` |
| Node 24.22.2, earlier harness | 36 passed, 3 failed | `results/proof-node-2026-10-31T19-45-34-823Z.json` |

The one Bun failure is a real Relay limit, covered under failure cases below. The three Node failures were harness bugs, since fixed: a test process shared an identity with a live connection, and a stale roster entry caused the other two. Node was not rerun on the final harness.

| Requirement | Observed |
|---|---|
| Ten agents plus one system identity | Registered with distinct ids, `type: 'agent'` and `type: 'system'` |
| Message reaches channel members | Plant posts reach the other 5 members once and never the other plant. `company` reaches the other 10 once |
| Reply reaches the sender | Arrives as `thread.reply`, and at every channel member, so filter on `envelope.parent` |
| Identities survive a restart | After SIGKILL and after SIGTERM plus SIGKILL: same id, tokens, memberships and history. `register` still fails with `name_conflict`, status 409 |
| A fresh process resumes an identity | `reconnect` keeps the id, and the process can send and get a reply |

### Latency

Measured over 100 round trips on a 6-member channel, while other sessions were loading the machine (raw `fsync` p50 39 ms, p95 117 ms). Treat these as a busy-machine range. A quiet baseline was never measured.

| Run | Send ack p50 / p95 | One way p50 / p95 | Round trip p50 / p95 / max | Proposal plus 5 replies p50 / max |
|---|---|---|---|---|
| Node 12:40 | 119 / 223 ms | 111 / 213 ms | 206 / 362 / 452 ms | 806 / 2,404 ms |
| Node 12:46 | 281 / 653 ms | 255 / 569 ms | 560 / 984 / 1,086 ms | 1,698 / 3,359 ms |
| Bun 13:01 | 227 / 1,030 ms | 199 / 667 ms | 454 / 1,586 / 3,436 ms | 1,274 / 3,238 ms |

Post cost grows with channel members (`probe-fanout.mjs`, 50 sends per row, mixed order):

| Members | Send ack p50 across runs |
|---|---|
| 1 | 54-60 ms |
| 5 | 75-160 ms |
| 10 | 382-568 ms |

Keep channels small. An agent process with one shared listener only needs one identity in a channel to hear it. Moving the database to `/dev/shm` helped little (round trip p50 314 ms against 425 ms in one side-by-side run), so data stays on disk, where it survives a WSL restart.

### Failure cases

| Case | Observed |
|---|---|
| Ordering | 200 awaited sends arrive in order at all 10 members. 100 concurrent sends: every receiver agrees on one order, none lost. 3 interleaved senders: FIFO per sender and one global order |
| Duplicate delivery | 0 duplicates by `messageId` in 8,600 receipts (Bun) and 9,905 (Node), both across server kills |
| Idempotency key, no restart | Same key returns the same message, delivered once |
| Idempotency key, after SIGKILL | **Fails.** The window is in memory, so a retry creates a second message with a new id. Dedupe on your own key, such as `proposalId` plus `componentId` |
| SIGKILL mid-conversation | Server killed after proposal 19 of 60. 60 of 60 acknowledged, 300 of 300 votes arrived, none lost, none duplicated, each proposal stored once. Sends carried idempotency keys, so the SDK retried through the outage. The slowest round took 5.1 s |
| Live clients after a kill | Reconnect with no code. All 11 separate streams took 5.5 to 23.7 s in total. A shared listener got its first message 3.7 s after the kill, because any one identity is enough |
| Receiver offline, server up | 10 of 10 missed messages replayed over the stream on reconnect. `inbox.list` stayed empty, so do not use it |
| Two live connections on one identity | The new connection got no reply in either run, and the Bun run confirmed the old one did. A new process is deaf while the old one is alive |

### Rules for callers

- Register once and persist the token. Use `reconnect` from then on.
- Use `agent:<componentId>` for agent names. Slashes and colons work, and the receiver sees the name unchanged.
- A sender never receives its own channel post.
- `messages.list` is newest first.
- With `idempotencyKey`, `sendMessage` retries network and 5xx failures up to three times, backing off from 1 s. Without one it throws at once. A key does not protect across a restart.
- Set `agentClientOptions.ws`, as in the client above. One stream took 14.1 s to return after the server came back on the default backoff, against 3.2 s worst case when tuned (`probe-reconnect.mjs`, 3 streams each, one run).
- A listener connects lazily, so wait for the stream before relying on it.
- Run one process per identity.

## WSL or Windows

WSL. Terse has no Windows runtime, and WSL cannot reach a Windows service on `127.0.0.1` or `localhost`. The only path that worked is gateway `172.29.80.1` to a `0.0.0.0` bind, and that address can change. So Relay, actors, glue and agents all belong in WSL.

Windows-side reachability follows the bind address in WSL:

| WSL bind | Windows `localhost` | Windows `127.0.0.1` | Windows `[::1]` |
|---|---|---|---|
| `127.0.0.1` or `0.0.0.0` | works | works | refused |
| `::` or `*` (Relay's default) | works | refused | works |

From Windows, use `localhost`. It worked in every case.

Keep code on the Linux filesystem. The server was still loading from `/mnt/c` after six minutes, blocked in `p9_client_rpc`, and one Node SDK script took 83 s. From the Linux filesystem the server boots in 2 to 15 s.

The node-24 install in WSL has no `npm`, so install with Bun.

## Glue on 7200

`probe-glue.sh` ran the glue at commit `bcfd064` in WSL on 7200 against this server, with a labelled stand-in for the actor port because Terse was not available at the time. 6 of 6 passed: WSL reached `/health`, glue connected to Relay, `POST /propose` was published to `#plant-a` and received by an agent, a vote posted on Relay reached the actor port, and a vote from the wrong identity was refused. A Windows client reached glue on `localhost` and `127.0.0.1`.

That glue has since been removed from this branch, so the probe needs a `glue/` with the same environment contract before it can run again. The network results stand. Our replacement glue has not been tested.

## Not verified

- A quiet-machine latency baseline.
- Rate limits. The default ceiling of about 250 channel posts per second comes from source reading, and these runs stayed well under it.
- Posting to a channel as a non-member.
- Behaviour after `wsl --shutdown`.

## Files

| File | Purpose |
|---|---|
| `setup-runtime.sh`, `start-relay.sh`, `stop-relay.sh` | Install, start and stop the server |
| `relay-lib.mjs` | Identity helpers |
| `smoke.mjs` | One send and one reply against a running server |
| `proof.mjs`, `identity-child.mjs` | The full proof, on a private server on port 8788 |
| `probe-names.mjs` | Name rules |
| `probe-network.mjs` | Which addresses reach a port |
| `probe-fanout.mjs` | Post cost against channel size |
| `probe-shared.mjs` | One `AgentRelay` holding all identities, across a SIGKILL |
| `probe-reconnect.mjs` | Default against tuned backoff |
| `probe-glue.sh`, `probe-glue.mjs`, `probe-actor-port.mjs` | Glue reachability, with the actor port stand-in |

Run the proof inside WSL:

```bash
cd "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/relay" && bun run proof.mjs
```

It takes about eight minutes. `--only=core,latency,ordering,restart,midflight,offline,idempotency` picks sections.

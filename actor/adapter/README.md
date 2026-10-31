# Actor adapter

Connects glue's live mode to the Component, Plant and Company actors. Transport only: the adapter forwards and the actors decide.

- `port.ts` exports `createActorPort()` and a default `{read, call}`. `terseInvoke` is the one function that talks to Terse.
- `rpc.ts` serves `port.ts` as `POST /rpc` on 127.0.0.1.

`read(kind, id)` calls `getState()`. `call(kind, id, method, args)` forwards `args` unchanged. A Component id `plant-a/LV-101` becomes the actor id `plant-a.LV-101`; ids inside `args` stay as they are.

## Run

In WSL, beside the Terse runtime:

```
cd actor
bun run adapter/rpc.ts
```

| Variable | Default | Meaning |
|---|---|---|
| `ADAPTER_PORT` | `7150` | Port for `/rpc` |
| `ACTOR_API_TOKEN` | unset | If set, requests need `Authorization: Bearer <token>` |
| `TERSE_URL`, then `DURABLE_ACTORS_CONTROL_PLANE_URL` | `http://127.0.0.1:7100` | Terse runtime |

Glue, either way:

```
GLUE_MODE=live ACTOR_API_URL=http://127.0.0.1:7150
GLUE_MODE=live ACTOR_CLIENT_MODULE=/absolute/path/to/actor/adapter/port.ts
```

Add `ACTOR_API_TOKEN` to glue when the adapter has one. If both are set, glue uses `ACTOR_CLIENT_MODULE`, and no server is needed.

## Wire

`{operation:"read",kind,id}` or `{operation:"call",kind,id,method,args}` replies `{result}`. Errors reply `{error}`:

| Status | Meaning |
|---|---|
| 400 | Malformed request |
| 401 | Missing or wrong token |
| 403 | Method off the allowlist in `port.ts`, which matches what `glue/live.ts` calls |
| 409 | The actor refused; the message starts with its stable code |
| 503 | Terse unreachable or timed out, the actor crashed, or the method does not exist |

## Test

```
cd actor/adapter
bun test ./tests
```

These drive glue's real `ActorAdapter`. No real actors run: one group uses an in-memory stub and one a local fake of Terse's invoke route, and each test name says which.

`tests/real-terse.ts` is a separate smoke through glue's `ActorAdapter`, `rpc.ts` and a live runtime. It reseeds that runtime, so it requires `ACTOR_API_URL` and belongs on a runtime you own.

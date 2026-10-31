# Contract tests

Proof that every boundary matches `shared/types.ts` and the route and method lists in `CLAUDE.MD` and `TASK1.MD` to `TASK3.MD`.

## Run

Run on WSL Bun 1.4.4. Windows Bun 1.3.14 merges same-named private methods across decorated classes, so `Component` runs `Plant`'s `#assertSeeded` and fails with a false `not_seeded`.

```bash
wsl.exe -d Ubuntu -- bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/actor/tests/contract/run.sh"
```

Typecheck, which is the compile-time half of the suite and also runs inside `types-sync.contract.test.ts`:

```bash
bun node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```

## What each file proves

| File | Boundary | Runs against |
|---|---|---|
| `plants.contract.test.ts` | `shared/plants.json` against the `CLAUDE.MD` table, field by field, parsed from the doc | Real files |
| `types-sync.contract.test.ts` | `shared/types.ts` equals the `CLAUDE.MD` block; five mutations prove drift fails `tsc` | Real files, `tsc` |
| `glue-routes.contract.test.ts` | Route table against `TASK3.MD`, accepted bodies, and shapes that must be refused | `lib/glue-spec.ts`, written from `TASK3.MD` |
| `actor-surface.contract.test.ts` | Public methods against `CLAUDE.MD`, emitted fields against the types, with any exception listed | Real source, static |
| `actor-runtime.contract.test.ts` | Input and output of every actor method, every state strictly parsed | Real classes on a **fake** Terse base |
| `agent-glue.contract.test.ts` | `HttpGlue` over HTTP, `agent/schemas.ts` structure against the types | Real agent client, **fake** spec server |
| `relay.contract.test.ts` | The five Relay messages, the `{type, payload}` envelope, the demo path, reset | Real `AgentRuntime` and actor classes; no Relay server, **scripted** LLM, **fake** Terse base |
| `types/*.assert.ts` | Agent schemas and actor signatures against the types | `tsc` |

## What this does not prove

`lib/fake-terse.ts` has no durability, no mailbox ordering and no real alarms. Persistence, concurrency, the real generated client and a real Relay server are out of scope here; `actor/tests/e2e` and `actor/tests/chaos` cover the runtime. No test here calls an LLM.

## Known exceptions

Each is pinned, so anything new fails.

- `setMetric` takes a fourth argument, `token`. `registerPlant` takes optional `models`.
- `id` is not emittable, because the Terse base class owns it. `PlantState.tick` is emitted as `tickCount`. `getState()` returns the contract names.
- `proposalSchema` reads votes with `.loose()`, so those three assertions use `Same` instead of `Equal`.

`lib/glue-spec.ts` is the route contract, written from `TASK3.MD` and the frozen types. Whatever serves as our glue should be checked against it; nothing here tests a glue service. Doc contradictions are in the shared notes folder as `ar-contract-doc-contradictions.md`.

# Crash test report (interim)

Status at 12:56 Pacific: scenarios against the real actors are running now. This report only states what was observed. Anything not run on the real runtime is labelled.

## What ran where

| Evidence | Runtime | Code under test |
|---|---|---|
| p1 durability and alarm | Real Terse 0.14.9 dev server, real `kill -9` | Throwaway probe actor in `probe/`, not ActorRelay code |
| `lib/logicChecks.ts` | Bun, no runtime | Pure functions in `actor/src/logic` only |
| `lib/selftest.ts` | Bun, no runtime | Harness only, on a stub server |

Everything else in `scenarios/` has not produced a result yet.

## Measured on the real runtime (probe actor)

- 50 of 50 acknowledged writes survived `kill -9` of the server.
- Alarms do not survive. After restart `alarm.get()` returned null and nothing fired for 4s. Calling `alarm.set` restored firing.
- Actor-to-actor calls work on a non-default port. The runtime gives each host its own server's URL, so a second server does not call 7100.
- Each actor runs in its own host process.
- `GLUE_URL` in the server's environment reaches the actors.
- First call to a cold actor: 635ms. Cold read after restart: 525ms.
- Server healthy 24.6s after the kill on an idle machine. CLI restarts took 47s and 51s, and a raw-binary start 42s, under load from other sessions. Local start rebuilds the bundle every time, with no cache and no skip option found in the source, so most of this is compile time rather than state recovery.

## Found from pure functions, not yet confirmed end to end

Both were sent to ar-actors with the exact sequence.

- A veto window that lapses during an outage executes on the first sweep after restart (`actor/src/logic/proposals.ts`), so no operator saw a live window.
- Delivering the same rule to Company twice raises `timesSeen` from 3 to 4 with no new evidence (`mergeCompanyRule` in `actor/src/logic/rules.ts`).

## How to run

From PowerShell:

```powershell
wsl.exe -d Ubuntu -- bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/actor/tests/chaos/prepare.sh"
wsl.exe -d Ubuntu -- bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/actor/tests/chaos/wsl.sh" run.ts --only c1
```

`prepare.sh` freezes `actor/` and `shared/` onto the Linux filesystem. Runs use port 7140 upward and their own data dirs under `~/ar-chaos`, so a server on 7100 is never touched.

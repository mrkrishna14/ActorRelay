# Person 1 status

**12:42 PT. Agents work with a fake glue. Actors are written but not yet proven on real Terse. The adapter that joins them to glue isn't on disk, so no live demo has run.**

| Area | State | Proof I saw | As of |
|---|---|---|---|
| Agent votes, counters, learning | Code done | 53 scripted tests reported pass; I reran 59 of the 62 agent cases, full run pending | 12:40 |
| Hostile model tests on `vote.ts` | 11 of 122 failing | I ran it, fake glue | 12:36 |
| Actor classes (`actor/src`) | Code on disk | Read only; no real Terse run seen | 12:39 |
| Actor HTTP adapter | **Not on disk.** Main is building it, port 7150 | None | 12:41 |
| Relay broker | Running in WSL, port 8787 | Listener seen; agents not yet proven on it | 12:40 |
| Terse runtime | Running in WSL for a probe, port 7100 | Listener seen; no ActorRelay run seen | 12:40 |
| `shared/history.json` | **Person 2, not delivered.** Tests use a labelled stand-in | File absent | 12:41 |
| `bridge/`, `web/`, `glue/` on this branch | Not merged | Glue read from Person 3's branch | 12:41 |

## Doesn't work yet
- No end-to-end run on real actors, real Relay and a real simulator.
- All four never-fake items are unproven live.
- Claude roles run on the labelled GPT fallback (main's decision, 12:35), so there is one real vendor today.

## Needs a person
- Person 3: use `ACTOR_API_URL=http://127.0.0.1:7150` and `RELAY_PUBLISH_URL=http://127.0.0.1:7201/publish`.
- Person 2: deliver `shared/history.json`, then rerun the agent cases on it.

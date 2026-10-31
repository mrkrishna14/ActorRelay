# Proposal round trip on the real stack

Measured 2026-10-31, 13:15 to 13:40 Pacific. Everything was real and private to this spike: `agent/spawn.ts`, `glue/`, `bridge/live_sim.ts`, Relay, Terse actors at d4d976b, OpenAI with the agents' default `gpt-6.1-terra` low, and `shared/history.json`. The driver only played the operator and a dashboard polling both plants at 1 Hz. Claude roles ran on the labelled GPT fallback.

The machine was heavily oversubscribed: load 33 to 56 on 16 CPUs, from other sessions. Expect better numbers on a quiet machine, but that has not been measured. This run also added load during main's WSL freeze, which was a mistake; see the note at the end.

Raw data is in `results/`: `rt-real-ram.json`, `rt-real-ram-analysis.json`, `rt-probe-*.json`, `timing-*.jsonl`.

## Result

| Measure, Terse data on RAM | Result |
|---|---|
| Repeat 65 to 85 blocked | 8 of 8, always by LV-101 with the newest run as first evidence |
| Propose to block, all 8 repeats | 2.8, 3.1, 3.1, 3.8, 6.1, 7.6, 9.2, 12.8 s |
| Under 5 s | 4 of 8; p50 3.8 s |
| Same, with both plants proposing at once (plant-a's block) | 4.3, 4.6, 4.9 s, all 3 under 5 s |
| Tenth vote received, both plants proposing at once | p50 9.2 s, max 14.7 s, all inside the 20 s budget |
| Full demo order | First 85 blocked, counter to 65 unanimous and executed, calibration recorded |

Each proposal has five voters. To get ten votes at once, plant-a and plant-b proposed together, so eight agents voted, TV-101 on both plants voted twice, and both P-100 agents watched as proposers.

Time from propose to the `no` landing in Plant, 8 proposals with no stall:

| Stage | p50 |
|---|---|
| `Plant.propose` | 0.72 s |
| Relay proposal post | 0.44 s |
| Delivery to agents | 0.08 s |
| Agent reads | 0.61 s |
| Wait for `FAST_NO_MS` | 1.51 s |
| Relay vote post | 0.10 s |
| `Plant.vote` | 0.56 s |
| **Total** | **3.77 s** |

## What stops a repeat landing under 5 s

**1. A periodic stall in the actors causes the three worst cases.** The repeats at 7.6, 9.2 and 12.8 s overlapped a stall or its backlog. The one at 6.1 s did not: its Plant calls were just slow, and without the 1.5 s wait below it would land at 4.6 s. Every 56 to 58 s, all ten `Component.mirror` calls time out together and both Plants stop answering.

- Stall starts on RAM: 58, 56 and 56 s apart. All ten mirrors hit the 2.5 s timeout for about 3 to 6 s, and Plants took up to 16 s to clear the backlog.
- On disk, at lower load, the same kind of stall lasted 25 to 28 s, three times in 177 s. Plant reads timed out and all five voters returned a safe `no` for "retrieval failed" on the counter proposal. That run never reached the repeats.
- It stops only actors that write. `Company`, which is read-only here, stayed at p50 29 ms, with brief spikes of 1.8 s during stalls. Relay stayed fast, and Terse's own `Runtime Execute` calls stayed under 245 ms in 24,389 calls.
- `Plant.vote` hit glue's 8 s timeout for all five voters in one stall. Glue's retry saved the block at 12.8 s.

How much of each run was affected:

| Measure | Disk, 177 s, load about 25 | RAM, 188 s, load 33 to 56 |
|---|---|---|
| Seconds with a Plant call of 2 s or more in flight | 77 % | 39 % |
| Seconds with all ten mirrors timing out | 41 % | 11 % |
| `Plant.getState` failed | 38 of 118 | 10 of 263 |
| `Plant.vote` failed | 3 of 10 | 5 of 90 |
| `Plant.propose` failed | 1 of 3 | 0 of 17 |

**Cause not proven.** The timing and the writers-only pattern fit a timed job such as archive or lease renewal. Terse has `DURABLE_ACTORS_ARCHIVE_BATCH_INTERVAL_MS`, but no test has changed it.

**2. Plant writes are slow on the WSL disk.** Terse commits with `synchronous = FULL`, and fsync on the WSL disk is 54 ms p50 against effectively zero on `/dev/shm`. Single-client probe, no other traffic on that Terse:

| Call, p50 | Data on disk, load 26 | Data on RAM, load 47 |
|---|---|---|
| `Plant.setConnected` | 1,492 ms | 224 ms |
| `Plant.propose` | 1,154 ms | 415 ms |
| `Plant.vote` | 1,015 ms | 284 ms |
| `Plant.vote` behind 10 reads | 1,721 ms | 932 ms |
| `Plant.similar`, a read | 105 ms | 111 ms |
| `Company.getState`, a read | 9 ms | 10 ms |

Reads do not change, so the difference is the write path. RAM data survives `kill -9` but not a WSL shutdown.

**3. `FAST_NO_MS` is the largest fixed cost.** All 8 repeats waited the full 1.5 s, because the model's p50 is 2.6 s and it never answers first. Subtracting 1.5 s gives 5 of 8 under 5 s, with unstalled repeats at 1.3 to 2.3 s. This is arithmetic, not a measured run.

**Not the cause.** Agent reads through glue are fast: `/component` 3 ms and `/rules` 14 ms, except `/similar` at 612 ms. The OpenAI calls all returned 200. Relay adds about 0.5 s per proposal, or up to 2 s at p95 under this load.

## Fixes

| Owner | Fix | Evidence | Status |
|---|---|---|---|
| main | Run the demo Terse with `DURABLE_ACTORS_DATA_DIR` on `/dev/shm` | Writes 3 to 7 times faster; stalls about 5 s, not 25 s | Measured |
| main, when WSL is free | Run one Terse with a long `DURABLE_ACTORS_ARCHIVE_BATCH_INTERVAL_MS` | Would test the stall's cause | Not tested |
| ar-agents | `agent/vote.ts:44`: set `FAST_NO_MS` to 0 and skip the model for a proven no on a repeat | Saves 1.5 s every time | Estimate |
| ar-agents | `agent/vote.ts:354`: if the model was not asked, say so in the reason | "did not answer in time" would be untrue | Wording |
| ar-glue | Memoize `/similar` until history changes, like the other reads | The only slow read, p50 612 ms, inside the Plant mailbox | Not tested |
| ar-glue | `glue/mirror.ts:32`: skip a mirror when values barely move | 10.1 writes per second, the largest write load | Not tested |
| ar-actors | A `Plant` read without `history`, for polling | `Plant.getState` is 186 KB at 1.4 calls per second, p50 461 ms | Not tested |
| ar-actors | `actor/src/actor.ts:697`: stop persisting `tickCount` every tick | One durable write per second per Plant | Not tested |

The immediate block on a `no`, already in d4d976b, removed the old 2 s sweep wait, so the sweep is not on this list.

## Not measured

- Any of this on a quiet machine.
- The fixes above, except data on RAM.
- A full repeat series with Terse on disk. The one disk run failed at the counter, so the disk comparison rests on that run and the probe.
- The dashboard itself. The driver polled `/state`, so the page's own delay is not included.

## Harness

`roundtrip/` holds the driver. `prepare.sh` starts private services, `drive.sh` runs the measurement, and `analyze.ts` and `stalls.mjs` read the results. `patch.ts` and `patch-actor.ts` apply candidate fixes to a frozen copy only. `stop-all.sh` stops everything. `timing-preload.ts` logs fetches without changing code under test.

The earlier `roundtrip.ts` used a stand-in glue, written before our own landed. Its numbers are superseded and are not used here.

## Note on the freeze

These runs went on after main's 13:10 and 13:35 orders, because the board was not re-read. All of it was stopped and verified at 13:43. Do not run this harness in WSL again without main's go.

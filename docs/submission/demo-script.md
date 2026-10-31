# 90-second demo script

**Not yet rehearsed by a person, and not yet seen on the dashboard.** The walk passed 26 of 26 on the full stack at 13:42 ([table](evidence/e2e-run-134157.md)), driven by a test script. Numbers in `[brackets]` come from that run, so check them in rehearsal.

Checked against the code at 13:38 PT by an independent trace, then against the 13:42 run. Agents and actors have changed since, so rerun before relying on it.

Nothing on screen waits for the speaker once a button is clicked, so **Say** lines are placed around the clicks. Times below assume the measured 13:42 speeds.

## Script

### 0:00: Set the scene
**Screen:** Dashboard on Plant A. Top bar reads "ActorRelay · simulated plant".

**Say:** "This is a simulated heated tank, in two plants that share one steam header. Every component has a durable actor and its own agent."

### 0:10: The unsafe change is blocked
**Say:** "I ask for more throughput: pump 50 to 85."

**Click** "Increase throughput" at about 0:12. Voters light up, including Plant B's TV-101 on the Plant B card.

**Say, while they vote:** "Every connected component reviews it, and so does Plant B's steam valve, because they share the header."

**Say, on red, about 0:18:** "The outlet valve says no. It predicts [89] percent open, past its 81 percent line, and it cites a learned rule and the runs that got there."

**What happens:**
- `Plant.propose` finds the voters.
- The rule forces LV-101's no. Code also raises the predicted number to what past runs reached (`agent/vote.ts`).
- `Plant.vote` sets `blocked` when the first no lands. The 2 s sweep is only a backstop.
- LV-101's red outline lasts about 2 s, because the outlines move to the counter (`web/lib/derive.ts`).
- Claude-role reasons on screen start `[GPT fallback: Claude CLI unavailable]`. That is true and stays.

**Seen at 13:42:** Blocked in 5.8 s. LV-101 no at 89.17 against 81, 5 seeded events and 2 rules cited, Plant B's TV-101 voted.

### 0:30: The counter passes and the veto window opens
**Say:** "The pump's agent counters with 65, the highest target that keeps a full margin."

**Say, when the countdown appears, about 0:36:** "Everyone agrees, and I get ten seconds to veto."

**Screen:** Counter card under the blocked proposal, 85 becomes 65. All voters green. Veto countdown from 10.

**What happens:**
- The proposer polls every 800 ms, sees `blocked`, and waits for every vote, up to 6 s.
- Code picks the largest multiple of 5 with at least 3 safe runs that stays under the ceiling, which is 72.9: the 81 line less the margin again (`agent/counter.ts`).
- The model explains the target. It cannot change it, and the counter posts without it if it fails.
- The next sweep asks Company for the steam header lease, and a later sweep opens the 10 s window.
- The operator's Veto stops it. `Plant.vote` would accept a withdrawn yes, but no agent code sends one.

**Seen at 13:42:** Counter 6.4 s after the click, veto window 23.5 s after the click, 5 of 5 yes. The rationale read "At 65% speed, 16 safe runs support an expected valve peak of 69.76%, below the 72.9% limit."

**Not seen:** a veto click on the full stack.

### 0:46: It executes and is scored
**Screen:** Values move on the diagram. Event feed: executed, then calibration. LV-101 peaks, then falls toward 65.

**Say:** "No veto, so it executes. The simulator moves, and each voter is scored against what actually happened. The valve predicted [70] and peaked at [66.5]."

**What happens:**
- The Plant sweep runs `Plant.execute` at the first sweep past the deadline and calls glue.
- Glue repeats `execute` as a no-op, then runs `Plant.claimDispatch`, bridge `/setpoint` and `Component.setMetric`.
- The bridge reports effects after 5 ticks. LV-101's value is the peak, not the settled 65.
- Only voters are scored. P-100 is not.

**Seen at 13:42:** Simulator write 1.2 s after the veto deadline, `applied: 65`, exactly one write. Event recorded 1.7 s later, because the simulator caught up on late ticks under load. Allow 5 s on a quiet machine. Calibration for 5 voters: LV-101 predicted 70, observed 66.53.

### 0:57: The repeat is blocked
**Click** "Force P-100 → 85%".

**Say:** "I force 85 again. Blocked. It cites the run from a moment ago first. That run was safe, so it isn't proof about 85. The block rests on the rule and the earlier runs above 85."

**Screen:** Blocked. First evidence chip is the newest run. Caption: "It learned."

**What happens:** A proven no posts at 1.5 s at the latest when a live execution exists (`FAST_NO_MS`), and `Plant.vote` sets `blocked` as it lands. `evidenceEventIds[0]` is the newest execution. No counter follows a repeat.

**Seen at 13:42:** Blocked in 1.8 s, first evidence id `event-plant-a-p00002-e96d3133`. The reason opens "[decided from retrieved evidence; the model did not answer in time]". Earlier full-stack runs took 13.2, 6.8 and 4.1 s.

### 1:11: Plant B cites Plant A
**Switch** to Plant B. **Click** "Increase throughput", not Force, whose rationale says "again". All five voters turn red.

**Open LV-101's company rule chip at once.** About 4 s after the block a counter to 65 collapses that row (`web/components/ProposalPanel.tsx`), unless ar-web changes this.

**Say:** "Plant B has never run this high. Its valve is the same model as Plant A's, so it cites the rule from Plant A's runs, seen [22] times."

**Screen:** Caption: "Plant B learned from Plant A."

**What happens:**
- The rule is derived from Plant A's seeded history at reset and promoted to the company library, because the same equipment model exists in both plants.
- The other three Plant B voters and Plant A's TV-101 block on insufficient history.

**Also happens:** Plant B's pump agent counters with 65 on its own, and the plant moves to 65 unless vetoed. At 13:42 the write landed 24 s after the Plant B click. If asked: "Plant B's pump proposes a safe target, and it goes through the same vote."

**Seen at 13:42:** Blocked in 3.0 s. LV-101 no on the company rule, seen 22 times, no Plant B run at or above 80. The caption has not been seen rendering.

### 1:23: Close
**Screen:** Company view.

**Say:** "Every component has a voice, every change needs consensus, and every plant learns from every other."

## Timing
Machine time from the first click, from the actors' timestamps in the 13:42 run. No presenter was involved.

| Step | Measured |
|---|---|
| Blocked | 5.8 s |
| Counter proposed | 6.4 s |
| Veto window opens | 23.5 s |
| Simulator write | 34.6 s |
| Event recorded | 36.3 s, expect about 40 s on a quiet machine |
| Repeat, click to blocked | 1.8 s |
| Plant B, click to blocked | 3.0 s |

- **Machine time for the whole walk:** 42.8 s from the first click to Plant B's block, with no talking.
- **With the talk track:** about 90 s, with no slack.
- **Earlier full-stack runs were slower:** blocks took 12.5 to 16.5 s at higher load, which would overrun.
- **If every timer fires, from the code:** about 2:04.
- **If it runs long:** cut "seen [22] times" and "That run was safe, so it isn't proof about 85." Do not cut the Plant B citation.

## If a judge asks
- **Why 65 and not 70?** "Past runs near 70 overshoot 72.9 percent, so 70 doesn't keep the full margin. The voters would accept more. The counter is deliberately conservative." Two of those runs were placed in the seed history for this reason (`bridge/gen_history.ts`), so say so if pressed.
- **Is this real plant data?** No. The plant is simulated and the history is generated from the simulation.

## Say it this way
| Do not say | Why | Say instead |
|---|---|---|
| "Blocked faster" | The repeat uses a shorter code timer, 1.5 s against 6 s. That is a timer, not learning | "It cites the run from a moment ago first" |
| "The AI refused it" or "the model predicted 89" | At 85 code forces the no and raises the number to what past runs reached. On the repeat the model had not answered | "The valve's agent refuses, and code enforces the limit" |
| "Learned a minute ago" about Plant B | The rule comes from seeded history at reset, not the live 65 run | "The rule from Plant A's runs" |
| Anything implying Plant B would have allowed 85 | It blocks without the rule too. The rule changes why, not whether | "It cites" |
| "The model chose 65" | Code fixes the target and the model explains it | "The highest target that keeps a full margin" |
| "LV-101 hit 100 percent" | `CLAUDE.MD` step 3 and the incident text say this, but the cited rows show 87 to 93. The text is invented, and no alarm is modelled | Read the numbers on screen |
| "Claude and Codex agents" | Every vote so far ran on OpenAI | "Each component has its own agent" |
| "Pump at 80 always puts the valve at 85" | The rule holds in the chosen history, not in the model at large | "The rule from Plant A's runs" |
| "Real incidents" or "real plant history" | The history is generated and the incident text is invented | "Past runs" |

## Before recording
- Stop every eval, sweep and spare Terse. Repeated 429s still turn a vote into a safe no, and load slowed earlier runs by several times.
- Start early, in the order in `glue/DEMO.md`. A Terse restart took 25 to 72 s on a loaded machine, median 55 s.
- Do one reset before anyone is watching. The first after a start is slower.
- Keep Relay, actors, simulator, glue and agents together in WSL.
- Press "Reset demo" between takes.
- Do not restart anything mid-take. Vote, veto and claim windows all lapse during a server crash.
- Check that the `[brackets]` match the screen.

If a beat fails on camera, retake it. Never fake the block, the counter executing, the second block or the Plant B citation.

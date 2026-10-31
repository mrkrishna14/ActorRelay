# 90-second demo script

**Checked at 15:49 PT against the code and three clean full-stack runs:** [13:42](evidence/e2e-run-134157.md), [14:09](evidence/e2e-run-140851.md) and [15:41](evidence/e2e-run-154135.md), all 26 of 26. All were driven by a test script, and **no person has rehearsed this on a clock.** The dashboard was seen showing the 15:41 run. Numbers in `[brackets]` come from those runs, so check them on screen.

The page also has a **Guided tour** button, which narrates the same walk with its own fixed text. This script is the presenter-led version.

Nothing on screen waits for the speaker once a button is clicked, so **Say** lines are placed around the clicks. Times below assume the measured 13:42 speeds.

## Script

### 0:00: Set the scene
**Screen:** Dashboard on Plant A. Top bar reads "ActorRelay · simulated plant".

**Say:** "This is a simulated heated tank, in two plants that share one steam header. Every component has a durable actor and its own agent."

### 0:10: The unsafe change is blocked
**Say:** "I ask for more throughput: pump 50 to 85."

**Click** "Increase throughput" at about 0:12. Voters light up, including Plant B's TV-101 on the Plant B card.

**Say, while they vote:** "Every connected component reviews it, and so does Plant B's steam valve, because they share the header." The block can land in under a second, so finish this sentence even if the screen is already red.

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

**Screen:** Counter card under the blocked proposal, 85 becomes 65. All voters green. Veto countdown from 10, with the Veto button on the story card.

**What happens:**
- The proposer polls every 800 ms, sees `blocked`, and waits for every vote, up to 6 s.
- Code picks the largest multiple of 5 with at least 3 safe runs that stays under the ceiling, which is 72.9: the 81 line less the margin again (`agent/counter.ts`).
- The model explains the target. It cannot change it, and the counter posts without it if it fails.
- The next sweep asks Company for the steam header lease, and a later sweep opens the 10 s window.
- The operator's Veto stops it. `Plant.vote` would accept a withdrawn yes, but no agent code sends one.

**Seen at 13:42:** Counter 6.4 s after the click, veto window 23.5 s after the click, 5 of 5 yes. The rationale read "At 65% speed, 16 safe runs support an expected valve peak of 69.76%, below the 72.9% limit."

**Veto:** the button sits on the story card during the window (`web/components/StoryCard.tsx`). A click on the full stack passed at 15:44:58, per main: the proposal went to vetoed and P-100 stayed at 50. It was a scripted click in a test browser, not a person.

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
**Click** "Force P-100 → 85%". It stays disabled until the 65 run is observed, so wait for the event feed.

**Say:** "I force 85 again. Blocked. It cites the run from a moment ago first. That run was safe, so it isn't proof about 85. The block rests on the rule and the earlier runs above 85."

**Screen:** Blocked. First evidence chip is the newest run. Caption: "It learned."

**What happens:** Once a live run exists, a no that evidence already proves skips the model (`agent/vote.ts`), and `Plant.vote` sets `blocked` as it lands. `evidenceEventIds[0]` is the newest execution. No counter follows a repeat.

**Seen:** 342 ms at 14:09 and 2.2 s at 13:42, with the 65 run cited first both times. At 15:42 the card on screen read "LV-101 cited the run from 3 s ago as evidence 1, its latest observation, not proof."

### 1:11: Plant B cites Plant A
**Switch** to Plant B. **Click** "Increase throughput", not Force, whose rationale says "again". All five voters turn red.

**Check LV-101's company rule chip.** When the counter appears the blocked card collapses, but `no` voters stay listed in compact form (`web/components/ProposalPanel.tsx`). Confirm in rehearsal that the chip stays reachable.

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
Machine time from the first click.

| Step | 13:42 run | 14:09 run | 15:41 run |
|---|---|---|---|
| Blocked | 5.8 s | 3.9 s | 0.4 s |
| Counter after block | 0.6 s | 1.3 s | 7.4 s |
| Repeat, click to blocked | 1.8 s | 0.34 s | 0.3 s |

- **Whole walk on a quiet machine:** in the 15:41 run the repeat started 30 s after the first click, with no talking.
- **With the talk track:** there is more slack than the 13:42 timing allowed. Let the screen catch up rather than rushing.
- **If it runs long:** cut "seen [22] times" and "That run was safe, so it isn't proof about 85." Do not cut the Plant B citation.

## If a judge asks
- **Why 65 and not 70?** "Past runs near 70 overshoot 72.9 percent, so 70 doesn't keep the full margin. The voters would accept more. The counter is deliberately conservative." Two of those runs were placed in the seed history for this reason (`bridge/gen_history.ts`), so say so if pressed.
- **Is this real plant data?** No. The plant is simulated and the history is generated from the simulation.

## Say it this way
| Do not say | Why | Say instead |
|---|---|---|
| "Much faster" or "it learned to be faster" | A repeat skips the model when evidence proves the no. That was 342 ms against 3.9 s at 14:09, but 0.3 s against 0.4 s at 15:41 | "It answers from memory, with no model call, and cites the run from a moment ago" |
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
- Preflight: read `http://127.0.0.1:7200/health` twice. `ticks` must rise between reads. If it does not, or a proposal sits in voting with 5 of 5 yes and no veto window, run `scripts/demo-restart.sh` inside WSL, about 50 s, then press "Reset demo", because it runs the e2e on the way up. Reset alone does not cure this.
- Keep the laptop awake through judging. A stack stopped ticking at 15:40 after an apparent 25-minute pause of the machine.
- Do one reset before anyone is watching. The first after a start is slower.
- Keep Relay, actors, simulator, glue and agents together in WSL.
- Press "Reset demo" between takes.
- Do not restart anything mid-take. Vote, veto and claim windows all lapse during a server crash.
- Check that the `[brackets]` match the screen.

If a beat fails on camera, retake it. Never fake the block, the counter executing, the second block or the Plant B citation.

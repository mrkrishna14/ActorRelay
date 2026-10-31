# 90-second video script

Nothing has been recorded. Pick the variant from what `bun run glue/e2e.ts --live` reports, not from what you expect:
- Exit code `0` in live mode: **Live variant**.
- Anything else: **Mock variant**.

Button labels were read from `web/app/page.tsx` at 12:35 and may change, so check them in the dry run.

## Pre-record checklist
- [ ] Glue and web are running, and `http://127.0.0.1:3000` loads at 1920×1080. Startup order is in `glue/DEMO.md`.
- [ ] The dashboard's mode indicator matches the variant you are recording.
- [ ] Click **↻ Reset**, then confirm proposals are cleared and all ten components are back.
- [ ] The "simulated plant" label is in frame, and the mode banner is not cropped.
- [ ] Notifications are off, secrets and other tabs are hidden, and the microphone level is checked.
- [ ] One full dry run came in under 90 seconds.
- [ ] After recording, watch the whole file with sound before using it.

## Live variant
Use only after live acceptance passes. Say a line only if it happened on screen. If Plant B reports insufficient history instead of citing a rule, say that and drop the "Plant B learned" line.

| Time | Operator click | Show | Narration |
|---|---|---|---|
| 0:00–0:10 | None | Tree, P&ID with live values, proposal panel, chart and events, "simulated plant" label | "This is a simulated plant. Every component has its own agent and its own durable memory, and no setpoint changes unless the connected components agree." |
| 0:10–0:22 | **↗ Increase throughput** on Plant A | P-100 50 → 85. Voters light up: TK-101, LV-101, E-101, TV-101, plus Plant B's TV-101 | "The pump asks to go from 50 to 85 percent. Everything connected has to vote, including Plant B's steam valve, because both plants share one steam header." |
| 0:22–0:35 | Open LV-101's row and an evidence chip | LV-101 NO, predicted value, threshold, evidence ids. Status BLOCKED | "The outlet valve refuses. It predicts it would pass its limit, and it cites past runs as evidence. The change is blocked." |
| 0:35–0:55 | Wait for the agent's counter. Do not click **Veto** | Counter to 65, all yes, 10-second countdown, values move, chart steps, calibration event | "The pump counters at 65. Everyone agrees, a human gets ten seconds to veto, and then it executes. Each agent compares its prediction with what happened." |
| 0:55–1:08 | **Request 85% again** | Blocked again, with this session's execution as first evidence. Caption: "It learned" | "Ask for 85 again. Blocked faster, and the first evidence is the run we just did." |
| 1:08–1:22 | Switch to Plant B, then **↗ Increase throughput** | Plant B's LV-101 votes NO, citing the company rule | "Plant B has never run this high. Its valve refuses anyway, citing the rule learned in Plant A." |
| 1:22–1:30 | None | Hold on the events feed | "Every component has a voice, every change needs consensus, and every plant learns from every other." |

## Mock variant
The mock label stays on screen for the whole video: "MOCK SERVICE · Example state and fixture votes. No live agent reasoning." If a take crops it, redo the take.

What this variant must not do:
- Don't describe a fixture vote as an agent reasoning, deciding, predicting, or learning.
- Don't say "It learned" or "Plant B learned from Plant A". The mock has no rule transfer, and the dashboard's caption only appears in live mode.
- Don't describe the 65% proposal as an agent's counter. The operator clicks it.

| Time | Operator click | Show | Narration |
|---|---|---|---|
| 0:00–0:12 | None | Dashboard, with mock banner and "simulated plant" label in frame | "This is ActorRelay running in mock mode on a simulated plant. The votes you'll see are fixtures. No live agents are connected in this recording, so this shows the interface and the workflow." |
| 0:12–0:27 | **↗ Increase throughput** on Plant A | P-100 50 → 85, voters light up, including Plant B's TV-101 | "A pump change to 85 percent needs a vote from every connected component, including Plant B's steam valve on the shared steam header." |
| 0:27–0:42 | Open LV-101's row | LV-101 NO, reason text starting "Mock prediction", status BLOCKED | "One no blocks the change. This is a fixture vote, and the design is for the valve's agent to make this call from its own history." |
| 0:42–1:02 | **Propose 65%**. Do not click **Veto** | Counter card, all yes, 10-second countdown, mock measurements update | "I'm entering a safer 65 percent by hand. In mock mode, the votes pass, a person gets ten seconds to veto, and only then does the change apply." |
| 1:02–1:14 | **Request 85% again** | Blocked by the same fixture rule. No caption | "A second request goes through the same review with no bypass. Citing the earlier run as evidence is what the live agents are designed to add, and it isn't shown here." |
| 1:14–1:22 | Switch to Company view | Plant cards, `steam-header-1`, rule library as it is | "Both plants sit under one company and share that steam header. Rules are designed to carry across plants, and that isn't running in this mock." |
| 1:22–1:30 | None | Hold on the dashboard, with mock banner visible | "Digital twins predict. ActorRelay makes the components negotiate, remember, and refuse, across every plant you own." |

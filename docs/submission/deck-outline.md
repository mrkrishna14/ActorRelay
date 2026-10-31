# Three-slide deck outline

Not built yet. Use the dashboard's visual language from `web/`, and a capture of the live page. Keep the "simulated plant" label in shot. The bullets on slides 2 and 3 were seen in the 13:42, 14:09 and 15:41 full-stack runs.

## Slide 1: The problem
**Title:** One pump change moves everything.

- Raise a pump's speed and the outlet valve, tank, steam coil and shared steam header all respond.
- Each system watches its own piece.
- The lesson from the last incident sits in a log nobody reads at change time.

**Visual:** The TK-101 diagram with arrows from P-100 to each component, and two plants on one steam header.

**Say:** "Plants are connected. The software watching them usually isn't."

**Basis:** Unit design and physics in `CLAUDE.MD`. The third bullet is the problem statement, not a measured result.

## Slide 2: The product
**Title:** Negotiate. Remember. Refuse.

- **Negotiate:** any setpoint change is a proposal, and every connected component votes on it.
- **Remember:** each voter retrieves past runs and cites them. Afterwards its prediction is scored against what happened.
- **Refuse:** one no blocks the change, with its evidence. The agent offers a safer target, and a human gets a 10-second veto.
- **Across plants:** a rule from Plant A is cited in Plant B.

**Footer, verbatim:** Digital twins predict. ActorRelay makes the components negotiate, remember, and refuse, across every plant you own.

**Visual:** The proposal card: P-100 50 to 85 blocked by LV-101, then the counter at 65.

**Say:** "No supervisory change happens unless the connected equipment agrees."

**Basis:** Seen in the 13:42, 14:09 and 15:41 full-stack runs. See [real-vs-stand-in.md](real-vs-stand-in.md).

## Slide 3: Why both tools
**Title:** Actors hold the truth. Relay carries the argument.

| Durable Actors (Terse) | Agent Relay |
|---|---|
| One actor per component, plant and company | Ten component agents, each on its plant's channel. TV-101 agents also join `company` |
| State, history, calibration and rules live in the actor | Proposals, votes and counters travel as messages |
| One call at a time per actor, so decisions stay in order | Cross-plant votes go over `company` |
| `setMetric` only accepts a one-time token from the execute path | Rules reach the other plant's agents |

**Say:** "Actors decide what is allowed. Relay is where the components argue."

**Basis:** The 13:42 run's logs show real actors and real Relay together: 10 agents, 25 votes, no failed Relay posts. "Rules reach the other plant" holds because every vote reads `/rules` (`agent/vote.ts`), and glue also posts `rule` on `company`.

## Do not put on a slide
- Two model vendors. Every vote so far ran on OpenAI.
- "Crash-proof" or "survives any failure". Fine to say: the actors' stored data held across 37 `kill -9`s with no acknowledged write lost. The rest of the stack was not crash tested.
- "Deployed". The actors run on a local Terse dev server.
- Eval headline numbers. The samples are small, the mix is partly chosen, and the results depend on the model.

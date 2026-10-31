// Shapes a reasonable reader of the docs could send, and that glue must refuse with 400.
import * as ex from "./examples";

export const nearMisses: [string, string, unknown][] = [
  ["/vote", "a bare Vote without the {vote} wrapper", ex.vote],
  ["/calibration", "a bare CalibrationEntry", ex.calibration],
  ["/rule", "a bare LearnedRule", ex.rule],
  ["/counter", "a full Proposal as proposal", { parentProposalId: "p", proposal: ex.proposal }],
  ["/counter", "from or proposerAgentId inside proposal", { parentProposalId: "p", proposal: { ...ex.routeBodies["/counter"].proposal, from: 50 } }],
  ["/counter", "a proposal missing plantId or metric", { parentProposalId: "p", proposal: { to: 65, rationale: "x" } }],
  ["/propose", "from", { ...ex.routeBodies["/propose"], from: 50 }],
  ["/propose", "proposerAgentId", { ...ex.routeBodies["/propose"], proposerAgentId: "agent:plant-a/P-100" }],
  ["/propose", "a proposer from the other plant", { ...ex.routeBodies["/propose"], plantId: "plant-b" }],
  ["/tick", "a plantId from the Plant alarm", { plantId: "plant-a" }],
  ["/execute-callback", "the one-time token", { proposalId: "p", token: "t" }],
  ["/veto", "a missing by", { proposalId: "p" }],
  ["/mirror", "a non-finite metric", { componentId: "plant-a/LV-101", metrics: { positionPct: Infinity } }],
  ["/vote", "extra fields on the vote", { vote: { ...ex.vote, confidence: 0.9 } }],
  ["/vote", "the short safe no from TASK1 step 5", { vote: { vote: "no", reason: "malformed prediction" } }],
  ["/vote", "an empty reason", { vote: { ...ex.vote, reason: "" } }],
  ["/vote", "a fractional similarCount", { vote: { ...ex.vote, similarCount: 2.5 } }],
];

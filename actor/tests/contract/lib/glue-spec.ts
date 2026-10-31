// The glue routes as TASK3.MD writes them, built on the strict contract schemas. Our own glue must accept these bodies
// and refuse anything else; agents and actors are held to them here.
import { z } from "zod";
import type { Proposal } from "../../../../shared/types";
import { CalibrationEntryS, ComponentIdS, EffectS, LearnedRuleS, MetricsS, PlantIdS, VoteS } from "./schemas";
import type { Equal, Expect } from "./typeassert";

const id = z.string().min(1);

export const ProposalInputS = z
  .strictObject({ plantId: PlantIdS, proposerComponentId: ComponentIdS, metric: id, to: z.number().finite(), rationale: z.string().min(1) })
  .refine((p) => p.proposerComponentId.startsWith(`${p.plantId}/`), "proposer must belong to the plant");

// A vote on the wire also has to pass Plant.vote, which needs a real reason and a whole count.
const WireVoteS = VoteS.extend({ reason: z.string().min(1), similarCount: z.number().int().nonnegative() }).strict();

export const routeSchemas: Record<string, z.ZodType> = {
  "/mirror": z.strictObject({ componentId: ComponentIdS, metrics: MetricsS }),
  "/tick": z.strictObject({}),
  "/propose": ProposalInputS,
  "/vote": z.strictObject({ vote: WireVoteS }),
  "/counter": z.strictObject({ parentProposalId: id, proposal: ProposalInputS }),
  "/veto": z.strictObject({ proposalId: id, by: id }),
  "/execute-callback": z.strictObject({ proposalId: id }),
  "/observed": z.strictObject({ proposalId: id, effects: z.array(EffectS) }),
  "/calibration": z.strictObject({ componentId: ComponentIdS, entry: CalibrationEntryS }),
  "/rule": z.strictObject({ rule: LearnedRuleS }),
  "/reset": z.strictObject({}),
};

export type ProposalInput = z.infer<typeof ProposalInputS>;
export type GlueSpecChecks = [Expect<Equal<ProposalInput, Pick<Proposal, "plantId" | "proposerComponentId" | "metric" | "to" | "rationale">>>];

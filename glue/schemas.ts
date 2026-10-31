import { z } from "zod";
export const plantId = z.enum(["plant-a", "plant-b"]);
const id = z.string().min(1).max(200);
export const metrics = z.record(z.string(), z.number().finite());
export const proposalInput = z.object({plantId, proposerComponentId:id, metric:id, to:z.number().finite(), rationale:z.string().min(1).max(4000)}).strict().refine(v=>v.proposerComponentId.startsWith(v.plantId+"/"), "Component must belong to plant");
export const voteSchema = z.object({proposalId:id,componentId:id,agentId:id,vote:z.enum(["yes","no"]),reason:z.string().min(1),predicted:metrics,marginPct:z.number().min(0).max(100),evidenceEventIds:z.array(id),evidenceRuleIds:z.array(id),similarCount:z.number().int().nonnegative()}).strict();
export const effect = z.object({componentId:id,metric:id,before:z.number().finite(),after:z.number().finite(),ticksToSettle:z.number().nonnegative()});
export const calibration = z.object({at:id,proposalId:id,metric:id,predicted:z.number().finite(),observed:z.number().finite(),absError:z.number().nonnegative()});
export const ruleSchema = z.object({id,scope:z.enum(["component","plant","company"]),model:z.string().nullable(),text:z.string().min(1),condition:z.object({componentId:z.string().nullable(),metric:id,op:z.enum([">=","<="]),value:z.number().finite()}),consequence:z.object({componentId:z.string().nullable(),metric:id,op:z.enum([">=","<="]),value:z.number().finite(),withinTicks:z.number().nonnegative()}),supportEventIds:z.array(id),timesSeen:z.number().int().nonnegative(),createdAt:id,lastSeenAt:id});
export const schemas:Record<string,z.ZodType> = {
 "/propose":proposalInput,"/mirror":z.object({componentId:id,metrics}).strict(),
 "/vote":z.object({vote:voteSchema}).strict(),"/counter":z.object({parentProposalId:id,proposal:proposalInput}).strict(),
 "/veto":z.object({proposalId:id,by:id}).strict(),"/execute-callback":z.object({proposalId:id}).strict(),
 "/observed":z.object({proposalId:id,effects:z.array(effect)}).strict(),
 "/calibration":z.object({componentId:id,entry:calibration}).strict(),"/rule":z.object({rule:ruleSchema}).strict(),
 "/reset":z.object({}).strict(),"/tick":z.object({}).strict()
};
export type Vote = z.infer<typeof voteSchema>;
export type ProposalInput = z.infer<typeof proposalInput>;

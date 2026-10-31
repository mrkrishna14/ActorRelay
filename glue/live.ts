import {ApiError,type ActorPort} from "./actors";
import type {SimulationPort} from "./simulation";
import {Journal} from "./journal";
import {z} from "zod";
import {metrics} from "./schemas";
const plants=["plant-a","plant-b"];
// HistoryEvent.upstreamSnapshot is flat; these are the keys history.json records and Plant.similar compares.
const upstreamKeys=["feedM3h","headerBarg","feedTempC"];
const upstreamOf=(snapshot:Record<string,Record<string,number>>)=>{const out:Record<string,number>={};for(const metrics of Object.values(snapshot))for(const key of upstreamKeys)if(key in metrics)out[key]??=metrics[key]!;return out;};
// shared/plants.json lists component ids per plant with full records at the top level; Plant.loadSeed wants the full records nested.
export function normalizeSeed(seed:any){const records:any[]=seed.components??[];const byId=new Map(records.map(c=>[c.id,c]));const seeded=seed.plants.map((p:any)=>({...p,components:p.components.map((c:any)=>typeof c==="string"?byId.get(c):c)}));for(const p of seeded)if(p.components.some((c:any)=>!c))throw new ApiError(503,`shared/plants.json is missing a component for ${p.id}`);return {plants:seeded,company:seed.company??{plants:seed.plants.map((p:any)=>p.id),sharedResources:seed.sharedResources??[]}};}
const SIM_TOLERANCE=0.5;
const claimSchema=z.discriminatedUnion("dispatch",[z.object({dispatch:z.literal(true),proposalId:z.string(),componentId:z.string(),metric:z.string(),value:z.number(),token:z.string().min(1)}),z.object({dispatch:z.literal(false),proposalId:z.string(),state:z.string()})]);
export interface Publisher {publish(type:string,payload:any,channels:string[]):Promise<void>;}
/** Polls /tick without overlapping itself. Repeated identical failures log once. Returns a stop function. */
export function startMirrorDriver(tick:()=>Promise<unknown>,intervalMs:number,log:(message:string)=>void=console.error){
 let running=false,last:string|null=null;
 const timer=setInterval(()=>{if(running)return;running=true;tick().then(()=>{last=null;},error=>{const message=String(error);if(message!==last)log(`Mirror tick failed: ${message}`);last=message;}).finally(()=>{running=false;});},intervalMs);
 return ()=>clearInterval(timer);
}
export class LiveCoordinator {
 private executing=new Set<string>();
 private ticking?:Promise<{ok:true,mirrored:number}>;
 private resetting=false;
 constructor(private actors:ActorPort,private sim:SimulationPort,private relay:Publisher,private journal:Journal){}
 private plantOf(id:string){const p=id.split("/")[0];if(!plants.includes(p))throw new ApiError(400,"Unknown plant component");return p;}
 async state(plantId:string){const [plant,company,...groups]=await Promise.all([this.actors.read("Plant",plantId),this.actors.read("Company","company"),...plants.map(p=>this.actors.read("Plant",p))]);const ids=[...new Set(groups.flatMap(p=>p.components as string[]))];const components=await Promise.all(ids.map(id=>this.actors.read("Component",id)));return {plant,company,components,mode:"live"};}
 async get(path:string,u:URL){if(path==="/state")return this.state(u.searchParams.get("plantId")??"plant-a");if(path.startsWith("/component/"))return this.actors.read("Component",decodeURIComponent(path.slice(11)));if(path==="/similar"){const id=z.string().min(1).parse(u.searchParams.get("componentId"));const metric=z.string().min(1).parse(u.searchParams.get("metric"));const to=z.coerce.number().finite().parse(z.string().min(1).parse(u.searchParams.get("to")));const k=z.coerce.number().int().min(1).max(100).parse(u.searchParams.get("k")??5);let upstream:unknown;try{upstream=JSON.parse(u.searchParams.get("upstreamSnapshot")??"{}");}catch{throw new ApiError(400,"upstreamSnapshot must be JSON");}return this.actors.call("Plant",this.plantOf(id),"similar",[id,metric,to,metrics.parse(upstream),k]);}if(path==="/rules"){const id=u.searchParams.get("componentId");const company=await this.actors.read("Company","company");const plant=id?await this.actors.read("Plant",this.plantOf(id)):null;const rules=new Map([...(plant?.rules??[]),...(company.rules??[])].map(r=>[r.id,r]));return [...rules.values()].filter(r=>!u.searchParams.get("model")||r.model===u.searchParams.get("model"));}throw new ApiError(404,"Unknown read route");}
 async post(path:string,b:any){switch(path){
  case "/mirror":return this.actors.call("Component",b.componentId,"mirror",[b.metrics]);
  case "/tick":if(this.resetting)return {ok:true,mirrored:0,skipped:"reset in progress"};return this.ticking??=this.mirrorOnce().finally(()=>{this.ticking=undefined;});
  case "/propose":case "/counter":{const input=path==="/counter"?{...b.proposal,parentProposalId:b.parentProposalId}:b;const result=await this.actors.call("Plant",input.plantId,"propose",[input]);const proposal=result.proposal??result;await this.publishAccepted("proposal",{proposal},[proposal.plantId,...(proposal.crossPlant?["company"]:[])],{proposal});return {proposal,mode:"live"};}
  case "/vote":{const p=await this.findProposal(b.vote.proposalId);return this.actors.call("Plant",p.plantId,"vote",[b.vote]);}
  case "/veto":{const p=await this.findProposal(b.proposalId);return this.actors.call("Plant",p.plantId,"veto",[b.proposalId,b.by]);}
  case "/execute-callback":return this.execute(b.proposalId);
  case "/observed":{const p=await this.findProposal(b.proposalId);const command=this.journal.get("command",b.proposalId);if(command?.status==="observed")return command.observedResult;if(command?.status!=="accepted")throw new ApiError(409,"No accepted command exists for observation");const event={id:`observed:${p.id}`,at:new Date().toISOString(),plantId:p.plantId,componentId:p.proposerComponentId,metric:p.metric,before:p.from,after:p.to,upstreamSnapshot:command.upstreamSnapshot??{},effects:b.effects,incident:null,approvedBy:p.votes.filter((v:any)=>v.vote==="yes").map((v:any)=>v.componentId),operator:null,proposalId:p.id};const result=await this.actors.call("Plant",p.plantId,"recordEvent",[event]);const recorded=result?.event??result;const stored=recorded?.id?recorded:event;this.journal.set("command",p.id,{...command,status:"observed",eventId:stored.id,observedResult:result});await this.publishAccepted("executed",{proposalId:p.id,event:stored},[p.plantId,"company"],{proposalId:p.id,eventId:stored.id});return result;}
  case "/calibration":return this.actors.call("Component",b.componentId,"addCalibration",[b.entry]);
  case "/rule":{const origin=b.rule.condition.componentId??b.rule.consequence.componentId;const plant=origin?this.plantOf(origin):null;if(!plant)throw new ApiError(400,"Rule needs originating componentId");const result=await this.actors.call("Plant",plant,"promoteRule",[b.rule]);const returned=result?.rule??result;const rule=returned?.id?returned:b.rule;await this.publishAccepted("rule",{rule},rule.scope==="company"?["company"]:[plant],{ruleId:rule.id});return result;}
  case "/reset":{if(this.resetting)throw new ApiError(409,"Reset already in progress");if(this.executing.size)throw new ApiError(409,"Execution in progress; wait before reset");this.resetting=true;try{let seed:any,history:any;try{seed=await Bun.file(new URL("../shared/plants.json",import.meta.url)).json();history=await Bun.file(new URL("../shared/history.json",import.meta.url)).json();}catch{throw new ApiError(503,"Reset needs shared/plants.json and shared/history.json");}await this.ticking?.catch(()=>{});await this.sim.reset();const {plants:seedPlants,company:seedCompany}=normalizeSeed(seed);
    // Company first: Plant.loadSeed promotes rules derived from history to Company, and Company.loadSeed wipes its rules.
    await this.actors.call("Company","company","loadSeed",[seedCompany]);for(const plant of seedPlants){for(const c of plant.components)await this.actors.call("Component",c.id,"loadSeed",[c]);await this.actors.call("Plant",plant.id,"loadSeed",[plant,history.filter((e:any)=>e.plantId===plant.id)]);}}finally{this.resetting=false;}await this.post("/tick",{});return {ok:true,mode:"live"};}
 }throw new ApiError(404,"Unknown mutation route");}
 private async mirrorOnce(){let count=0;for(const plant of plants){const snapshot=await this.sim.snapshot(plant);for(const [id,values] of Object.entries(snapshot)){await this.actors.call("Component",id,"mirror",[values]);count++;}}return {ok:true as const,mirrored:count};}
 // The actor change already committed, so a Relay failure must not read as a rejected request.
 private async publishAccepted(type:string,payload:any,channels:string[],details:Record<string,unknown>){try{await this.relay.publish(type,payload,channels);}catch(error){throw new ApiError(502,"Actor accepted the change but Relay publish failed; the message stays queued for retry. Do not resubmit.",{accepted:true,...details,cause:String(error)});}}
 private async findProposal(id:string){for(const plantId of plants){const state=await this.actors.read("Plant",plantId);const p=state.proposals.find((p:any)=>p.id===id);if(p)return p;}throw new ApiError(404,"Unknown proposal");}
 // setMetric always runs, because it is what moves the Plant's execution from claimed to applied. A mirror tick writing the same value does not. A retry that finds the token spent already succeeded.
 private async syncActor(proposalId:string,entry:any){
  try{await this.actors.call("Component",entry.command.componentId,"setMetric",[entry.command.metric,entry.command.value,proposalId,entry.token]).catch(error=>{if(!String(error?.message??error).includes("token_already_used"))throw error;});
   const {token:_token,...kept}=entry;this.journal.set("command",proposalId,{...kept,status:"accepted"});return entry.result;
  }catch(error){throw new ApiError(502,"Simulation accepted command; actor synchronization is pending. Retry callback to reconcile without redispatch.",{accepted:true,proposalId,cause:String(error)});}
 }
 async execute(proposalId:string){
  const existing=this.journal.get("command",proposalId);if(existing){if(existing.status==="actor_sync_pending")return this.syncActor(proposalId,existing);if(["accepted","observed"].includes(existing.status))return existing.result;throw new ApiError(409,"Command outcome requires reconciliation; refusing duplicate dispatch",{status:existing.status});}
  if(this.resetting)throw new ApiError(409,"Reset in progress; fresh review required");if(this.executing.has(proposalId))throw new ApiError(409,"Command already in progress");this.executing.add(proposalId);
  try{
   // The Plant actor owns approval: execute() checks votes and the veto deadline, then flips the proposal to executed and calls back here.
   const proposal=await this.findProposal(proposalId);
   if(proposal.status!=="executed")throw new ApiError(409,"Proposal has not been accepted for execution by the Plant actor");
   if(!/^plant-[ab]\/P-100$/.test(proposal.proposerComponentId)||proposal.metric!=="speedPct")throw new ApiError(403,"Simulation write target is not allowlisted");
   const refuse=async(status:number,reason:string):Promise<never>=>{await this.actors.call("Plant",proposal.plantId,"reportDispatchFailure",[proposalId,reason]).catch(()=>{});throw new ApiError(status,reason);};
   const claim=claimSchema.parse(await this.actors.call("Plant",proposal.plantId,"claimDispatch",[proposalId]));
   // Exactly one caller wins the claim. Losing means another attempt owns it, so this one must not write.
   if(!claim.dispatch)return {proposalId,dispatch:false,state:claim.state,observed:false};
   if(claim.componentId!==proposal.proposerComponentId||claim.metric!==proposal.metric||claim.value!==proposal.to)return refuse(409,"Actor claim does not match the proposal");
   const current=await this.actors.read("Component",claim.componentId),limit=current.limits[claim.metric];
   if(!limit||claim.value<limit.min||claim.value>=limit.critical*(1-current.marginPct/100))return refuse(409,"Target violates the current hard limit");
   const snapshot=await this.sim.snapshot(proposal.plantId);
   const measured=snapshot[claim.componentId]?.[claim.metric];
   if(measured===undefined||Math.abs(measured-proposal.from)>SIM_TOLERANCE)return refuse(409,"Simulation changed after proposal; fresh review required");
   const command={componentId:claim.componentId,metric:claim.metric,value:claim.value,proposalId,commandId:`proposal:${proposalId}`},upstreamSnapshot=upstreamOf(snapshot);
   this.journal.set("command",proposalId,{status:"dispatching",command,upstreamSnapshot,startedAt:new Date().toISOString()});
   let applied:any;try{applied=await this.sim.setpoint(command);}catch(error){this.journal.set("command",proposalId,{status:"unknown",command,upstreamSnapshot,error:String(error)});await this.actors.call("Plant",proposal.plantId,"reportDispatchFailure",[proposalId,`Simulator outcome unknown: ${String(error)}`]).catch(()=>{});throw error;}
   // Acceptance is not observed recovery. Do not mark recovered here.
   const appliedValue=typeof applied==="number"?applied:applied?.valueApplied??applied?.appliedValue??applied?.applied??applied?.value;
   if(typeof appliedValue!=="number"||Math.abs(appliedValue-command.value)>SIM_TOLERANCE){this.journal.set("command",proposalId,{status:"unknown",command,upstreamSnapshot,result:applied});return refuse(502,"Simulation acknowledgment did not confirm requested value; reconcile command journal");}
   const result={proposalId,commandId:command.commandId,acceptance:applied,observed:false};
   const pending={status:"actor_sync_pending",command,upstreamSnapshot,result,token:claim.token};this.journal.set("command",proposalId,pending);
   return this.syncActor(proposalId,pending);
  }finally{this.executing.delete(proposalId);}
 }
}

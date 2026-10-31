import {ApiError,type ActorPort} from "./actors";
import type {SimulationPort} from "./simulation";
import {Journal} from "./journal";
import {z} from "zod";
const plants=["plant-a","plant-b"];
// HistoryEvent.upstreamSnapshot is flat; these are the keys history.json records and Plant.similar compares.
const upstreamKeys=["feedM3h","headerBarg","feedTempC"];
const upstreamOf=(snapshot:Record<string,Record<string,number>>)=>{const out:Record<string,number>={};for(const metrics of Object.values(snapshot))for(const key of upstreamKeys)if(key in metrics)out[key]??=metrics[key]!;return out;};
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
 async get(path:string,u:URL){if(path==="/state")return this.state(u.searchParams.get("plantId")??"plant-a");if(path.startsWith("/component/"))return this.actors.read("Component",decodeURIComponent(path.slice(11)));if(path==="/similar"){const id=u.searchParams.get("componentId")!;return this.actors.call("Plant",this.plantOf(id),"similar",[id,u.searchParams.get("metric"),Number(u.searchParams.get("to")),JSON.parse(u.searchParams.get("upstreamSnapshot")??"{}"),Number(u.searchParams.get("k")??5)]);}if(path==="/rules"){const id=u.searchParams.get("componentId");const company=await this.actors.read("Company","company");const plant=id?await this.actors.read("Plant",this.plantOf(id)):null;return [...(plant?.rules??[]),...company.rules].filter(r=>!u.searchParams.get("model")||r.model===u.searchParams.get("model"));}throw new ApiError(404,"Unknown read route");}
 async post(path:string,b:any){switch(path){
  case "/mirror":return this.actors.call("Component",b.componentId,"mirror",[b.metrics]);
  case "/tick":if(this.resetting)return {ok:true,mirrored:0,skipped:"reset in progress"};return this.ticking??=this.mirrorOnce().finally(()=>{this.ticking=undefined;});
  case "/propose":case "/counter":{const input=path==="/counter"?{...b.proposal,parentProposalId:b.parentProposalId}:b;const result=await this.actors.call("Plant",input.plantId,"propose",[input]);const proposal=result.proposal??result;await this.publishAccepted("proposal",{proposal},[proposal.plantId,...(proposal.crossPlant?["company"]:[])],{proposal});return {proposal,mode:"live"};}
  case "/vote":{const p=await this.findProposal(b.vote.proposalId);return this.actors.call("Plant",p.plantId,"vote",[b.vote]);}
  case "/veto":{const p=await this.findProposal(b.proposalId);return this.actors.call("Plant",p.plantId,"veto",[b.proposalId,b.by]);}
  case "/execute-callback":return this.execute(b.proposalId);
  case "/observed":{const p=await this.findProposal(b.proposalId);const command=this.journal.get("command",b.proposalId);if(command?.status==="observed")return command.observedResult;if(command?.status!=="accepted")throw new ApiError(409,"No accepted command exists for observation");const event={id:`observed:${p.id}`,at:new Date().toISOString(),plantId:p.plantId,componentId:p.proposerComponentId,metric:p.metric,before:p.from,after:p.to,upstreamSnapshot:command.upstreamSnapshot??{},effects:b.effects,incident:null,approvedBy:p.votes.filter((v:any)=>v.vote==="yes").map((v:any)=>v.componentId),operator:null,proposalId:p.id};const result=await this.actors.call("Plant",p.plantId,"recordEvent",[event]);this.journal.set("command",p.id,{...command,status:"observed",eventId:event.id,observedResult:result});await this.publishAccepted("executed",{proposalId:p.id,event},[p.plantId,"company"],{proposalId:p.id,eventId:event.id});return result;}
  case "/calibration":return this.actors.call("Component",b.componentId,"addCalibration",[b.entry]);
  case "/rule":{const plant=b.rule.condition.componentId?this.plantOf(b.rule.condition.componentId):null;if(!plant)throw new ApiError(400,"Rule needs originating componentId");const result=await this.actors.call("Plant",plant,"promoteRule",[b.rule]);await this.publishAccepted("rule",{rule:b.rule},b.rule.scope==="company"?["company"]:[plant],{ruleId:b.rule.id});return result;}
  case "/reset":{if(this.executing.size)throw new ApiError(409,"Execution in progress; wait before reset");let seed:any,history:any;try{seed=await Bun.file(new URL("../shared/plants.json",import.meta.url)).json();history=await Bun.file(new URL("../shared/history.json",import.meta.url)).json();}catch{throw new ApiError(503,"Reset needs shared/plants.json and shared/history.json");}this.resetting=true;try{await this.ticking?.catch(()=>{});await this.sim.reset();for(const plant of seed.plants){for(const c of plant.components)await this.actors.call("Component",c.id,"loadSeed",[c]);await this.actors.call("Plant",plant.id,"loadSeed",[plant,history.filter((e:any)=>e.plantId===plant.id)]);}await this.actors.call("Company","company","loadSeed",[seed.company]);}finally{this.resetting=false;}await this.post("/tick",{});return {ok:true,mode:"live"};}
 }throw new ApiError(404,"Unknown mutation route");}
 private async mirrorOnce(){let count=0;for(const plant of plants){const snapshot=await this.sim.snapshot(plant);for(const [id,values] of Object.entries(snapshot)){await this.actors.call("Component",id,"mirror",[values]);count++;}}return {ok:true as const,mirrored:count};}
 // The actor change already committed, so a Relay failure must not read as a rejected request.
 private async publishAccepted(type:string,payload:any,channels:string[],details:Record<string,unknown>){try{await this.relay.publish(type,payload,channels);}catch(error){throw new ApiError(502,"Actor accepted the change but Relay publish failed; the message stays queued for retry. Do not resubmit.",{accepted:true,...details,cause:String(error)});}}
 private async findProposal(id:string){for(const plantId of plants){const state=await this.actors.read("Plant",plantId);const p=state.proposals.find((p:any)=>p.id===id);if(p)return p;}throw new ApiError(404,"Unknown proposal");}
 // The first attempt always calls setMetric: a mirror tick can already have written the new value. Only a retry may skip it.
 private async syncActor(proposalId:string,entry:any,firstAttempt=false){
  try{const c=firstAttempt?null:await this.actors.read("Component",entry.command.componentId);if(!c||c.metrics[entry.command.metric]!==entry.command.value)await this.actors.call("Component",entry.command.componentId,"setMetric",[entry.command.metric,entry.command.value,proposalId,entry.token]);
   const {token:_token,...kept}=entry;this.journal.set("command",proposalId,{...kept,status:"accepted"});return entry.result;
  }catch(error){throw new ApiError(502,"Simulation accepted command; actor synchronization is pending. Retry callback to reconcile without redispatch.",{accepted:true,proposalId,cause:String(error)});}
 }
 async execute(proposalId:string){
  const existing=this.journal.get("command",proposalId);if(existing){if(existing.status==="actor_sync_pending")return this.syncActor(proposalId,existing);if(["accepted","observed"].includes(existing.status))return existing.result;throw new ApiError(409,"Command outcome requires reconciliation; refusing duplicate dispatch",{status:existing.status});}
  if(this.resetting)throw new ApiError(409,"Reset in progress; fresh review required");if(this.executing.has(proposalId))throw new ApiError(409,"Command already in progress");this.executing.add(proposalId);
  try{
   const proposal=await this.findProposal(proposalId);
   if(proposal.status!=="veto_window"||!proposal.vetoDeadline||!Number.isFinite(Date.parse(proposal.vetoDeadline))||Date.parse(proposal.vetoDeadline)>Date.now()||!proposal.requiredVoters?.length||new Set(proposal.requiredVoters).size!==proposal.requiredVoters.length||proposal.votes.length!==proposal.requiredVoters.length||new Set(proposal.votes.map((v:any)=>v.componentId)).size!==proposal.votes.length||proposal.requiredVoters.some((id:string)=>!proposal.votes.some((v:any)=>v.componentId===id&&v.vote==="yes")))throw new ApiError(409,"Proposal lacks unanimous approval or elapsed veto window");
   if(!/^plant-[ab]\/P-100$/.test(proposal.proposerComponentId)||proposal.metric!=="speedPct")throw new ApiError(403,"Simulation write target is not allowlisted");
   const current=await this.actors.read("Component",proposal.proposerComponentId),limit=current.limits[proposal.metric];
   if(current.metrics[proposal.metric]!==proposal.from||!limit||proposal.to<limit.min||proposal.to>=limit.critical*(1-current.marginPct/100))throw new ApiError(409,"Stale proposal or current hard limit violation");
   const auth=z.object({authorized:z.literal(true),token:z.string().min(1),expiresAt:z.string().datetime(),proposalId:z.literal(proposalId)}).parse(await this.actors.call("Plant",proposal.plantId,"authorizeExecution",[proposalId]));
   const snapshot=await this.sim.snapshot(proposal.plantId);
   if(snapshot[proposal.proposerComponentId]?.[proposal.metric]!==proposal.from)throw new ApiError(409,"Simulation changed after proposal; fresh review required");
   if(Date.parse(auth.expiresAt)<=Date.now())throw new ApiError(409,"Actor execution token expired");
   const command={componentId:proposal.proposerComponentId,metric:proposal.metric,value:proposal.to,proposalId,commandId:`proposal:${proposalId}`},upstreamSnapshot=upstreamOf(snapshot);
   this.journal.set("command",proposalId,{status:"dispatching",command,upstreamSnapshot,startedAt:new Date().toISOString()});
   let applied:any;try{applied=await this.sim.setpoint(command);}catch(error){this.journal.set("command",proposalId,{status:"unknown",command,upstreamSnapshot,error:String(error)});throw error;}
   // Acceptance is not observed recovery. Do not mark recovered here.
   const appliedValue=typeof applied==="number"?applied:applied?.valueApplied??applied?.appliedValue??applied?.applied??applied?.value;
   if(appliedValue!==command.value){this.journal.set("command",proposalId,{status:"unknown",command,upstreamSnapshot,result:applied});throw new ApiError(502,"Simulation acknowledgment did not confirm requested value; reconcile command journal");}
   const result={proposalId,commandId:command.commandId,acceptance:applied,observed:false};
   const pending={status:"actor_sync_pending",command,upstreamSnapshot,result,token:auth.token};this.journal.set("command",proposalId,pending);
   return this.syncActor(proposalId,pending,true);
  }finally{this.executing.delete(proposalId);}
 }
}

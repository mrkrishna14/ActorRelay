// FAKE HARNESS ONLY. These are stand-ins for services other owners run for real.
// Nothing here is a live agent, a durable actor, Relay delivery, or physics.
// FakeActors follows the contract in origin/zubair:actor/src/actor.ts and logic/*.ts by hand. It does not run that code.
import {ApiError,type ActorKind,type ActorPort} from "../actors";
import type {SimulationPort} from "../simulation";
import type {Publisher} from "../live";

const clone=<T>(v:T):T=>v===undefined?v:structuredClone(v);
const latency=()=>Bun.sleep(1); // every port call yields, as a real RPC would
const SETPOINT_TOLERANCE=0.01,RELEVANCE_BAND=0.15;

export type FakeOpts={
 vetoMs?:number; claimTimeoutMs?:number;
 ids?:"actor"|"per-seed-counter";               // actor: `<plant>-p00001-<nonce>` as in actor/src/ids.ts. per-seed-counter: a hypothetical actor that restarts its ids after loadSeed
 similar?:"actor"|"contract-literal"|"nearest-only"; // actor: rankSimilar's live-event-first ranking. contract-literal: CLAUDE.md ranking with a 5 m3/h feed bucket (the bucket size is the harness's guess). nearest-only: same, no bucket
 rawCompanySeed?:boolean;                       // store shared/plants.json company exactly as seeded (it has no `rules`)
 plainErrors?:boolean;                          // throw plain Error("code: detail") as the real actor does, with no HTTP status
};

const STATUS:Record<string,number>={proposal_not_found:404,not_seeded:503,not_a_required_voter:403,invalid_token:403,invalid_vote:400,invalid_proposal:400,invalid_rule:400,invalid_event:400,invalid_veto:400,invalid_counter:400,out_of_limits:400,unsafe_yes:400};
type Execution={proposalId:string,componentId:string,metric:string,value:number,state:"accepted"|"claimed"|"applied"|"observed"|"failed",attempts:number,acceptedAt:string,claimedAt:string|null,appliedAt:string|null,observedAt:string|null,failedAt:string|null,failure:string|null};
type PlantMeta={seq:number,topology:Record<string,any>,setpoints:Record<string,Record<string,number>>,executions:Map<string,Execution>,tokens:Map<string,string>,liveEventIds:string[]};
const ruleKey=(r:any)=>[r.condition.componentId,r.condition.metric,r.condition.op,r.consequence.componentId,r.consequence.metric,r.consequence.op].join("|");
const companyRuleKey=(r:any)=>[r.model,r.condition.metric,r.condition.op,r.consequence.metric,r.consequence.op].join("|");

/** FAKE Component, Plant and Company store, shaped like Person 1's actors. */
export class FakeActors implements ActorPort {
 components=new Map<string,any>(); plants=new Map<string,any>(); company:any=null;
 log:{kind:string,id:string,method:string,args:any[]}[]=[];
 failNext:Record<string,number>={};   // the call fails and has no effect
 loseReply:Record<string,number>={};  // the call takes effect, then the reply is lost
 beforeMirror?:(id:string)=>Promise<void>;
 callbacks:string[]=[];               // FAKE of postToGlue("/execute-callback"): recorded, and sent only if onCallback is set
 onCallback?:(proposalId:string)=>Promise<unknown>;
 lastCallback?:Promise<{ok:boolean,error?:any}>;
 private meta=new Map<string,PlantMeta>(); private plantModels=new Map<string,string[]>();
 constructor(public opts:FakeOpts={}){}
 count(method:string){return this.log.filter(c=>c.method===method).length;}
 private fail(code:string,detail:string):never{
  const message=`${code}: ${detail} (FAKE actor)`;
  if(this.opts.plainErrors)throw new Error(message);
  throw new ApiError(STATUS[code]??409,message);
 }

 async read(kind:ActorKind,id:string){
  await latency();
  const value=kind==="Component"?this.components.get(id):kind==="Plant"?this.plants.get(id):this.company;
  if(!value)throw new ApiError(404,`FAKE actor: unknown ${kind} ${id}`);
  return clone(value);
 }
 async call(kind:ActorKind,id:string,method:string,rawArgs:unknown[]){
  await latency();
  const args=clone(rawArgs) as any[];
  this.log.push({kind,id,method,args});
  if(this.failNext[method]){this.failNext[method]!--;throw new ApiError(503,`FAKE actor: injected ${method} failure`);}
  const fn=(this as any)[`${kind}_${method}`];
  if(!fn)throw new ApiError(404,`FAKE actor: no method ${kind}.${method}`);
  const result=clone(await fn.call(this,id,...args));
  if(this.loseReply[method]){this.loseReply[method]!--;throw new ApiError(503,`FAKE actor: injected lost ${method} reply`);}
  return result;
 }

 Component_loadSeed(id:string,c:any){this.components.set(id,{...c,calibration:[]});return this.comp(id);}
 async Component_mirror(id:string,metrics:any){if(this.beforeMirror)await this.beforeMirror(id);const c=this.comp(id);c.metrics={...c.metrics,...metrics};c.lastTick=new Date().toISOString();return c;}
 Component_addCalibration(id:string,e:any){const c=this.comp(id);c.calibration.push(e);return c;}
 // As in actor.ts: only reachable with a token Plant minted for this exact proposal, component, metric and value.
 Component_setMetric(id:string,metric:string,value:number,proposalId:string,token:string){
  const c=this.comp(id);
  if(!Object.hasOwn(c.limits,metric))this.fail("invalid_metric",`${id} has no limit for ${metric}`);
  if(!proposalId||!token)this.fail("invalid_token","proposalId and token are required");
  this.log.push({kind:"Plant",id:c.plantId,method:"redeemToken",args:[proposalId]});
  this.Plant_redeemToken(c.plantId,{proposalId,token,componentId:id,metric,value});
  c.metrics[metric]=value;c.lastTick=new Date().toISOString();
  return c;
 }

 Plant_loadSeed(id:string,plant:any,history:any[]){
  const topology:Record<string,any>={},setpoints:Record<string,Record<string,number>>={};
  for(const c of plant.components){topology[c.id]=c;setpoints[c.id]={...c.metrics};}
  this.plants.set(id,{id,name:plant.name,components:plant.components.map((c:any)=>c.id),proposals:[],history:history.filter((e:any)=>e.plantId===id),rules:[],audit:[],tick:0,connected:false});
  this.meta.set(id,{seq:0,topology,setpoints,executions:new Map(),tokens:new Map(),liveEventIds:[]});
  this.plantModels.set(id,[...new Set(plant.components.map((c:any)=>c.model as string))]); // the real Plant registers these on its first sweep
  return {components:plant.components.length,history:this.plant(id).history.length,rules:0};
 }
 Plant_propose(id:string,input:any){
  const plant=this.plant(id),m=this.metaOf(id),def=m.topology[input.proposerComponentId];
  if(!def)this.fail("invalid_proposal",`${input.proposerComponentId} is not a component of ${id}`);
  if(!Object.hasOwn(def.limits,input.metric))this.fail("invalid_proposal",`${input.proposerComponentId} has no limit for ${input.metric}`);
  const limit=def.limits[input.metric],current=m.setpoints[input.proposerComponentId]![input.metric];
  if(input.to<limit.min||input.to>=limit.critical)this.fail("out_of_limits",`${input.metric} ${input.to} is outside ${limit.min}..${limit.critical}`);
  if(current===undefined)this.fail("invalid_proposal",`${input.proposerComponentId} has no current ${input.metric}`);
  if(Math.abs(input.to-current)<=SETPOINT_TOLERANCE)this.fail("invalid_proposal",`${input.metric} is already ${current}`);
  if(input.parentProposalId){
   const parent=plant.proposals.find((p:any)=>p.id===input.parentProposalId);
   if(!parent)this.fail("proposal_not_found",input.parentProposalId);
   if(parent.proposerComponentId!==input.proposerComponentId)this.fail("invalid_counter","a counter must come from the parent's proposer");
   if(parent.status!=="blocked")this.fail("parent_not_blocked",`${parent.id} is ${parent.status}`);
   if(plant.proposals.filter((p:any)=>p.parentProposalId===parent.id).length>=2)this.fail("too_many_counters",parent.id);
  }
  const local=this.reachable(id,input.proposerComponentId),remote=this.Company_requiredCrossPlantVoters("company",{plantId:id,proposerComponentId:input.proposerComponentId,requiredVoters:local});
  m.seq++;
  const proposal={id:this.opts.ids==="per-seed-counter"?`${id}-p${String(m.seq).padStart(5,"0")}`:`${id}-p${String(m.seq).padStart(5,"0")}-${crypto.randomUUID().slice(0,8)}`,at:new Date().toISOString(),plantId:id,proposerComponentId:input.proposerComponentId,proposerAgentId:`agent:${input.proposerComponentId}`,metric:input.metric,from:current,to:input.to,rationale:input.rationale,requiredVoters:[...local,...remote],votes:[],status:"voting",vetoDeadline:null,parentProposalId:input.parentProposalId??null,crossPlant:remote.length>0};
  plant.proposals.push(proposal);return proposal;
 }
 Plant_vote(id:string,v:any){
  const plant=this.plant(id),p=this.findIn(id,v.proposalId);
  if(!p.requiredVoters.includes(v.componentId))this.fail("not_a_required_voter",`${v.componentId} on ${p.id}`);
  if(v.agentId!==`agent:${v.componentId}`)this.fail("invalid_vote",`agentId must be agent:${v.componentId}`);
  const existing=p.votes.find((x:any)=>x.componentId===v.componentId),withdraw=p.status==="veto_window"&&existing?.vote==="yes"&&v.vote==="no";
  if(!withdraw){
   if(existing)this.fail("duplicate_vote",`${v.componentId} already voted on ${p.id}`);
   if(p.status!=="voting"&&p.status!=="blocked")this.fail("stale_proposal",`${p.id} is ${p.status}`);
  }
  const unknownEvent=v.evidenceEventIds.find((e:string)=>!plant.history.some((h:any)=>h.id===e));
  if(unknownEvent!==undefined)this.fail("invalid_vote",`evidence event ${unknownEvent} is not in history`);
  const unknownRule=v.evidenceRuleIds.find((r:string)=>!plant.rules.some((x:any)=>x.id===r)&&!(this.company?.rules??[]).some((x:any)=>x.id===r));
  if(unknownRule!==undefined)this.fail("invalid_vote",`evidence rule ${unknownRule} does not exist`);
  const meta=this.metaOf(id),def=meta.topology[v.componentId]??meta.topology[`${id}/${v.componentId.split("/")[1]}`];
  const vote=this.enforceVoteSafety(v,def);
  if(withdraw){p.votes=p.votes.map((x:any)=>x.componentId===vote.componentId?vote:x);p.status="blocked";p.vetoDeadline=null;}
  else p.votes.push(vote);
  return p;
 }
 private enforceVoteSafety(vote:any,def:any){
  if(vote.vote!=="yes"||!def)return vote;
  for(const [metric,limit] of Object.entries<any>(def.limits)){
   if(!Object.hasOwn(vote.predicted,metric))this.fail("invalid_vote",`a yes from ${vote.componentId} must predict ${metric}`);
   const predicted=vote.predicted[metric];
   if(predicted>=Math.max(limit.critical*(1-vote.marginPct/100),limit.max))this.fail("unsafe_yes",`${vote.componentId} predicts ${metric} ${predicted} past its limit`);
   if(vote.similarCount===0&&predicted>=limit.critical*0.85)return {...vote,vote:"no",reason:`insufficient history: no similar events and ${metric} is within 15% of critical. ${vote.reason}`};
  }
  return vote;
 }
 // As in actor.ts the deadline is not checked here: a veto lands until the sweep has executed the proposal.
 Plant_veto(id:string,proposalId:string,by:string){
  if(!by)this.fail("invalid_veto","by is required");
  const p=this.findIn(id,proposalId);
  if(p.status!=="veto_window")this.fail("veto_closed",`${proposalId} is ${p.status}`);
  p.status="vetoed";p.vetoDeadline=null;return p;
 }
 // Records acceptance and then calls back. Idempotent. Whether the simulator moved is recorded later.
 Plant_execute(id:string,proposalId:string){
  const m=this.metaOf(id),existing=m.executions.get(proposalId);
  if(existing)return existing;
  const p=this.findIn(id,proposalId);
  if(p.status!=="veto_window")this.fail("not_approved",`${p.id} is ${p.status}`);
  if(p.vetoDeadline===null||Date.now()<Date.parse(p.vetoDeadline))this.fail("veto_window_open",`${p.id} is still in its veto window`);
  if(!this.unanimous(p))this.fail("not_approved",`${p.id} does not have every required yes`);
  if(this.isStale(id,p))this.fail("stale_proposal",`${p.id} was proposed from ${p.from}`);
  const limit=m.topology[p.proposerComponentId]?.limits[p.metric];
  if(!limit)this.fail("not_approved",`no limit for ${p.metric}`);
  if(p.to<limit.min||p.to>=limit.critical)this.fail("out_of_limits",`${p.metric} ${p.to} is outside ${limit.min}..${limit.critical}`);
  const execution:Execution={proposalId,componentId:p.proposerComponentId,metric:p.metric,value:p.to,state:"accepted",attempts:1,acceptedAt:new Date().toISOString(),claimedAt:null,appliedAt:null,observedAt:null,failedAt:null,failure:null};
  m.executions.set(proposalId,execution);p.status="executed";m.setpoints[p.proposerComponentId]![p.metric]=p.to;
  this.callbacks.push(proposalId);
  if(this.onCallback){const send=this.onCallback;this.lastCallback=Promise.resolve().then(()=>send(proposalId)).then(()=>({ok:true}),error=>({ok:false,error}));}
  return execution;
 }
 Plant_getExecution(id:string,proposalId:string){return this.metaOf(id).executions.get(proposalId)??null;}
 // Exactly one caller is told to write to the simulator.
 Plant_claimDispatch(id:string,proposalId:string){
  const m=this.metaOf(id),execution=m.executions.get(proposalId);
  if(!execution)this.fail("not_accepted",`${proposalId} has not been accepted`);
  if(execution.state!=="accepted")return {dispatch:false,proposalId,state:execution.state};
  const token=`fake-token-${crypto.randomUUID()}`;
  m.tokens.set(proposalId,token);execution.state="claimed";execution.claimedAt=new Date().toISOString();
  const {componentId,metric,value}=execution;
  return {dispatch:true,proposalId,componentId,metric,value,token};
 }
 // Failed attempts do not burn the token. Only an exact match consumes it.
 Plant_redeemToken(id:string,r:any){
  const m=this.metaOf(id),execution=m.executions.get(r.proposalId);
  if(!execution)this.fail("invalid_token","no such execution");
  if(m.tokens.get(r.proposalId)===undefined||m.tokens.get(r.proposalId)!==r.token)this.fail("invalid_token","token does not match");
  if(execution.componentId!==r.componentId||execution.metric!==r.metric||execution.value!==r.value)this.fail("invalid_token","token is bound to another write");
  if(execution.state==="applied"||execution.state==="observed")this.fail("token_already_used",r.proposalId);
  if(execution.state!=="claimed")this.fail("invalid_token",`execution is ${execution.state}`);
  execution.state="applied";execution.appliedAt=new Date().toISOString();
  return {redeemed:true};
 }
 Plant_reportDispatchFailure(id:string,proposalId:string,reason:string){
  const execution=this.metaOf(id).executions.get(proposalId);
  if(!execution)this.fail("not_accepted",`${proposalId} has not been accepted`);
  if(execution.state==="applied"||execution.state==="observed")this.fail("already_applied",proposalId);
  return this.failExecution(id,execution,reason||"dispatch failed");
 }
 private failExecution(id:string,execution:Execution,reason:string){
  execution.state="failed";execution.failedAt=new Date().toISOString();execution.failure=reason;
  const p=this.plant(id).proposals.find((x:any)=>x.id===execution.proposalId);
  if(p){p.status="expired";this.metaOf(id).setpoints[p.proposerComponentId]![p.metric]=p.from;}
  return execution;
 }
 // Returns the stored event. With a proposal, the id and values are the actor's own, not the caller's.
 Plant_recordEvent(id:string,e:any){
  const plant=this.plant(id),m=this.metaOf(id);
  if(!Array.isArray(e?.effects))this.fail("invalid_event","effects must be an array");
  const proposalId=e.proposalId??null;
  if(proposalId!==null){const existing=plant.history.find((x:any)=>x.proposalId===proposalId);if(existing)return existing;}
  let event=e;
  if(proposalId!==null){
   const p=this.findIn(id,proposalId),execution=m.executions.get(proposalId);
   if(p.status!=="executed"||!execution)this.fail("not_executed",`${proposalId} is ${p.status}`);
   if(execution.state!=="claimed"&&execution.state!=="applied")this.fail("not_dispatched",`${proposalId} is ${execution.state}`);
   event={id:`event-${proposalId}`,at:new Date().toISOString(),plantId:id,componentId:p.proposerComponentId,metric:p.metric,before:p.from,after:p.to,upstreamSnapshot:e.upstreamSnapshot??{},effects:e.effects,incident:e.incident??null,approvedBy:p.votes.filter((v:any)=>v.vote==="yes").map((v:any)=>v.agentId),operator:e.operator??null,proposalId};
   execution.state="observed";execution.observedAt=event.at;
  }
  if(plant.history.some((x:any)=>x.id===event.id))this.fail("duplicate_event",event.id);
  plant.history.push(event);m.liveEventIds.push(event.id);
  return event;
 }
 Plant_promoteRule(id:string,r:any){
  const plant=this.plant(id);
  const missing=r.supportEventIds.find((e:string)=>!plant.history.some((h:any)=>h.id===e));
  if(missing!==undefined)this.fail("invalid_rule",`supporting event ${missing} is not in history`);
  const index=plant.rules.findIndex((x:any)=>ruleKey(x)===ruleKey(r));
  let rule=r;
  if(index===-1)plant.rules.push(r);
  else{const current=plant.rules[index],supportEventIds=[...new Set([...current.supportEventIds,...r.supportEventIds])];rule={...current,supportEventIds,timesSeen:Math.max(current.timesSeen,supportEventIds.length),lastSeenAt:new Date().toISOString()};plant.rules[index]=rule;}
  if(rule.model!==null&&[...this.plantModels].some(([other,models])=>other!==id&&models.includes(rule.model)))this.promoteToCompany(rule,id);
  return rule;
 }
 // Company rules drop component ids so the same equipment model matches in any plant.
 private promoteToCompany(rule:any,plantId:string){
  const key=[rule.model,rule.condition.metric,rule.consequence.metric,rule.consequence.op===">="?"high":"low"].join(":");
  const incoming={...rule,id:`company-rule:${key}`,scope:"company",text:`${rule.text} (first learned in ${plantId})`,condition:{...rule.condition,componentId:null},consequence:{...rule.consequence,componentId:null}};
  this.company.rules??=[];
  const index=this.company.rules.findIndex((x:any)=>companyRuleKey(x)===companyRuleKey(incoming));
  if(index===-1)this.company.rules.push(incoming);
  else{const current=this.company.rules[index];this.company.rules[index]={...current,text:incoming.text,condition:incoming.condition,consequence:incoming.consequence,supportEventIds:[...new Set([...current.supportEventIds,...incoming.supportEventIds])],timesSeen:current.timesSeen+1,lastSeenAt:new Date().toISOString()};}
 }
 Plant_similar(id:string,componentId:string,metric:string,to:number,snapshot:any,k:number){
  const same=this.plant(id).history.filter((e:any)=>e.componentId===componentId&&e.metric===metric);
  const nearest=(a:any,b:any)=>Math.abs(a.after-to)-Math.abs(b.after-to);
  if(this.opts.similar==="contract-literal"){
   const bucket=(s:any)=>Math.round((s?.feedM3h??0)/5);
   return same.filter((e:any)=>bucket(e.upstreamSnapshot)===bucket(snapshot)).sort(nearest).slice(0,k);
  }
  if(this.opts.similar==="nearest-only")return same.sort(nearest).slice(0,k);
  return this.rankSimilar(id,same,componentId,metric,to,snapshot,k);
 }
 // Hand copy of actor/src/logic/similar.ts: the newest live event first, then seeded events inside the relevance band by distance.
 private rankSimilar(id:string,candidates:any[],componentId:string,metric:string,to:number,upstream:Record<string,number>,k:number){
  if(!candidates.length)return [];
  const limit=this.metaOf(id).topology[componentId]?.limits?.[metric],spread=(v:number[])=>v.length?Math.max(...v)-Math.min(...v):0;
  const range=(limit&&limit.max-limit.min>0)?limit.max-limit.min:spread(candidates.map(e=>e.after))||1;
  const spreads:Record<string,number>={};
  for(const key of Object.keys(upstream))spreads[key]=spread([upstream[key]!,...candidates.flatMap(e=>Object.hasOwn(e.upstreamSnapshot,key)?[e.upstreamSnapshot[key]]:[])]);
  const distance=(e:any)=>{const keys=Object.keys(upstream).filter(x=>Object.hasOwn(e.upstreamSnapshot,x));const u=keys.length?keys.reduce((s,x)=>s+Math.abs(upstream[x]!-e.upstreamSnapshot[x])/(spreads[x]||1),0)/keys.length:0;return Math.abs(e.after-to)/range+0.5*u;};
  const newestFirst=(a:any,b:any)=>b.at.localeCompare(a.at)||a.id.localeCompare(b.id);
  const live=new Set(this.metaOf(id).liveEventIds),newestLive=candidates.filter(e=>live.has(e.id)).sort(newestFirst)[0];
  const ranked=candidates.filter(e=>e!==newestLive&&Math.abs(e.after-to)/range<=RELEVANCE_BAND).sort((a,b)=>distance(a)-distance(b)||newestFirst(a,b));
  return (newestLive?[newestLive,...ranked]:ranked).slice(0,k);
 }
 Company_loadSeed(_id:string,c:any){this.company=this.opts.rawCompanySeed?c:{...c,rules:c.rules??[],crossPlantProposals:c.crossPlantProposals??[],audit:c.audit??[]};return this.company;}
 Company_requiredCrossPlantVoters(_id:string,p:any){
  const local=new Set([p.proposerComponentId,...p.requiredVoters]),out=new Set<string>();
  for(const r of this.company.sharedResources)if(r.components.some((c:string)=>local.has(c)))for(const c of r.components)if(!c.startsWith(p.plantId+"/")&&!local.has(c))out.add(c);
  return [...out];
 }

 /** FAKE of the 2s Plant proposal sweep. Tests call it explicitly so the journey is deterministic. */
 sweep(plantId:string){
  const plant=this.plant(plantId),m=this.metaOf(plantId),now=Date.now(),toExecute:string[]=[];
  const touched=(p:any)=>[p.proposerComponentId,...p.requiredVoters] as string[];
  const occupied=new Set<string>(plant.proposals.filter((p:any)=>p.status==="veto_window").flatMap(touched));
  for(const p of plant.proposals){
   if(p.status==="veto_window"){if(p.vetoDeadline!==null&&now>=Date.parse(p.vetoDeadline))toExecute.push(p.id);continue;}
   if(p.status!=="voting")continue;
   if(p.votes.some((v:any)=>v.vote==="no"))p.status="blocked";
   else if(this.isStale(plantId,p))p.status="expired";
   else if(this.unanimous(p)){
    if(touched(p).some(c=>occupied.has(c)))continue;
    touched(p).forEach(c=>occupied.add(c));
    p.status="veto_window";p.vetoDeadline=new Date(now+(this.opts.vetoMs??300)).toISOString();
   }else if(now-Date.parse(p.at)>=30000)p.status="expired";
  }
  for(const id of toExecute){
   this.log.push({kind:"Plant",id:plantId,method:"execute",args:[id]});
   try{this.Plant_execute(plantId,id);}catch{const p=this.findIn(plantId,id);p.status="expired";p.vetoDeadline=null;}
  }
  // At most once: a claim that never finished is reported, not retried, because the write may have landed.
  for(const execution of m.executions.values())if(execution.state==="claimed"&&now-Date.parse(execution.claimedAt!)>=(this.opts.claimTimeoutMs??20000))this.failExecution(plantId,execution,"claimed dispatch never confirmed; simulator outcome unknown");
 }
 proposal(id:string){for(const plant of this.plants.values()){const p=plant.proposals.find((x:any)=>x.id===id);if(p)return p;}throw new ApiError(404,"FAKE actor: unknown proposal");}
 private unanimous(p:any){return p.requiredVoters.length>0&&p.requiredVoters.every((c:string)=>p.votes.some((v:any)=>v.componentId===c&&v.vote==="yes"));}
 private isStale(plantId:string,p:any){const current=this.metaOf(plantId).setpoints[p.proposerComponentId]?.[p.metric];return current===undefined||Math.abs(current-p.from)>SETPOINT_TOLERANCE;}
 private findIn(plantId:string,id:string){const p=this.plant(plantId).proposals.find((x:any)=>x.id===id);if(!p)this.fail("proposal_not_found",String(id));return p;}
 private comp(id:string){const c=this.components.get(id);if(!c)throw new ApiError(404,`FAKE actor: unknown component ${id}`);return c;}
 private plant(id:string){const p=this.plants.get(id);if(!p)this.fail("not_seeded",`${id} has no seed`);return p;}
 private metaOf(id:string){const m=this.meta.get(id);if(!m)this.fail("not_seeded",`${id} has no seed`);return m;}
 private reachable(plantId:string,start:string){
  const topology=this.metaOf(plantId).topology,seen=new Set([start]),queue=[start];
  while(queue.length){const c=topology[queue.shift()!];if(!c)continue;for(const n of [...c.upstream,...c.downstream])if(!seen.has(n)&&Object.hasOwn(topology,n)){seen.add(n);queue.push(n);}}
  seen.delete(start);return (this.plant(plantId).components as string[]).filter(c=>seen.has(c));
 }
}

/** FAKE simulation: a linear lookup that echoes setpoints. Not the tank model and not physics. */
export class FakeSim implements SimulationPort {
 speed:Record<string,number>={"plant-a":50,"plant-b":50};
 setpoints:any[]=[]; resets=0; events:string[]=[];
 onSetpoint?:(command:any)=>any;
 async snapshot(plantId:string){
  await latency();
  const s=this.speed[plantId]!;
  return {[`${plantId}/P-100`]:{speedPct:s,feedM3h:0.3*s},[`${plantId}/TK-101`]:{levelPct:50,tempC:75},[`${plantId}/LV-101`]:{positionPct:s===50?50:s+1.5},[`${plantId}/E-101`]:{dutyKw:s===50?898.5:17.97*s},[`${plantId}/TV-101`]:{positionPct:50.5,steamKgH:s===50?1533:30.66*s,headerBarg:6}} as Record<string,Record<string,number>>;
 }
 async reset(){await latency();this.resets++;this.events.push("reset");this.speed={"plant-a":50,"plant-b":50};return {ok:true};}
 async setpoint(command:any){
  await latency();
  this.setpoints.push(command);this.events.push(`setpoint:${command.proposalId}`);
  if(this.onSetpoint)return this.onSetpoint(command);
  this.speed[command.componentId.split("/")[0]]=command.value;
  return {valueApplied:command.value};
 }
}

/** FAKE publisher: records messages. No Relay delivery happens. */
export class FakePublisher implements Publisher {
 published:{type:string,payload:any,channels:string[]}[]=[]; fail=false;
 async publish(type:string,payload:any,channels:string[]){if(this.fail)throw new Error("FAKE publisher down");this.published.push({type,payload,channels});}
}

/** FAKE of the @agent-relay/sdk client surface relay.ts uses, so the real RelayBridge runs without a network. */
export class FakeRelayClient {
 inbox:any[]=[]; sent:any[]=[]; sendFailures=0; handlers:Record<string,((e:any)=>void)[]>={};
 agents={me:async()=>({name:"fake-system"})};
 channels={get:async()=>({}),create:async()=>({}),join:async()=>({})};
 events={on:(event:string,fn:(e:any)=>void)=>{(this.handlers[event]??=[]).push(fn);},connect:()=>{},subscribe:()=>{},disconnect:async()=>{}};
 messages={
  list:async(channel:string)=>[...this.inbox].filter(m=>m.channel===channel).reverse(),
  send:async(m:any)=>{if(this.sendFailures>0){this.sendFailures--;throw new Error("FAKE relay send failure");}this.sent.push(m);return {};},
 };
}

/** FAKE publish endpoint for RELAY_PUBLISH_URL mode: a local HTTP server that records posts. No Relay delivery happens. */
export function fakePublishEndpoint(){
 const endpoint={
  received:[] as {body:any,authorization:string|null}[],
  status:200,
  rejectType:null as string|null,
  server:Bun.serve({port:0,hostname:"127.0.0.1",fetch:async req=>{
   const body:any=await req.json();
   if(endpoint.status!==200||body.type===endpoint.rejectType)return new Response("{}",{status:endpoint.status!==200?endpoint.status:400});
   endpoint.received.push({body,authorization:req.headers.get("authorization")});
   return Response.json({ok:true});
  }}),
 };
 return endpoint;
}

/** FAKE history standing in for shared/history.json, which origin/zubair does not carry. */
export function fakeHistory(){
 const at=(i:number)=>new Date(Date.UTC(2026,9,1+i)).toISOString();
 const run=(id:string,plantId:string,after:number,lv:number,incident:string|null,i:number)=>({id,at:at(i),plantId,componentId:`${plantId}/P-100`,metric:"speedPct",before:50,after,upstreamSnapshot:{feedM3h:15,headerBarg:6},effects:[{componentId:`${plantId}/LV-101`,metric:"positionPct",before:50,after:lv,ticksToSettle:3}],incident,approvedBy:[],operator:"fake-history",proposalId:null});
 return [
  ...[84,85,85,86,87,88].map((after,i)=>run(`fake-hist-a-${after}-${i}`,"plant-a",after,100,"fake high level alarm",i)),
  run("fake-hist-a-65","plant-a",65,66,null,7),
  run("fake-hist-b-60","plant-b",60,61,null,8),
 ];
}

// Used by server.ts's real ActorAdapter through ACTOR_CLIENT_MODULE in the HTTP section of run.ts.
export function createActorPort(){return (globalThis as any).__fakeHarnessActors;}

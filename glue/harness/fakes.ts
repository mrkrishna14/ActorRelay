// FAKE HARNESS ONLY. These are stand-ins for services other owners have not delivered.
// Nothing here is a live agent, a durable actor, Relay delivery, or physics.
import {ApiError,type ActorKind,type ActorPort} from "../actors";
import type {SimulationPort} from "../simulation";
import type {Publisher} from "../live";

const clone=<T>(v:T):T=>v===undefined?v:structuredClone(v);
const latency=()=>Bun.sleep(1); // every port call yields, as a real RPC would

export type FakeOpts={
 vetoMs?:number; tokenTtlMs?:number;
 ids?:"unique"|"per-seed-counter";              // per-seed-counter: an actor that restarts p-1, p-2 after loadSeed
 similar?:"recency-first"|"contract-literal"|"nearest-only"; // contract-literal: CLAUDE.md ranking with a 5 m3/h feed bucket (the bucket size is the harness's guess). nearest-only: same, no bucket
 rawCompanySeed?:boolean;                       // store shared/plants.json company exactly as seeded (it has no `rules`)
};
let uniqueId=0;

/** FAKE Component, Plant and Company store. Enforces what the contract and live.ts expect of real actors. */
export class FakeActors implements ActorPort {
 components=new Map<string,any>(); plants=new Map<string,any>(); company:any=null;
 log:{kind:string,id:string,method:string,args:any[]}[]=[];
 failNext:Record<string,number>={};
 beforeMirror?:(id:string)=>Promise<void>;
 private counters=new Map<string,number>(); private tokens=new Map<string,{token:string,expiresAt:number,used:boolean}>();
 constructor(public opts:FakeOpts={}){}
 count(method:string){return this.log.filter(c=>c.method===method).length;}

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
  return clone(await fn.call(this,id,...args));
 }

 Component_loadSeed(id:string,c:any){this.components.set(id,{...c,calibration:[]});return {ok:true};}
 async Component_mirror(id:string,metrics:any){if(this.beforeMirror)await this.beforeMirror(id);const c=this.comp(id);c.metrics={...c.metrics,...metrics};c.lastTick=new Date().toISOString();return {ok:true};}
 Component_addCalibration(id:string,e:any){this.comp(id).calibration.push(e);return {ok:true};}
 Component_setMetric(id:string,metric:string,value:number,proposalId:string,token:string){
  const grant=this.tokens.get(proposalId);
  if(!grant||grant.token!==token)throw new ApiError(403,"FAKE actor: setMetric without a valid execution token");
  if(grant.used)throw new ApiError(409,"FAKE actor: execution token already used");
  if(Date.now()>=grant.expiresAt)throw new ApiError(403,"FAKE actor: execution token expired");
  const p=this.proposal(proposalId);
  if(p.proposerComponentId!==id||p.metric!==metric||p.to!==value)throw new ApiError(403,"FAKE actor: setMetric does not match the approved proposal");
  grant.used=true;this.comp(id).metrics[metric]=value;return {ok:true};
 }

 Plant_loadSeed(id:string,plant:any,history:any[]){
  this.plants.set(id,{id,name:plant.name,components:plant.components.map((c:any)=>c.id),proposals:[],history:[...history],rules:[],audit:[],tick:0,connected:true});
  this.counters.set(id,0);return {ok:true};
 }
 Plant_propose(id:string,input:any){
  const plant=this.plant(id),proposer=this.comp(input.proposerComponentId);
  if(input.parentProposalId){const parent=this.proposal(input.parentProposalId);if(parent.status!=="blocked")throw new ApiError(409,"FAKE actor: parent must be blocked");if(parent.proposerComponentId!==input.proposerComponentId)throw new ApiError(400,"FAKE actor: counter must match proposer");}
  if(!(input.metric in proposer.metrics))throw new ApiError(400,"FAKE actor: unknown metric");
  const local=this.reachable(input.proposerComponentId),cross=this.Company_requiredCrossPlantVoters("company",{requiredVoters:local,plantId:id});
  const n=this.counters.get(id)!+1;this.counters.set(id,n);
  const proposal={id:this.opts.ids==="per-seed-counter"?`${id}-p-${n}`:`fake-${id}-${++uniqueId}`,at:new Date().toISOString(),plantId:id,proposerComponentId:input.proposerComponentId,proposerAgentId:`agent:${input.proposerComponentId}`,metric:input.metric,from:proposer.metrics[input.metric],to:input.to,rationale:input.rationale,requiredVoters:[...local,...cross],votes:[],status:"voting",vetoDeadline:null,parentProposalId:input.parentProposalId??null,crossPlant:cross.length>0};
  plant.proposals.push(proposal);return proposal;
 }
 Plant_vote(id:string,v:any){
  const p=this.proposalIn(id,v.proposalId);
  if(p.status!=="voting")throw new ApiError(409,"FAKE actor: proposal is not accepting votes");
  if(!p.requiredVoters.includes(v.componentId))throw new ApiError(403,"FAKE actor: not a required voter");
  if(p.votes.some((x:any)=>x.componentId===v.componentId))throw new ApiError(409,"FAKE actor: duplicate vote");
  p.votes.push(v);return p;
 }
 Plant_veto(id:string,proposalId:string,_by:string){
  const p=this.proposalIn(id,proposalId);
  if(p.status!=="veto_window"||Date.now()>=Date.parse(p.vetoDeadline))throw new ApiError(409,"FAKE actor: veto window is not open");
  p.status="vetoed";return p;
 }
 Plant_authorizeExecution(id:string,proposalId:string){
  const p=this.proposalIn(id,proposalId);
  if(p.status!=="veto_window"||Date.now()<Date.parse(p.vetoDeadline))throw new ApiError(409,"FAKE actor: not authorized");
  if(!p.requiredVoters.every((c:string)=>p.votes.some((v:any)=>v.componentId===c&&v.vote==="yes")))throw new ApiError(409,"FAKE actor: not unanimous");
  const expiresAt=Date.now()+(this.opts.tokenTtlMs??30000),token=`fake-token-${proposalId}`;
  this.tokens.set(proposalId,{token,expiresAt,used:false});
  return {authorized:true,token,expiresAt:new Date(expiresAt).toISOString(),proposalId};
 }
 Plant_recordEvent(id:string,e:any){
  const plant=this.plant(id);
  if(!plant.history.some((x:any)=>x.id===e.id))plant.history.push(e);
  if(e.proposalId)this.proposalIn(id,e.proposalId).status="executed";
  return {ok:true,eventId:e.id};
 }
 Plant_promoteRule(id:string,r:any){
  const plant=this.plant(id);
  if(!plant.rules.some((x:any)=>x.id===r.id))plant.rules.push(r);
  if(r.scope==="company"){this.company.rules??=[];if(!this.company.rules.some((x:any)=>x.id===r.id))this.company.rules.push(r);}
  return {ok:true,ruleId:r.id};
 }
 Plant_similar(id:string,componentId:string,metric:string,to:number,snapshot:any,k:number){
  const same=this.plant(id).history.filter((e:any)=>e.componentId===componentId&&e.metric===metric);
  const nearest=(a:any,b:any)=>Math.abs(a.after-to)-Math.abs(b.after-to);
  if(this.opts.similar==="contract-literal"){
   const bucket=(s:any)=>Math.round((s?.feedM3h??0)/5);
   return same.filter((e:any)=>bucket(e.upstreamSnapshot)===bucket(snapshot)).sort(nearest).slice(0,k);
  }
  if(this.opts.similar==="nearest-only")return same.sort(nearest).slice(0,k);
  // The live-run-first ordering the demo needs (see the report): events from this run lead, regardless of `after`.
  const live=same.filter((e:any)=>e.proposalId).sort((a:any,b:any)=>Date.parse(b.at)-Date.parse(a.at));
  return [...live,...same.filter((e:any)=>!e.proposalId).sort(nearest)].slice(0,k);
 }
 Company_loadSeed(_id:string,c:any){this.company=this.opts.rawCompanySeed?c:{rules:[],crossPlantProposals:[],audit:[],...c};return {ok:true};}
 Company_requiredCrossPlantVoters(_id:string,p:any){
  const out:string[]=[];
  for(const r of this.company.sharedResources)if(r.components.some((c:string)=>p.requiredVoters.includes(c)))out.push(...r.components.filter((c:string)=>!c.startsWith(p.plantId+"/")));
  return out;
 }

 /** FAKE of the 2s Plant proposal sweep. Tests call it explicitly so the journey is deterministic. */
 sweep(plantId:string){
  const plant=this.plant(plantId),now=Date.now();
  for(const p of plant.proposals){
   if(p.status!=="voting")continue;
   if(p.votes.some((v:any)=>v.vote==="no"))p.status="blocked";
   else if(p.requiredVoters.every((c:string)=>p.votes.some((v:any)=>v.componentId===c&&v.vote==="yes"))){
    if(plant.proposals.some((o:any)=>o!==p&&o.status==="veto_window"&&o.proposerComponentId===p.proposerComponentId))continue;
    p.status="veto_window";p.vetoDeadline=new Date(now+(this.opts.vetoMs??300)).toISOString();
   }else if(now-Date.parse(p.at)>30000)p.status="expired";
  }
 }
 proposal(id:string){for(const plant of this.plants.values()){const p=plant.proposals.find((x:any)=>x.id===id);if(p)return p;}throw new ApiError(404,"FAKE actor: unknown proposal");}
 private proposalIn(plantId:string,id:string){const p=this.plant(plantId).proposals.find((x:any)=>x.id===id);if(!p)throw new ApiError(404,"FAKE actor: unknown proposal in this plant");return p;}
 private comp(id:string){const c=this.components.get(id);if(!c)throw new ApiError(404,`FAKE actor: unknown component ${id}`);return c;}
 private plant(id:string){const p=this.plants.get(id);if(!p)throw new ApiError(404,`FAKE actor: unknown plant ${id}`);return p;}
 private reachable(start:string){
  const seen=new Set([start]),queue=[start];
  while(queue.length){const c=this.comp(queue.shift()!);for(const n of [...c.upstream,...c.downstream])if(!seen.has(n)){seen.add(n);queue.push(n);}}
  seen.delete(start);return [...seen];
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

/** FAKE history standing in for shared/history.json, which no branch has delivered yet. */
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

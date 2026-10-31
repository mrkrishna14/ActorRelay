import {describe,it,expect,beforeEach,afterEach} from "bun:test";
import {z} from "zod";
import {ApiError,type ActorKind,type ActorPort} from "./actors";
import {Journal} from "./journal";
import {LiveCoordinator,startMirrorDriver,type Publisher} from "./live";
import {RelayBridge} from "./relay";
import type {SimulationPort} from "./simulation";

const PID="p1",PUMP="plant-a/P-100",voters=["plant-a/LV-101","plant-a/TK-101"];
// What the Plant actor holds once its own execute() has accepted the proposal.
const approved=()=>({id:PID,plantId:"plant-a",proposerComponentId:PUMP,metric:"speedPct",from:50,to:65,status:"executed",vetoDeadline:new Date(Date.now()-1000).toISOString(),requiredVoters:[...voters],votes:voters.map(componentId=>({componentId,vote:"yes"})),crossPlant:false});

// Mirrors the dispatch state machine in Plant.claimDispatch, redeemToken and reportDispatchFailure.
class FakeActors implements ActorPort {
 proposal:any=approved();
 execution="accepted";
 pump:any={metrics:{speedPct:50},limits:{speedPct:{min:20,max:90,critical:95}},marginPct:10};
 plantRules:any[]=[];companyRules:any[]=[];
 calls:{method:string,args:unknown[]}[]=[];
 failures:string[]=[];
 failSetMetric=false;loseSetMetricResponse=false;failReport=false;
 setMetricError?:string;claimOverride?:any;
 async read(kind:ActorKind,id:string){
  if(kind==="Plant")return {id,proposals:id==="plant-a"?[this.proposal]:[],rules:this.plantRules};
  if(kind==="Company")return {rules:this.companyRules};
  if(kind==="Component"&&id===PUMP)return this.pump;
  throw new ApiError(404,"Unknown actor");
 }
 async call(_kind:ActorKind,_id:string,method:string,args:any[]){
  this.calls.push({method,args});
  if(method==="claimDispatch"){
   if(this.claimOverride)return this.claimOverride;
   if(this.execution!=="accepted")return {dispatch:false,proposalId:PID,state:this.execution};
   this.execution="claimed";
   return {dispatch:true,proposalId:PID,componentId:this.proposal.proposerComponentId,metric:this.proposal.metric,value:this.proposal.to,token:"tok"};
  }
  if(method==="reportDispatchFailure"){
   if(this.failReport)throw new ApiError(503,"Actor transport unreachable");
   if(this.execution==="applied"||this.execution==="observed")throw new ApiError(409,`already_applied: ${PID}`);
   this.execution="failed";this.proposal.status="expired";this.failures.push(args[1]);return {state:"failed"};
  }
  if(method==="setMetric"){
   if(this.failSetMetric)throw new ApiError(503,"Actor transport unreachable");
   if(this.setMetricError)throw new ApiError(409,this.setMetricError);
   if(args[3]!=="tok")throw new ApiError(409,"invalid_token: token does not match");
   if(this.execution==="applied")throw new ApiError(409,`token_already_used: ${PID}`);
   if(this.execution!=="claimed")throw new ApiError(409,`invalid_token: execution is ${this.execution}`);
   this.execution="applied";this.pump.metrics.speedPct=args[1];
   if(this.loseSetMetricResponse){this.loseSetMetricResponse=false;throw new ApiError(503,"Actor transport unreachable");}
   return {ok:true};
  }
  if(method==="recordEvent"){
   if(this.execution!=="claimed"&&this.execution!=="applied")throw new ApiError(409,`not_dispatched: ${PID}`);
   this.execution="observed";return {...args[0],id:`event-${PID}`};
  }
  if(method==="similar")return [];
  if(method==="propose")return {proposal:{...approved(),status:"voting"}};
  return {ok:true};
 }
 count(method:string){return this.calls.filter(c=>c.method===method).length;}
}
class FakeSim implements SimulationPort {
 values:Record<string,Record<string,Record<string,number>>>={"plant-a":{[PUMP]:{speedPct:50,feedM3h:15},"plant-a/TV-101":{positionPct:50,headerBarg:6}},"plant-b":{"plant-b/P-100":{speedPct:50}}};
 setpoints=0;failSnapshot=false;
 onSetpoint:(command:any)=>any=command=>({valueApplied:command.value});
 async snapshot(plantId:string){if(this.failSnapshot)throw new ApiError(503,"Simulation transport unavailable");return this.values[plantId]!;}
 async reset(){return {};}
 async setpoint(command:any){this.setpoints++;return this.onSetpoint(command);}
}
class FakeRelay implements Publisher {
 published:{type:string,payload:any,channels:string[]}[]=[];
 fail=false;
 async publish(type:string,payload:any,channels:string[]){if(this.fail)throw new Error("relay down");this.published.push({type,payload,channels});}
}
const failure=async(run:()=>Promise<unknown>)=>{try{await run();}catch(error){return error as ApiError;}throw new Error("Expected rejection");};

describe("LiveCoordinator",()=>{
 let actors:FakeActors,sim:FakeSim,relay:FakeRelay,journal:Journal,live:LiveCoordinator;
 beforeEach(()=>{actors=new FakeActors();sim=new FakeSim();relay=new FakeRelay();journal=new Journal(":memory:");live=new LiveCoordinator(actors,sim,relay,journal);});
 afterEach(()=>journal.close());
 const rejectedWithoutDispatch=async(status=409)=>{const e=await failure(()=>live.execute(PID));expect(e.status).toBe(status);expect(sim.setpoints).toBe(0);return e;};
 const rearm=(change:(p:any)=>void=()=>{})=>{actors.proposal=approved();actors.execution="accepted";change(actors.proposal);};

 describe("Plant approval",()=>{
  it("rejects a proposal the Plant has not executed, without claiming",async()=>{
   for(const status of ["voting","blocked","veto_window","vetoed","expired"]){
    rearm(p=>{p.status=status;});
    const e=await rejectedWithoutDispatch();expect(e.message).toContain("not been accepted");
   }
   expect(actors.count("claimDispatch")).toBe(0);expect(actors.count("setMetric")).toBe(0);expect(journal.get("command",PID)).toBeUndefined();
  });
  it("does not treat elapsed votes as approval while the proposal is still in veto_window",async()=>{
   rearm(p=>{p.status="veto_window";});await rejectedWithoutDispatch();
   rearm(p=>{p.status="veto_window";p.vetoDeadline=new Date(Date.now()+10000).toISOString();});await rejectedWithoutDispatch();
   rearm(p=>{p.status="voting";p.votes[0].vote="no";});await rejectedWithoutDispatch();
   expect(actors.count("claimDispatch")).toBe(0);
  });
  it("rejects writes outside the allowlist before claiming",async()=>{
   rearm(p=>{p.metric="otherPct";});await rejectedWithoutDispatch(403);
   rearm(p=>{p.proposerComponentId="plant-a/LV-101";});await rejectedWithoutDispatch(403);
   expect(actors.count("claimDispatch")).toBe(0);
  });
  it("rejects an unknown proposal",async()=>{
   const e=await failure(()=>live.execute("nope"));expect(e.status).toBe(404);expect(sim.setpoints).toBe(0);
  });
 });

 describe("claimDispatch",()=>{
  it("dispatches the claimed values and redeems the claim token",async()=>{
   const result:any=await live.execute(PID);
   expect(result).toMatchObject({proposalId:PID,commandId:`proposal:${PID}`,observed:false});
   expect(sim.setpoints).toBe(1);expect(actors.count("claimDispatch")).toBe(1);
   expect(actors.calls.find(c=>c.method==="setMetric")!.args).toEqual(["speedPct",65,PID,"tok"]);
   expect(actors.execution).toBe("applied");expect(actors.failures).toEqual([]);
  });
  it("does not write, journal or report failure when the claim is lost",async()=>{
   for(const state of ["claimed","applied","observed","failed"]){
    actors.execution=state;
    expect(await live.execute(PID)).toEqual({proposalId:PID,dispatch:false,state,observed:false});
   }
   expect(sim.setpoints).toBe(0);expect(actors.count("setMetric")).toBe(0);expect(actors.count("reportDispatchFailure")).toBe(0);expect(journal.get("command",PID)).toBeUndefined();
  });
  it("lets exactly one of two glue instances write",async()=>{
   const otherJournal=new Journal(":memory:"),other=new LiveCoordinator(actors,sim,relay,otherJournal);
   try{
    const results:any[]=await Promise.all([live.execute(PID),other.execute(PID)]);
    expect(sim.setpoints).toBe(1);expect(actors.count("setMetric")).toBe(1);
    expect(results.filter(r=>r.dispatch===false)).toEqual([{proposalId:PID,dispatch:false,state:"claimed",observed:false}]);
   }finally{otherJournal.close();}
  });
  it("refuses a claim that does not match the proposal",async()=>{
   for(const mismatch of [{value:90},{metric:"otherPct"},{componentId:"plant-b/P-100"}]){
    rearm();actors.failures=[];
    actors.claimOverride={dispatch:true,proposalId:PID,componentId:PUMP,metric:"speedPct",value:65,token:"tok",...mismatch};
    const e=await rejectedWithoutDispatch();expect(e.message).toContain("does not match");
    expect(actors.failures).toEqual(["Actor claim does not match the proposal"]);
   }
  });
  it("rejects a malformed claim without writing",async()=>{
   for(const claim of [{dispatch:true,proposalId:PID,componentId:PUMP,metric:"speedPct",value:65,token:""},{dispatch:true,proposalId:PID,componentId:PUMP,metric:"speedPct",value:65},{dispatch:"yes"},null]){
    actors.claimOverride=claim??{dispatch:null};
    expect(await failure(()=>live.execute(PID))).toBeInstanceOf(z.ZodError);
   }
   expect(sim.setpoints).toBe(0);expect(actors.count("setMetric")).toBe(0);
  });
  it("does not write on retry when the snapshot fails after the claim",async()=>{
   sim.failSnapshot=true;
   expect((await failure(()=>live.execute(PID))).status).toBe(503);
   sim.failSnapshot=false;
   expect(await live.execute(PID)).toEqual({proposalId:PID,dispatch:false,state:"claimed",observed:false});
   expect(sim.setpoints).toBe(0);
  });
 });

 describe("refusals",()=>{
  it("rejects sim drift without journaling and reports the failure",async()=>{
   sim.values["plant-a"]![PUMP]!.speedPct=55;
   const e=await rejectedWithoutDispatch();expect(e.message).toContain("Simulation changed");
   expect(journal.get("command",PID)).toBeUndefined();expect(actors.failures).toEqual(["Simulation changed after proposal; fresh review required"]);
   expect(actors.execution).toBe("failed");
  });
  it("rejects a missing simulator reading and reports the failure",async()=>{
   delete sim.values["plant-a"]![PUMP]!.speedPct;
   await rejectedWithoutDispatch();expect(actors.count("reportDispatchFailure")).toBe(1);
  });
  it("applies the 0.5 tolerance to sim drift on both sides",async()=>{
   for(const measured of [50.4,49.6]){
    rearm();journal.remove("command",PID);sim.setpoints=0;sim.values["plant-a"]![PUMP]!.speedPct=measured;
    await live.execute(PID);expect(sim.setpoints).toBe(1);
   }
   for(const measured of [50.6,49.4]){
    rearm();journal.remove("command",PID);sim.setpoints=0;sim.values["plant-a"]![PUMP]!.speedPct=measured;
    await rejectedWithoutDispatch();
   }
  });
  it("does not dispatch on retry after a sim drift refusal",async()=>{
   sim.values["plant-a"]![PUMP]!.speedPct=55;await rejectedWithoutDispatch();
   sim.values["plant-a"]![PUMP]!.speedPct=50;
   await rejectedWithoutDispatch();expect(actors.count("claimDispatch")).toBe(1);
  });
  it("still refuses when the failure report cannot reach the Plant",async()=>{
   sim.values["plant-a"]![PUMP]!.speedPct=55;actors.failReport=true;
   const e=await rejectedWithoutDispatch();expect(e.message).toContain("Simulation changed");
  });
  it("refuses targets past the safety margin and below the minimum, and reports them",async()=>{
   for(const to of [86,95,10]){
    rearm(p=>{p.to=to;});actors.failures=[];
    const e=await rejectedWithoutDispatch();expect(e.message).toContain("hard limit");
    expect(actors.failures).toEqual(["Target violates the current hard limit"]);
   }
  });
  it("refuses a metric with no limit",async()=>{
   delete actors.pump.limits.speedPct;await rejectedWithoutDispatch();expect(actors.count("reportDispatchFailure")).toBe(1);
  });
 });

 describe("retry",()=>{
  it("does not redispatch on retry",async()=>{
   const first=await live.execute(PID),second=await live.execute(PID);
   expect(sim.setpoints).toBe(1);expect(actors.count("setMetric")).toBe(1);expect(actors.count("claimDispatch")).toBe(1);expect(second).toEqual(first);
   expect(journal.get<any>("command",PID).status).toBe("accepted");expect(journal.get<any>("command",PID).token).toBeUndefined();
  });
  it("reports acceptance when actor sync fails, then reconciles without redispatch",async()=>{
   actors.failSetMetric=true;
   const e=await failure(()=>live.execute(PID));expect(e.status).toBe(502);expect((e.details as any).accepted).toBe(true);expect(journal.get<any>("command",PID).status).toBe("actor_sync_pending");
   expect(actors.count("reportDispatchFailure")).toBe(0);
   actors.failSetMetric=false;await live.execute(PID);
   expect(sim.setpoints).toBe(1);expect(actors.count("claimDispatch")).toBe(1);expect(actors.pump.metrics.speedPct).toBe(65);
   expect(journal.get("command",PID)).toMatchObject({status:"accepted",upstreamSnapshot:{feedM3h:15,headerBarg:6}});
  });
  it("counts token_already_used on retry as success",async()=>{
   actors.loseSetMetricResponse=true;
   expect((await failure(()=>live.execute(PID))).status).toBe(502);
   expect(actors.execution).toBe("applied");expect(journal.get<any>("command",PID).status).toBe("actor_sync_pending");
   const result:any=await live.execute(PID);
   expect(result).toMatchObject({proposalId:PID,observed:false});
   expect(actors.count("setMetric")).toBe(2);expect(sim.setpoints).toBe(1);expect(actors.count("reportDispatchFailure")).toBe(0);
   expect(journal.get<any>("command",PID).status).toBe("accepted");expect(journal.get<any>("command",PID).token).toBeUndefined();
  });
  it("does not count any other setMetric rejection as success",async()=>{
   actors.setMetricError="invalid_token: token does not match";
   const e=await failure(()=>live.execute(PID));expect(e.status).toBe(502);expect((e.details as any).accepted).toBe(true);
   expect(journal.get<any>("command",PID).status).toBe("actor_sync_pending");expect(journal.get<any>("command",PID).token).toBe("tok");
   expect((await failure(()=>live.execute(PID))).status).toBe(502);expect(sim.setpoints).toBe(1);
  });
  it("calls setMetric even when a mirror tick already wrote the new value",async()=>{
   sim.onSetpoint=command=>{actors.pump.metrics.speedPct=command.value;return {valueApplied:command.value};};
   await live.execute(PID);expect(actors.count("setMetric")).toBe(1);
  });
 });

 describe("unknown outcome",()=>{
  it("refuses redispatch and reports failure when the simulator call fails",async()=>{
   sim.onSetpoint=()=>{throw new ApiError(503,"Simulation transport unavailable");};
   expect((await failure(()=>live.execute(PID))).status).toBe(503);expect(journal.get<any>("command",PID).status).toBe("unknown");
   expect(actors.failures).toHaveLength(1);expect(actors.failures[0]).toContain("Simulator outcome unknown");
   const e=await failure(()=>live.execute(PID));expect(e.status).toBe(409);expect((e.details as any).status).toBe("unknown");
   expect(sim.setpoints).toBe(1);expect(actors.count("claimDispatch")).toBe(1);expect(actors.count("setMetric")).toBe(0);
  });
  it("surfaces the simulator error when the failure report also fails",async()=>{
   sim.onSetpoint=()=>{throw new ApiError(503,"Simulation transport unavailable");};actors.failReport=true;
   expect((await failure(()=>live.execute(PID))).status).toBe(503);expect(journal.get<any>("command",PID).status).toBe("unknown");
  });
  it("treats a missing or wrong acknowledgment as unknown and reports failure",async()=>{
   for(const ack of [null,{},{valueApplied:"65"},{valueApplied:64},{valueApplied:65.6}]){
    rearm();actors.failures=[];journal.remove("command",PID);sim.setpoints=0;sim.onSetpoint=()=>ack;
    expect((await failure(()=>live.execute(PID))).status).toBe(502);expect(journal.get<any>("command",PID).status).toBe("unknown");
    expect(actors.failures).toEqual(["Simulation acknowledgment did not confirm requested value; reconcile command journal"]);
    expect((await failure(()=>live.execute(PID))).status).toBe(409);expect(sim.setpoints).toBe(1);expect(actors.count("setMetric")).toBe(0);
   }
  });
  it("accepts an acknowledgment within the 0.5 tolerance",async()=>{
   sim.onSetpoint=()=>({valueApplied:65.4});await live.execute(PID);
   expect(journal.get<any>("command",PID).status).toBe("accepted");expect(actors.failures).toEqual([]);
  });
  it("refuses redispatch after a crash mid-dispatch",async()=>{
   journal.set("command",PID,{status:"dispatching",command:{}});
   await rejectedWithoutDispatch();expect(actors.count("claimDispatch")).toBe(0);
  });
 });

 describe("/observed",()=>{
  it("requires an accepted command before recording an observation",async()=>{
   const observed={proposalId:PID,effects:[]};
   expect((await failure(()=>live.post("/observed",observed))).status).toBe(409);
   for(const status of ["unknown","dispatching"]){
    journal.set("command",PID,{status,command:{}});
    expect((await failure(()=>live.post("/observed",observed))).status).toBe(409);
   }
   journal.remove("command",PID);
   actors.failSetMetric=true;await failure(()=>live.execute(PID));
   expect((await failure(()=>live.post("/observed",observed))).status).toBe(409);
   expect(actors.count("recordEvent")).toBe(0);expect(relay.published).toEqual([]);
  });
  it("records the pre-dispatch simulation snapshot on the observed event",async()=>{
   await live.execute(PID);sim.values["plant-a"]![PUMP]!.feedM3h=19.5;
   await live.post("/observed",{proposalId:PID,effects:[]});
   const event:any=actors.calls.find(c=>c.method==="recordEvent")!.args[0];
   expect(event.upstreamSnapshot).toEqual({feedM3h:15,headerBarg:6});
   expect(journal.get<any>("command",PID).status).toBe("observed");
  });
  it("publishes the event the actor returned",async()=>{
   await live.execute(PID);
   const result:any=await live.post("/observed",{proposalId:PID,effects:[]});
   expect(result.id).toBe(`event-${PID}`);
   expect(relay.published).toHaveLength(1);
   expect(relay.published[0]).toMatchObject({type:"executed",channels:["plant-a","company"],payload:{proposalId:PID,event:{id:`event-${PID}`}}});
   expect(journal.get<any>("command",PID).eventId).toBe(`event-${PID}`);
  });
  it("returns the stored result on a repeat without recording or publishing again",async()=>{
   await live.execute(PID);
   const first=await live.post("/observed",{proposalId:PID,effects:[]}),second=await live.post("/observed",{proposalId:PID,effects:[]});
   expect(second).toEqual(first);expect(actors.count("recordEvent")).toBe(1);expect(relay.published).toHaveLength(1);
  });
  it("does not record an observation twice when Relay fails",async()=>{
   await live.execute(PID);relay.fail=true;
   const e=await failure(()=>live.post("/observed",{proposalId:PID,effects:[]}));expect(e.status).toBe(502);expect((e.details as any).accepted).toBe(true);
   relay.fail=false;await live.post("/observed",{proposalId:PID,effects:[]});
   expect(actors.count("recordEvent")).toBe(1);
  });
 });

 describe("/similar",()=>{
  const similar=(query:string)=>live.get("/similar",new URL(`http://glue/similar?${query}`));
  const base=`componentId=${encodeURIComponent(PUMP)}&metric=speedPct&to=65`;
  it("passes validated input to the Plant",async()=>{
   await similar(`${base}&k=3&upstreamSnapshot=${encodeURIComponent('{"feedM3h":15}')}`);
   expect(actors.calls.find(c=>c.method==="similar")!.args).toEqual([PUMP,"speedPct",65,{feedM3h:15},3]);
  });
  it("defaults k and the upstream snapshot",async()=>{
   await similar(base);
   expect(actors.calls.find(c=>c.method==="similar")!.args).toEqual([PUMP,"speedPct",65,{},5]);
  });
  it("rejects invalid input before reaching the Plant",async()=>{
   for(const query of [
    "metric=speedPct&to=65",`componentId=${encodeURIComponent(PUMP)}&to=65`,`componentId=${encodeURIComponent(PUMP)}&metric=speedPct`,
    `componentId=&metric=speedPct&to=65`,`componentId=${encodeURIComponent(PUMP)}&metric=speedPct&to=`,`componentId=${encodeURIComponent(PUMP)}&metric=speedPct&to=abc`,`componentId=${encodeURIComponent(PUMP)}&metric=speedPct&to=Infinity`,
    `${base}&k=0`,`${base}&k=101`,`${base}&k=1.5`,`${base}&k=x`,
    `${base}&upstreamSnapshot=${encodeURIComponent('{"feedM3h":"high"}')}`,`${base}&upstreamSnapshot=${encodeURIComponent("[1]")}`
   ])expect(await failure(()=>similar(query))).toBeInstanceOf(z.ZodError);
   expect(actors.count("similar")).toBe(0);
  });
  it("answers 400 for malformed snapshot JSON and an unknown plant",async()=>{
   expect((await failure(()=>similar(`${base}&upstreamSnapshot=${encodeURIComponent("{nope")}`))).status).toBe(400);
   expect((await failure(()=>similar("componentId=plant-z%2FP-100&metric=speedPct&to=65"))).status).toBe(400);
   expect(actors.count("similar")).toBe(0);
  });
 });

 describe("/rules",()=>{
  const rules=(query="")=>live.get("/rules",new URL(`http://glue/rules${query}`));
  it("dedupes a rule held by both the plant and the company, keeping the company copy",async()=>{
   actors.plantRules=[{id:"r1",model:"feed-pump-A",text:"plant"},{id:"r2",model:"feed-pump-A",text:"plant only"}];
   actors.companyRules=[{id:"r1",model:"feed-pump-A",text:"company"}];
   expect(await rules(`?componentId=${encodeURIComponent(PUMP)}`)).toEqual([{id:"r1",model:"feed-pump-A",text:"company"},{id:"r2",model:"feed-pump-A",text:"plant only"}]);
  });
  it("reads only company rules without a component and filters by model",async()=>{
   actors.plantRules=[{id:"r1",model:"feed-pump-A"}];
   actors.companyRules=[{id:"r2",model:"feed-pump-A"},{id:"r3",model:"outlet-valve-A"}];
   expect(await rules()).toEqual(actors.companyRules);
   expect(await rules("?model=outlet-valve-A")).toEqual([{id:"r3",model:"outlet-valve-A"}]);
  });
 });

 it("returns 502 with accepted:true when /propose is accepted but Relay fails",async()=>{
  relay.fail=true;
  const e=await failure(()=>live.post("/propose",{plantId:"plant-a",proposerComponentId:PUMP,metric:"speedPct",to:65,rationale:"test"}));
  expect(e.status).toBe(502);expect(e.details).toMatchObject({accepted:true,proposal:{id:PID}});expect(actors.count("propose")).toBe(1);
 });
 it("returns 502 with accepted:true for /counter and /rule too",async()=>{
  relay.fail=true;
  expect((await failure(()=>live.post("/counter",{parentProposalId:"p0",proposal:{plantId:"plant-a",proposerComponentId:PUMP,metric:"speedPct",to:65,rationale:"test"}}))).details).toMatchObject({accepted:true});
  const rule={id:"r1",scope:"company",condition:{componentId:PUMP}};
  expect((await failure(()=>live.post("/rule",{rule}))).details).toMatchObject({accepted:true,ruleId:"r1"});
 });
 it("coalesces overlapping ticks",async()=>{
  const [a,b]=await Promise.all([live.post("/tick",{}),live.post("/tick",{})]);
  expect(a).toEqual({ok:true,mirrored:3});expect(b).toEqual(a);expect(actors.count("mirror")).toBe(3);
  await live.post("/tick",{});expect(actors.count("mirror")).toBe(6);
 });
});

describe("startMirrorDriver",()=>{
 it("does not overlap itself",async()=>{
  let running=0,peak=0,runs=0;
  const stop=startMirrorDriver(async()=>{runs++;running++;peak=Math.max(peak,running);await Bun.sleep(25);running--;},5);
  await Bun.sleep(120);stop();await Bun.sleep(30);
  expect(peak).toBe(1);expect(runs).toBeGreaterThan(1);
 });
 it("keeps running after failures and logs each new failure once",async()=>{
  const logs:string[]=[];let runs=0;
  const stop=startMirrorDriver(async()=>{runs++;throw new Error("sim down");},5,message=>logs.push(message));
  await Bun.sleep(300);stop();
  expect(runs).toBeGreaterThan(2);expect(logs).toEqual(["Mirror tick failed: Error: sim down"]);
 });
});

describe("RelayBridge outbox",()=>{
 it("queues a publish made before Relay initializes",async()=>{
  const journal=new Journal(":memory:"),bridge=new RelayBridge(async()=>{},journal);
  expect((await failure(()=>bridge.publish("proposal",{proposal:{id:PID}},["plant-a"]))).status).toBe(503);
  expect(journal.list("relay-outbox").map(e=>e.id)).toEqual([`proposal:${PID}`]);
  await bridge.flush();journal.close();
 });
});

import {describe,it,expect,beforeEach,afterEach} from "bun:test";
import {ApiError,type ActorKind,type ActorPort} from "./actors";
import {Journal} from "./journal";
import {LiveCoordinator,startMirrorDriver,type Publisher} from "./live";
import {RelayBridge} from "./relay";
import type {SimulationPort} from "./simulation";

const PID="p1",PUMP="plant-a/P-100",voters=["plant-a/LV-101","plant-a/TK-101"];
const approved=()=>({id:PID,plantId:"plant-a",proposerComponentId:PUMP,metric:"speedPct",from:50,to:65,status:"veto_window",vetoDeadline:new Date(Date.now()-1000).toISOString(),requiredVoters:[...voters],votes:voters.map(componentId=>({componentId,vote:"yes"})),crossPlant:false});

class FakeActors implements ActorPort {
 proposal:any=approved();
 pump:any={metrics:{speedPct:50},limits:{speedPct:{min:20,max:90,critical:95}},marginPct:10};
 calls:{method:string,args:unknown[]}[]=[];
 failSetMetric=false;
 async read(kind:ActorKind,id:string){
  if(kind==="Plant")return {id,proposals:id==="plant-a"?[this.proposal]:[]};
  if(kind==="Component"&&id===PUMP)return this.pump;
  throw new ApiError(404,"Unknown actor");
 }
 async call(_kind:ActorKind,_id:string,method:string,args:unknown[]){
  this.calls.push({method,args});
  if(method==="authorizeExecution")return {authorized:true,token:"tok",expiresAt:new Date(Date.now()+60000).toISOString(),proposalId:PID};
  if(method==="setMetric"){if(this.failSetMetric)throw new ApiError(503,"Actor transport unreachable");this.pump.metrics.speedPct=args[1];return {ok:true};}
  if(method==="propose")return {proposal:{...approved(),status:"voting"}};
  return {ok:true};
 }
 count(method:string){return this.calls.filter(c=>c.method===method).length;}
}
class FakeSim implements SimulationPort {
 values:Record<string,Record<string,Record<string,number>>>={"plant-a":{[PUMP]:{speedPct:50,feedM3h:15},"plant-a/TV-101":{positionPct:50,headerBarg:6}},"plant-b":{"plant-b/P-100":{speedPct:50}}};
 setpoints=0;
 onSetpoint:(command:any)=>any=command=>({valueApplied:command.value});
 async snapshot(plantId:string){return this.values[plantId];}
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

 it("rejects unapproved execution",async()=>{
  actors.proposal.status="voting";await rejectedWithoutDispatch();
  actors.proposal=approved();actors.proposal.votes[0].vote="no";await rejectedWithoutDispatch();
  actors.proposal=approved();actors.proposal.votes.pop();await rejectedWithoutDispatch();
  expect(actors.count("authorizeExecution")).toBe(0);
 });
 it("rejects execution before the veto window elapses",async()=>{
  actors.proposal.vetoDeadline=new Date(Date.now()+10000).toISOString();await rejectedWithoutDispatch();
  actors.proposal.vetoDeadline=null;await rejectedWithoutDispatch();
 });
 it("rejects a stale simulation value without journaling a command",async()=>{
  sim.values["plant-a"]![PUMP]!.speedPct=55;
  const e=await rejectedWithoutDispatch();expect(e.message).toContain("Simulation changed");expect(journal.get("command",PID)).toBeUndefined();
 });
 it("rejects writes outside the allowlist and past the safety margin",async()=>{
  actors.proposal.metric="otherPct";await rejectedWithoutDispatch(403);
  actors.proposal=approved();actors.proposal.to=86;await rejectedWithoutDispatch();
 });
 it("does not redispatch on retry",async()=>{
  const first=await live.execute(PID),second=await live.execute(PID);
  expect(sim.setpoints).toBe(1);expect(actors.count("setMetric")).toBe(1);expect(second).toEqual(first);
  expect(journal.get("command",PID).status).toBe("accepted");expect(journal.get("command",PID).token).toBeUndefined();
 });
 it("reports acceptance when actor sync fails, then reconciles without redispatch",async()=>{
  actors.failSetMetric=true;
  const e=await failure(()=>live.execute(PID));expect(e.status).toBe(502);expect((e.details as any).accepted).toBe(true);expect(journal.get("command",PID).status).toBe("actor_sync_pending");
  actors.failSetMetric=false;await live.execute(PID);
  expect(sim.setpoints).toBe(1);expect(actors.pump.metrics.speedPct).toBe(65);
  expect(journal.get("command",PID)).toMatchObject({status:"accepted",upstreamSnapshot:{feedM3h:15,headerBarg:6}});
 });
 it("calls setMetric even when a mirror tick already wrote the new value",async()=>{
  sim.onSetpoint=command=>{actors.pump.metrics.speedPct=command.value;return {valueApplied:command.value};};
  await live.execute(PID);expect(actors.count("setMetric")).toBe(1);
 });
 it("refuses redispatch when the outcome is unknown",async()=>{
  sim.onSetpoint=()=>{throw new ApiError(503,"Simulation transport unavailable");};
  expect((await failure(()=>live.execute(PID))).status).toBe(503);expect(journal.get("command",PID).status).toBe("unknown");
  const e=await failure(()=>live.execute(PID));expect(e.status).toBe(409);expect((e.details as any).status).toBe("unknown");expect(sim.setpoints).toBe(1);
 });
 it("treats a missing or wrong acknowledgment as unknown",async()=>{
  for(const ack of [null,{valueApplied:64}]){
   journal.remove("command",PID);sim.setpoints=0;sim.onSetpoint=()=>ack;
   expect((await failure(()=>live.execute(PID))).status).toBe(502);expect(journal.get("command",PID).status).toBe("unknown");
   expect((await failure(()=>live.execute(PID))).status).toBe(409);expect(sim.setpoints).toBe(1);
  }
 });
 it("refuses redispatch after a crash mid-dispatch",async()=>{
  journal.set("command",PID,{status:"dispatching",command:{}});
  await rejectedWithoutDispatch();
 });
 it("requires an accepted command before recording an observation",async()=>{
  const observed={proposalId:PID,effects:[]};
  expect((await failure(()=>live.post("/observed",observed))).status).toBe(409);
  journal.set("command",PID,{status:"unknown",command:{}});
  expect((await failure(()=>live.post("/observed",observed))).status).toBe(409);
  journal.remove("command",PID);
  actors.failSetMetric=true;await failure(()=>live.execute(PID));
  expect((await failure(()=>live.post("/observed",observed))).status).toBe(409);
  expect(actors.count("recordEvent")).toBe(0);
 });
 it("records the pre-dispatch simulation snapshot on the observed event",async()=>{
  await live.execute(PID);sim.values["plant-a"]![PUMP]!.feedM3h=19.5;
  await live.post("/observed",{proposalId:PID,effects:[]});
  const event:any=actors.calls.find(c=>c.method==="recordEvent")!.args[0];
  expect(event.upstreamSnapshot).toEqual({feedM3h:15,headerBarg:6});
  expect(relay.published[0]).toMatchObject({type:"executed",channels:["plant-a","company"]});
  expect(journal.get("command",PID).status).toBe("observed");
 });
 it("does not record an observation twice when Relay fails",async()=>{
  await live.execute(PID);relay.fail=true;
  const e=await failure(()=>live.post("/observed",{proposalId:PID,effects:[]}));expect(e.status).toBe(502);expect((e.details as any).accepted).toBe(true);
  relay.fail=false;await live.post("/observed",{proposalId:PID,effects:[]});
  expect(actors.count("recordEvent")).toBe(1);
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

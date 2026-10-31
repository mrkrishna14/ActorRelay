import {describe,expect,test} from "bun:test";
import {LiveCoordinator,commandSpec,commandValue} from "./live";
import {Journal} from "./journal";
import type {ActorPort} from "./actors";

describe("approved loop command dispatch",()=>{
 test("only explicit command combinations are allowed; setpoint takes precedence over moving PV",()=>{
  expect(commandSpec("plant-a/TK-101","levelPct")?.setpoint).toBe("levelSetpointPct");
  expect(commandSpec("plant-b/TK-101","tempC")?.setpoint).toBe("tempSetpointC");
  expect(commandSpec("plant-a/TV-101","steamKgH")?.max).toBe(3000);
  expect(commandSpec("plant-a/LV-101","positionPct")).toBeUndefined();
  expect(commandSpec("plant-a/TK-101/extra","tempC")).toBeUndefined();
  expect(commandValue({tempC:73,tempSetpointC:75},"tempC",commandSpec("plant-a/TK-101","tempC")!)).toBe(75);
  expect(commandValue({tempC:75},"tempC",commandSpec("plant-a/TK-101","tempC")!)).toBe(75);
 });
 test("temperature dispatch checks reviewed SP, redeems approval token, then restores measured PV",async()=>{
  const cid="plant-a/TK-101",id="temperature-1";
  const proposal={id,plantId:"plant-a",proposerComponentId:cid,metric:"tempC",from:75,to:76,status:"executed"};
  const values={tempC:74.2,tempSetpointC:75};
  const component={metrics:{...values},limits:{tempC:{min:70,max:80,critical:85}},marginPct:10};
  const calls:string[]=[];
  const actors:ActorPort={read:async(kind,actorId)=>kind==="Plant"?{proposals:actorId==="plant-a"?[proposal]:[]}:component,
   call:async(_kind,_id,method,args:any[])=>{calls.push(method);if(method==="claimDispatch")return {dispatch:true,proposalId:id,componentId:cid,metric:"tempC",value:76,token:"actual-approval-token"};if(method==="setMetric"){expect(args).toEqual(["tempC",76,id,"actual-approval-token"]);component.metrics.tempC=76;}if(method==="mirror")component.metrics={...args[0]};return {};}};
  let writes=0;
  const sim={snapshot:async()=>({[cid]:{...values,tempSetpointC:writes?76:75}}),reset:async()=>({}),setpoint:async(command:any)=>{writes++;expect(command.metric).toBe("tempC");return {value:76};}};
  const journal=new Journal(":memory:");
  try{const live=new LiveCoordinator(actors,sim,{publish:async()=>{}},journal);await live.execute(id);expect(writes).toBe(1);expect(calls).toEqual(["claimDispatch","setMetric","mirror"]);expect(component.metrics).toEqual({tempC:74.2,tempSetpointC:76});expect(journal.get("command",id).status).toBe("accepted");}finally{journal.close();}
 });
});

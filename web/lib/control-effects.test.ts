import {describe,expect,test} from "bun:test";
import {createDemoState,demoReducer,DEMO_EPOCH,DEMO_REVIEW_MS,type DemoState} from "./demo";
import type {ComponentTag} from "./types";
const value=(state:DemoState,tag:ComponentTag,metric:string)=>state.components.find(c=>c.plantId==="plant-a"&&c.tag===tag)!.metrics[metric];
const request=(tag:ComponentTag,metric:string,to:number)=>demoReducer(createDemoState(),{type:"propose",plantId:"plant-a",tag,metric,to,now:DEMO_EPOCH});
const tick=(state:DemoState,now:number)=>demoReducer(state,{type:"tick",now});
const reviewed=(tag:ComponentTag,metric:string,to:number)=>tick(request(tag,metric,to),DEMO_EPOCH+DEMO_REVIEW_MS);
describe("browser sample loop controls",()=>{
 test("temperature review uses correct proposer and distinct SP/PV then coupled response",()=>{
  const state=reviewed("TK-101","tempC",76),p=state.proposals.at(-1)!;
  expect(p.proposerTag).toBe("TK-101");expect(p.metric).toBe("tempC");expect(p.votes).toHaveLength(5);
  expect(p.votes.some(v=>v.tag==="TK-101"&&v.plantId==="plant-a")).toBe(false);
  expect(p.votes.every(v=>v.evidence.length===0)).toBe(true);expect(p.status).toBe("veto_window");
  const applied=tick(state,p.vetoDeadline!);
  expect(value(applied,"TK-101","tempSetpointC")).toBe(76);expect(value(applied,"TK-101","tempC")).toBe(75);
  const half=tick(applied,p.vetoDeadline!+2500),end=tick(half,p.vetoDeadline!+5000);
  expect(value(half,"TK-101","tempC")).toBeCloseTo(75.5);expect(value(end,"TK-101","tempC")).toBe(76);
  expect(value(end,"P-100","speedPct")).toBe(50);expect(value(end,"E-101","dutyKw")).toBeGreaterThan(900);
  expect(value(end,"TV-101","steamKgH")).toBeGreaterThan(1533);expect(end.messages.at(-1)?.text).toContain("76°C");
 });
 test("steam proposal enters local flow control and changes tank temperature without corrupting pump",()=>{
  const state=reviewed("TV-101","steamKgH",1540),p=state.proposals.at(-1)!;
  expect(p.status).toBe("veto_window");
  const applied=tick(state,p.vetoDeadline!);expect(value(applied,"TV-101","steamSetpointKgH")).toBe(1540);
  expect(value(applied,"TV-101","steamKgH")).toBe(1533);expect(value(applied,"TV-101","steamFlowLocal")).toBe(1);
  const end=tick(applied,p.vetoDeadline!+5000);expect(value(end,"TV-101","steamKgH")).toBe(1540);
  expect(value(end,"TK-101","tempC")).toBeGreaterThan(75);expect(value(end,"P-100","speedPct")).toBe(50);
  expect(end.messages.at(-1)?.text).toContain("1540kg/h");expect(end.messages.at(-1)?.text).not.toContain("1542%");
 });
 test("level closes outlet, preserves temperature and supports veto",()=>{
  const state=reviewed("TK-101","levelPct",60),p=state.proposals.at(-1)!;
  expect(p.status).toBe("veto_window");
  const vetoed=demoReducer(state,{type:"veto",id:p.id,now:p.vetoDeadline!-1});
  expect(value(tick(vetoed,p.vetoDeadline!+6000),"TK-101","levelPct")).toBe(50);
  const end=tick(tick(state,p.vetoDeadline!),p.vetoDeadline!+5000);
  expect(value(end,"TK-101","levelPct")).toBe(60);expect(value(end,"LV-101","positionPct")).toBeLessThan(50);expect(value(end,"TK-101","tempC")).toBe(75);
 });
 test("unsafe sample temperatures are refused and chat requests identify the loop",()=>{
  const refused=reviewed("TK-101","tempC",79);expect(refused.proposals.at(-1)?.status).toBe("blocked");expect(value(refused,"TK-101","tempSetpointC")).toBe(75);
  const state=demoReducer(createDemoState(),{type:"send",text:"Set FIC-201 steam to 1540 kg/h",channel:"plant-a",now:DEMO_EPOCH});expect(state.proposals.at(-1)?.proposerTag).toBe("TV-101");expect(state.proposals.at(-1)?.to).toBe(1540);
 });
});

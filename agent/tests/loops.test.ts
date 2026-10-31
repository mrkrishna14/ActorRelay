import {describe,expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import type {HistoryEvent} from "../../shared/types.js";
import {counterFor,decideVote} from "../src/pipeline.js";
import {decide,physicsPrior,relevanceRadius} from "../src/predict.js";
import {FakeBackend,proposal} from "./fake.js";

const history=()=>JSON.parse(readFileSync(new URL("../../shared/loop-history.json",import.meta.url),"utf8")) as HistoryEvent[];
describe("real model loop evidence and grounded decisions",()=>{
 test("a modest local steam-flow request has three actual simulated comparable runs",async()=>{
  const backend=new FakeBackend(history());
  for(const to of [1530,1540,1550]){
   const p=proposal({proposerComponentId:"plant-a/TV-101",metric:"steamKgH",from:1533,to});
   const vote=await decideVote(p,"plant-a/TK-101",{backend,llmFor:()=>null});
   expect(vote.similarCount).toBeGreaterThanOrEqual(3);expect(vote.evidenceEventIds.length).toBeGreaterThanOrEqual(3);
   expect(vote.predicted.tempC).toBeGreaterThan(73);expect(vote.predicted.tempC).toBeLessThan(76.5);expect(vote.vote).toBe("yes");
   expect(vote.reason).toContain("baseline");
  }
 });
 test("high local steam target gets a hot-tank prediction and a real refusal",async()=>{
  const backend=new FakeBackend(history());
  const p=proposal({proposerComponentId:"plant-a/TV-101",metric:"steamKgH",from:1533,to:2200});
  const vote=await decideVote(p,"plant-a/TK-101",{backend,llmFor:()=>null});
  expect(vote.similarCount).toBe(0);expect(vote.predicted.tempC).toBeGreaterThan(85);expect(vote.vote).toBe("no");
 });
 test("level and temperature priors reflect hydrostatic flow and energy demand",async()=>{
  const backend=new FakeBackend();const context=await Promise.all([...backend.components.keys()].map(id=>backend.component(id)));
  const level=physicsPrior(await backend.component("plant-a/LV-101"),proposal({proposerComponentId:"plant-a/TK-101",metric:"levelPct",from:50,to:60}),context);
  expect(level.find(item=>item.metric==="positionPct")?.value).toBeLessThan(50);
  const temp=physicsPrior(await backend.component("plant-a/E-101"),proposal({proposerComponentId:"plant-a/TK-101",metric:"tempC",from:75,to:76}),context);
  expect(temp.find(item=>item.metric==="dutyKw")?.value).toBeGreaterThan(900);
 });
 test("a missing forecast never silently becomes an approval",async()=>{
  const self=await new FakeBackend().component("plant-a/LV-101");
  expect(decide(self,{},5).vote).toBe("no");
 });
 test("zero steam cannot approve a cold tank or zero heating duty",async()=>{
  const backend=new FakeBackend(history());
  const p=proposal({proposerComponentId:"plant-a/TV-101",metric:"steamKgH",from:1533,to:0});
  for(const id of ["plant-a/TK-101","plant-a/E-101"]){
   const vote=await decideVote(p,id,{backend,llmFor:()=>null});
   expect(vote.vote).toBe("no");expect(vote.reason).toContain("minimum");
  }
 });
 test("invalid forecasts refuse while exactly-at-minimum valid forecasts remain eligible",async()=>{
  const tank=await new FakeBackend().component("plant-a/TK-101");
  expect(decide(tank,{tempC:70},5).vote).toBe("yes");
  for(const value of [69.9,Number.NaN,Infinity,-Infinity])expect(decide(tank,{tempC:value},5).vote).toBe("no");
  expect(decide(tank,{unmonitoredMetric:1},5).vote).toBe("no");
 });
 test("tank relevance is metric-aware: ±2 °C for tempC, ±10 % for levelPct",async()=>{
  expect([relevanceRadius("tempC"),relevanceRadius("levelPct"),relevanceRadius("speedPct")]).toEqual([2,10,15]);
  const backend=new FakeBackend(history());const deps={backend,llmFor:()=>null};
  const tank=(metric:string,from:number,to:number)=>proposal({plantId:"plant-b",proposerComponentId:"plant-b/TK-101",metric,from,to});
  const hot=await decideVote(tank("tempC",75,78),"plant-b/TK-101",deps);
  expect(hot.similarCount).toBe(1);expect(hot.vote).toBe("no");expect(hot.predicted.tempC).toBeGreaterThan(76.5);
  const warm=await decideVote(tank("tempC",75,76),"plant-b/TK-101",deps);expect(warm.similarCount).toBe(3);expect(warm.vote).toBe("yes");
  const duty=await decideVote(tank("tempC",75,78),"plant-b/E-101",deps);expect(duty.predicted.dutyKw).toBeGreaterThan(930);expect(duty.vote).toBe("yes");
  const steam=await decideVote(tank("tempC",75,78),"plant-b/TV-101",deps);expect(steam.predicted.steamKgH).toBeGreaterThan(1580);
  expect((await decideVote(tank("levelPct",50,60),"plant-b/TK-101",deps)).similarCount).toBe(2);
  expect((await decideVote(tank("levelPct",50,55),"plant-b/TK-101",deps)).similarCount).toBe(3);
 });
 test("tank counters step 1 °C / 5 % back to evidence-backed targets and skip non-moves",async()=>{
  const backend=new FakeBackend(history());const deps={backend,llmFor:()=>null};const plant=await backend.plant("plant-b");
  const counter=async(metric:string,from:number,to:number)=>{
   const p=proposal({plantId:"plant-b",proposerComponentId:"plant-b/TK-101",metric,from,to,status:"blocked"});
   p.votes=[{...(await decideVote(p,"plant-b/TK-101",deps)),vote:"no"}]; // a voter blocked it; the counter is what is under test
   return counterFor(p,{...plant,proposals:[p]},deps);
  };
  expect((await counter("tempC",75,78))?.to).toBe(76);
  expect((await counter("levelPct",50,60))?.to).toBe(55);
  expect((await counter("tempC",75,77))?.to).toBe(76); // the step back (75) would not move, so the safe 76 itself
  const tiny=proposal({plantId:"plant-b",proposerComponentId:"plant-b/TK-101",metric:"tempC",from:75,to:76,status:"blocked"});
  tiny.votes=[{...(await decideVote(tiny,"plant-b/TK-101",deps)),vote:"no"}];
  expect(await counterFor(tiny,{...plant,proposals:[tiny]},deps)).toBeNull(); // no 1 °C move left between 75 and 76
 });
});

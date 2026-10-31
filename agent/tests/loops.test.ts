import {describe,expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import type {HistoryEvent} from "../../shared/types.js";
import {decideVote} from "../src/pipeline.js";
import {decide,physicsPrior} from "../src/predict.js";
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
});

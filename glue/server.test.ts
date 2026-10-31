import {describe,it,expect} from "bun:test";
import {handle} from "./server";
import {MockStore} from "./mock";
const call=(path:string,body?:unknown)=>handle(new Request(`http://localhost${path}`,body===undefined?undefined:{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}));
describe("glue boundary",()=>{
 it("reports honest mock capability",async()=>{const r=await call("/health");const b=await r.json();expect(b.mode).toBe("mock");expect(b.integrations.actors).toBe(false);});
 it("rejects malformed proposal before mutation",async()=>{const r=await call("/propose",{plantId:"plant-a",to:Infinity});expect(r.status).toBe(400);});
 it("cannot execute an unapproved proposal",async()=>{await call("/reset",{});const r=await call("/propose",{plantId:"plant-a",proposerComponentId:"plant-a/P-100",metric:"speedPct",to:65,rationale:"test"});const b=await r.json();expect((await call("/execute-callback",{proposalId:b.proposal.id})).status).toBe(409);});
 it("rejects duplicate and unauthorized votes",async()=>{await call("/reset",{});const r=await call("/propose",{plantId:"plant-a",proposerComponentId:"plant-a/P-100",metric:"speedPct",to:65,rationale:"test"});const b=await r.json();const v={proposalId:b.proposal.id,componentId:"plant-a/LV-101",agentId:"agent:test",vote:"yes",reason:"test",predicted:{positionPct:66},marginPct:10,evidenceEventIds:[],evidenceRuleIds:[],similarCount:0};expect((await call("/vote",{vote:v})).status).toBe(200);expect((await call("/vote",{vote:v})).status).toBe(409);expect((await call("/vote",{vote:{...v,componentId:"unknown"}})).status).toBe(400);await call("/reset",{});});
 it("allows both local dashboard origins",async()=>{for(const origin of ["http://localhost:3000","http://127.0.0.1:3000"]){const r=await handle(new Request("http://localhost/health",{headers:{origin}}));expect(r.headers.get("access-control-allow-origin")).toBe(origin);}});
 it("rejects stale approved snapshots",()=>{const m=new MockStore();const p:any=m.propose({plantId:"plant-a",proposerComponentId:"plant-a/P-100",metric:"speedPct",to:65,rationale:"test"});p.status="veto_window";p.vetoDeadline=new Date(Date.now()-1).toISOString();p.votes=p.requiredVoters.map((componentId:string)=>({componentId,vote:"yes"}));m.component("plant-a/P-100").metrics.speedPct=55;expect(()=>m.execute(p.id)).toThrow("Stale proposal");m.reset();});
 it("reads encoded component IDs",async()=>{const r=await call("/component/plant-a%2FLV-101");expect(r.status).toBe(200);expect((await r.json()).id).toBe("plant-a/LV-101");});
});

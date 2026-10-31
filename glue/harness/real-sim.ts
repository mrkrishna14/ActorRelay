// Real bridge/live_sim.py, real shared/ seed, real LiveCoordinator. Actors, votes and Relay are still FAKE.
// Start the simulator first: python bridge/live_sim.py --port 7310 --fast
// Then, from glue/: SIM_URL=http://127.0.0.1:7310 bun run harness/real-sim.ts
import {FakeActors,FakePublisher} from "./fakes";
import {LiveCoordinator} from "../live";
import {SimulationAdapter} from "../simulation";
import {Journal} from "../journal";
const base=process.env.SIM_URL??"http://127.0.0.1:7310";
const actors=new FakeActors({vetoMs:300}),publisher=new FakePublisher();
const live=new LiveCoordinator(actors,new SimulationAdapter(base),publisher,new Journal(":memory:"));
const url=(path:string,q:Record<string,unknown>={})=>{const u=new URL(path,"http://x");for(const [k,v] of Object.entries(q))u.searchParams.set(k,String(v));return u;};
let failed=0;const check=(name:string,ok:boolean,detail="")=>{if(!ok)failed++;console.log(`${ok?"PASS":"FAIL"}  ${name}${detail?`  (${detail})`:""}`);};
const metric=async(id:string,m:string)=>{await live.post("/tick",{});return (await live.get(`/component/${id}`,url("/x")) as any).metrics[m];};
async function vote(proposalId:string){
 const p=actors.proposal(proposalId);
 for(const voter of p.requiredVoters){
  const c:any=await live.get(`/component/${voter}`,url("/x"));
  const similar:any=await live.get("/similar",url("/similar",{componentId:p.proposerComponentId,metric:p.metric,to:p.to,k:5}));
  let predicted:Record<string,number>=Object.fromEntries(Object.keys(c.limits).map(m=>[m,c.metrics[m]])),choice="yes";
  if(c.tag==="LV-101"){const position=p.to+(p.to>=80?4:1.5);predicted={positionPct:position};if(position>c.limits.positionPct.critical*(1-c.marginPct/100))choice="no";}
  await live.post("/vote",{vote:{proposalId,componentId:voter,agentId:`agent:${voter}`,vote:choice,reason:`FAKE scripted ${choice} vote`,predicted,marginPct:c.marginPct,evidenceEventIds:similar.map((e:any)=>e.id),evidenceRuleIds:[],similarCount:similar.length}});
 }
 actors.sweep(p.plantId);return actors.proposal(proposalId);
}
const propose=async(plantId:string,to:number)=>(await live.post("/propose",{plantId,proposerComponentId:`${plantId}/P-100`,metric:"speedPct",to,rationale:"FAKE scripted run against the real simulator"}) as any).proposal;
console.log(`FAKE actors, votes and Relay. REAL simulator at ${base} and real shared/ seed.\n`);
await live.post("/reset",{});
const state:any=await live.state("plant-a");
check("reset seeds ten components from shared/plants.json",state.components.length===10,`${state.components.length}`);
check("reset loads real history",state.plant.history.length===200,`${state.plant.history.length} events`);
check("simulator values mirror into actors",Math.abs(await metric("plant-a/LV-101","positionPct")-50)<3);
const headerBefore=await metric("plant-b/TV-101","headerBarg");
const unsafe=await vote((await propose("plant-a",85)).id);
check("85% blocked by the scripted LV-101 no, citing real history",unsafe.status==="blocked"&&unsafe.votes.find((v:any)=>v.componentId==="plant-a/LV-101")?.evidenceEventIds.length>=3,unsafe.status);
check("85% blocked reaches no simulator write",(await metric("plant-a/P-100","speedPct"))===50);
const safe=await vote((await propose("plant-a",65)).id);
check("65% opens the veto window",safe.status==="veto_window",safe.status);
await Bun.sleep(320);actors.sweep("plant-a");
check("Plant accepts after the deadline",safe.status==="executed",safe.status);
const result:any=await live.post("/execute-callback",{proposalId:safe.id});
check("real simulator acknowledges the setpoint",result.acceptance?.value===65&&result.acceptance?.accepted===true,JSON.stringify(result.acceptance));
const retry:any=await live.post("/execute-callback",{proposalId:safe.id});
check("retry does not redispatch",retry.commandId===result.commandId);
let observed:any=null;for(let i=0;i<100&&!observed;i++){const r=await fetch(`${base}/observed?proposalId=${encodeURIComponent(safe.id)}`);if(r.status===200)observed=await r.json();else await Bun.sleep(100);}
check("simulator reports observed effects",!!observed?.effects?.length,`${observed?.effects?.length} effects`);
const recorded:any=await live.post("/observed",{proposalId:safe.id,effects:observed.effects});
check("observed event stored with a real upstream snapshot",recorded.proposalId===safe.id&&Object.keys(recorded.upstreamSnapshot??{}).length>0,JSON.stringify(recorded.upstreamSnapshot));
check("executed published to Relay fake",publisher.published.some(m=>m.type==="executed"));
for(let i=0;i<20;i++){await Bun.sleep(100);await live.post("/tick",{});}
const position=await metric("plant-a/LV-101","positionPct"),speed=await metric("plant-a/P-100","speedPct"),headerAfter=await metric("plant-b/TV-101","headerBarg");
check("LV-101 settles in the demo range 60 to 72",position>=60&&position<=72,`${position.toFixed(1)}%`);
check("pump mirror stays at the new speed",speed===65,`${speed}%`);
check("more steam in plant-a lowers plant-b's header",headerAfter<headerBefore,`${headerBefore.toFixed(2)} to ${headerAfter.toFixed(2)} barg`);
console.log(`\n${failed?`${failed} failed`:"All passed"}. Not proven: real actors, real agents, real Relay delivery.`);
process.exit(failed?1:0);

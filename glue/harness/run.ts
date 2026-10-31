// FAKE HARNESS. Real LiveCoordinator, RelayBridge inbound logic, schemas and Journal.
// Fake actors, fake sim, fake publisher, scripted votes. Not live agents, not physics, not Relay delivery.
// Run from glue/: bun run harness/run.ts
import {fileURLToPath} from "node:url";
import {ApiError} from "../actors";
import {Journal} from "../journal";
import {LiveCoordinator} from "../live";
import {RelayBridge} from "../relay";
import {schemas} from "../schemas";
import {FakeActors,FakePublisher,FakeRelayClient,FakeSim,fakeHistory,type FakeOpts} from "./fakes";

const results:{section:string,name:string,pass:boolean,detail:string}[]=[];
let section="";
const check=(name:string,pass:boolean,detail="")=>{results.push({section,name,pass,detail});};
const attempt=async(name:string,run:()=>Promise<void>)=>{try{await run();}catch(error){check(name,false,`threw: ${String(error)}`);}};
const caught=async(run:()=>Promise<unknown>)=>{try{await run();return null;}catch(error){return error as any;}};
const statusOf=(e:any)=>e?.status??(e?"non-ApiError "+e.constructor?.name:"no error");

// Real plants.json from origin/zubair (read-only git). history.json has no branch yet, so it is FAKE.
const plantsProc=Bun.spawnSync(["git","show","origin/zubair:shared/plants.json"],{cwd:import.meta.dir});
if(plantsProc.exitCode!==0)throw new Error("Could not read origin/zubair:shared/plants.json");
const plantsJson=JSON.parse(plantsProc.stdout.toString());

const realBunFile=Bun.file;
function shimShared(){
 (Bun as any).file=(p:any,...rest:any[])=>{
  const s=String(p);
  // A 5ms await stands in for the real disk read live.ts does here.
  if(s.endsWith("shared/plants.json"))return {json:async()=>{await Bun.sleep(5);return structuredClone(plantsJson);}};
  if(s.endsWith("shared/history.json"))return {json:async()=>{await Bun.sleep(5);return fakeHistory();}};
  return (realBunFile as any)(p,...rest);
 };
}

type World=ReturnType<typeof world>;
function world(opts:FakeOpts={}){
 const actors=new FakeActors(opts),sim=new FakeSim(),pub=new FakePublisher(),journal=new Journal(":memory:");
 const live=new LiveCoordinator(actors,sim,pub,journal);
 const bridge=new RelayBridge((path,body)=>live.post(path,body),journal);
 return {actors,sim,pub,journal,live,bridge};
}
// Same validation server.ts applies before calling the coordinator.
const api=(w:World,path:string,body:unknown)=>w.live.post(path,schemas[path]!.parse(body));
const url=(path:string,q:Record<string,string|number>={})=>{const u=new URL(`http://fake-harness${path}`);for(const [k,v] of Object.entries(q))u.searchParams.set(k,String(v));return u;};
let msgId=0;
const inbound=(from:string,type:string,payload:unknown,channel="plant-a")=>({id:`fake-msg-${++msgId}`,channel,from:{name:from},text:JSON.stringify({type,payload})}) as any;
const pump=(plantId:string)=>`${plantId}/P-100`;
const proposeBody=(plantId:string,to:number)=>({plantId,proposerComponentId:pump(plantId),metric:"speedPct",to,rationale:`FAKE harness step to ${to}`});

/** FAKE agents: a scripted rule, not reasoning. The evidence comes from the real /similar and /rules routes. */
async function scriptedVotes(w:World,proposalId:string){
 const p=w.actors.proposal(proposalId);
 for(const voter of p.requiredVoters){
  const c:any=await w.live.get(`/component/${voter}`,url(`/component/${voter}`));
  const pumpNow:any=await w.live.get(`/component/${p.proposerComponentId}`,url("/x"));
  const similar:any=await w.live.get("/similar",url("/similar",{componentId:p.proposerComponentId,metric:p.metric,to:p.to,upstreamSnapshot:JSON.stringify({feedM3h:pumpNow.metrics.feedM3h,headerBarg:6}),k:5}));
  const rules:any=await w.live.get("/rules",url("/rules",{componentId:voter,model:c.model}));
  let predicted=Object.fromEntries(Object.keys(c.limits).slice(0,1).map(m=>[m,c.metrics[m]])),vote="yes";
  if(c.tag==="LV-101"){
   const position=p.to+(p.to>=80?4:1.5),threshold=c.limits.positionPct.critical*(1-c.marginPct/100);
   predicted={positionPct:position};if(position>threshold)vote="no";
  }
  await w.bridge.receive(inbound(`agent:${voter}`,"vote",{vote:{proposalId,componentId:voter,agentId:`agent:${voter}`,vote,reason:`FAKE scripted ${vote} vote`,predicted,marginPct:c.marginPct,evidenceEventIds:similar.map((e:any)=>e.id),evidenceRuleIds:rules.map((r:any)=>r.id),similarCount:similar.length}}));
 }
 w.actors.sweep(p.plantId);
 return w.actors.proposal(proposalId);
}
const voteOf=(p:any,tag:string)=>p.votes.find((v:any)=>v.componentId.endsWith(`/${tag}`));
const waitVeto=async(w:World,p:any)=>{await Bun.sleep(Math.max(0,Date.parse(w.actors.proposal(p.id).vetoDeadline)-Date.now())+5);};
const newProposal=async(w:World,plantId:string,to:number)=>((await api(w,"/propose",proposeBody(plantId,to))) as any).proposal;
/** Drives a fresh proposal to the point the Plant alarm would fire the execute callback. */
const readyToExecute=async(w:World,to=65,plantId="plant-a")=>{const p=await newProposal(w,plantId,to);const voted=await scriptedVotes(w,p.id);if(voted.status!=="veto_window")throw new Error(`setup: expected veto_window, got ${voted.status}`);await waitVeto(w,voted);return voted;};
const rule={id:"fake-rule-lv-high",scope:"company",model:"outlet-valve-A",text:"FAKE rule: P-100 speedPct >= 80 leads to LV-101 positionPct >= 85 within 3 ticks",condition:{componentId:"plant-a/P-100",metric:"speedPct",op:">=",value:80},consequence:{componentId:"plant-a/LV-101",metric:"positionPct",op:">=",value:85,withinTicks:3},supportEventIds:["fake-hist-a-85-1"],timesSeen:3,createdAt:new Date().toISOString(),lastSeenAt:new Date().toISOString()};

section="Preflight";
await attempt("real /reset fails closed while shared/ is absent",async()=>{
 const w=world(),e=await caught(()=>api(w,"/reset",{}));
 const present=await realBunFile(new URL("../../shared/plants.json",import.meta.url)).exists();
 check("real /reset fails closed while shared/ is absent",present||e?.status===503,present?"shared/ now exists, check skipped":`status ${statusOf(e)}: ${e?.message}`);
});
shimShared();

section="Reset";
await attempt("reset yields ten components",async()=>{
 const w=world();await api(w,"/reset",{});
 const a:any=await w.live.state("plant-a"),b:any=await w.live.state("plant-b"),ids=a.components.map((c:any)=>c.id);
 check("reset yields ten components from both plants",ids.length===10&&new Set(ids).size===10&&b.components.length===10,`${ids.length} components`);
 check("reset calls sim once and mirrors all ten afterward",w.sim.resets===1&&w.actors.count("mirror")===10,`resets=${w.sim.resets} mirrors=${w.actors.count("mirror")}`);
 check("state reports live mode with an empty proposal list",a.mode==="live"&&a.plant.proposals.length===0&&a.plant.components.length===5);
 await newProposal(w,"plant-a",65);await api(w,"/reset",{});
 check("second reset clears proposals",(await w.live.state("plant-a") as any).plant.proposals.length===0);
});

section="Demo journey";
const J=world();
let repeatEventId="";
await attempt("journey",async()=>{
 await api(J,"/reset",{});
 // Steps 2-3: 85 blocked by LV-101.
 const bad=await newProposal(J,"plant-a",85);
 check("step 2: propose 85 has from=50 and five voters including plant-b TV-101",bad.from===50&&bad.requiredVoters.length===5&&bad.requiredVoters.includes("plant-b/TV-101")&&bad.crossPlant===true,JSON.stringify(bad.requiredVoters));
 check("step 2: proposal published to plant-a and company",JSON.stringify(J.pub.published[0]?.channels)===JSON.stringify(["plant-a","company"]));
 const blocked=await scriptedVotes(J,bad.id),lv=voteOf(blocked,"LV-101");
 check("step 3: blocked by LV-101 no, prediction past 81, with history cited",blocked.status==="blocked"&&lv.vote==="no"&&lv.predicted.positionPct>81&&lv.evidenceEventIds.length>=3,`status=${blocked.status} predicted=${lv?.predicted.positionPct} evidence=${lv?.evidenceEventIds.length}`);
 check("step 3: plant-b TV-101 vote routed to the plant-a proposal",!!voteOf(blocked,"TV-101")&&blocked.votes.some((v:any)=>v.componentId==="plant-b/TV-101"));
 check("step 3: nothing dispatched to the sim",J.sim.setpoints.length===0);
 // Step 4: counter to 65 over the real relay inbound path.
 await J.bridge.receive(inbound("agent:plant-a/P-100","counter",{parentProposalId:bad.id,proposal:proposeBody("plant-a",65)}));
 const counter=J.actors.plants.get("plant-a").proposals.find((p:any)=>p.parentProposalId===bad.id);
 check("step 4: counter created with parent link and published",!!counter&&counter.to===65&&J.pub.published.some(m=>m.type==="proposal"&&m.payload.proposal.id===counter.id));
 const approved=await scriptedVotes(J,counter.id);
 check("step 4: unanimous yes opens the veto window",approved.status==="veto_window"&&!!approved.vetoDeadline&&approved.votes.every((v:any)=>v.vote==="yes")&&approved.votes.length===5,`status=${approved.status}`);
 const early=await caught(()=>api(J,"/execute-callback",{proposalId:counter.id}));
 check("step 4: execute inside the veto window is rejected without dispatch",early?.status===409&&J.sim.setpoints.length===0&&J.actors.count("authorizeExecution")===0,`status ${statusOf(early)}`);
 await waitVeto(J,approved);
 const executed:any=await api(J,"/execute-callback",{proposalId:counter.id});
 check("step 4: execute dispatches once and does not claim observation",J.sim.setpoints.length===1&&J.sim.setpoints[0].value===65&&executed.observed===false&&executed.commandId===`proposal:${counter.id}`);
 const entry=J.journal.get("command",counter.id);
 check("step 4: journal shows accepted with no token retained",entry?.status==="accepted"&&entry.token===undefined,`status=${entry?.status}`);
 check("step 4: actor metric follows setMetric",J.actors.components.get("plant-a/P-100").metrics.speedPct===65&&J.actors.count("setMetric")===1);
 await api(J,"/tick",{});
 const lvNow=J.actors.components.get("plant-a/LV-101").metrics.positionPct;
 check("step 4: mirror carries the FAKE sim values to the actor",lvNow>=65&&lvNow<=68,`LV-101=${lvNow}`);
 const preEarly=await caught(()=>api(J,"/observed",{proposalId:"nope",effects:[]}));
 check("step 4: observed for an unknown proposal is 404",preEarly?.status===404,`status ${statusOf(preEarly)}`);
 await api(J,"/observed",{proposalId:counter.id,effects:[{componentId:"plant-a/LV-101",metric:"positionPct",before:50,after:66.5,ticksToSettle:3}]});
 const event=J.actors.plants.get("plant-a").history.find((e:any)=>e.proposalId===counter.id);
 repeatEventId=event?.id;
 const hasKeys=event&&["id","at","plantId","componentId","metric","before","after","upstreamSnapshot","effects","incident","approvedBy","operator","proposalId"].every(k=>k in event);
 check("step 4: observed writes a complete HistoryEvent with the pre-dispatch snapshot",!!hasKeys&&event.before===50&&event.after===65&&event.upstreamSnapshot.feedM3h===15&&event.approvedBy.length===5,JSON.stringify(event?.upstreamSnapshot));
 check("step 4: proposal reaches executed after recordEvent",J.actors.proposal(counter.id).status==="executed");
 const executedMsg=J.pub.published.find(m=>m.type==="executed");
 check("step 4: executed published to plant-a and company",JSON.stringify(executedMsg?.channels)===JSON.stringify(["plant-a","company"])&&executedMsg?.payload.event.id===event?.id);
 await J.bridge.receive(inbound("agent:plant-a/LV-101","calibration",{componentId:"plant-a/LV-101",entry:{at:new Date().toISOString(),proposalId:counter.id,metric:"positionPct",predicted:66.5,observed:66.5,absError:0}}));
 check("step 4: calibration from the LV-101 sender is stored",J.actors.components.get("plant-a/LV-101").calibration.length===1);
 await J.bridge.receive(inbound("agent:plant-a/P-100","rule",{rule},"company"));
 check("step 4: company rule reaches the company library and channel",J.actors.company.rules.some((r:any)=>r.id===rule.id)&&J.pub.published.some(m=>m.type==="rule"&&m.channels[0]==="company"));
 // Step 5: repeat 85.
 const again=await newProposal(J,"plant-a",85);
 check("step 5: repeat 85 starts from the executed value",again.from===65,`from=${again.from}`);
 const blocked2=await scriptedVotes(J,again.id),lv2=voteOf(blocked2,"LV-101");
 check("step 5: repeat blocked with the new event cited first",blocked2.status==="blocked"&&lv2.vote==="no"&&lv2.evidenceEventIds[0]===event?.id,`first evidence=${lv2?.evidenceEventIds[0]}`);
 // Step 6: plant-b.
 const b=await newProposal(J,"plant-b",85);
 check("step 6: plant-b proposal requires plant-a TV-101",b.from===50&&b.crossPlant===true&&b.requiredVoters.includes("plant-a/TV-101"));
 const blockedB=await scriptedVotes(J,b.id),lvB=voteOf(blockedB,"LV-101");
 check("step 6: plant-b blocked citing the company rule",blockedB.status==="blocked"&&lvB.vote==="no"&&lvB.evidenceRuleIds.includes(rule.id),`rules=${JSON.stringify(lvB?.evidenceRuleIds)}`);
 const plantARules:any=await J.live.get("/rules",url("/rules",{componentId:"plant-a/LV-101"}));
 check("GET /rules lists a company rule once for its originating plant",new Set(plantARules.map((r:any)=>r.id)).size===plantARules.length,`ids=${JSON.stringify(plantARules.map((r:any)=>r.id))}`);
 check("step 6: plant-b never received a dispatch",J.sim.setpoints.every(s=>s.componentId==="plant-a/P-100")&&J.sim.speed["plant-b"]===50);
});

section="No double dispatch";
await attempt("retry",async()=>{
 const w=world();await api(w,"/reset",{});const p=await readyToExecute(w);
 const first=await api(w,"/execute-callback",{proposalId:p.id}),second=await api(w,"/execute-callback",{proposalId:p.id});
 check("sequential retry returns the same result with one dispatch",w.sim.setpoints.length===1&&w.actors.count("setMetric")===1&&JSON.stringify(first)===JSON.stringify(second),`setpoints=${w.sim.setpoints.length}`);
 await api(w,"/observed",{proposalId:p.id,effects:[]});await api(w,"/observed",{proposalId:p.id,effects:[]});await api(w,"/execute-callback",{proposalId:p.id});
 check("retry after observed still does not dispatch or re-record",w.sim.setpoints.length===1&&w.actors.count("recordEvent")===1&&w.pub.published.filter(m=>m.type==="executed").length===1);
});
await attempt("concurrent",async()=>{
 const w=world();await api(w,"/reset",{});const p=await readyToExecute(w);
 const all=await Promise.allSettled(Array.from({length:5},()=>api(w,"/execute-callback",{proposalId:p.id})));
 check("five concurrent callbacks dispatch once",w.sim.setpoints.length===1,`setpoints=${w.sim.setpoints.length} fulfilled=${all.filter(r=>r.status==="fulfilled").length}`);
});
await attempt("sync-fail",async()=>{
 const w=world();await api(w,"/reset",{});const p=await readyToExecute(w);
 w.actors.failNext.setMetric=1;
 const e=await caught(()=>api(w,"/execute-callback",{proposalId:p.id}));
 check("setMetric failure reports 502 accepted:true",e?.status===502&&e.details?.accepted===true,`status ${statusOf(e)}`);
 await api(w,"/execute-callback",{proposalId:p.id});
 check("retry reconciles the actor with no second dispatch",w.sim.setpoints.length===1&&w.journal.get("command",p.id).status==="accepted"&&w.actors.components.get("plant-a/P-100").metrics.speedPct===65);
});
await attempt("expired-token",async()=>{
 const w=world({tokenTtlMs:40});await api(w,"/reset",{});const p=await readyToExecute(w);
 w.actors.failNext.setMetric=1;await caught(()=>api(w,"/execute-callback",{proposalId:p.id}));await Bun.sleep(60);
 const noTick=await caught(()=>api(w,"/execute-callback",{proposalId:p.id}));await api(w,"/tick",{});
 const afterTick=await caught(()=>api(w,"/execute-callback",{proposalId:p.id}));
 check("retry with an expired token recovers once a mirror tick lands",noTick?.status===502&&afterTick===null&&w.sim.setpoints.length===1&&w.journal.get("command",p.id).status==="accepted",`before tick ${statusOf(noTick)}, after tick ${statusOf(afterTick)}`);
});
await attempt("unknown",async()=>{
 const w=world();await api(w,"/reset",{});const p=await readyToExecute(w);
 w.sim.onSetpoint=()=>{throw new ApiError(503,"FAKE sim down");};
 const a=await caught(()=>api(w,"/execute-callback",{proposalId:p.id})),b=await caught(()=>api(w,"/execute-callback",{proposalId:p.id}));
 check("sim failure leaves unknown and refuses redispatch",a?.status===503&&b?.status===409&&w.sim.setpoints.length===1&&w.journal.get("command",p.id).status==="unknown");
 const o=await caught(()=>api(w,"/observed",{proposalId:p.id,effects:[]}));
 check("observed is refused for an unknown command",o?.status===409&&w.actors.count("recordEvent")===0);
});

section="Unapproved execute";
await attempt("unapproved",async()=>{
 const w=world();await api(w,"/reset",{});
 const voting=await newProposal(w,"plant-a",65);
 const e1=await caught(()=>api(w,"/execute-callback",{proposalId:voting.id}));
 check("voting proposal rejected",e1?.status===409,`status ${statusOf(e1)}`);
 const bad=await newProposal(w,"plant-a",85);await scriptedVotes(w,bad.id);
 const e2=await caught(()=>api(w,"/execute-callback",{proposalId:bad.id}));
 check("blocked proposal rejected",e2?.status===409,`status ${statusOf(e2)}`);
 const e3=await caught(()=>api(w,"/execute-callback",{proposalId:"fake-does-not-exist"}));
 check("unknown proposal rejected",e3?.status===404,`status ${statusOf(e3)}`);
 const w2=world();await api(w2,"/reset",{});const v=await newProposal(w2,"plant-a",65);await scriptedVotes(w2,v.id);
 await api(w2,"/veto",{proposalId:v.id,by:"fake-operator"});await waitVeto(w2,v);
 const e4=await caught(()=>api(w2,"/execute-callback",{proposalId:v.id}));
 const late=await (async()=>{const w3=world();await api(w3,"/reset",{});const p=await readyToExecute(w3);return caught(()=>api(w3,"/veto",{proposalId:p.id,by:"fake-operator"}));})();
 check("vetoed proposal rejected",e4?.status===409,`status ${statusOf(e4)}`);
 check("veto after the deadline rejected",late?.status===409,`status ${statusOf(late)}`);
 check("no dispatch or authorization on any rejected execute",w.sim.setpoints.length===0&&w2.sim.setpoints.length===0&&w.actors.count("authorizeExecution")===0&&w2.actors.count("authorizeExecution")===0);
 const w4=world();await api(w4,"/reset",{});const stale=await readyToExecute(w4);w4.sim.speed["plant-a"]=55;
 const e5=await caught(()=>api(w4,"/execute-callback",{proposalId:stale.id}));
 check("sim drift after approval rejected without dispatch or journal entry",e5?.status===409&&w4.sim.setpoints.length===0&&w4.journal.get("command",stale.id)===undefined,`status ${statusOf(e5)}`);
});

section="Bug hunt: reset";
await attempt("id-reuse",async()=>{
 const w=world({ids:"per-seed-counter"});await api(w,"/reset",{});
 const p1=await readyToExecute(w);await api(w,"/execute-callback",{proposalId:p1.id});await api(w,"/observed",{proposalId:p1.id,effects:[]});
 await api(w,"/reset",{});const before=w.sim.setpoints.length;
 const p2=await newProposal(w,"plant-a",65);
 const take2=await scriptedVotes(w,p2.id);
 check("second take after reset: votes count when the actor reuses a proposal id",take2.votes.length===5,`id=${p2.id} reused=${p1.id===p2.id} votes=${take2.votes.length} (relay-inbound journal not cleared)`);
 for(const c of take2.requiredVoters)if(!take2.votes.some((v:any)=>v.componentId===c))await w.actors.call("Plant","plant-a","vote",[{proposalId:p2.id,componentId:c,agentId:`agent:${c}`,vote:"yes",reason:"FAKE direct vote to reach execute",predicted:{},marginPct:10,evidenceEventIds:[],evidenceRuleIds:[],similarCount:0}]);
 w.actors.sweep("plant-a");await waitVeto(w,p2);
 const r:any=await caught(()=>api(w,"/execute-callback",{proposalId:p2.id}));
 check("second take after reset: execute dispatches when the actor reuses a proposal id",w.sim.setpoints.length===before+1,`setpoints added=${w.sim.setpoints.length-before}, sim speed=${w.sim.speed["plant-a"]}, error=${r?.message??"none (stale success returned)"}`);
});
await attempt("second-take",async()=>{
 const w=world();await api(w,"/reset",{});const p1=await readyToExecute(w);await api(w,"/execute-callback",{proposalId:p1.id});await api(w,"/observed",{proposalId:p1.id,effects:[]});
 await api(w,"/reset",{});const p2=await readyToExecute(w);await api(w,"/execute-callback",{proposalId:p2.id});
 check("second take after reset works when actor ids are globally unique",w.sim.setpoints.length===2&&w.sim.speed["plant-a"]===65);
});
await attempt("reset-race",async()=>{
 const w=world();await api(w,"/reset",{});const p=await readyToExecute(w);
 const eventsBefore=w.sim.events.length;
 const [r,e]=await Promise.allSettled([api(w,"/reset",{}),api(w,"/execute-callback",{proposalId:p.id})]);
 const seq=w.sim.events.slice(eventsBefore);
 check("execute that arrives just after /reset does not dispatch",!seq.some(x=>x.startsWith("setpoint")),`order=${JSON.stringify(seq)} reset=${r.status} execute=${e.status==="rejected"?`${e.reason?.status} ${e.reason?.message}`:"fulfilled"} simSpeedAfter=${w.sim.speed["plant-a"]} actorSpeedAfter=${w.actors.components.get("plant-a/P-100").metrics.speedPct}`);
});
await attempt("raw-company",async()=>{
 const w=world({rawCompanySeed:true});await api(w,"/reset",{});
 const e=await caught(()=>w.live.get("/rules",url("/rules",{componentId:"plant-a/LV-101"})));
 check("GET /rules survives company seed exactly as in shared/plants.json (no rules key)",e===null,e?`${e.constructor?.name}: ${e.message}`:"");
});

section="Bug hunt: mirror";
await attempt("mirror-race",async()=>{
 const w=world();await api(w,"/reset",{});const p=await readyToExecute(w);
 let release!:()=>void;const gate=new Promise<void>(res=>{release=res;});let held!:()=>void;const isHeld=new Promise<void>(res=>{held=res;});
 w.actors.beforeMirror=async id=>{if(id==="plant-a/P-100"){held();await gate;}};
 const tick=api(w,"/tick",{});await isHeld;w.actors.beforeMirror=undefined;
 await api(w,"/execute-callback",{proposalId:p.id});release();await tick;
 const speed=w.actors.components.get("plant-a/P-100").metrics.speedPct;
 check("a tick in flight during execute does not regress the actor metric",speed===65,`actor speedPct=${speed}, sim=${w.sim.speed["plant-a"]}`);
 const again=await newProposal(w,"plant-a",70);
 check("a proposal made right after that execute has the true from",again.from===65,`from=${again.from}`);
});

section="Bug hunt: relay inbound";
const vote=(componentId:string,agentId:string,proposalId:string)=>({proposalId,componentId,agentId,vote:"yes",reason:"FAKE",predicted:{},marginPct:10,evidenceEventIds:[],evidenceRuleIds:[],similarCount:0});
await attempt("dedupe",async()=>{
 const w=world();await api(w,"/reset",{});const p=await newProposal(w,"plant-a",65);
 const m=inbound("agent:plant-a/LV-101","vote",{vote:vote("plant-a/LV-101","agent:plant-a/LV-101",p.id)});
 await w.bridge.receive(m);await w.bridge.receive({...m,id:"fake-replayed"});
 check("replayed vote reaches the actor once",w.actors.count("vote")===1,`vote calls=${w.actors.count("vote")}`);
});
await attempt("wrong-sender",async()=>{
 const w=world();await api(w,"/reset",{});const p=await newProposal(w,"plant-a",65);
 const e=await caught(()=>w.bridge.receive(inbound("agent:plant-a/TK-101","vote",{vote:vote("plant-a/LV-101","agent:plant-a/LV-101",p.id)})));
 check("sender naming a different agentId is rejected",e?.status===403&&w.actors.count("vote")===0,`status ${statusOf(e)}`);
});
await attempt("impersonation",async()=>{
 const w=world();await api(w,"/reset",{});const p=await newProposal(w,"plant-a",65);
 const e=await caught(()=>w.bridge.receive(inbound("agent:plant-a/P-100","vote",{vote:vote("plant-a/LV-101","agent:plant-a/P-100",p.id)})));
 check("agent cannot vote as another component by setting agentId to itself",w.actors.count("vote")===0,`status ${statusOf(e)}, vote calls=${w.actors.count("vote")}, recorded voter=${w.actors.proposal(p.id).votes[0]?.componentId}`);
});
await attempt("natural-rule",async()=>{
 const w=world();await api(w,"/reset",{});
 const e=await caught(()=>w.bridge.receive(inbound("agent:plant-a/LV-101","rule",{rule},"company")));
 check("LV-101 agent can promote the rule about its own valve (condition on P-100, consequence on LV-101)",e===null&&w.actors.count("promoteRule")===1,`status ${statusOf(e)}: ${e?.message??""}`);
});
await attempt("flat",async()=>{
 const w=world();await api(w,"/reset",{});const p=await newProposal(w,"plant-a",65);
 const v=vote("plant-a/LV-101","agent:plant-a/LV-101",p.id);
 const e=await caught(()=>w.bridge.receive({id:"fake-flat",channel:"plant-a",from:{name:"agent:plant-a/LV-101"},text:JSON.stringify({type:"vote",vote:v})} as any));
 check("flat envelope {type,vote}, the code's payload fallback, is accepted",e===null&&w.actors.count("vote")===1,e?`${e.constructor?.name}: ${String(e.message).slice(0,90).replace(/\s+/g," ")}`:"");
});
const startedBridge=async(w:World,client:FakeRelayClient)=>{w.journal.set("credential","relay-agent-token","FAKE-not-a-real-token");const b=new RelayBridge((path,body)=>live.post(path,body),w.journal,()=>client as any),live=new LiveCoordinator(w.actors,w.sim,b,w.journal);await b.start();return b;};
await attempt("poison",async()=>{
 const w=world();await api(w,"/reset",{});const p=await newProposal(w,"plant-a",65);
 const client=new FakeRelayClient(),b=await startedBridge(w,client);
 const good=inbound("agent:plant-a/LV-101","vote",{vote:vote("plant-a/LV-101","agent:plant-a/LV-101",p.id)});
 client.inbox=[inbound("agent:plant-a/TK-101","vote",{vote:vote("plant-a/TK-101","agent:plant-a/TK-101","fake-gone-proposal")}),good];
 const e=await caught(()=>b.backfill());
 check("one rejected message does not stop backfill of later messages",w.actors.count("vote")===1,`vote calls=${w.actors.count("vote")}, backfill error=${e?.message??"none"}`);
 client.inbox=[{...inbound("agent:plant-a/TK-101","vote",{}),text:"null"},good];
 const e2=await caught(()=>b.backfill());
 check("a message whose text is JSON null is ignored",!(e2 instanceof TypeError),e2?`${e2.constructor?.name}: ${e2.message}`:"");
});
await attempt("replay",async()=>{
 const w=world();await api(w,"/reset",{});const p=await newProposal(w,"plant-a",85);await scriptedVotes(w,p.id);
 const client=new FakeRelayClient(),b2=await startedBridge(w,client);
 const before=w.actors.count("propose");
 client.inbox=[inbound("agent:plant-a/P-100","counter",{parentProposalId:p.id,proposal:proposeBody("plant-a",65)})];
 client.sendFailures=1;
 const e=await caught(()=>b2.backfill());
 const replay=await caught(()=>b2.backfill());
 const made=w.actors.count("propose")-before;
 check("counter accepted before a Relay failure is not re-proposed by backfill",made===1,`first ${statusOf(e)} accepted=${e?.details?.accepted}, second ${replay?statusOf(replay):"ok"}, Plant.propose calls=${made}`);
});

section="Contract probe";
await attempt("literal",async()=>{
 const w=world({similar:"contract-literal"});await api(w,"/reset",{});
 const p=await readyToExecute(w);await api(w,"/execute-callback",{proposalId:p.id});await api(w,"/tick",{});
 await api(w,"/observed",{proposalId:p.id,effects:[{componentId:"plant-a/LV-101",metric:"positionPct",before:50,after:66.5,ticksToSettle:3}]});
 const again=await newProposal(w,"plant-a",85),blocked=await scriptedVotes(w,again.id),lv=voteOf(blocked,"LV-101");
 check("similar() ranked literally per CLAUDE.md still returns the new event first",lv.evidenceEventIds[0]===`observed:${p.id}`,`evidence=${JSON.stringify(lv.evidenceEventIds)}`);
});

await attempt("nearest",async()=>{
 const w=world({similar:"nearest-only"});await api(w,"/reset",{});
 const p=await readyToExecute(w);await api(w,"/execute-callback",{proposalId:p.id});await api(w,"/tick",{});
 await api(w,"/observed",{proposalId:p.id,effects:[]});
 const again=await newProposal(w,"plant-a",85),blocked=await scriptedVotes(w,again.id),lv=voteOf(blocked,"LV-101");
 check("similar() ranked by nearest `after` alone, k=5, retrieves the new event at all",lv.evidenceEventIds.includes(`observed:${p.id}`),`evidence=${JSON.stringify(lv.evidenceEventIds)}`);
});

section="HTTP via server.ts";
await attempt("http",async()=>{
 const sim=new FakeSim();
 const simServer=Bun.serve({port:0,hostname:"127.0.0.1",fetch:async req=>{const u=new URL(req.url);
  if(u.pathname==="/snapshot")return Response.json(await sim.snapshot(u.searchParams.get("plantId")!));
  if(u.pathname==="/reset")return Response.json(await sim.reset());
  if(u.pathname==="/setpoint")return Response.json(await sim.setpoint(await req.json()));
  return new Response("{}",{status:404});}});
 (globalThis as any).__fakeHarnessActors=new FakeActors();
 Object.assign(process.env,{GLUE_MODE:"live",GLUE_JOURNAL_PATH:":memory:",ACTOR_CLIENT_MODULE:fileURLToPath(new URL("./fakes.ts",import.meta.url)),SIM_URL:simServer.url.origin,EXECUTION_CALLBACK_TOKEN:"FAKE-harness-only"});
 for(const k of ["ACTOR_API_URL","ACTOR_API_TOKEN","RELAY_WORKSPACE_KEY","RELAY_AGENT_TOKEN","BRIDGE_PUSHES_MIRROR"])delete process.env[k];
 const {handle}=await import("../server");
 const call=(path:string,body?:unknown,headers:Record<string,string>={})=>handle(new Request(`http://fake-harness${path}`,body===undefined?{headers}:{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)}));
 const reset=await call("/reset",{});
 check("POST /reset through real ActorAdapter and SimulationAdapter",reset.status===200&&sim.resets===1,`status ${reset.status}`);
 const state:any=await (await call("/state?plantId=plant-b")).json();
 check("GET /state returns ten components in live mode",state.mode==="live"&&state.components?.length===10&&state.integrations?.simulation===true&&state.integrations?.actors===true,`components=${state.components?.length} integrations=${JSON.stringify(state.integrations)}`);
 const tick:any=await (await call("/tick",{})).json();
 check("POST /tick mirrors ten components over HTTP sim",tick.mirrored===10,JSON.stringify(tick));
 check("execute-callback without the bearer token is 401",(await call("/execute-callback",{proposalId:"x"})).status===401);
 check("execute-callback with the token reaches the coordinator",(await call("/execute-callback",{proposalId:"x"},{authorization:"Bearer FAKE-harness-only"})).status===404);
 check("/propose fails closed when Relay is not configured",(await call("/propose",proposeBody("plant-a",65))).status===503);
 check("malformed vote is 400",(await call("/vote",{vote:{proposalId:"x"}})).status===400);
 const errorLog=console.error;console.error=()=>{};
 const missing=await call("/similar?metric=speedPct&to=85"),garbage=await call("/similar?componentId=plant-a/P-100&metric=speedPct&to=85&upstreamSnapshot=notjson"),badTo=await call("/similar?componentId=plant-a/P-100&metric=speedPct&to=abc");
 console.error=errorLog;
 check("GET /similar without componentId is a client error",missing.status===400,`status ${missing.status}`);
 check("GET /similar with malformed upstreamSnapshot is a client error",garbage.status===400,`status ${garbage.status}`);
 check("GET /similar with non-numeric to is a client error",badTo.status===400,`status ${badTo.status}`);
 simServer.stop(true);
});

const failed=results.filter(r=>!r.pass);
const line="=".repeat(100);
console.log(`\n${line}\nFAKE HARNESS: fake actors, fake sim table, fake publisher, scripted votes. NOT live agents, NOT physics, NOT Relay delivery.\n${line}`);
let current="";
for(const r of results){
 if(r.section!==current){current=r.section;console.log(`\n-- ${current}`);}
 console.log(`${r.pass?"PASS":"FAIL"}  ${r.name}${r.detail&&(!r.pass||process.env.HARNESS_VERBOSE)?`\n        ${r.detail}`:""}`);
}
console.log(`\n${results.length-failed.length} passed, ${failed.length} failed of ${results.length}. A PASS here says nothing about real actors, agents, Relay, or the simulator.`);
process.exit(failed.length?1:0);

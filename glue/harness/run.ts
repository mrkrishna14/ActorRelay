// FAKE HARNESS. Real LiveCoordinator, RelayBridge inbound logic, schemas and Journal.
// Fake actors, fake sim, fake publisher, scripted votes. Not live agents, not physics, not Relay delivery.
// Run from glue/: bun run harness/run.ts
import {fileURLToPath} from "node:url";
import {ApiError} from "../actors";
import {Journal} from "../journal";
import {LiveCoordinator} from "../live";
import {RelayBridge} from "../relay";
import {schemas} from "../schemas";
import {FakeActors,FakePublisher,FakeRelayClient,FakeSim,fakeHistory,fakePublishEndpoint,type FakeOpts} from "./fakes";

const results:{section:string,name:string,pass:boolean,detail:string}[]=[];
let section="";
const check=(name:string,pass:boolean,detail="")=>{results.push({section,name,pass,detail});};
const attempt=async(name:string,run:()=>Promise<void>)=>{try{await run();}catch(error){check(name,false,`threw: ${String(error)}`);}};
const caught=async(run:()=>Promise<unknown>)=>{try{await run();return null;}catch(error){return error as any;}};
const statusOf=(e:any)=>e?.status??(e?"non-ApiError "+e.constructor?.name:"no error");

// Real plants.json from origin/zubair (read-only git). origin/zubair has no shared/history.json, so history is FAKE.
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
  let predicted:Record<string,number>=Object.fromEntries(Object.keys(c.limits).map(m=>[m,c.metrics[m]])),vote="yes";
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
// Takes the proposal as voted: a veto clears vetoDeadline on the actor's copy.
const waitVeto=async(p:any)=>{await Bun.sleep(Math.max(0,Date.parse(p.vetoDeadline)-Date.now())+5);};
const newProposal=async(w:World,plantId:string,to:number)=>((await api(w,"/propose",proposeBody(plantId,to))) as any).proposal;
/** Drives a fresh proposal through the FAKE sweep: Plant.execute has accepted it and the callback is due. Tests deliver the callback themselves. */
const readyToExecute=async(w:World,to=65,plantId="plant-a")=>{const p=await newProposal(w,plantId,to);const voted=await scriptedVotes(w,p.id);if(voted.status!=="veto_window")throw new Error(`setup: expected veto_window, got ${voted.status}`);await waitVeto(voted);w.actors.sweep(plantId);if(voted.status!=="executed")throw new Error(`setup: expected executed, got ${voted.status}`);return voted;};
const COMPANY_RULE_ID="company-rule:outlet-valve-A:speedPct:positionPct:high";
const rule={id:"fake-rule-lv-high",scope:"company",model:"outlet-valve-A",text:"FAKE rule: P-100 speedPct >= 80 leads to LV-101 positionPct >= 85 within 3 ticks",condition:{componentId:"plant-a/P-100",metric:"speedPct",op:">=",value:80},consequence:{componentId:"plant-a/LV-101",metric:"positionPct",op:">=",value:85,withinTicks:3},supportEventIds:["fake-hist-a-85-1"],timesSeen:3,createdAt:new Date().toISOString(),lastSeenAt:new Date().toISOString()};

const predictedFor=(componentId:string)=>(({"P-100":{speedPct:50},"TK-101":{levelPct:50,tempC:75},"LV-101":{positionPct:50},"E-101":{dutyKw:898.5},"TV-101":{positionPct:50.5,steamKgH:1533}}) as Record<string,Record<string,number>>)[componentId.split("/")[1]!]!;
const vote=(componentId:string,agentId:string,proposalId:string,similarCount=0)=>({proposalId,componentId,agentId,vote:"yes",reason:"FAKE",predicted:predictedFor(componentId),marginPct:10,evidenceEventIds:[],evidenceRuleIds:[],similarCount});

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
 const earlyPlant=await caught(()=>J.actors.call("Plant","plant-a","execute",[counter.id]));
 check("step 4: Plant.execute inside the veto window is refused",earlyPlant?.status===409&&String(earlyPlant.message).includes("veto_window_open")&&approved.status==="veto_window",`status ${statusOf(earlyPlant)}`);
 check("step 4: execute callback inside the veto window is rejected without dispatch",early?.status===409&&J.sim.setpoints.length===0&&J.actors.count("claimDispatch")===0,`status ${statusOf(early)}`);
 await waitVeto(approved);
 let executed:any;J.actors.onCallback=async id=>{executed=await api(J,"/execute-callback",{proposalId:id});};
 J.actors.sweep("plant-a");J.actors.onCallback=undefined;
 check("step 4: after the deadline the sweep sets executed, then the callback runs",J.actors.proposal(counter.id).status==="executed"&&JSON.stringify(J.actors.callbacks)===JSON.stringify([counter.id]));
 const delivered=await J.actors.lastCallback;
 if(!delivered?.ok)throw new Error(`callback failed: ${delivered?.error}`);
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
 check("step 4: the stored event has the actor's own id and the journal keeps that id",event?.id===`event-${counter.id}`&&J.journal.get("command",counter.id)?.eventId===event?.id,`id=${event?.id}`);
 check("step 4: the execution reaches observed after recordEvent",(await J.actors.call("Plant","plant-a","getExecution",[counter.id]))?.state==="observed");
 const executedMsg=J.pub.published.find(m=>m.type==="executed");
 check("step 4: executed published to plant-a and company",JSON.stringify(executedMsg?.channels)===JSON.stringify(["plant-a","company"])&&executedMsg?.payload.event.id===event?.id);
 await J.bridge.receive(inbound("agent:plant-a/LV-101","calibration",{componentId:"plant-a/LV-101",entry:{at:new Date().toISOString(),proposalId:counter.id,metric:"positionPct",predicted:66.5,observed:66.5,absError:0}}));
 check("step 4: calibration from the LV-101 sender is stored",J.actors.components.get("plant-a/LV-101").calibration.length===1);
 await J.bridge.receive(inbound("agent:plant-a/P-100","rule",{rule},"company"));
 check("step 4: company rule reaches the company library under the actor's company id, and the channel",J.actors.company.rules.some((r:any)=>r.id===COMPANY_RULE_ID)&&J.pub.published.some(m=>m.type==="rule"&&m.channels[0]==="company"),JSON.stringify(J.actors.company.rules.map((r:any)=>r.id)));
 // Step 5: repeat 85.
 const again=await newProposal(J,"plant-a",85);
 check("step 5: repeat 85 starts from the executed value",again.from===65,`from=${again.from}`);
 const blocked2=await scriptedVotes(J,again.id),lv2=voteOf(blocked2,"LV-101");
 check("step 5: repeat blocked with the new event cited first",blocked2.status==="blocked"&&lv2.vote==="no"&&lv2.evidenceEventIds[0]===event?.id,`first evidence=${lv2?.evidenceEventIds[0]}`);
 // Step 6: plant-b.
 const b=await newProposal(J,"plant-b",85);
 check("step 6: plant-b proposal requires plant-a TV-101",b.from===50&&b.crossPlant===true&&b.requiredVoters.includes("plant-a/TV-101"));
 const blockedB=await scriptedVotes(J,b.id),lvB=voteOf(blockedB,"LV-101");
 check("step 6: plant-b blocked citing the company rule",blockedB.status==="blocked"&&lvB.vote==="no"&&lvB.evidenceRuleIds.includes(COMPANY_RULE_ID),`rules=${JSON.stringify(lvB?.evidenceRuleIds)}`);
 const plantARules:any=await J.live.get("/rules",url("/rules",{componentId:"plant-a/LV-101"}));
 check("GET /rules lists a company rule once for its originating plant",new Set(plantARules.map((r:any)=>r.id)).size===plantARules.length,`ids=${JSON.stringify(plantARules.map((r:any)=>r.id))}`);
 check("step 6: plant-b never received a dispatch",J.sim.setpoints.every(s=>s.componentId==="plant-a/P-100")&&J.sim.speed["plant-b"]===50);
});

section="Fake actor contract (checks the FAKE matches actor.ts)";
await attempt("contract",async()=>{
 const w=world();await api(w,"/reset",{});
 const gone=await caught(()=>w.actors.call("Plant","plant-a","authorizeExecution",["x"]));
 check("authorizeExecution no longer exists",gone?.status===404,`status ${statusOf(gone)}`);
 const p=await newProposal(w,"plant-a",65);
 const notAccepted=await caught(()=>w.actors.call("Plant","plant-a","claimDispatch",[p.id]));
 const noVotes=await caught(()=>w.actors.call("Plant","plant-a","execute",[p.id]));
 check("claimDispatch and execute both refuse a proposal without approval",String(notAccepted?.message).includes("not_accepted")&&String(noVotes?.message).includes("not_approved"));
 const voted=await scriptedVotes(w,p.id);await waitVeto(voted);w.actors.sweep("plant-a");
 const [c1,c2]=[await w.actors.call("Plant","plant-a","claimDispatch",[p.id]),await w.actors.call("Plant","plant-a","claimDispatch",[p.id])];
 check("claimDispatch gives one dispatch:true with a token, then dispatch:false",c1.dispatch===true&&!!c1.token&&c2.dispatch===false&&c2.state==="claimed"&&c2.token===undefined,JSON.stringify({first:c1.dispatch,second:c2}));
 const set=(token:string,value=65)=>w.actors.call("Component","plant-a/P-100","setMetric",["speedPct",value,p.id,token]);
 const wrong=await caught(()=>set("FAKE-wrong"));
 check("wrong token is refused and does not burn the real one",String(wrong?.message).includes("invalid_token")&&w.actors.components.get("plant-a/P-100").metrics.speedPct===50);
 const wrongValue=await caught(()=>set(c1.token,70));
 check("token bound to another value is refused",String(wrongValue?.message).includes("invalid_token"));
 await set(c1.token);
 const again=await caught(()=>set(c1.token));
 check("setMetric redeems through the plant, and a second redeem fails with token_already_used",w.actors.count("redeemToken")===4&&(await w.actors.call("Plant","plant-a","getExecution",[p.id])).state==="applied"&&String(again?.message).includes("token_already_used"),String(again?.message));
 const late=await caught(()=>w.actors.call("Plant","plant-a","reportDispatchFailure",[p.id,"FAKE"]));
 check("reportDispatchFailure refuses an applied execution",String(late?.message).includes("already_applied"),String(late?.message));
 const e1=await w.actors.call("Plant","plant-a","recordEvent",[{id:"caller-id",proposalId:p.id,effects:[],before:1,after:2}]),e2=await w.actors.call("Plant","plant-a","recordEvent",[{id:"other-id",proposalId:p.id,effects:[]}]);
 check("recordEvent returns the stored event with the actor's own id, and repeats return it",e1.id===`event-${p.id}`&&e1.before===50&&e1.after===65&&e2.id===e1.id,`id=${e1.id}`);
 const w2=world();await api(w2,"/reset",{});const q=await readyToExecute(w2);
 const notDispatched=await caught(()=>w2.actors.call("Plant","plant-a","recordEvent",[{proposalId:q.id,effects:[]}]));
 check("recordEvent refuses an execution that was accepted but never claimed",String(notDispatched?.message).includes("not_dispatched"));
 await w2.actors.call("Plant","plant-a","claimDispatch",[q.id]);const failed=await w2.actors.call("Plant","plant-a","reportDispatchFailure",[q.id,"FAKE reason"]);
 check("reportDispatchFailure fails the execution, expires the proposal and restores the setpoint",failed.state==="failed"&&failed.failure==="FAKE reason"&&w2.actors.proposal(q.id).status==="expired"&&(await newProposal(w2,"plant-a",70)).from===50);
 const unsafe=await caught(async()=>{const r=await newProposal(w2,"plant-b",65);await w2.actors.call("Plant","plant-b","vote",[{...vote("plant-b/LV-101","agent:plant-b/LV-101",r.id),predicted:{}}]);});
 check("a yes vote that predicts nothing is refused",String(unsafe?.message).includes("must predict"),String(unsafe?.message));
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
await attempt("lost-reply",async()=>{
 const w=world();await api(w,"/reset",{});const p=await readyToExecute(w);
 w.actors.loseReply.setMetric=1;
 const e=await caught(()=>api(w,"/execute-callback",{proposalId:p.id}));
 const retry=await caught(()=>api(w,"/execute-callback",{proposalId:p.id}));
 check("setMetric applied but reply lost: retry treats token_already_used as success, no second dispatch",e?.status===502&&retry===null&&w.sim.setpoints.length===1&&w.journal.get("command",p.id).status==="accepted"&&w.journal.get("command",p.id).token===undefined,`first ${statusOf(e)}, retry ${retry?retry.message:"ok"}`);
 const w2=world({plainErrors:true});await api(w2,"/reset",{});const q=await readyToExecute(w2);
 w2.actors.loseReply.setMetric=1;await caught(()=>api(w2,"/execute-callback",{proposalId:q.id}));
 const plain=await caught(()=>api(w2,"/execute-callback",{proposalId:q.id}));
 check("token_already_used is still recognized as the actor's plain Error, with no HTTP status",plain===null&&w2.journal.get("command",q.id).status==="accepted",plain?String(plain.message):"");
});
await attempt("claim-loser",async()=>{
 const w=world();await api(w,"/reset",{});const p=await readyToExecute(w);
 await api(w,"/execute-callback",{proposalId:p.id});
 // A second glue process, or one with a lost journal: only the actor's claim stands between it and a second write.
 const fresh=new LiveCoordinator(w.actors,w.sim,w.pub,new Journal(":memory:"));
 const lost:any=await fresh.post("/execute-callback",{proposalId:p.id});
 check("a glue with an empty journal loses the claim and does not write",lost.dispatch===false&&w.sim.setpoints.length===1,JSON.stringify(lost));
});
await attempt("claim-timeout",async()=>{
 const w=world({claimTimeoutMs:40});await api(w,"/reset",{});const p=await readyToExecute(w);
 w.actors.failNext.setMetric=1;await caught(()=>api(w,"/execute-callback",{proposalId:p.id}));await Bun.sleep(60);w.actors.sweep("plant-a");
 const retry=await caught(()=>api(w,"/execute-callback",{proposalId:p.id}));
 check("retry after the actor timed out the claim reports 502 accepted:true with no second dispatch",retry?.status===502&&retry.details?.accepted===true&&w.sim.setpoints.length===1,`status ${statusOf(retry)}: ${retry?.details?.cause??""}`);
 const next=await newProposal(w,"plant-a",70);
 check("after a timed-out claim on a write the simulator accepted, a new proposal starts from the simulator's value",next.from===w.sim.speed["plant-a"],`from=${next.from} sim=${w.sim.speed["plant-a"]}: every later execute is refused as drift until /reset`);
});
await attempt("unknown",async()=>{
 const w=world();await api(w,"/reset",{});const p=await readyToExecute(w);
 w.sim.onSetpoint=()=>{throw new ApiError(503,"FAKE sim down");};
 const a=await caught(()=>api(w,"/execute-callback",{proposalId:p.id})),b=await caught(()=>api(w,"/execute-callback",{proposalId:p.id}));
 check("sim failure leaves unknown and refuses redispatch",a?.status===503&&b?.status===409&&w.sim.setpoints.length===1&&w.journal.get("command",p.id).status==="unknown");
 check("sim failure is reported to the Plant",w.actors.count("reportDispatchFailure")===1&&w.actors.proposal(p.id).status==="expired");
 const o=await caught(()=>api(w,"/observed",{proposalId:p.id,effects:[]}));
 check("observed is refused for an unknown command",o?.status===409&&w.actors.count("recordEvent")===0);
});
await attempt("bad-ack",async()=>{
 const w=world();await api(w,"/reset",{});const p=await readyToExecute(w);
 w.sim.onSetpoint=()=>({valueApplied:p.to+5});
 const e=await caught(()=>api(w,"/execute-callback",{proposalId:p.id}));
 check("a simulator ack for another value is unknown, reported, and not synced to the actor",e?.status===502&&w.journal.get("command",p.id).status==="unknown"&&w.actors.count("setMetric")===0&&w.actors.count("reportDispatchFailure")===1,`status ${statusOf(e)}`);
});
await attempt("bad-claim",async()=>{
 const w=world();await api(w,"/reset",{});const p=await readyToExecute(w);
 const call=w.actors.call.bind(w.actors);
 w.actors.call=async(kind,id,method,args)=>{const r=await call(kind,id,method,args);return method==="claimDispatch"&&r.dispatch?{...r,value:r.value+5}:r;};
 const e=await caught(()=>api(w,"/execute-callback",{proposalId:p.id}));
 check("a claim that does not match the proposal is refused without dispatch",e?.status===409&&w.sim.setpoints.length===0&&w.actors.count("reportDispatchFailure")===1,`status ${statusOf(e)}`);
});
await attempt("margin-limit",async()=>{
 const w=world();await api(w,"/reset",{});const p=await readyToExecute(w);
 w.actors.components.get("plant-a/P-100").marginPct=50;
 const e=await caught(()=>api(w,"/execute-callback",{proposalId:p.id}));
 check("target past the component's current margin is refused at dispatch",e?.status===409&&w.sim.setpoints.length===0&&w.actors.count("reportDispatchFailure")===1,`status ${statusOf(e)}`);
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
 const votedV={...w2.actors.proposal(v.id)};await api(w2,"/veto",{proposalId:v.id,by:"fake-operator"});await waitVeto(votedV);w2.actors.sweep("plant-a");
 const e4=await caught(()=>api(w2,"/execute-callback",{proposalId:v.id}));
 check("the sweep does not execute a vetoed proposal",w2.actors.proposal(v.id).status==="vetoed"&&w2.actors.callbacks.length===0);
 const late=await (async()=>{const w3=world();await api(w3,"/reset",{});const p=await readyToExecute(w3);return caught(()=>api(w3,"/veto",{proposalId:p.id,by:"fake-operator"}));})();
 check("vetoed proposal rejected",e4?.status===409,`status ${statusOf(e4)}`);
 check("veto after the deadline rejected",late?.status===409,`status ${statusOf(late)}`);
 check("no dispatch or claim on any rejected execute",w.sim.setpoints.length===0&&w2.sim.setpoints.length===0&&w.actors.count("claimDispatch")===0&&w2.actors.count("claimDispatch")===0);
 const blockedExecute=await caught(()=>w.actors.call("Plant","plant-a","execute",[bad.id]));
 check("Plant.execute refuses a blocked proposal",String(blockedExecute?.message).includes("not_approved"),String(blockedExecute?.message));
 const staleSetpoint=await (async()=>{const w5=world();await api(w5,"/reset",{});const a=await newProposal(w5,"plant-a",65),b=await newProposal(w5,"plant-a",70);const voted=await scriptedVotes(w5,a.id);await waitVeto(voted);w5.actors.sweep("plant-a");await scriptedVotes(w5,b.id);return w5.actors.proposal(b.id).status;})();
 check("a proposal overtaken by another execution expires as stale",staleSetpoint==="expired",`status ${staleSetpoint}`);
 const w4=world();await api(w4,"/reset",{});const stale=await readyToExecute(w4);w4.sim.speed["plant-a"]=55;
 const e5=await caught(()=>api(w4,"/execute-callback",{proposalId:stale.id}));
 check("sim drift after approval rejected without dispatch or journal entry",e5?.status===409&&w4.sim.setpoints.length===0&&w4.journal.get("command",stale.id)===undefined,`status ${statusOf(e5)}`);
 check("sim drift is reported to the Plant, which expires the proposal",w4.actors.count("reportDispatchFailure")===1&&w4.actors.proposal(stale.id).status==="expired");
});

section="Bug hunt: reset";
await attempt("id-reuse",async()=>{
 const w=world({ids:"per-seed-counter"});await api(w,"/reset",{});
 const p1=await readyToExecute(w);await api(w,"/execute-callback",{proposalId:p1.id});await api(w,"/observed",{proposalId:p1.id,effects:[]});
 await api(w,"/reset",{});const before=w.sim.setpoints.length;
 const p2=await newProposal(w,"plant-a",65);
 const take2=await scriptedVotes(w,p2.id);
 check("second take after reset: votes count when the actor reuses a proposal id",take2.votes.length===5,`id=${p2.id} reused=${p1.id===p2.id} votes=${take2.votes.length} (relay-inbound journal not cleared)`);
 for(const c of take2.requiredVoters)if(!take2.votes.some((v:any)=>v.componentId===c))await w.actors.call("Plant","plant-a","vote",[vote(c,`agent:${c}`,p2.id,1)]);
 w.actors.sweep("plant-a");await waitVeto(w.actors.proposal(p2.id));w.actors.sweep("plant-a");
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

await attempt("rule-merge",async()=>{
 const w=world();await api(w,"/reset",{});
 await api(w,"/rule",{rule:{...rule,id:"fake-rule-first",scope:"plant"}});
 await api(w,"/rule",{rule:{...rule,id:"fake-rule-second",scope:"plant"}});
 const published=w.pub.published.filter(m=>m.type==="rule").at(-1)?.payload.rule.id,stored=w.actors.plants.get("plant-a").rules.map((r:any)=>r.id);
 check("/rule publishes the rule the actor stored, so cited ids exist",stored.includes(published),`published=${published} stored=${JSON.stringify(stored)}`);
});

section="RELAY_PUBLISH_URL mode (FAKE endpoint, not Relay delivery)";
const publishWorld=async(publishUrl:string)=>{
 const actors=new FakeActors(),sim=new FakeSim(),journal=new Journal(":memory:");
 process.env.RELAY_PUBLISH_URL=publishUrl;
 const bridge=new RelayBridge((path,body)=>live.post(path,body),journal);
 delete process.env.RELAY_PUBLISH_URL;
 const live=new LiveCoordinator(actors,sim,bridge,journal);
 await bridge.start();await live.post("/reset",{});
 return {actors,sim,journal,live,bridge,outbox:()=>journal.list("relay-outbox")};
};
await attempt("publish-url",async()=>{
 const endpoint=fakePublishEndpoint(),w=await publishWorld(endpoint.server.url.href);
 try{
  check("start() in publish mode needs no Relay credentials and reports configured",w.bridge.status.configured&&w.bridge.status.connected);
  const {proposal}:any=await w.live.post("/propose",proposeBody("plant-a",65)),got=endpoint.received[0]?.body;
  check("publish posts {type,payload,channels}",JSON.stringify(Object.keys(got??{}).sort())===JSON.stringify(["channels","payload","type"])&&got.type==="proposal"&&got.payload.proposal.id===proposal.id&&JSON.stringify(got.channels)===JSON.stringify(["plant-a","company"]),JSON.stringify(got)?.slice(0,160));
  check("a delivered publish leaves the outbox empty",w.outbox().length===0);
  check("no bearer header is sent while RELAY_TOKEN is unset",endpoint.received[0]?.authorization===null);
  process.env.RELAY_TOKEN="FAKE-relay-token";
  await w.bridge.publish("rule",{rule:{id:"fake-bearer"}},["company"]);
  delete process.env.RELAY_TOKEN;
  check("RELAY_TOKEN is sent as a bearer",endpoint.received.at(-1)?.authorization==="Bearer FAKE-relay-token");
  await w.bridge.publish("rule",{rule:{id:"fake-channels"}},["company","not-a-channel"]);
  check("channels outside the Relay set are dropped",JSON.stringify(endpoint.received.at(-1)!.body.channels)===JSON.stringify(["company"]));

  endpoint.status=500;const before=endpoint.received.length,proposes=w.actors.count("propose");
  const failed=await caught(()=>w.live.post("/propose",proposeBody("plant-a",70)));
  check("failed publish reports 502 accepted:true and stays queued",failed?.status===502&&failed.details?.accepted===true&&w.outbox().length===1&&w.outbox()[0]!.value.type==="proposal",`status ${statusOf(failed)} outbox=${w.outbox().length}`);
  const stillDown=await caught(()=>w.bridge.flush());
  check("flush while the endpoint is down keeps the message and records the error",!stillDown&&w.outbox().length===1&&/Relay publish returned 500/.test(w.bridge.status.error??""),`error ${w.bridge.status.error} outbox=${w.outbox().length}`);
  endpoint.status=200;await w.bridge.flush();
  const sent=endpoint.received.slice(before);
  check("flush delivers the queued message once and empties the outbox, with no new proposal",sent.length===1&&sent[0]!.body.payload.proposal.id===failed?.details?.proposal?.id&&w.outbox().length===0&&w.actors.count("propose")===proposes+1,`sent=${sent.length} outbox=${w.outbox().length}`);
  await w.bridge.flush();
  check("a second flush sends nothing",endpoint.received.length===before+1);

  endpoint.rejectType="fake-poison";
  await caught(()=>w.bridge.publish("fake-poison",{id:"a"},["company"]));
  endpoint.status=500;await caught(()=>w.bridge.publish("fake-z-later",{id:"b"},["company"]));endpoint.status=200;
  await caught(()=>w.bridge.flush());
  check("one message the endpoint keeps rejecting does not block later ones in flush",endpoint.received.some(r=>r.body.type==="fake-z-later"),`outbox=${JSON.stringify(w.outbox().map(e=>e.id))}`);
 }finally{endpoint.server.stop(true);}
 const down=await caught(()=>w.bridge.publish("rule",{rule:{id:"fake-unreachable"}},["company"]));
 check("an unreachable endpoint also leaves the message queued",down!==null&&w.outbox().some(e=>e.id==="rule:fake-unreachable"),String(down));
});

section="Contract probe";
await attempt("literal",async()=>{
 const w=world({similar:"contract-literal"});await api(w,"/reset",{});
 const p=await readyToExecute(w);await api(w,"/execute-callback",{proposalId:p.id});await api(w,"/tick",{});
 await api(w,"/observed",{proposalId:p.id,effects:[{componentId:"plant-a/LV-101",metric:"positionPct",before:50,after:66.5,ticksToSettle:3}]});
 const again=await newProposal(w,"plant-a",85),blocked=await scriptedVotes(w,again.id),lv=voteOf(blocked,"LV-101");
 check("similar() ranked literally per CLAUDE.md still returns the new event first",lv.evidenceEventIds[0]===`event-${p.id}`,`evidence=${JSON.stringify(lv.evidenceEventIds)}`);
});

await attempt("nearest",async()=>{
 const w=world({similar:"nearest-only"});await api(w,"/reset",{});
 const p=await readyToExecute(w);await api(w,"/execute-callback",{proposalId:p.id});await api(w,"/tick",{});
 await api(w,"/observed",{proposalId:p.id,effects:[]});
 const again=await newProposal(w,"plant-a",85),blocked=await scriptedVotes(w,again.id),lv=voteOf(blocked,"LV-101");
 check("similar() ranked by nearest `after` alone, k=5, retrieves the new event at all",lv.evidenceEventIds.includes(`event-${p.id}`),`evidence=${JSON.stringify(lv.evidenceEventIds)}`);
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
 for(const k of ["ACTOR_API_URL","ACTOR_API_TOKEN","RELAY_WORKSPACE_KEY","RELAY_AGENT_TOKEN","RELAY_PUBLISH_URL","RELAY_TOKEN","BRIDGE_PUSHES_MIRROR"])delete process.env[k];
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
 // Approves through the FAKE actor port directly, because /propose needs Relay and that is checked below.
 const actors:FakeActors=(globalThis as any).__fakeHarnessActors;
 const accepted=async(to:number)=>{const p=await actors.call("Plant","plant-a","propose",[proposeBody("plant-a",to)]);for(const c of p.requiredVoters)await actors.call("Plant","plant-a","vote",[vote(c,`agent:${c}`,p.id,1)]);actors.sweep("plant-a");await waitVeto(actors.proposal(p.id));actors.sweep("plant-a");return p.id as string;};
 const noToken=await accepted(65);
 delete process.env.EXECUTION_CALLBACK_TOKEN;
 const open=await call("/execute-callback",{proposalId:noToken});
 process.env.EXECUTION_CALLBACK_TOKEN="FAKE-harness-only";
 check("execute-callback with no bearer succeeds when EXECUTION_CALLBACK_TOKEN is unset, as the actor sends it",open.status===200&&sim.setpoints.length===1&&sim.setpoints[0].value===65,`status ${open.status} setpoints=${sim.setpoints.length}`);
 const guarded=await accepted(70);
 const wrong=await call("/execute-callback",{proposalId:guarded},{authorization:"Bearer FAKE-wrong"}),none=await call("/execute-callback",{proposalId:guarded});
 check("execute-callback with a wrong or missing bearer fails when the token is set, with no dispatch",wrong.status===401&&none.status===401&&sim.setpoints.length===1,`wrong ${wrong.status}, none ${none.status}, setpoints=${sim.setpoints.length}`);
 const right=await call("/execute-callback",{proposalId:guarded},{authorization:"Bearer FAKE-harness-only"});
 check("execute-callback with the right bearer dispatches",right.status===200&&sim.setpoints.length===2,`status ${right.status} setpoints=${sim.setpoints.length}`);
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

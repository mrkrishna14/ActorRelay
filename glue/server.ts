import {z} from "zod";
import {schemas,plantId} from "./schemas";
import {ActorAdapter,ApiError} from "./actors";
import {MockStore} from "./mock";
import {RelayBridge} from "./relay";
import {Journal} from "./journal";
import {SimulationAdapter} from "./simulation";
import {LiveCoordinator,startMirrorDriver} from "./live";
const mode=process.env.GLUE_MODE??"mock";
if(!["mock","live"].includes(mode))throw new Error("GLUE_MODE must be mock or live");
const mock=new MockStore(),actors=new ActorAdapter();
let coordinator:LiveCoordinator;
const journal=new Journal();
const relay=new RelayBridge((path,body)=>coordinator.post(path,body),journal);
const simulation=new SimulationAdapter();
coordinator=new LiveCoordinator(actors,simulation,relay,journal);
const bridgePushes=["1","true"].includes(process.env.BRIDGE_PUSHES_MIRROR??"");
const integrations=async()=>({actors:mode==="live"&&!!(process.env.ACTOR_API_URL||process.env.ACTOR_CLIENT_MODULE),relay:mode==="live"&&relay.status.connected,simulation:mode==="live"&&await simulation.reachable()});
export async function startIntegrations(){if(mode==="live")await relay.start();}

const cors={"access-control-allow-origin":process.env.CORS_ORIGIN??"http://localhost:3000","access-control-allow-methods":"GET, POST, OPTIONS","access-control-allow-headers":"Content-Type, Authorization","vary":"Origin"};
export async function handle(req:Request):Promise<Response>{
 const origin=req.headers.get("origin");
 const allowed=process.env.CORS_ORIGIN?[process.env.CORS_ORIGIN]:["http://localhost:3000","http://127.0.0.1:3000"];
 const responseOrigin=origin&&allowed.includes(origin)?origin:allowed[0];
 const headers={...cors,"access-control-allow-origin":responseOrigin};
 const json=(value:any,status=200)=>Response.json(value,{status,headers});
 try{
 const u=new URL(req.url),path=u.pathname;
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:{...cors,"access-control-allow-origin":responseOrigin}});
 if(path==="/health")return json({ok:true,mode,capabilityNote:"actors means configured, not verified. relay means connected. simulation means the snapshot probe answered within the last few seconds.",integrations:await integrations(),simulationUrl:mode==="live"?simulation.base:undefined,mirrorDriver:mode==="live"?(bridgePushes?"bridge":"glue"):undefined,relayStatus:mode==="live"?relay.status:undefined,...(mode==="mock"?{mockNotice:"Mock fixtures only; no live reasoning or physics"}:{})});
 if(req.method==="GET"){
  if(mode==="live"){if(path==="/state"){plantId.parse(u.searchParams.get("plantId")??"plant-a");return json({...await coordinator.get(path,u),integrations:await integrations()});}return json(await coordinator.get(path,u));}
  if(path==="/state"){const id=plantId.parse(u.searchParams.get("plantId")??"plant-a");return json(mock.state(id));}
  if(path.startsWith("/component/")){const id=decodeURIComponent(path.slice(11));return json(mock.component(id));}
  if(path==="/similar"){const id=z.string().min(1).parse(u.searchParams.get("componentId"));const metric=z.string().min(1).parse(u.searchParams.get("metric"));const to=z.coerce.number().finite().parse(z.string().min(1).parse(u.searchParams.get("to")));const k=z.coerce.number().int().min(1).max(100).parse(u.searchParams.get("k")??5);const c=mock.component(id);return json(mock.plants[c.plantId].history.filter((e:any)=>e.componentId===id&&e.metric===metric).sort((a:any,b:any)=>Math.abs(a.after-to)-Math.abs(b.after-to)).slice(0,k));}
  if(path==="/rules")return json(mock.company.rules);
  throw new ApiError(404,"Unknown route");
 }
 if(req.method!=="POST")throw new ApiError(405,"Method not allowed");
 const schema=schemas[path];if(!schema)throw new ApiError(404,"Unknown route");
 let raw;try{raw=await req.json();}catch{throw new ApiError(400,"Malformed JSON body");}const b:any=schema.parse(raw);
 if(mode==="live"){
  // The Plant actor's claim is the authority for a write, and its callback sends no bearer. A configured token is still enforced.
  if(path==="/execute-callback"&&process.env.EXECUTION_CALLBACK_TOKEN&&req.headers.get("authorization")!==`Bearer ${process.env.EXECUTION_CALLBACK_TOKEN}`)throw new ApiError(401,"Execution callback token rejected");
  if(["/propose","/counter","/observed","/rule"].includes(path)&&!relay.status.configured)throw new ApiError(503,"Relay participant is not configured");
  if(path==="/tick"&&bridgePushes)return json({ok:true,mirrored:0,mirrorDriver:"bridge"});
  return json(await coordinator.post(path,b));
 }
 switch(path){
  case "/reset":mock.reset();return json({ok:true,mode});
  case "/tick":return json({ok:true,mode});
  case "/propose":return json({proposal:mock.propose(b),mode});
  case "/counter":{const parent=mock.find(b.parentProposalId);if(parent.status!=="blocked")throw new ApiError(409,"Parent must be blocked");if(b.proposal.proposerComponentId!==parent.proposerComponentId)throw new ApiError(400,"Counter must match proposer");return json({proposal:mock.propose(b.proposal,b.parentProposalId),mode});}
  case "/vote":return json({proposal:mock.vote(b.vote),mode});
  case "/veto":{const p=mock.find(b.proposalId);if(p.status!=="veto_window"||Date.now()>=Date.parse(p.vetoDeadline))throw new ApiError(409,"Veto window is not open");p.status="vetoed";mock.audit(p.plantId,"veto",p.id,`Vetoed by ${b.by}`);return json({proposal:p,mode});}
  case "/execute-callback":return json({...mock.execute(b.proposalId),mode});
  case "/mirror":{const c=mock.component(b.componentId);c.metrics={...c.metrics,...b.metrics};c.lastTick=new Date().toISOString();return json({component:c,mode});}
  case "/observed":{const p=mock.find(b.proposalId);if(p.status!=="executed")throw new ApiError(409,"Proposal has not executed");return json({ok:true,mode,notice:"Mock observations are fixture-only"});}
  case "/calibration":{mock.component(b.componentId).calibration.push(b.entry);return json({ok:true,mode});}
  case "/rule":{if(!mock.company.rules.some((r:any)=>r.id===b.rule.id))mock.company.rules.push(b.rule);return json({rule:b.rule,mode});}
 }
 throw new ApiError(404,"Unknown route");
}catch(e){if(e instanceof z.ZodError)return json({error:"Validation failed",issues:e.issues},400);if(e instanceof ApiError)return json({error:e.message,details:e.details},e.status);console.error(e);return json({error:"Internal server error"},500);}}
if(import.meta.main){if(mode==="live"){startIntegrations().catch(error=>console.error("Relay startup failed:",String(error)));setInterval(()=>relay.flush().catch(error=>console.error("Relay outbox retry failed:",String(error))),5000);setInterval(()=>relay.backfill().catch(error=>console.error("Relay backfill failed:",String(error))),15000);if(!bridgePushes){const tickMs=Number(process.env.GLUE_TICK_MS??1000);if(!(tickMs>=100))throw new Error("GLUE_TICK_MS must be at least 100");startMirrorDriver(()=>coordinator.post("/tick",{}),tickMs);}}const server=Bun.serve({port:Number(process.env.PORT??7200),hostname:process.env.HOST??"127.0.0.1",fetch:handle});console.log(`ActorRelay glue ${mode} on ${server.url}${mode==="mock"?" — MOCK FIXTURES ONLY":""}`);}

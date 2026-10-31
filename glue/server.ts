import {z} from "zod";
import {schemas,plantId} from "./schemas";
import {ActorAdapter,ApiError} from "./actors";
import {MockStore} from "./mock";
import {publish} from "./relay";
const mode=process.env.GLUE_MODE??"mock";
if(!["mock","live"].includes(mode))throw new Error("GLUE_MODE must be mock or live");
const mock=new MockStore(),actors=new ActorAdapter();
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
 if(path==="/health")return json({ok:true,mode,capabilityNote:"Integration flags indicate configuration, not verified upstream readiness",integrations:{actors:mode==="live"&&!!process.env.ACTOR_API_URL,relay:mode==="live"&&!!process.env.RELAY_PUBLISH_URL,simulation:mode==="live"&&!!process.env.SIM_URL},...(mode==="mock"?{mockNotice:"Mock fixtures only; no live reasoning or physics"}:{})});
 if(req.method==="GET"){
  if(path==="/state"){const id=plantId.parse(u.searchParams.get("plantId")??"plant-a");return json(mode==="mock"?mock.state(id):{...await actors.request(path+u.search),mode:"live"});}
  if(path.startsWith("/component/")){const id=decodeURIComponent(path.slice(11));return json(mode==="mock"?mock.component(id):await actors.request(path));}
  if(path==="/similar"){const id=z.string().min(1).parse(u.searchParams.get("componentId"));const metric=z.string().min(1).parse(u.searchParams.get("metric"));const to=z.coerce.number().finite().parse(z.string().min(1).parse(u.searchParams.get("to")));const k=z.coerce.number().int().min(1).max(100).parse(u.searchParams.get("k")??5);if(mode==="live")return json(await actors.request(path+u.search));const c=mock.component(id);return json(mock.plants[c.plantId].history.filter((e:any)=>e.componentId===id&&e.metric===metric).sort((a:any,b:any)=>Math.abs(a.after-to)-Math.abs(b.after-to)).slice(0,k));}
  if(path==="/rules")return json(mode==="mock"?mock.company.rules:await actors.request(path+u.search));
  throw new ApiError(404,"Unknown route");
 }
 if(req.method!=="POST")throw new ApiError(405,"Method not allowed");
 const schema=schemas[path];if(!schema)throw new ApiError(404,"Unknown route");
 let raw;try{raw=await req.json();}catch{throw new ApiError(400,"Malformed JSON body");}const b:any=schema.parse(raw);
 if(mode==="live"){
  // Actor adapter owns validation, authorization, execution tokens and durable outbox.
  // Never write directly to the simulator from a public callback.
  if(["/propose","/counter","/observed","/rule"].includes(path)&&!process.env.RELAY_PUBLISH_URL)throw new ApiError(503,"Relay system participant is not configured");
  const result=await actors.request(path,"POST",b);
  const event=path==="/propose"||path==="/counter"?"proposal":path==="/observed"?"executed":path==="/rule"?"rule":null;
  if(event){const p=result.proposal??result;try{await publish(event,result,[p.plantId??"company",...(p.crossPlant?["company"]:[])]);}catch(e){throw new ApiError(502,"Actor mutation accepted but Relay publication failed; reconcile before retrying",{accepted:true,result,cause:String(e)});}}
  return json(result);
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
if(import.meta.main){const server=Bun.serve({port:Number(process.env.PORT??7200),hostname:process.env.HOST??"127.0.0.1",fetch:handle});console.log(`ActorRelay glue ${mode} on ${server.url}${mode==="mock"?" — MOCK FIXTURES ONLY":""}`);}

import { RelaycastMessagingClient, type RelayMessagingClient, type RelayMessage } from "@agent-relay/sdk";
import {ApiError} from "./actors";
import {Journal} from "./journal";
import {schemas} from "./schemas";
const channels=["plant-a","plant-b","company"];
type Dispatch=(path:string,body:any,sender:string)=>Promise<unknown>;
export class RelayBridge {
 private client?:RelayMessagingClient;
 private name=process.env.RELAY_SYSTEM_NAME??"actorrelay-system";
 private inflight=new Set<string>();
 private journal:Journal;
 status:{configured:boolean,connected:boolean,error:string|null}={configured:false,connected:false,error:null};
 constructor(private dispatch:Dispatch,journal?:Journal,private factory:(opts:any)=>RelayMessagingClient=(opts)=>new RelaycastMessagingClient(opts)){this.journal=journal??new Journal();}
 async start(){
  const token=process.env.RELAY_AGENT_TOKEN??this.journal.get<string>("credential","relay-agent-token"),workspaceKey=process.env.RELAY_WORKSPACE_KEY;
  this.status.configured=!!(token||workspaceKey);
  if(!this.status.configured)throw new ApiError(503,"Relay requires RELAY_WORKSPACE_KEY for registration or RELAY_AGENT_TOKEN to reconnect");
  try{
   const baseUrl=process.env.RELAY_BASE_URL;
   let agentToken=token;
   if(!agentToken){const workspace=this.factory({workspaceKey,baseUrl});const registration=await workspace.agents.register({name:this.name,type:"agent",persona:"ActorRelay integration system participant"});agentToken=registration.token;this.journal.set("credential","relay-agent-token",agentToken);}
   this.client=this.factory({workspaceKey,agentToken,baseUrl});
   const me=await this.client.agents.me();this.name=me.name;
   for(const channel of channels){try{await this.client.channels.get(channel);}catch(e){if((e as any).status===404||(e as any).statusCode===404||(e as any).code==="not_found")await this.client.channels.create({name:channel});else throw e;}await this.client.channels.join(channel);}
   this.client.events.on("connected",()=>{this.status.connected=true;this.status.error=null;void this.backfill().catch(e=>{this.status.error=String(e);});});
   this.client.events.on("disconnected",()=>{this.status.connected=false;});
   this.client.events.on("error",()=>{this.status.error="Relay event connection error";});
   for(const event of ["messageCreated","threadReply"] as const)this.client.events.on(event,async e=>{try{await this.receive(e.message);}catch(error){this.status.error=String(error);console.error("Relay inbound rejected:",String(error));}});
   this.client.events.connect();this.client.events.subscribe(channels);
   await this.backfill();
  }catch(error){this.status.error=String(error);throw error;}
 }
 async backfill(){if(!this.client)return;for(const channel of channels){const messages=await this.client.messages.list(channel,{limit:100});for(const message of [...messages].reverse())await this.receive(message);}}
 async receive(message:RelayMessage){
  const sender=message.from.name;if(!sender||sender===this.name)return;
  let envelope:any;try{envelope=JSON.parse(message.text);}catch{return;}
  const path=({vote:"/vote",counter:"/counter",calibration:"/calibration",rule:"/rule"} as Record<string,string>)[envelope.type];if(!path)return;
  const raw=envelope.payload??envelope;
  const body=schemas[path].parse(raw);
  // Sender identity comes from authenticated Relay transport, never the envelope.
  const value:any=body;
  const claimed=path==="/vote"?value.vote.agentId:path==="/counter"?`agent:${value.proposal.proposerComponentId}`:path==="/calibration"?`agent:${value.componentId}`:path==="/rule"&&value.rule.condition.componentId?`agent:${value.rule.condition.componentId}`:null;
  if(!claimed||sender!==claimed)throw new ApiError(403,"Relay sender is not authorized for this component action");
  const key=path==="/vote"?`${value.vote.proposalId}:${value.vote.componentId}`:message.id;
  if(this.journal.get("relay-inbound",key)||this.inflight.has(key))return;
  this.inflight.add(key);
  try{await this.dispatch(path,body,sender);this.journal.set("relay-inbound",key,{messageId:message.id,processedAt:new Date().toISOString()});}finally{this.inflight.delete(key);}
 }
 async publish(type:string,payload:any,targetChannels:string[]){
  const entity=payload.proposal??payload.event??payload.rule??payload;
  const key=`${type}:${entity.id??payload.proposalId??crypto.randomUUID()}`;
  const record={type,payload,channels:[...new Set(targetChannels)].filter(c=>channels.includes(c))};
  // Queue before the client check so a change accepted while Relay is down is still delivered by flush().
  this.journal.set("relay-outbox",key,record);
  if(!this.client)throw new ApiError(503,"Relay participant has not initialized");
  await this.sendOutbox(key,record);
 }
 private async sendOutbox(key:string,record:any){if(!this.client)throw new ApiError(503,"Relay unavailable");for(const channel of record.channels)await this.client.messages.send({channel,text:JSON.stringify({type:record.type,payload:record.payload}),idempotencyKey:`${key}:${channel}`});this.journal.remove("relay-outbox",key);}
 async flush(){if(!this.client)return;for(const entry of this.journal.list("relay-outbox"))await this.sendOutbox(entry.id,entry.value);}
 async stop(){await this.client?.events.disconnect();this.status.connected=false;}
}

import {pathToFileURL} from "node:url";
export class ApiError extends Error { constructor(public status:number,message:string,public details?:unknown){super(message);} }
export type ActorKind="Component"|"Plant"|"Company";
export interface ActorPort {read(kind:ActorKind,id:string):Promise<any>;call(kind:ActorKind,id:string,method:string,args:unknown[]):Promise<any>;}
export class ActorAdapter implements ActorPort {
 private module?:Promise<ActorPort>;
 constructor(private base=process.env.ACTOR_API_URL,private token=process.env.ACTOR_API_TOKEN,private modulePath=process.env.ACTOR_CLIENT_MODULE){}
 private async client(){if(!this.modulePath)return;this.module??=import(pathToFileURL(this.modulePath).href).then(async m=>{const value=m.createActorPort?await m.createActorPort():m.default;if(!value?.read||!value?.call)throw new ApiError(503,"Actor client module must export createActorPort() or default {read,call}");return value;});return this.module;}
 async read(kind:ActorKind,id:string){const client=await this.client();return client?client.read(kind,id):this.rpc({operation:"read",kind,id});}
 async call(kind:ActorKind,id:string,method:string,args:unknown[]){const client=await this.client();return client?client.call(kind,id,method,args):this.rpc({operation:"call",kind,id,method,args});}
 private async rpc(body:any){if(!this.base)throw new ApiError(503,"Actor client unavailable: configure ACTOR_CLIENT_MODULE or ACTOR_API_URL");try{const r=await fetch(new URL("/rpc",this.base),{method:"POST",headers:{"content-type":"application/json",...(this.token?{authorization:`Bearer ${this.token}`}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});const data=await r.json();if(!r.ok)throw new ApiError(r.status>=500?503:r.status,data.error??"Actor request failed");return data.result??data;}catch(e){if(e instanceof ApiError)throw e;throw new ApiError(503,"Actor transport unreachable",String(e));}}
}

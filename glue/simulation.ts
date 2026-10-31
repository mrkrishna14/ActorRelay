import {z} from "zod";
import {ApiError} from "./actors";
import {metrics} from "./schemas";
export interface SimulationPort {snapshot(plantId:string):Promise<Record<string,Record<string,number>>>;reset():Promise<unknown>;setpoint(command:{componentId:string;metric:string;value:number;proposalId:string;commandId:string}):Promise<any>;}
export class SimulationAdapter implements SimulationPort {
 private probed={at:0,reachable:false};
 constructor(readonly base=process.env.SIM_URL??"http://127.0.0.1:7300"){}
 /** Short, cached reachability check, so /state polling does not add load or latency. */
 async reachable(){if(Date.now()-this.probed.at<2000)return this.probed.reachable;let reachable=false;try{reachable=(await fetch(new URL("/snapshot?plantId=plant-a",this.base),{signal:AbortSignal.timeout(1000)})).ok;}catch{}this.probed={at:Date.now(),reachable};return reachable;}
 private async request(path:string,body?:unknown){try{const r=await fetch(new URL(path,this.base),{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});const value=await r.json();if(!r.ok)throw new ApiError(r.status>=500?503:r.status,value.error??"Simulation rejected request");return value;}catch(e){if(e instanceof ApiError)throw e;throw new ApiError(503,"Simulation transport unavailable",String(e));}}
 async snapshot(plantId:string){const value=await this.request(`/snapshot?plantId=${encodeURIComponent(plantId)}`);const parsed=z.record(z.string(),metrics).parse(value);for(const id of Object.keys(parsed))if(!id.startsWith(plantId+"/"))throw new ApiError(502,"Simulation returned component from wrong plant");return parsed;}
 async reset(){return this.request("/reset",{});}
 async setpoint(command:{componentId:string;metric:string;value:number;proposalId:string;commandId:string}){return this.request("/setpoint",command);}
}

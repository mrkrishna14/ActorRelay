import {ApiError} from "./actors";
// Transport boundary. Person 1's system participant may expose this endpoint;
// this is not a replacement for registering/joining with the Relay SDK.
export async function publish(type:string,payload:any,channels:string[]){
 const url=process.env.RELAY_PUBLISH_URL;
 if(!url)throw new ApiError(503,"Relay publishing unavailable: configure RELAY_PUBLISH_URL for the system participant.");
 const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json",...(process.env.RELAY_TOKEN?{authorization:`Bearer ${process.env.RELAY_TOKEN}`}:{})},body:JSON.stringify({type,payload,channels}),signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw new ApiError(503,"Relay transport rejected publication");
}

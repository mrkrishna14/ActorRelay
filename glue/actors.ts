export class ApiError extends Error { constructor(public status:number,message:string,public details?:unknown){super(message);} }
export class ActorAdapter {
 constructor(private base=process.env.ACTOR_API_URL,private token=process.env.ACTOR_API_TOKEN){}
 async request(path:string,method="GET",body?:unknown):Promise<any>{
  if(!this.base) throw new ApiError(503,"Actor integration unavailable: configure ACTOR_API_URL after Person 1 provides the HTTP adapter.");
  try {
   const r=await fetch(new URL(path,this.base),{method,headers:{"content-type":"application/json",...(this.token?{authorization:`Bearer ${this.token}`}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
   const data=await r.json().catch(()=>({error:"Non-JSON actor response"}));
   if(!r.ok) throw new ApiError(r.status>=500?503:r.status,data.error??"Actor request failed",data);
   return data;
  }catch(e){if(e instanceof ApiError)throw e;throw new ApiError(503,"Actor service unreachable",String(e));}
 }
}

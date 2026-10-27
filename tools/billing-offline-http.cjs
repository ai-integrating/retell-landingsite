// Offline-only: real loopback HTTP, actual backend handler, file-backed isolated
// KV and provider fixtures. No provider transport or environment credentials.
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),http=require("node:http");
const {createRequire}=require("node:module");
function start({directory,secret,phone,resource,loseFirstReply=false,runId="offline-run",cleanupResources=[]}){
 if(secret.length<32||!fs.existsSync(path.join(directory,"TEST_ONLY")))throw Error("ISOLATION_REQUIRED");
 const file=path.join(directory,"state.json");
 if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify({kv:{
 [`billing:test:resource:${resource.key}`]:resource,
 [`agent:${resource.agentId}:client`]:resource.configClientId},phone,writes:0,lost:false,
 runId,cleanupResources,removed:[],evidenceRetained:false}));
 const read=()=>JSON.parse(fs.readFileSync(file,"utf8"));
 const save=s=>{fs.writeFileSync(file+".tmp",JSON.stringify(s));fs.renameSync(file+".tmp",file);};
 const kv={
 get:async k=>{const s=read();const v=s.kv[k];if(v?.__lease)return v.until>Date.now()?v.value:null;return v;},
 set:async(k,v,o)=>{const s=read(),old=s.kv[k];
 if(o?.nx&&old&&(!old.__lease||old.until>Date.now()))return null;
 s.kv[k]=o?.ex?{__lease:true,value:v,until:Date.now()+o.ex*1000}:v;save(s);return "OK";},
 eval:async(_s,keys,args)=>{const s=read();if(s.kv[keys[0]]?.value===args[0])delete s.kv[keys[0]];save(s);}
 };
 const axios={
 get:async url=>{if(url!==`https://api.retellai.com/get-phone-number/${encodeURIComponent(resource.target)}`)throw Error("NETWORK_SCOPE");
 return {data:read().phone};},
 patch:async(url,data)=>{
 if(url!==`https://api.retellai.com/update-phone-number/${encodeURIComponent(resource.target)}`)throw Error("NETWORK_SCOPE");
 if(Object.keys(data).some(k=>!["inbound_agents","outbound_agents"].includes(k)))throw Error("PATCH_SCOPE");
 const s=read();Object.assign(s.phone,data);s.writes++;
 const lose=loseFirstReply&&!s.lost;if(lose)s.lost=true;save(s);
 if(lose)throw Error("SIMULATED_LOST_PROVIDER_REPLY");return {data:s.phone};
 }};
 const base=path.resolve(__dirname,"../api/billing-service-control.js"),req=createRequire(base);
 const sandbox={module:{exports:{}},Buffer,process:{env:{BILLING_SERVICE_SECRET:secret,RETELL_API_KEY:"offline-fixture"}},
 require:n=>n==="axios"?axios:n==="@vercel/kv"?{kv}:n==="../lib/billing-cancellation"?
 {...req(n),ENABLED:true}:req(n)};
 vm.runInNewContext(fs.readFileSync(base,"utf8"),sandbox,{filename:base});
 const server=http.createServer(async(req,res)=>{
 let text="";for await(const chunk of req){text+=chunk;if(text.length>16000){res.writeHead(413);return res.end();}}
 try{req.body=text?JSON.parse(text):{};}catch{res.writeHead(400);return res.end();}
 res.status=code=>{res.statusCode=code;return res;};res.json=value=>res.end(JSON.stringify(value));
 try{await sandbox.module.exports(req,res);}catch{res.status(500).json({error:"OFFLINE_HANDLER_FAILED"});}
 });
 return new Promise(resolve=>server.listen(0,"127.0.0.1",()=>resolve({
 url:`http://127.0.0.1:${server.address().port}`,read,
 cleanupIO:{
 now:()=>Math.floor(Date.now()/1000),
 assertIdle:async()=>{if(Object.values(read().kv).some(v=>v&&v.__lease&&v.until>Date.now()))throw Error("TEST_LEASE_ACTIVE");},
 inventoryHash:async id=>{
 const s=read();if(id!==s.runId)throw Error("RUN_SCOPE");
 return req("../lib/billing-cancellation").hash(s.cleanupResources);},
 retainEvidence:async()=>{const s=read();fs.writeFileSync(path.join(directory,"evidence.json"),JSON.stringify(s));
 s.evidenceRetained=true;save(s);},
 exists:async r=>{const s=read();if(!s.cleanupResources.some(x=>x.id===r.id&&x.kind===r.kind))throw Error("RESOURCE_SCOPE");
 return !s.removed.includes(r.kind+":"+r.id);},
 remove:async r=>{const s=read();if(!s.evidenceRetained||
 !s.cleanupResources.some(x=>x.id===r.id&&x.kind===r.kind))throw Error("CLEANUP_SCOPE");
 s.removed.push(r.kind+":"+r.id);save(s);},
 recordRemoval:async()=>{},
 },
 close:()=>new Promise(r=>server.close(r))
 })));
}
module.exports={start};

const {test}=require("node:test"),assert=require("node:assert/strict"),vm=require("node:vm"),fs=require("node:fs");
const {operation,hash}=require("../lib/billing-cancellation");
const policy=require("../lib/billing-live-policy");
test("live resources are disabled and no customer is approved",()=>{
 assert.equal(policy.LIVE_ENABLED,false);assert.deepEqual(policy.APPROVED_RESOURCES,[]);
});
test("live admission survives disabled gates, empty approvals and processing pause; storage failure closes admission",async()=>{
 const holds=new Map();let failure=false;
 const context={module:{exports:{}},process:{env:{BILLING_CANCELLATION_PAUSED:"true"}},
 require:n=>n==="@vercel/kv"?{kv:{get:async k=>{if(failure)throw Error("STORAGE_UNAVAILABLE");return holds.get(k);}}}:require(n)};
 vm.runInNewContext(fs.readFileSync(require.resolve("../lib/billing-cancellation"),"utf8"),context);
 const admit=context.module.exports.assertAllowed;
 for(const kind of ["booking","outbound","phone_inbound","phone_outbound","phone_writes","agent_routes"]){
  holds.set(`billing:live:hold:${kind}:suspended`,{intentId:"retained"});
  await assert.rejects(admit(kind,"suspended"),/BILLING_SERVICE_SUSPENDED/);
  await admit(kind,"unheld-shared");
 }
 failure=true;await assert.rejects(admit("booking","unheld-shared"),/STORAGE_UNAVAILABLE/);
 await assert.rejects(admit("outbound","unheld-shared"),/STORAGE_UNAVAILABLE/);
 assert.equal(holds.size,6);
});
test("live namespace recovers lost routing response, retains number and rejects changed ownership",async()=>{
 const route=[{agent_id:"synthetic",agent_version:0,weight:1}];
 const r={key:"voice",clientId:900009,testOnly:false,numberPolicy:"retain_disconnected",
 bindingIds:["binding"],ownershipHash:"reviewed",agentId:"synthetic",configClientId:"synthetic",
 kind:"phone_inbound",target:"+15550001111",reviewedRoute:route,routeHash:hash(route),otherRouteHash:hash(route)};
 policy.APPROVED_RESOURCES.push({key:r.key,clientId:r.clientId,registryHash:policy.digest(r)});
 try{
 const kv=new Map([["billing:live:resource:voice",r],["agent:synthetic:client","synthetic"]]);
 let phone={phone_number:r.target,inbound_agents:route,outbound_agents:route},writes=0;
 const io={now:()=>100,get:async k=>kv.get(k),set:async(k,v)=>kv.set(k,v),
 phone:async()=>phone,patchPhone:async(n,p)=>{assert.equal(n,r.target);writes++;phone={...phone,...p};throw Error("LOST_REPLY");}};
 const body={key:"voice",action:"suspend",clientId:r.clientId,bindingId:"binding",ownershipHash:r.ownershipHash,
 intent:{id:"intent",action:"suspend",clientId:r.clientId,bindingId:"binding",serviceKeys:["voice"],effectiveAt:1}};
 const scope={namespace:"live",approved:policy.approved};
 await assert.rejects(operation(io,body,scope),/LOST_REPLY/);
 assert.equal((await operation(io,body,scope)).state,"suspended");
 await operation(io,body,scope);assert.equal(writes,1);
 assert.deepEqual(phone.outbound_agents,route);assert.equal(phone.phone_number,r.target);
 assert.ok(kv.has("billing:live:journal:intent:"+hash("voice")));
 assert.equal([...kv.keys()].some(k=>k.startsWith("billing:test")),false);
 kv.set("billing:live:resource:voice",{...r,agentId:"changed"});
 await assert.rejects(operation(io,body,scope),/OWNERSHIP_CHANGED/);
 }finally{policy.APPROVED_RESOURCES.length=0;}
});
test("live HTTP endpoint checks auth, disabled gate and allowlist before any external write",async()=>{
 let enabled=false,reads=0;
 const sandbox={module:{exports:{}},Buffer,process:{env:{BILLING_LIVE_SERVICE_SECRET:"synthetic"}},require:n=>{
 if(n==="@vercel/kv")return {kv:{get:async()=>{reads++;return null;}}};
 if(n==="axios")return {patch:()=>assert.fail("external write"),get:()=>assert.fail("provider read")};
 if(n==="../lib/billing-live-policy")return {LIVE_ENABLED:enabled,approved:()=>false};
 return require(n);}};
 const call=async(headers)=>{
 const context={...sandbox,module:{exports:{}}};
 vm.runInNewContext(fs.readFileSync(require.resolve("../api/billing-live-service-control"),"utf8"),context);
 const res={status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
 await context.module.exports({headers,method:"POST",body:{key:"voice",bindingId:"b",clientId:900009,action:"suspend"}},res);
 return res.code;};
 assert.equal(await call({}),401);assert.equal(await call({authorization:"Bearer wrong"}),401);
 assert.equal(await call({authorization:"Bearer synthetic"}),503);assert.equal(reads,0);
 enabled=true;assert.equal(await call({authorization:"Bearer synthetic"}),403);
});

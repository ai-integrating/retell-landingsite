const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {command,sign,decodeProviderResponse}=require("../tools/billing-live-cli.cjs");
test("live CLI is auth gated; isolated full flow and expired-execution cleanup use only test IDs",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"billing-cli-"));
 const oldKey=process.env.RETELL_API_KEY,oldPhone=process.env.RETELL_TEST_CONSENTING_PHONE;
 process.env.RETELL_API_KEY="offline";process.env.RETELL_TEST_CONSENTING_PHONE="+15550002222";
 const resources={},calls=[],writes=[];let now=1000,lostPublish=false,lostDelete=false;
 const fetcher=async(url,opt)=>{
 const u=new URL(url),p=decodeURIComponent(u.pathname),body=opt.body?JSON.parse(opt.body):null;
 assert.equal(u.origin,"https://api.retellai.com");
 if(opt.method==="POST"&&p==="/v2/list-calls")return Response.json(calls);
 if(opt.method!=="GET")writes.push(p);
 if(p==="/create-retell-llm"){resources.llm={...body,llm_id:"llm_test",version:0};return Response.json(resources.llm);}
 if(p==="/create-agent"){resources.agent={...body,agent_id:"agent_test",version:0,is_published:false};return Response.json(resources.agent);}
 if(p==="/publish-agent-version/agent_test"){resources.agent.is_published=true;resources.llm.is_published=true;if(!lostPublish){lostPublish=true;throw Error("lost publication reply");}return Response.json({});}
 if(p==="/create-phone-number"){resources.number={...body,phone_number:"+15550001111"};return Response.json(resources.number);}
 if(p==="/v2/create-phone-call"){
 assert.equal(body.to_number,process.env.RETELL_TEST_CONSENTING_PHONE);
 calls.push(...["inbound","outbound"].map((direction,i)=>({call_id:"call"+i,agent_id:"agent_test",agent_version:0,
 from_number:i?"+15550001111":"+15550002222",to_number:i?"+15550002222":"+15550001111",
 direction,call_status:"ended",duration_ms:10000,start_timestamp:now++,call_cost:{combined_cost:1}})));
 return Response.json({call_id:"call1"});
 }
 const kind=p.includes("phone-number")?"number":p.includes("retell-llm")?"llm":"agent";
 const expected={number:"+15550001111",agent:"agent_test",llm:"llm_test"}[kind];
 assert.ok(p.endsWith("/"+expected),"no customer IDs in any dispatch");
 if(opt.method==="DELETE"){delete resources[kind];if(!lostDelete){lostDelete=true;throw Error("lost deletion reply");}return new Response(null,{status:204});}
 if(opt.method==="PATCH"){
 Object.assign(resources[kind],body);
 // Retained live response shape: a cleared direction is omitted, not [].
 for(const field of ["inbound_agents","outbound_agents"])if(Array.isArray(resources[kind][field])&&!resources[kind][field].length)delete resources[kind][field];
 return Response.json({});}
 return resources[kind]?Response.json(resources[kind]):new Response(null,{status:404});
 };
 const run=(cmd,approval)=>command(cmd,dir,{fetcher,approval});
 try{
 await run("init");assert.equal(fs.statSync(path.join(dir,"keys.json")).mode&0o777,0o600);
 await assert.rejects(run("prepare"));assert.equal(writes.length,0);
 await run("authorize-execution",{approved:true,reviewReference:"offline-test-only",expiresAt:Date.now()+60000,
 workspaceId:"synthetic",accountConfirmed:true,acceptedPricingUncertainty:true,maxAttempts:3,maxSeconds:60});
 await assert.rejects(run("prepare"),/lost publication/);
 await run("prepare");assert.equal(writes.filter(x=>x.startsWith("/publish-agent")).length,1);
 await run("purchase");await run("inbound");await run("outbound");
 await run("suspend");await run("suspend");assert.equal(writes.filter(x=>x.startsWith("/update-phone")).length,2);
 await run("post-shutdown-inbound");await assert.rejects(run("inbound"),/LIMIT/);
 assert.equal((await run("verify",{inboundShutdownObserved:true})).routesEmpty,true);
 const stateFile=path.join(dir,"state.json"),original=fs.readFileSync(stateFile,"utf8");
 const altered=JSON.parse(original);altered.ids.number="+15550009999";
 fs.writeFileSync(stateFile,JSON.stringify(altered));
 await assert.rejects(run("suspend"),/STATE_INTEGRITY/);fs.writeFileSync(stateFile,original);
 // Expired execution authority cannot authorize writes; cleanup has independent authority.
 const grantFile=path.join(dir,"execution-grant.json"),grant=JSON.parse(fs.readFileSync(grantFile));
 grant.grant.expiresAt=1;grant.signature=sign(grant.grant,JSON.parse(fs.readFileSync(path.join(dir,"keys.json"))).execution);
 fs.writeFileSync(grantFile,JSON.stringify(grant));await assert.rejects(run("suspend"),/EXPIRED/);
 await assert.rejects(run("cleanup"));
 await run("authorize-cleanup",{approved:true,reviewReference:"cleanup-test-only",expiresAt:Date.now()+60000});
 for(const [field,value] of [["fallback_number","+15550009999"],["inbound_agent_id","foreign"],["outbound_agents",[{agent_id:"foreign",agent_version:0,weight:1}]]]){
 const prior=resources.number[field];resources.number[field]=value;
 await assert.rejects(run("cleanup"),/CLEANUP_ROUTING_REVIEW/);
 assert.equal(writes.filter(x=>x.startsWith("/delete-")).length,0);
 if(prior===undefined)delete resources.number[field];else resources.number[field]=prior;
 }
 await assert.rejects(run("cleanup"),/lost deletion/);
 assert.equal((await run("cleanup")).cleanupVerified,true);
 assert.deepEqual(Object.keys(resources),[]);
 assert.deepEqual(writes.filter(x=>x.startsWith("/delete-")),["/delete-phone-number/+15550001111","/delete-agent/agent_test","/delete-retell-llm/llm_test"]);
 }finally{
 if(oldKey===undefined)delete process.env.RETELL_API_KEY;else process.env.RETELL_API_KEY=oldKey;
 if(oldPhone===undefined)delete process.env.RETELL_TEST_CONSENTING_PHONE;else process.env.RETELL_TEST_CONSENTING_PHONE=oldPhone;
 fs.rmSync(dir,{recursive:true,force:true});
 }
});
test("response parser bounds and sanitizes diagnostics; malformed reads and failed writes fail closed",async()=>{
 const notes=[],record=e=>notes.push(e);
 const parse=(response,method="GET",p="/get-agent/agent_private?version=0")=>decodeProviderResponse(response,{method,p,record});
 await assert.rejects(parse(new Response("")),/RESPONSE_EMPTY/);
 await assert.rejects(parse(new Response("<html>Bearer SECRET +15550002222 private@example.com</html>",{headers:{"content-type":"text/html"}})),/RESPONSE_NON_JSON/);
 await assert.rejects(parse(new Response('{"secret":"PRIVATE",')),/RESPONSE_MALFORMED_JSON/);
 await assert.rejects(parse(new Response("x".repeat(65537))),/TOO_LARGE/);
 await assert.rejects(parse(new Response("",{status:404}),"POST","/create-agent"),/HTTP_404/);
 assert.equal(await parse(new Response("",{status:404})),null);
 assert.deepEqual(await parse(new Response("",{status:200}),"POST","/publish-agent-version/agent_private"),{});
 assert.deepEqual(await parse(new Response(null,{status:204}),"DELETE","/delete-agent/agent_private"),{});
 await assert.rejects(parse(new Response("null")),/INVALID_SHAPE/);
 const encoded=JSON.stringify(notes);
 for(const sensitive of ["SECRET","PRIVATE","private@example","15550002222","agent_private"])assert.ok(!encoded.includes(sensitive));
});
for(const variant of ["empty","malformed","non_json","unpublished","readback_malformed"]){
 test("publication response "+variant+" recovers by exact read-back without duplicate publication",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"billing-parser-"));
 const oldKey=process.env.RETELL_API_KEY,oldPhone=process.env.RETELL_TEST_CONSENTING_PHONE;
 process.env.RETELL_API_KEY="offline";process.env.RETELL_TEST_CONSENTING_PHONE="+15550002222";
 let llm,agent,publications=0,badRead=variant==="readback_malformed";
 const fetcher=async(url,opt)=>{
 const p=new URL(url).pathname,body=opt.body?JSON.parse(opt.body):null;
 if(p==="/create-retell-llm"){llm={...body,llm_id:"llm_test",version:0};return Response.json(llm);}
 if(p==="/create-agent"){agent={...body,agent_id:"agent_test",version:0,is_published:false};return Response.json(agent);}
 if(p==="/get-retell-llm/llm_test")return Response.json(llm);
 if(p==="/get-agent/agent_test"){
 if(publications&&badRead){badRead=false;return new Response('{"broken":');}
 return Response.json(agent);}
 if(p==="/publish-agent-version/agent_test"){
 publications++;if(variant!=="unpublished"){agent.is_published=true;llm.is_published=true;}
 return new Response(variant==="malformed"?'{"broken":':variant==="non_json"?"<html>secret response</html>":"",{status:200});
 }
 throw Error("UNEXPECTED_OFFLINE_DISPATCH");
 };
 const run=()=>command("prepare",dir,{fetcher});
 try{
 await command("init",dir);
 await command("authorize-execution",dir,{approval:{approved:true,reviewReference:"offline-parser-test",expiresAt:Date.now()+300000,
 workspaceId:"synthetic",accountConfirmed:true,pricingVerified:true,maxAttempts:3,maxSeconds:60}});
 // The legacy unconditional response.json() reproduces a SyntaxError for an empty 200 acknowledgment.
 if(variant==="empty")await assert.rejects(new Response("").json(),SyntaxError);
 if(variant==="empty")assert.equal((await run()).prepared,true);
 else await assert.rejects(run(),variant==="unpublished"?/PUBLICATION_UNCONFIRMED/:/PROVIDER_RESPONSE_/);
 if(variant==="unpublished")await assert.rejects(run(),/PUBLICATION_UNCERTAIN/);
 else {assert.equal((await run()).prepared,true);assert.equal((await run()).prepared,true);}
 assert.equal(publications,1);
 const diagnostics=JSON.parse(fs.readFileSync(path.join(dir,"provider-diagnostics.json")));
 assert.ok(diagnostics.length<=20);
 assert.ok(!JSON.stringify(diagnostics).includes("secret response"));
 if(variant!=="unpublished")assert.deepEqual((await command("status",dir)).pending,[]);
 }finally{
 if(oldKey===undefined)delete process.env.RETELL_API_KEY;else process.env.RETELL_API_KEY=oldKey;
 if(oldPhone===undefined)delete process.env.RETELL_TEST_CONSENTING_PHONE;else process.env.RETELL_TEST_CONSENTING_PHONE=oldPhone;
 fs.rmSync(dir,{recursive:true,force:true});
 }
 });
}
test("unknown creation response stops and never retries creation",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"billing-cli-unknown-"));
 const beforeKey=process.env.RETELL_API_KEY,beforePhone=process.env.RETELL_TEST_CONSENTING_PHONE;
 process.env.RETELL_API_KEY="offline";process.env.RETELL_TEST_CONSENTING_PHONE="+15550002222";
 let requests=0;
 const fetcher=async()=>{requests++;throw Error("unknown creation response");};
 try{
 await command("init",dir);
 await command("authorize-execution",dir,{approval:{approved:true,reviewReference:"offline-unknown-test",expiresAt:Date.now()+60000,
 workspaceId:"synthetic",accountConfirmed:true,pricingVerified:true,maxAttempts:3,maxSeconds:60}});
 await assert.rejects(command("prepare",dir,{fetcher}),/unknown creation/);
 await assert.rejects(command("prepare",dir,{fetcher}),/UNCERTAIN_OPERATION/);assert.equal(requests,1);
 assert.deepEqual((await command("status",dir)).pending,["llm"]);
 }finally{
 if(beforeKey===undefined)delete process.env.RETELL_API_KEY;else process.env.RETELL_API_KEY=beforeKey;
 if(beforePhone===undefined)delete process.env.RETELL_TEST_CONSENTING_PHONE;else process.env.RETELL_TEST_CONSENTING_PHONE=beforePhone;
 fs.rmSync(dir,{recursive:true,force:true});
 }
});

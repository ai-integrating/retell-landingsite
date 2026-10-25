const {test}=require("node:test"),assert=require("node:assert/strict");
const {initialize,capture,blocksNumberSetup}=require("../lib/onboarding-business");
const {withLlm}=require("../lib/refinement-coordinator");
const {createHandler}=require("../api/onboarding-business");
const {enrollment}=require("../lib/business-enrollment");
const clone=structuredClone;
function fixture(){
 // Minimal sanitized real-provider fixture: metadata is absent, not empty.
 const agent=clone(require("./fixtures/retell-agent-without-metadata.json"));
 const llm={llm_id:"llm_new",version:0,is_published:false,general_prompt:"Keep Alex greeting.\nKeep Scheduler safety rules.",
  general_tools:[{name:"book",type:"custom",url:"https://invalid.example/tool"}],begin_message:"Hello, Alex speaking."};
 let phone={phone_number:"+15555550123",inbound_agents:[{agent_id:"agent_new",weight:1}],
  outbound_agents:[{agent_id:"agent_new",weight:1}],nickname:"Synthetic routing"};
 const body={action:"prepare",client_id:"synthetic-new",agent_id:"agent_new",phone_number:phone.phone_number};
 const map=new Map([["agent:agent_new:client",body.client_id],["prov:1234567890",{status:"completed",agent_id:"agent_new",
  llm_id:"llm_new",business_bootstrap:capture({business_phone:"+15555559999",global_info:"Synthetic business facts."},"Synthetic")}]]),writes=[];
 const evidence={version:1,submission_id:"1234567890",agent_id:"agent_new",llm_id:"llm_new",
  business_bootstrap:clone(map.get("prov:1234567890").business_bootstrap)};
 map.set("onboarding:provisioned:v1:agent_new",evidence);
 map.set("onboarding:identity:v1:agent_new",{...clone(evidence),client_id:body.client_id});
 let fault,extraVersion=false;
 const kv={get:async k=>clone(map.get(k)??null),set:async(k,v)=>{if(map.has(k))return null;map.set(k,v);return"OK"},
  eval:async(s,k,a)=>{if(map.get(k[0])!==a[0])return 0;if(s.includes('redis.call("del"'))map.delete(k[0]);
   if(k.length===2)map.set(k[1],JSON.parse(a[1]));return 1}};
 const fail=(label,before)=>{if(fault===label+(before?":before":":after")){fault=null;throw Error("LOST_RESPONSE")}};
 const axios={get:async(url,o={})=>{
  if(url.includes("list-agent-versions"))return{data:{items:[clone(agent),...(extraVersion?[{...clone(agent),version:1}]:[])],has_more:false}};
  if(url.includes("get-phone-number"))return{data:clone(phone)};
  if(url.includes("get-agent/")){assert.equal(o.params.version,0);return{data:clone(agent)};}
  if(url.includes("get-retell-llm/")){assert.equal(o.params.version,0);return{data:clone(llm)};}
  throw Error("UNEXPECTED_GET");
 },post:async(url,data)=>{
  if(url.endsWith("/v2/list-agents"))return{data:{items:[{...clone(agent),channel:"voice"}],has_more:false}};
  assert.ok(url.includes("/publish-agent-version/"));assert.deepEqual(data,{version:0});
  writes.push("publish");fail("publish",true);agent.is_published=true;llm.is_published=true;fail("publish",false);return{data:clone(agent)};
 },patch:async(url,data,o)=>{
  if(url.includes("update-retell-llm")){assert.equal(o.params.version,0);writes.push("patch");fail("patch",true);llm.general_prompt=data.general_prompt;fail("patch",false);}
  else{assert.ok(url.includes("update-phone-number"));writes.push("route");fail("route",true);phone={...phone,...data};fail("route",false);}
  return{data:{}};
 }};
 const deps={body,kv,axios,base:"https://mock.invalid",headers:{},enabled:true};
 return {agent,llm,map,body,deps,writes,phone:()=>phone,setFault:x=>fault=x,setExtra:()=>extraVersion=true,
  prepare:()=>initialize(deps),activate:fingerprint=>initialize({...deps,body:{...body,action:"activate",fingerprint}})};
}
test("new initialization preserves surrounding prompt/tools/contact, verifies routes and queues review without enrollment",async()=>{
 const f=fixture(),original=clone(f.llm),p=await f.prepare();assert.equal(p.status,"initial_review_required");
 assert.equal(p.snapshot.businessPhone,"+15555559999");assert.equal(p.render_contract.fieldStates.salesPreference,"not_supplied");
 assert.deepEqual(f.writes,[]);const r=await f.activate(p.fingerprint);
 assert.equal(r.state,"active");assert.equal(r.agent_version,0);assert.ok(f.llm.general_prompt.startsWith(original.general_prompt));
 assert.deepEqual(f.llm.general_tools,original.general_tools);assert.equal(f.llm.begin_message,original.begin_message);
 assert.equal(f.phone().inbound_agents[0].agent_version,0);assert.equal(f.phone().outbound_agents[0].agent_version,0);
 assert.deepEqual(f.writes,["patch","publish","route"]);
 const again=await f.activate(p.fingerprint);assert.deepEqual(again,r);assert.equal(f.writes.length,3);
 assert.equal(f.map.has("business:enrollment:v1:agent_new"),false);
 assert.equal((await enrollment({...f.deps,body:{...f.body,action:"inspect"}})).status,"reviewable");
});
for(const phase of ["patch","publish","route"])test(`${phase} lost response recovers by read-back; no duplicate side effects`,async()=>{
 const f=fixture(),p=await f.prepare();f.setFault(phase+":after");await assert.rejects(f.activate(p.fingerprint),/LOST_RESPONSE/);
 await assert.rejects(withLlm({kv:f.deps.kv,llmId:"llm_new",getPrompt:async()=>""},async()=>{}),e=>e.code==="INITIALIZATION_UNRESOLVED");
 assert.equal((await f.activate(p.fingerprint)).state,"active");assert.equal(f.writes.filter(x=>x===phase).length,1);
});
for(const phase of ["patch","publish","route"])test(`${phase} uncertain non-application stops without blind retry`,async()=>{
 const f=fixture(),p=await f.prepare();f.setFault(phase+":before");await assert.rejects(f.activate(p.fingerprint),/LOST_RESPONSE/);
 await assert.rejects(f.activate(p.fingerprint),/UNCONFIRMED/);assert.equal(f.writes.filter(x=>x===phase).length,1);
});
test("drift in greeting, tools, prompt, phone, mapping, or versions invalidates approval",async()=>{
 for(const mutate of[f=>f.llm.begin_message="Edited",f=>f.llm.general_tools.push({name:"new"}),f=>f.llm.general_prompt+=" edit",
  f=>f.phone().nickname="Changed",f=>f.map.set("agent:agent_new:client","other"),f=>f.setExtra()]){
  const f=fixture(),p=await f.prepare();mutate(f);await assert.rejects(f.activate(p.fingerprint));assert.deepEqual(f.writes,[]);
 }
});
test("no old-client adoption, missing provenance, unknown operations or disabled gate",async()=>{
 for(const id of["lets-go-6659962517436476386","mcduffy-and-son-paving-6547488712412593990","test-6595816177431939415"]){
  const f=fixture();f.body.client_id=id;await assert.rejects(f.prepare());assert.deepEqual(f.writes,[]);
 }
 const f=fixture(),p=await f.prepare();await assert.rejects(initialize({...f.deps,enabled:false,body:{...f.body,action:"activate",fingerprint:p.fingerprint}}));
 f.map.delete("onboarding:identity:v1:agent_new");await assert.rejects(f.prepare());
 await assert.rejects(initialize({...f.deps,body:{...f.body,action:"other"}}));
});
test("durable proof supports receipt recovery after original provisioning record expires",async()=>{
 const f=fixture(),p=await f.prepare();await f.activate(p.fingerprint);f.map.delete("prov:1234567890");
 assert.equal((await f.activate(p.fingerprint)).state,"active");assert.equal(f.writes.length,3);
});
test("endpoint authenticates before inspection and ignores browser enable flags",async()=>{
 const f=fixture(),handler=createHandler({...f.deps,secret:"mock-secret",enabled:false});
 const invoke=async(headers,body)=>{const res={setHeader(){},status(n){this.code=n;return this},json(v){this.body=v;return this}};
  await handler({method:"POST",headers,body},res);return res};
 assert.equal((await invoke({},f.body)).code,401);
 assert.equal((await invoke({"x-maintenance-secret":"wrong"},f.body)).code,401);
 const p=await f.prepare();
 assert.equal((await invoke({"x-maintenance-secret":"mock-secret"},{...f.body,action:"activate",fingerprint:p.fingerprint})).body.error,"INITIALIZATION_DISABLED");
 assert.deepEqual(f.writes,[]);
});
test("writer rechecks unresolved initialization after acquiring its lease",async()=>{
 const f=fixture();let reads=0;const get=f.deps.kv.get;
 f.deps.kv.get=async k=>{if(k.endsWith(":bootstrap")&&++reads===2)return{status:"patch_uncertain"};return get(k);};
 await assert.rejects(withLlm({kv:f.deps.kv,llmId:"llm_new",getPrompt:async()=>""},async()=>assert.fail("writer ran")),
 e=>e.code==="INITIALIZATION_UNRESOLVED");
});
test("number setup is fenced before first PATCH, including interrupted initialization, without affecting other targets",async()=>{
 const f=fixture(),p=await f.prepare();assert.equal(await blocksNumberSetup(f.deps.kv,"agent_new"),false);
 f.setFault("patch:before");await assert.rejects(f.activate(p.fingerprint));
 assert.equal(await blocksNumberSetup(f.deps.kv,"agent_new"),true);
 assert.equal(await blocksNumberSetup(f.deps.kv,"agent_other"),false);
});
test("actual number endpoint rejects an initializing target before any provider request",async()=>{
 const Module=require("node:module"),original=Module._load;
 let reads=0,providerCalls=0;
 Module._load=function(name,...args){
  if(name==="@vercel/kv")return{kv:{get:async k=>{reads++;assert.equal(k,"agent:agent_new:initialization-llm");return"llm_new";}}};
  if(name==="axios")return{post:async()=>{providerCalls++;throw Error("UNEXPECTED_PROVIDER_WRITE")}};
  return original.call(this,name,...args);
 };
 let handler;try{handler=require("../api/buy-number");}finally{Module._load=original;}
 const res={setHeader(){},status(n){this.code=n;return this},json(b){this.body=b;return this}};
 await handler({method:"POST",body:{agent_id:"agent_new"},headers:{}},res);
 assert.equal(res.code,423);assert.equal(reads,1);assert.equal(providerCalls,0);
});
test("expired legacy provisioning record is not needed before first preparation",async()=>{
 const f=fixture();f.map.delete("prov:1234567890");
 const p=await f.prepare();assert.equal((await f.activate(p.fingerprint)).state,"active");
});
test("changed durable provenance rejects recovery without another PATCH",async()=>{
 const f=fixture(),p=await f.prepare();f.setFault("patch:after");
 await assert.rejects(f.activate(p.fingerprint),/LOST_RESPONSE/);
 f.map.get("onboarding:identity:v1:agent_new").submission_id="9876543210";
 await assert.rejects(f.activate(p.fingerprint));
 assert.deepEqual(f.writes,["patch"]);
});
test("missing or conflicting durable evidence never substitutes legacy record or metadata",async()=>{
 for(const mutate of[
  f=>f.map.delete("onboarding:identity:v1:agent_new"),
  f=>f.map.delete("onboarding:provisioned:v1:agent_new"),
  f=>f.map.get("onboarding:identity:v1:agent_new").client_id="another",
  f=>f.map.get("onboarding:provisioned:v1:agent_new").llm_id="llm_other"]){
  const f=fixture();f.agent.metadata={submission_id:"1234567890"};mutate(f);
  await assert.rejects(f.prepare());assert.deepEqual(f.writes,[]);
 }
});

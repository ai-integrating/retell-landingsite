const {test}=require("node:test"), assert=require("node:assert/strict"),crypto=require("node:crypto");
const clone=structuredClone,hash=x=>crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
const review=require("../lib/mcduffy-review.json"),r=require("../lib/business-render-v2");
const base={agent:{agent_id:"agent_synthetic",version:0,is_published:true,
  response_engine:{type:"retell-llm",llm_id:"llm_synthetic",version:0}},
  llm:{llm_id:"llm_synthetic",version:0,is_published:true,general_prompt:"Brian greeting. Never quote prices. Never schedule appointments.",
    general_tools:[{name:"Book_Appointment",type:"custom"}]}};
const kept=clone(base);kept.agent.version=1;kept.agent.base_version=0;kept.agent.is_published=false;
kept.agent.response_engine.version=1;kept.agent.handbook_config={echo_verification:true};
kept.llm.version=1;kept.llm.is_published=false;kept.llm.general_prompt="Separate manual draft";
const snapshot=Object.fromEntries(r.FIELDS.map(k=>[k,null]));snapshot.clientName="Synthetic";
snapshot.businessPhone="(508) 326-0740";snapshot.pricingPolicies="Never quote pricing.";
function request(revision=1,phase="draft"){
 const b={operation:r.OPERATION,client_id:"synthetic",agent_id:"agent_synthetic",section_id:r.SECTION_ID,
 revision,business_information:snapshot,snapshot_hash:r.hash(JSON.stringify(snapshot)),publish:false,
 renderer_version:r.RENDERER,field_states:Object.fromEntries(r.FIELDS.map(k=>[k,snapshot[k]===null?"not_supplied":"value"]))};
 b.request_hash=r.identity(b);b.idempotency_key=r.key(b);
 return {...b,operation:"apply_business_revision_v3",phase,publish:phase==="active",phone_number:"+15555550123"};
}
// Test-process-only policy uses synthetic resources; no reviewed customer data.
Object.assign(review,{client_id:"synthetic",agent_id:"agent_synthetic",llm_id:"llm_synthetic",phone_number:"+15555550123",
 baseline_hash:hash(base),draft_agent_hash:hash(kept.agent),draft_llm_hash:hash(kept.llm),
 snapshot_hash:request().snapshot_hash,request_hash:request().request_hash,
 phone_hash:hash({phone_number:"+15555550123",inbound_agents:[{agent_id:"agent_synthetic",weight:1}],
 outbound_agents:[{agent_id:"agent_synthetic",weight:1}],nickname:"Preserve"})});
const {versionedBusiness}=require("../lib/versioned-business"),{enrollment}=require("../lib/business-enrollment");
const {createHandler}=require("../api/mcduffy-adoption");
function fixture(unpinned=false){
 const values=new Map([["agent:agent_synthetic:client","synthetic"]]),versions=new Map([[0,clone(base)],[1,clone(kept)]]);
 let phone={phone_number:"+15555550123",inbound_agents:[{agent_id:"agent_synthetic",agent_version:0,weight:1}],
 outbound_agents:[{agent_id:"agent_synthetic",agent_version:0,weight:1}],nickname:"Preserve"};
 if(unpinned)for(const k of ["inbound_agents","outbound_agents"])delete phone[k][0].agent_version;
 const calls=[],fault={};
 const kv={get:async k=>clone(values.get(k)??null),set:async(k,v)=>{if(values.has(k))return null;values.set(k,v);return "OK"},
 eval:async(s,k,a)=>{if(values.get(k[0])!==a[0])return 0;if(s.includes('redis.call("del"'))values.delete(k[0]);
 if(k.length===2)values.set(k[1],JSON.parse(a[1]));
 if(k.length===5){const p=values.get(k[1]);if(p&&p.generation>=a[4])return -1;
 values.set(k[1],JSON.parse(a[1]));values.set(k[2],JSON.parse(a[2]));values.set(k[3],JSON.parse(a[1]));values.set(k[4],JSON.parse(a[3]));}return 1;}};
 const maybe=(stage,before=false)=>{if(fault[stage]===(before?"before":"after")){delete fault[stage];throw Error("LOST_RESPONSE");}};
 const axios={
 get:async(url,o)=>{const v=o.params?.version;
 if(url.includes("get-phone-number"))return{data:clone(phone)};
 if(url.includes("list-agent-versions"))return{data:{items:[...versions.values()].map(d=>({version:d.agent.version,is_published:d.agent.is_published})),has_more:false}};
 assert.ok(Number.isSafeInteger(v),"No implicit latest");
 return {data:clone(url.includes("get-agent")?versions.get(v).agent:versions.get(v).llm)};},
 post:async(url,b)=>{if(url.includes("list-agents"))return{data:{items:[{agent_id:"agent_synthetic",channel:"voice"}],has_more:false}};
 const stage=url.includes("create-agent-version")?"create":"publish";calls.push(stage);maybe(stage,true);
 if(stage==="create"){assert.equal(b.base_version,versions.size===2?0:versions.size-1);
 const d=clone(versions.get(b.base_version)),v=versions.size;d.agent.version=v;d.agent.base_version=b.base_version;
 d.agent.response_engine.version=v;d.llm.version=v;d.agent.is_published=d.llm.is_published=false;versions.set(v,d);}
 else{assert.ok(b.version>1);versions.get(b.version).agent.is_published=versions.get(b.version).llm.is_published=true;}
 maybe(stage);return{data:{}};},
 patch:async(url,b,o)=>{const stage=url.includes("update-phone-number")?"route":"patch";calls.push(stage);maybe(stage,true);
 if(stage==="route")phone={...phone,...clone(b)};
 else{assert.ok(o.params.version>1);versions.get(o.params.version).llm.general_prompt=b.general_prompt;}
 if(fault.drift){versions.get(1).agent.handbook_config.echo_verification=false;delete fault.drift;}
 maybe(stage);return{data:{}};}};
 const deps={kv,axios,base:"https://mock.invalid",headers:{},expectedLlm:"llm_synthetic",findUpgradeHits:()=>[]};
 return {values,versions,calls,fault,deps,run:(phase="draft",revision=1)=>versionedBusiness({...deps,body:request(revision,phase),initialAdoption:revision===1}),
 inspect:()=>enrollment({...deps,body:{action:"inspect",client_id:"synthetic",agent_id:"agent_synthetic",phone_number:phone.phone_number}})};
}
test("adopt, publish, inspect/enroll and subsequent update retain independent draft and explicit versions",async()=>{
 const f=fixture();await f.run();const first=await f.run("active");assert.equal(first.agent_version,2);
 assert.deepEqual(await f.run("active"),first);assert.deepEqual(f.versions.get(0),base);assert.deepEqual(f.versions.get(1),kept);
 const evidence=await f.inspect();assert.equal(evidence.status,"reviewable");assert.ok(evidence.retained_policy);
 await enrollment({...f.deps,body:{action:"approve",generation:2,request_id:"approve",expected_fingerprint:evidence.fingerprint,
 client_id:"synthetic",agent_id:"agent_synthetic",phone_number:"+15555550123"}});
 await f.run("draft",2);await f.run("active",2);
 assert.deepEqual(f.versions.get(1),kept);assert.equal(f.calls.filter(x=>x==="create").length,2);
});
for(const stage of ["create","patch","publish","route"])test(`lost ${stage} response recovers without duplicate dispatch`,async()=>{
 const f=fixture();if(["publish","route"].includes(stage))await f.run();
 f.fault[stage]="after";const phase=["publish","route"].includes(stage)?"active":"draft";
 await assert.rejects(f.run(phase));await f.run(phase);
 assert.equal(f.calls.filter(x=>x===stage).length,1);assert.deepEqual(f.versions.get(1),kept);
});
test("publication uncertainty without remote commit fails closed; routing pre-dispatch failure safely retries",async()=>{
 const f=fixture();await f.run();f.fault.publish="before";await assert.rejects(f.run("active"));
 await assert.rejects(f.run("active"),/PUBLICATION_UNRESOLVED/);assert.equal(f.calls.filter(x=>x==="publish").length,1);
 const g=fixture();await g.run();g.fault.route="before";await assert.rejects(g.run("active"));await g.run("active");
 assert.equal(g.calls.filter(x=>x==="publish").length,1);
});
test("changed retained content, handbook, missing draft and unexpected drafts block mutation and enrollment",async()=>{
 for(const change of [f=>{f.versions.get(1).llm.general_prompt+=" edit"},f=>{f.versions.get(1).agent.handbook_config.x=true},
 f=>f.versions.delete(1),f=>{const x=clone(kept);x.agent.version=4;f.versions.set(4,x)}]){
 const f=fixture();await f.run();await f.run("active");change(f);const count=f.calls.length;
 await assert.rejects(f.run("draft",2));await assert.rejects(f.inspect());assert.equal(f.calls.length,count);
 }
});
test("concurrent retained-draft edit stops before publication; lease conflict stops writes",async()=>{
 const f=fixture();f.fault.drift=true;await assert.rejects(f.run(),/RETAINED_DRAFT_CHANGED/);
 assert.ok(!f.calls.includes("publish"));
 const g=fixture();g.values.set("refinement:v1:llm:llm_synthetic:lock","other");await assert.rejects(g.run(),/LLM_BUSY/);
 assert.equal(g.calls.length,0);
});
test("operator endpoint rejects absent credentials and scope changes",async()=>{
 const f=fixture(),res={setHeader(){},status(n){this.code=n;return this},json(v){this.body=v;return this}};
 await createHandler({...f.deps,secret:"synthetic",apiKey:"mock"})({method:"POST",headers:{},body:request()},res);
 assert.equal(res.code,401);
 const wrong={...request(),client_id:"other"};wrong.idempotency_key=r.key(wrong);
 await assert.rejects(versionedBusiness({...f.deps,body:wrong,initialAdoption:true}),/ADOPTION_SCOPE_CHANGED/);
 assert.equal(f.calls.length,0);
});
test("baseline pin is scoped, replayable and recovers a lost routing response",async()=>{
 const {pinBaseline}=require("../lib/mcduffy-baseline");
 const f=fixture(true);f.fault.route="after";
 const run=()=>pinBaseline({...f.deps,body:request(1,"baseline")});
 await assert.rejects(run());assert.equal((await run()).state,"baseline_pinned");await run();
 assert.equal(f.calls.filter(x=>x==="route").length,1);
 assert.deepEqual(f.versions.get(0),base);assert.deepEqual(f.versions.get(1),kept);
 await f.run();await assert.rejects(run(),/ADOPTION_ALREADY_STARTED/);
});
test("approval replay cannot reconcile after retained draft changes",async()=>{
 const f=fixture();await f.run();await f.run("active");const e=await f.inspect();
 const body={action:"approve",generation:2,request_id:"retry",expected_fingerprint:e.fingerprint,
 client_id:"synthetic",agent_id:"agent_synthetic",phone_number:"+15555550123"};
 const receipt=await enrollment({...f.deps,body});
 assert.deepEqual(await enrollment({...f.deps,body}),receipt);
 f.versions.get(1).llm.general_prompt+=" changed";
 await assert.rejects(enrollment({...f.deps,body}),/RETAINED_DRAFT_CHANGED/);
});

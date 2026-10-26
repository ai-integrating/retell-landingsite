const {test}=require("node:test"),assert=require("node:assert/strict");
const {advance}=require("../lib/versioned-lifecycle");
const contract=require("../lib/business-greeting"),v2=require("../lib/business-render-v2");
function request(revision=2,text="Hello from our team.",before="Hello from Brian.") {
 const snapshot=Object.fromEntries(v2.FIELDS.map(k=>[k,k==="clientName"?"Synthetic":null]));
 const r={operation:v2.OPERATION,renderer_version:contract.RENDERER,client_id:"synthetic",agent_id:"agent_synthetic",
   section_id:v2.SECTION_ID,revision,publish:false,business_information:snapshot,
   snapshot_hash:contract.hash(JSON.stringify(snapshot)),
   field_states:Object.fromEntries(v2.FIELDS.map(k=>[k,k==="clientName"?"value":"not_supplied"])),
   greeting:{text,expected_hash:contract.greetingHash(before)}};
 r.request_hash=contract.identity(r);r.idempotency_key=contract.key(r);return contract.validate(r);
}
function fixture(fault) {
 const seed=request(1,"Hello from Brian.");
 let state=null,phone={inbound_agents:[{agent_id:"agent_synthetic",agent_version:0,weight:1}],
   outbound_agents:[{agent_id:"agent_synthetic",agent_version:0,weight:1}]},once=false;
 const counts={create:0,patch:0,publish:0,route:0},history=[];
 const versions=new Map([[0,{agent:{agent_id:"agent_synthetic",version:0,is_published:true,
   response_engine:{type:"retell-llm",llm_id:"llm_synthetic",version:0}},
   llm:{llm_id:"llm_synthetic",version:0,is_published:true,begin_message:"Hello from Brian.",
     general_prompt:"SAFETY AND SCHEDULER\n"+contract.section(seed)+"\nBOOKING RULES",
     general_tools:[{name:"scheduler",description:"unchanged"}],begin_after_user_silence_ms:1000}}]]);
 // Retained draft excluded by adapter after its exact-hash check, never by lifecycle.
 const retained=structuredClone(versions.get(0));retained.agent.version=1;retained.agent.is_published=false;
 retained.llm.version=1;retained.llm.is_published=false;retained.llm.general_prompt="PRIVATE HANDBOOK DRAFT";
 versions.set(1,retained);const retainedCopy=structuredClone(retained);
 const mutate=async(name,fn)=>{counts[name]++;if(fault===name+":before"&&!once){once=true;throw Error("timeout");}
   fn();if(fault===name+":after"&&!once){once=true;throw Error("timeout");}};
 const io={load:async()=>structuredClone(state),store:async r=>{state=structuredClone(r);},
   archive:async r=>history.push(structuredClone(r)),phone:async()=>structuredClone(phone),
   read:async v=>structuredClone(versions.get(v)),
   versions:async()=>[...versions.values()].filter(d=>d.agent.version!==1).map(d=>d.agent),
   create:async v=>mutate("create",()=>{const d=structuredClone(versions.get(v)),n=versions.size;
     d.agent.version=n;d.agent.base_version=v;d.agent.response_engine.version=n;d.agent.is_published=false;
     d.llm.version=n;d.llm.is_published=false;versions.set(n,d);}),
   patch:async(id,v,prompt,greeting)=>mutate("patch",()=>{assert.equal(id,"llm_synthetic");
     versions.get(v).llm.general_prompt=prompt;versions.get(v).llm.begin_message=greeting;}),
   publish:async v=>mutate("publish",()=>{versions.get(v).agent.is_published=true;versions.get(v).llm.is_published=true;}),
   route:async r=>mutate("route",()=>{phone={...phone,...r};})};
 const run=(r=request(),phase="active")=>advance({io,request:r,contract,phase});
 return {run,versions,counts,history,io,retainedCopy};
}
test("greeting identity changes and old receipts cannot validate new text",()=>{
 const a=request(),b=request(2,"A different opening.");
 assert.notEqual(a.request_hash,b.request_hash);assert.notEqual(a.idempotency_key,b.idempotency_key);
 assert.equal(contract.receipt(a,"llm_synthetic").greeting_hash,contract.greetingHash(a.greeting.text));
 assert.throws(()=>contract.validate({...a,greeting:b.greeting}),/REQUEST_IDENTITY_MISMATCH/);
});
for(const text of [""," ","{{name}}","line\nbreak","x".repeat(501)])
 test("reject unsupported greeting "+JSON.stringify(text.slice(0,12)),()=>assert.throws(()=>request(2,text)));
test("two updates preserve prompt surroundings, retained draft, greeting-independent settings and exact routes",async()=>{
 const f=fixture(),a=await f.run();assert.equal(a.agent_version,2);
 const first=f.versions.get(2);
 assert.equal(first.llm.begin_message,"Hello from our team.");
 assert.ok(first.llm.general_prompt.startsWith("SAFETY AND SCHEDULER\n"));
 assert.ok(first.llm.general_prompt.endsWith("\nBOOKING RULES"));
 const b=await f.run(request(3,"Welcome back.","Hello from our team."));
 assert.equal(b.agent_version,3);assert.equal(b.published,true);
 assert.deepEqual(f.versions.get(1),f.retainedCopy);
 assert.deepEqual(f.versions.get(3).llm.general_tools,f.versions.get(0).llm.general_tools);
 assert.equal(f.versions.get(3).llm.begin_after_user_silence_ms,1000);
 const before={...f.counts};await f.run(request(3,"Welcome back.","Hello from our team."));
 assert.deepEqual(f.counts,before);assert.equal(f.history.length,1);
 const phone=await f.io.phone();assert.equal(phone.inbound_agents[0].agent_version,3);
 assert.equal(phone.outbound_agents[0].agent_version,3);
});
for(const action of ["create","patch","publish","route"])
 test(action+" lost response recovers without duplicate writes",async()=>{
   const f=fixture(action+":after");await assert.rejects(f.run(),/timeout/);
   const result=await f.run();assert.equal(result.state,"active");
   assert.equal(f.counts[action],1);const counts={...f.counts};await f.run();assert.deepEqual(f.counts,counts);
 });
for(const action of ["create","patch","publish"])
 test(action+" uncertain non-application fails closed",async()=>{
   const f=fixture(action+":before");await assert.rejects(f.run());await assert.rejects(f.run());
   assert.equal(f.counts[action],1);
 });
test("external greeting drift fails before a clone",async()=>{
 const f=fixture();f.versions.get(0).llm.begin_message="Manually edited";
 await assert.rejects(f.run(),/GREETING_BASELINE_CHANGED/);assert.equal(f.counts.create,0);
});
test("draft greeting and tools drift block publication",async()=>{
 for(const field of ["begin_message","general_tools"]){
   const f=fixture();await f.run(request(),"draft");
   f.versions.get(2).llm[field]=field==="begin_message"?"Unreviewed":"changed";
   await assert.rejects(f.run(),/DRAFT_CONFIGURATION_CHANGED/);assert.equal(f.counts.publish,0);
 }
});
test("wrong caller expected hash cannot authorize a changed greeting",async()=>{
 const f=fixture(),r=request(2,"New","not the baseline");
 await assert.rejects(f.run(r),/GREETING_BASELINE_CHANGED/);assert.equal(f.counts.create,0);
});

const {test}=require("node:test"),assert=require("node:assert/strict");
const review=require("../lib/mcduffy-review.json");
const {withLlm}=require("../lib/refinement-coordinator");
const {protectedSetup}=require("../lib/mcduffy-write-guard");
const {createHandler}=require("../api/refinement");
function response(){
 return {code:200,setHeader(){},status(n){this.code=n;return this;},json(b){this.body=b;return this;},send(b){this.body=b;return this;}};
}
for(const phase of ["before-baseline","baseline-pinned","creating","draft","publishing","active"]){
 test(`legacy write blocked before any coordination I/O: ${phase}`,async()=>{
  const kv=new Proxy({}, {get(){throw Error("KV_MUST_NOT_BE_ACCESSED");}});
  await assert.rejects(withLlm({kv,llmId:review.llm_id,getPrompt(){throw Error("RETELL_MUST_NOT_BE_ACCESSED");}},
    ()=>{throw Error("WORK_MUST_NOT_RUN");}),e=>e.code==="MCDUFFY_LEGACY_WRITES_PAUSED"&&e.status===423);
 });
}
test("version-specific adoption still allowed; unrelated legacy LLM unchanged",async()=>{
 for(const [llmId,versionLifecycle]of [[review.llm_id,true],["unrelated",false]]){
  const kv={get:async()=>null,set:async()=>"OK",eval:async()=>1};
  const result=await withLlm({kv,llmId,versionLifecycle,getPrompt:async()=>"unchanged"},async()=>"allowed");
  assert.equal(result,"allowed");
 }
});
test("setup identities detected in request/record despite different test submission",()=>{
 for(const v of [review.client_id,review.agent_id,review.llm_id,review.client_id.split("-").at(-1)])
  assert.equal(protectedSetup({submission_id:"different-test",nested:{agent_id:v}}),true);
 assert.equal(protectedSetup({client_id:"other",agent_id:"another",business_name:"Mcduffy"}),false);
 assert.equal(protectedSetup({client_id:"other",agent_id:"another",template_agent_id:review.agent_id}),false);
});
test("actual legacy refinement rejects journal-free target, browser bypass flags ignored",async()=>{
 let gets=0;
 const handler=createHandler({apiKey:"mock",secret:"mock",kv:{get:async()=>{throw Error("NO_KV");}},
  axios:{get:async()=>{gets++;return {data:{response_engine:{type:"retell-llm",llm_id:review.llm_id}}};},
  patch:async()=>{throw Error("NO_PATCH");},post:async()=>{throw Error("NO_PUBLISH");}}});
 const res=response();
 await handler({method:"POST",headers:{"x-refinement-secret":"mock"},body:{agent_id:review.agent_id,
 category:"pricing",update_text:"Synthetic update",request_id:"late-job",versionLifecycle:true}},res);
 assert.equal(res.code,423);assert.equal(gets,0);
 const other=response();
 await handler({method:"POST",headers:{"x-refinement-secret":"mock"},body:{agent_id:"another-alias",
 category:"pricing",update_text:"Synthetic update",request_id:"late-job"}},other);
 assert.equal(other.code,423);assert.equal(gets,1);
});

// Isolated node:test process only: stub the existing provision module's dependencies.
const kvPath=require.resolve("@vercel/kv");require(kvPath);
let records=[],calls=[];
const kv={get:async k=>{calls.push(["get",k]);return records.shift()??null;},
 set:async k=>{calls.push(["set",k]);return "OK";},
 del:async k=>{calls.push(["del",k]);return 1;}};
require.cache[kvPath].exports={kv};
const provision=require("../api/provision");
test("late provisioning blocked by request or persisted target before lock/record writes",async()=>{
 for(const variant of ["body","record","original-submission"]){
  calls=[];records=variant==="record"?[{agent_id:review.agent_id,status:"agent_created"}]:[null];
  const res=response(),body={submission_id:variant==="original-submission"?review.client_id.split("-").at(-1):"other-test",
    ...(variant==="body"?{llm_id:review.llm_id}:{})};
  await provision({method:"POST",body},res);
  assert.equal(res.code,423);assert.equal(calls.filter(x=>x[0]!=="get").length,0);
 }
});
test("provision rechecks record after lease acquisition and releases only its own lock",async()=>{
 calls=[];records=[null,{agent_id:review.agent_id,status:"agent_created"}];const res=response();
 await provision({method:"POST",body:{submission_id:"racing-test"}},res);
 assert.equal(res.code,423);
 assert.deepEqual(calls.filter(x=>x[0]!=="get"),[["set","provlock:racing-test"],["del","provlock:racing-test"]]);
});
test("completed provision receipt remains read-only and idempotent",async()=>{
 calls=[];records=[{status:"completed",agent_id:review.agent_id}];const res=response();
 await provision({method:"POST",body:{submission_id:"completed"}},res);
 assert.equal(res.code,200);assert.equal(calls.filter(x=>x[0]!=="get").length,0);
});
test("queued number setup cannot rebind protected agent; no number purchase",async()=>{
 const handler=require("../api/buy-number"),res=response();
 await handler({method:"POST",body:{agent_id:review.agent_id}},res);
 assert.equal(res.code,423);
});

const {test}=require("node:test"),assert=require("node:assert/strict");
const {TARGET,plan}=require("../tools/lets-go-prepare.cjs");
const {FIELDS,hash}=require("../lib/refinement-section");
function fixture(){
 const snapshot=Object.fromEntries(FIELDS.map(f=>[f,null])),digest=hash(JSON.stringify(snapshot));
 return {recovery:{agent:{agent_id:TARGET.agent,is_published:false,response_engine:{llm_id:TARGET.llm,version:0}},
 llm:{llm_id:TARGET.llm,version:0,is_published:false,general_prompt:"Scheduler rules\r\nunchanged",general_tools:[{name:"book"}]}},
 request:{operation:"replace_business_section_v1",section_id:"portal.business-information.v1",client_id:TARGET.client,
 agent_id:TARGET.agent,revision:1,snapshot_hash:digest,idempotency_key:`business:${TARGET.client}:${TARGET.agent}:1:${digest}`,business_information:snapshot,publish:false}};
}
test("offline proposal preserves Scheduler and tools and repeat rendering",()=>{
 const {recovery,request}=fixture(),before=structuredClone(recovery);
 const p=plan(recovery,request);assert.deepEqual(recovery,before);
 assert.ok(p.after.startsWith(recovery.llm.general_prompt));
 recovery.llm.general_prompt=p.after;assert.equal(plan(recovery,request).after,p.after);
});
test("offline proposal rejects other targets or publication",()=>{
 for(const field of ["client_id","agent_id","publish"]){
 const {recovery,request}=fixture();request[field]=field==="publish"?true:"other";assert.throws(()=>plan(recovery,request));}
 const {recovery,request}=fixture();recovery.llm.llm_id="other";assert.throws(()=>plan(recovery,request));
});
test("ownership uses POST only for listing and fails closed on legacy arrays",async()=>{
 const {verifyOwnership}=require("../lib/retell-ownership");
 await assert.rejects(verifyOwnership({get:()=>assert.fail("No fallback"),post:async(url,body,options)=>{
 assert.equal(url,"https://mock.invalid/v2/list-agents");assert.deepEqual(body,{});assert.equal(options.params.limit,1000);
 return {data:[]};
 }},"https://mock.invalid",{},TARGET.agent,TARGET.llm),/OWNERSHIP_LIST_INCOMPLETE/);
});

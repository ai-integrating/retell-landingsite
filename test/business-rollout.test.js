const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("../api/refinement");
const { PILOT, BUSINESS_SECTION_PILOT_ENABLED, pilotMatches } = require("../lib/business-rollout");
const { FIELDS, SECTION_ID, hash } = require("../lib/refinement-section");

function request(operation = "replace_business_section_v1") {
  const snapshot = Object.fromEntries(FIELDS.map(k => [k, null]));
  const digest = hash(JSON.stringify(snapshot));
  return { operation, client_id: PILOT.clientId, agent_id: PILOT.agentId, section_id: SECTION_ID,
    revision: 1, snapshot_hash: digest, idempotency_key: `business:${PILOT.clientId}:${PILOT.agentId}:1:${digest}`,
    business_information: snapshot, publish: operation === "publish_business_section_v1",
    ...(operation === "publish_business_section_v1" ? {phone_number:"+15555550123"} : {}) };
}
test("version-specific operation cannot bypass disabled gates", async () => {
  const r = await invoke({ ...request("apply_business_revision_v3"), enableSection: true, enablePilot: true });
  assert.equal(r.statusCode, 503); assert.equal(r.reads, 0);
});
test("version-specific pilot rejects another customer before external reads", async () => {
  const r = await invoke({ ...request("apply_business_revision_v3"), client_id: "other-client" }, true);
  assert.equal(r.statusCode, 403); assert.equal(r.reads, 0);
});
async function invoke(body, enablePilot = false, mapped = true) {
  let reads = 0;
  const forbidden = async () => { throw Error("Writes forbidden in pilot gate tests"); };
  const handler = createHandler({
    secret: "test-only", apiKey: "mock-only", enableSection: false, enablePilot,
    kv: {get:async()=>{reads++;return mapped ? PILOT.clientId : "different-client";},set:forbidden,eval:forbidden},
    axios: {get:async()=>{reads++;return {data:{agent_id:PILOT.agentId,response_engine:{type:"retell-llm",llm_id:mapped ? "llm_changed" : PILOT.llmId}}};},
      post:forbidden,patch:forbidden},
  });
  const res = {statusCode:200,body:null,setHeader(){},status(n){this.statusCode=n;return this;},json(value){this.body=value;return this;}};
  await handler({method:"POST",headers:{"x-refinement-secret":"test-only"},body},res);
  return {...res,reads};
}
test("pilot is enabled and only the exact pair matches",()=>{
  assert.equal(BUSINESS_SECTION_PILOT_ENABLED,true);
  assert.equal(pilotMatches(request()),true);
  assert.equal(pilotMatches({...request(),client_id:"different-client"}),false);
  assert.equal(pilotMatches({...request(),agent_id:"different-agent"}),false);
});
test("enabled release default rejects a different customer before external reads", async () => {
  const r = await invoke({...request("apply_business_revision_v3"),client_id:"other-client"}, BUSINESS_SECTION_PILOT_ENABLED);
  assert.equal(r.statusCode,403); assert.equal(r.reads,0);
});
for(const operation of ["replace_business_section_v1","publish_business_section_v1"]){
  test(`${operation}: request flags cannot activate the shipped disabled gates`,async()=>{
    const r=await invoke({...request(operation),enablePilot:true,enableSection:true});
    assert.equal(r.statusCode,503);assert.equal(r.reads,0);
  });
  test(`${operation}: non-pilot client or agent rejected before integrations`,async()=>{
    for(const change of [{client_id:"different-client"},{agent_id:"different-agent"}]){
      const r=await invoke({...request(operation),...change},true);
      assert.equal(r.statusCode,403);assert.equal(r.reads,0);
    }
  });
  test(`${operation}: approved pair still requires authoritative KV ownership`,async()=>{
    const r=await invoke(request(operation),true,false);
    assert.equal(r.statusCode,403);assert.equal(r.body.detail.code,"CLIENT_AGENT_MISMATCH");
    assert.equal(r.reads,operation === "publish_business_section_v1" ? 2 : 1);
  });
  test(`${operation}: changed LLM is rejected before locks, patches or publication`,async()=>{
    const r=await invoke(request(operation),true);
    assert.equal(r.statusCode,403);assert.equal(r.body.detail.code,"PILOT_LLM_MISMATCH");
    assert.equal(r.reads,operation === "publish_business_section_v1" ? 1 : 2);
  });
}

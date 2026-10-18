const { test } = require("node:test");
const assert = require("node:assert/strict");
const { publishBusiness, PUBLISH_OPERATION, assertNoUnrelatedDraft } = require("../lib/business-publication");
const { hash, section, FIELDS } = require("../lib/refinement-section");
const { RENEW, RELEASE, GUARDED_SET } = require("../lib/refinement-coordinator");
function fixture() {
  const snapshot = Object.fromEntries(FIELDS.map(k => [k, null]));
  const p = { operation: PUBLISH_OPERATION, client_id: "example-client", agent_id: "agent_example",
    section_id: "portal.business-information.v1", revision: 1, snapshot_hash: hash(JSON.stringify(snapshot)),
    business_information: snapshot, publish: true, phone_number: "+15555550123" };
  p.idempotency_key = `business:${p.client_id}:${p.agent_id}:1:${p.snapshot_hash}`;
  const old = { agent: { agent_id: p.agent_id, channel: "voice", version: 0, is_published: true,
    response_engine: { type: "retell-llm", llm_id: "llm_example", version: 0 }, voice_id: "original" },
    llm: { llm_id: "llm_example", version: 0, is_published: true, general_prompt: "Scheduler rules",
      general_tools: [{ name: "book", parameters: { time: "unchanged" } }] } };
  const current = structuredClone(old);
  current.agent.version = 1; current.agent.is_published = false; current.agent.response_engine.version = 1;
  current.llm.version = 1; current.llm.is_published = false;
  current.llm.general_prompt += "\n\n" + section(p);
  const root = "refinement:v1:llm:llm_example";
  const values = new Map([["agent:agent_example:client", p.client_id],
    [root + ":section", { clientId: p.client_id, agentId: p.agent_id, revision: 1,
      hash: p.snapshot_hash, key: p.idempotency_key }]]);
  const state = { posts: 0, timeout: false, reject: false, routeVersion: "latest_published", webhook: null };
  const kv = {
    async get(k) { return structuredClone(values.get(k) ?? null); },
    async set(k,v) { if(values.has(k))return null;values.set(k,v);return "OK"; },
    async eval(script,keys,args) {
      if(values.get(keys[0])!==args[0])return 0;
      if(script===RELEASE){values.delete(keys[0]);return 1;}
      if(script===RENEW)return 1;
      assert.equal(script,GUARDED_SET);values.set(keys[1],JSON.parse(args[1]));return 1;
    },
  };
  const axios = {
    async get(url, options) {
      if(url.includes("/get-phone-number/"))return {data:{phone_number:p.phone_number,inbound_webhook_url:state.webhook,
        inbound_agents:[{agent_id:p.agent_id,agent_version:state.routeVersion,weight:1}]}};
      if(url.includes("/list-agent-versions/")) return {data:{items:[{version:0,is_published:true},{version:1,is_published:current.agent.is_published}],has_more:false}};
      if(url.includes("/get-agent/"))return {data:structuredClone(options?.params?.version===0?old.agent:current.agent)};
      assert.ok(url.includes("/get-retell-llm/"));
      return {data:structuredClone(options?.params?.version===0?old.llm:current.llm)};
    },
    async post(url) {
      if(url.endsWith("/v2/list-agents"))return {data:{items:[current.agent],has_more:false}};
      assert.ok(url.endsWith("/publish-agent/agent_example"));state.posts++;
      if(state.reject){state.reject=false;throw Object.assign(Error("rejected"),{response:{status:429}});}
      current.agent.is_published=true;current.llm.is_published=true;
      if(state.timeout){state.timeout=false;throw Error("uncertain timeout");}
      return {data:{}};
    },
    async patch(){throw Error("PUBLICATION_MUST_NOT_PATCH");},
  };
  return { p, old, current, state, values, send:()=>publishBusiness({body:p,kv,axios,base:"https://mock.invalid",headers:{}}) };
}
test("v2 publication binds renderer and section hash and retries without publishing twice", async () => {
  const v2 = require("../lib/business-render-v2");
  const f = fixture(), p = f.p;
  p.operation = "publish_business_section_v2";
  p.renderer_version = v2.RENDERER;
  p.business_information = Object.fromEntries(v2.FIELDS.map(k => [k, null]));
  p.field_states = Object.fromEntries(v2.FIELDS.map(k => [k, "not_supplied"]));
  p.snapshot_hash = hash(JSON.stringify(p.business_information));
  p.request_hash = v2.identity(p); p.idempotency_key = v2.key(p);
  f.current.llm.general_prompt = f.old.llm.general_prompt + "\n\n" + v2.section(p);
  f.values.set("refinement:v1:llm:llm_example:section", {
    clientId: p.client_id, agentId: p.agent_id, revision: 1, hash: p.snapshot_hash, key: p.idempotency_key,
    rendererVersion: v2.RENDERER, requestHash: p.request_hash, sectionHash: hash(v2.section(p)),
  });
  const r = await f.send();
  assert.equal(r.renderer_version, v2.RENDERER);
  assert.equal(r.rendered_section_hash, hash(v2.section(p)));
  assert.equal(r.activation_verified, true);
  await f.send();
  assert.equal(f.state.posts, 1);
});
test("first managed section can publish only when all preexisting configuration is identical",async()=>{
  const f=fixture();assertNoUnrelatedDraft(f.current,f.old);
  const r=await f.send();assert.equal(r.state,"active");assert.equal(f.state.posts,1);
  await f.send();assert.equal(f.state.posts,1);
});
test("manual prompt, Scheduler tool or voice changes require review without publication",async()=>{
  for(const change of [
    f=>{f.current.llm.general_prompt="manual\n"+f.current.llm.general_prompt;},
    f=>{f.current.llm.general_tools[0].parameters.time="changed";},
    f=>{f.current.agent.voice_id="other";},
  ]) {const f=fixture();change(f);await assert.rejects(f.send(),{code:"MANUAL_REVIEW_REQUIRED"});assert.equal(f.state.posts,0);}
});
test("publication timeout after commit reconciles without duplicate POST",async()=>{
  const f=fixture();f.state.timeout=true;await assert.rejects(f.send());
  assert.equal((await f.send()).published,true);assert.equal(f.state.posts,1);
});
test("explicit rejection can retry publication without any prompt PATCH",async()=>{
  const f=fixture();f.state.reject=true;await assert.rejects(f.send());
  assert.equal((await f.send()).published,true);assert.equal(f.state.posts,2);
});
test("retry after manual edits cannot publish unrelated changes",async()=>{
  const f=fixture();f.state.reject=true;await assert.rejects(f.send());
  f.current.llm.general_tools.push({name:"manual"});
  await assert.rejects(f.send(),{code:"MANUAL_REVIEW_REQUIRED"});assert.equal(f.state.posts,1);
});
test("pinned old call versions and inbound webhook overrides cannot report active",async()=>{
  for(const change of [f=>{f.state.routeVersion=0;},f=>{f.state.webhook="https://example.invalid/override";}]){
    const f=fixture();change(f);
    await assert.rejects(f.send(),{code:"CALL_ROUTING_REVIEW_REQUIRED"});assert.equal(f.state.posts,0);
  }
});
test("already reviewed and published matching configuration verifies without publication",async()=>{
  const f=fixture();
  f.current.agent.is_published=true;f.current.llm.is_published=true;
  const result=await f.send();
  assert.equal(result.activation_verified,true);assert.equal(result.state,"active");
  assert.equal(f.state.posts,0);
});

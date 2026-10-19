const { test } = require("node:test"), assert = require("node:assert/strict");
const { versionedBusiness } = require("../lib/versioned-business");
const { outboundVersion } = require("../lib/versioned-outbound");
const r = require("../lib/business-render-v2");
const clone = structuredClone;
function body(revision = 2, phase = "draft") {
  const data = Object.fromEntries(r.FIELDS.map(k => [k, null])); data.clientName = "Mock";
  data.pricingPolicies = String(revision * 10);
  const p = { operation: r.OPERATION, client_id: "mock", agent_id: "agent_mock",
    section_id: r.SECTION_ID, revision, business_information: data,
    snapshot_hash: r.hash(JSON.stringify(data)), publish: false, renderer_version: r.RENDERER,
    field_states: Object.fromEntries(r.FIELDS.map(k => [k, data[k] === null ? "not_supplied" : "value"])) };
  p.request_hash = r.identity(p); p.idempotency_key = r.key(p);
  return { ...p, operation: "apply_business_revision_v3", phase, publish: phase === "active", phone_number: "+15555550123" };
}
function fixture() {
  const values = new Map([["agent:agent_mock:client", "mock"]]), calls = [];
  const b = body(1); delete b.phase; delete b.phone_number; b.operation = r.OPERATION;
  const versions = new Map([[0, { agent: { agent_id: "agent_mock", channel: "voice", version: 0, is_published: true,
    response_engine: { type: "retell-llm", llm_id: "llm_mock", version: 10 } },
    llm: { llm_id: "llm_mock", version: 10, is_published: true,
      general_prompt: "SCHEDULER\n" + r.section(b) + "\nBOOKING TOOLS", general_tools: [{ name: "book" }] } }]]);
  let phone = { phone_number: "+15555550123", inbound_agents: [{ agent_id: "agent_mock", agent_version: 0, weight: 1 }],
    outbound_agents: [{ agent_id: "agent_mock", agent_version: 0, weight: 1 }], nickname: "Preserve" };
  const kv = {
    get: async k => clone(values.get(k) ?? null),
    set: async (k, v) => { if (values.has(k)) return null; values.set(k, v); return "OK"; },
    eval: async (script, keys, args) => {
      if (values.get(keys[0]) !== args[0]) return 0;
      if (script.includes('redis.call("del"')) values.delete(keys[0]);
      if (keys.length === 2) values.set(keys[1], JSON.parse(args[1]));
      return 1;
    },
  };
  const axios = {
    get: async (url, options) => {
      const path = new URL(url).pathname, v = options.params?.version;
      calls.push(["GET", path, v]);
      if (path.startsWith("/list-agent-versions")) return { data: { items: [...versions.values()].map(d => ({ version: d.agent.version, is_published: d.agent.is_published })), has_more: false } };
      if (path.startsWith("/get-phone-number")) return { data: clone(phone) };
      assert.ok(Number.isSafeInteger(v), "Every agent/LLM read must be version-specific");
      if (path.startsWith("/get-agent")) return { data: clone(versions.get(v).agent) };
      return { data: clone([...versions.values()].find(d => d.llm.version === v).llm) };
    },
    post: async (url, data) => {
      const path = new URL(url).pathname; calls.push(["POST", path, clone(data)]);
      if (path === "/v2/list-agents") return { data: { items: [{ agent_id: "agent_mock", channel: "voice" }], has_more: false } };
      if (path.startsWith("/create-agent-version")) {
        const d = clone(versions.get(data.base_version)), v = versions.size;
        d.agent.version = v; d.agent.is_published = false; d.agent.response_engine.version = v + 10;
        d.agent.base_version = data.base_version;
        d.llm.version = v + 10; d.llm.is_published = false; versions.set(v, d); return { data: clone(d.agent) };
      }
      assert.equal(path, "/publish-agent-version/agent_mock"); assert.ok(Number.isSafeInteger(data.version));
      versions.get(data.version).agent.is_published = true; versions.get(data.version).llm.is_published = true;
      return { data: {} };
    },
    patch: async (url, data, options) => {
      const path = new URL(url).pathname; calls.push(["PATCH", path, options.params?.version]);
      if (path.startsWith("/update-phone-number")) { phone = { ...phone, ...clone(data) }; return { data: phone }; }
      assert.ok(Number.isSafeInteger(options.params.version));
      [...versions.values()].find(d => d.llm.version === options.params.version).llm.general_prompt = data.general_prompt;
      return { data: {} };
    },
  };
  const args = { kv, axios, base: "https://api.retellai.com", headers: {}, expectedLlm: "llm_mock", findUpgradeHits: () => [] };
  return { values, calls, versions, args, run: b => versionedBusiness({ ...args, body: b }) };
}
test("real contract/lease/adapter: two saves, exact versions, published routing and outbound override", async () => {
  const f = fixture();
  for (const rev of [2, 3]) {
    const draft = await f.run(body(rev)); assert.equal(draft.state, "draft");
    const active = await f.run(body(rev, "active")); assert.equal(active.agent_version, rev - 1);
    assert.equal(active.llm_version, rev + 9); assert.equal(active.activation_verified, true);
    assert.deepEqual(await f.run(body(rev, "active")), active);
    assert.equal(await outboundVersion({ ...f.args, agentId: "agent_mock", phoneNumber: "+15555550123" }), rev - 1);
  }
  assert.equal(f.calls.filter(c => c[1].startsWith("/create-agent-version")).length, 2);
  assert.equal(f.calls.filter(c => c[1].startsWith("/publish-agent-version")).length, 2);
  assert.equal(f.calls.filter(c => c[0] === "PATCH" && c[1].startsWith("/update-retell-llm")).length, 2);
  assert.equal(f.versions.get(1).agent.base_version, 0);
  assert.equal(f.versions.get(2).agent.base_version, 1);
  const serialized = JSON.stringify([...f.values.values()]);
  assert.ok(!serialized.includes("BOOKING TOOLS"), "No prompts in KV journals");
});
test("wrong ownership blocks all external mutations", async () => {
  const f = fixture(); f.values.set("agent:agent_mock:client", "other");
  await assert.rejects(f.run(body()), /CLIENT_AGENT_MISMATCH/);
  assert.equal(f.calls.length, 0);
});
test("maintenance blocks cloning; unrelated clients retain outbound behavior", async () => {
  const f = fixture(); f.values.set("refinement:v1:llm:llm_mock:maintenance", { id: "paused" });
  await assert.rejects(f.run(body()), /AGENT_MAINTENANCE/);
  assert.equal(f.calls.filter(c => c[1].startsWith("/create-agent-version")).length, 0);
  assert.equal(await outboundVersion({ ...f.args, agentId: "agent_unrelated", phoneNumber: "+15555550123" }), undefined);
});
test("lost shared lease prevents every version mutation", async () => {
  const f = fixture(); f.args.kv.eval = async () => 0;
  await assert.rejects(f.run(body()), /LLM_LEASE_LOST/);
  assert.equal(f.calls.filter(c => c[1].startsWith("/create-agent-version")).length, 0);
});
test("outbound verification rejects drift in published prompt", async () => {
  const f = fixture(); await f.run(body()); await f.run(body(2, "active"));
  f.versions.get(1).llm.general_prompt += "manual edit";
  await assert.rejects(outboundVersion({ ...f.args, agentId: "agent_mock", phoneNumber: "+15555550123" }),
    /OUTBOUND_VERSION_UNVERIFIED/);
});
test("outbound verification rejects incorrect published clone lineage", async () => {
  const f = fixture(); await f.run(body()); await f.run(body(2, "active"));
  f.versions.get(1).agent.base_version = 99;
  await assert.rejects(outboundVersion({ ...f.args, agentId: "agent_mock", phoneNumber: "+15555550123" }),
    /OUTBOUND_CONFIGURATION_CHANGED/);
});
test("reviewed already-published matching baseline seeds receipt without a new draft or publication", async () => {
  const f = fixture(); const result = await f.run(body(1, "active"));
  assert.equal(result.agent_version, 0); assert.equal(result.activation_verified, true);
  assert.equal(f.calls.filter(c => c[0] !== "GET" && c[1] !== "/v2/list-agents").length, 0);
});
test("publish:false can never enter publication phase", async () => {
  const f = fixture();
  await assert.rejects(f.run({ ...body(2, "active"), publish: false }), /INVALID_VERSIONED_REQUEST/);
  assert.equal(f.calls.length, 0);
});

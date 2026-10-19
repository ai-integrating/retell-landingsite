const { test } = require("node:test");
const assert = require("node:assert/strict");
const { advance } = require("../lib/versioned-lifecycle");
const clone = structuredClone;
const contract = {
  range: () => ({ start: 0, end: 1 }),
  replaceSection: (prompt, r) => `SCHEDULER_UNCHANGED\nprice=${r.price}`,
  receipt: (r, llm) => ({ ok: true, revision: r.revision, llm_id: llm }),
};
function fixture(fault) {
  let record = null, history = [], hit = false;
  const counts = { create: 0, patch: 0, publish: 0, route: 0 };
  const versions = new Map([[0, { agent: { agent_id: "agent_test", version: 0, is_published: true,
    response_engine: { type: "retell-llm", llm_id: "llm_test", version: 7 } },
    llm: { llm_id: "llm_test", version: 7, is_published: true, general_tools: [{ name: "booking" }],
      general_prompt: "SCHEDULER_UNCHANGED\nprice=10" } }]]);
  let phone = { inbound_agents: [{ agent_id: "agent_test", agent_version: 0, weight: 1 }],
    outbound_agents: [{ agent_id: "agent_test", agent_version: 0, weight: 1 }] };
  async function mutation(name, fn) {
    counts[name]++;
    if (!hit && fault === name + ":before") { hit = true; throw Error("TIMEOUT"); }
    fn();
    if (!hit && fault === name + ":after") { hit = true; throw Error("TIMEOUT"); }
  }
  const io = {
    load: async () => clone(record), store: async r => { record = clone(r); },
    archive: async r => { history.push(clone(r)); },
    phone: async () => clone(phone), read: async v => clone(versions.get(v)),
    versions: async () => [...versions.values()].map(x => ({ version: x.agent.version, is_published: x.agent.is_published })),
    create: async v => mutation("create", () => {
      const d = clone(versions.get(v)), n = versions.size;
      d.agent.version = n; d.agent.is_published = false; d.agent.response_engine.version = n + 7;
      d.llm.version = n + 7; d.llm.is_published = false; versions.set(n, d);
    }),
    patch: async (id, v, prompt) => mutation("patch", () => {
      assert.equal(id, "llm_test"); [...versions.values()].find(x => x.llm.version === v).llm.general_prompt = prompt;
    }),
    publish: async v => mutation("publish", () => { versions.get(v).agent.is_published = true; versions.get(v).llm.is_published = true; }),
    route: async routes => mutation("route", () => { phone = { ...phone, ...clone(routes) }; }),
  };
  const run = (revision = 1, phase = "active") => advance({ io, contract, phase,
    request: { operation: "replace_business_section_v2", agent_id: "agent_test", revision, price: revision * 20 } });
  return { run, io, counts, versions, history, state: () => record, phone: () => phone };
}
test("two successive updates pin exact distinct agent/LLM versions; replay adds no mutations", async () => {
  const f = fixture();
  const draft = await f.run(1, "draft"); assert.equal(draft.agent_version, 1); assert.equal(draft.llm_version, 8);
  assert.equal(f.phone().inbound_agents[0].agent_version, 0);
  const first = await f.run(); assert.equal(first.activation_verified, true);
  assert.deepEqual(await f.run(), first);
  const second = await f.run(2); assert.equal(second.agent_version, 2); assert.equal(second.llm_version, 9);
  assert.deepEqual(await f.run(2), second); assert.equal(f.history.length, 1);
  assert.deepEqual(f.counts, { create: 2, patch: 2, publish: 2, route: 2 });
  assert.equal(f.versions.get(0).llm.general_prompt, "SCHEDULER_UNCHANGED\nprice=10");
  assert.deepEqual(f.versions.get(2).llm.general_tools, f.versions.get(0).llm.general_tools);
});
for (const action of ["create", "patch", "publish", "route"]) {
  test(`${action} committed but response lost: reconcile without duplicate`, async () => {
    const f = fixture(action + ":after"); await assert.rejects(f.run(), /TIMEOUT/);
    const receipt = await f.run(); assert.equal(receipt.activation_verified, true);
    assert.equal(f.counts[action], 1);
  });
}
for (const action of ["create", "patch", "publish"]) {
  test(`${action} uncertain without remote commit: fail closed, no duplicate dispatch`, async () => {
    const f = fixture(action + ":before"); await assert.rejects(f.run(), /TIMEOUT/);
    await assert.rejects(f.run(), /UNRESOLVED/); assert.equal(f.counts[action], 1);
    assert.equal(f.phone().inbound_agents[0].agent_version, 0);
  });
}
test("routing failure before application safely retries verified desired routes", async () => {
  const f = fixture("route:before"); await assert.rejects(f.run(), /TIMEOUT/);
  assert.equal(f.state().status, "routing"); assert.equal((await f.run()).state, "active");
  assert.equal(f.counts.publish, 1);
});
test("manual draft changes block publication and routing", async () => {
  const f = fixture(); await f.run(1, "draft"); f.versions.get(1).llm.general_tools.push({ name: "unsafe" });
  await assert.rejects(f.run(), /CONFIGURATION_CHANGED/); assert.equal(f.counts.publish, 0);
});
test("missing publication baseline is a separate review, no create", async () => {
  const f = fixture(); f.versions.get(0).agent.is_published = false;
  await assert.rejects(f.run(), /INITIAL_PUBLICATION_REVIEW_REQUIRED/); assert.equal(f.counts.create, 0);
});
test("existing unrelated drafts block cloning", async () => {
  const f = fixture(); await f.io.create(0); await assert.rejects(f.run(), /MANUAL_DRAFT_REVIEW_REQUIRED/);
});
test("changed snapshot at same revision is rejected", async () => {
  const f = fixture(); await f.run();
  await assert.rejects(advance({ io: f.io, contract, phase: "active", request: { agent_id: "agent_test", revision: 1, price: 999 } }), /STALE_REVISION/);
});

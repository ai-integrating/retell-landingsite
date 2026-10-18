const { test } = require("node:test");
const assert = require("node:assert/strict");
const v2 = require("../lib/business-render-v2");
const v1 = require("../lib/refinement-section");
function request() {
  const values = Object.fromEntries(v2.FIELDS.map(k => [k, null]));
  values.pricingPolicies = "$14 per cut";
  const p = { operation: v2.OPERATION, renderer_version: v2.RENDERER, client_id: "fixture",
    agent_id: "agent_fixture", section_id: v1.SECTION_ID, revision: 5,
    business_information: values, snapshot_hash: v1.hash(JSON.stringify(values)), publish: false,
    field_states: Object.fromEntries(v2.FIELDS.map(k => [k, k === "pricingPolicies" ? "value" : "not_supplied"])) };
  p.request_hash = v2.identity(p); p.idempotency_key = v2.key(p); return p;
}
test("versioned identity, rendering and receipt; v1 receipt cannot match", () => {
  const p = v2.validate(request()), r = v2.receipt(p, "llm_fixture");
  assert.equal(r.rendered_section_hash, v1.hash(v2.section(p)));
  assert.notDeepEqual(r, v1.receipt(p, "llm_fixture"));
  assert.throws(() => v2.validate({ ...p, renderer_version: "old" }));
  assert.throws(() => v2.validate({ ...p, publish: true }));
  assert.equal(v2.replaceSection("Scheduler\n" + v1.section(p) + "\nTools", p),
    "Scheduler\n" + v2.section(p) + "\nTools");
});
test("clear differs from not supplied even with identical null snapshot", () => {
  const p = request(), q = structuredClone(p);
  q.field_states.serviceArea = "clear";
  assert.notEqual(v2.identity(q), p.request_hash);
  assert.throws(() => v2.validate(q));
  q.request_hash = v2.identity(q); q.idempotency_key = v2.key(q); v2.validate(q);
  assert.notEqual(v2.comparison({}, p)[2].action, v2.comparison({}, q)[2].action);
  assert.throws(() => v2.validate({ ...q, field_states: { ...q.field_states, pricingPolicies: "clear" } }));
});

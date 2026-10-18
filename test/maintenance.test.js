const { test } = require("node:test");
const assert = require("node:assert/strict");
const { maintenance, PAUSE, RESUME } = require("../lib/refinement-maintenance");
const { withLlm, RENEW, RELEASE, GUARDED_SET } = require("../lib/refinement-coordinator");
function fixture() {
  const values = new Map();
  const kv = {
    async get(k) { return values.get(k) ?? null; },
    async set(k, v) { if (values.has(k)) return null; values.set(k, v); return "OK"; },
    async eval(script, keys, args) {
      if (script === PAUSE || script === RESUME) {
        if (values.has(keys[0])) return -1;
        const current = values.get(keys[1]);
        if (script === PAUSE) {
          if (current && current !== args[0]) return -2;
          values.set(keys[1], args[0]); return 1;
        }
        if (current !== args[0]) return -2;
        values.delete(keys[1]); return 1;
      }
      if (values.get(keys[0]) !== args[0]) return 0;
      if (script === RELEASE) { values.delete(keys[0]); return 1; }
      if (script === RENEW) return 1;
      assert.equal(script, GUARDED_SET);
      values.set(keys[1], JSON.parse(args[1])); return 1;
    },
  };
  const options = { kv, llmId: "llm_test", getPrompt: async () => "Scheduler unchanged",
    patchPrompt: async () => { throw Error("unexpected prompt mutation"); } };
  return { kv, values, options };
}
test("maintenance pause is idempotent, blocks writers and requires matching owner to resume", async () => {
  const f = fixture(), id = "maintenance_owner_123";
  await maintenance(f.kv, "llm_test", "pause", id);
  await maintenance(f.kv, "llm_test", "pause", id);
  await assert.rejects(withLlm(f.options, () => {}), { code: "AGENT_MAINTENANCE" });
  await assert.rejects(maintenance(f.kv, "llm_test", "resume", "another_owner_1234"));
  await maintenance(f.kv, "llm_test", "resume", id);
  assert.equal(await withLlm(f.options, () => "success"), "success");
});
test("pause does not claim an in-flight writer has drained", async () => {
  const f = fixture();
  await withLlm(f.options, async () => {
    await assert.rejects(maintenance(f.kv, "llm_test", "pause", "maintenance_owner_123"), { code: "WRITER_IN_FLIGHT" });
  });
});
test("unresolved configuration blocks every later writer and maintenance resume", async () => {
  const f = fixture();
  await assert.rejects(withLlm(f.options, ({ applyConfiguration }) => applyConfiguration({
    read: async () => ({ general_tools: [{ name: "existing", settings: { enabled: true } }] }),
    expected: { general_tools: [{ name: "changed", settings: { enabled: false } }] },
    patch: async () => { throw Error("uncertain timeout"); },
  })));
  await assert.rejects(withLlm(f.options, () => {}), { code: "CONFIGURATION_OUTCOME_UNRESOLVED" });
  await maintenance(f.kv, "llm_test", "pause", "maintenance_owner_123");
  await assert.rejects(maintenance(f.kv, "llm_test", "resume", "maintenance_owner_123"), { code: "UNRESOLVED_WRITER" });
});
test("confirmed configuration preserves nested data and identical retry skips PATCH", async () => {
  const f = fixture();
  let current = { tools: [{ nested: { value: 1 } }] }, patches = 0;
  const expected = { tools: [{ nested: { value: 2 } }] };
  const work = ({ applyConfiguration }) => applyConfiguration({
    read: async () => current, expected, patch: async () => { patches++; current = expected; },
  });
  await withLlm(f.options, work); await withLlm(f.options, work);
  assert.equal(patches, 1);
  assert.equal(f.values.get("refinement:v1:llm:llm_test:configuration").status, "confirmed");
});
test("maintenance on one LLM does not pause another", async () => {
  const f = fixture();
  await maintenance(f.kv, "llm_other", "pause", "maintenance_owner_123");
  assert.equal(await withLlm(f.options, () => "success"), "success");
});

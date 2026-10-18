const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

// No real KV/Retell modules are loaded. Lua behavior is modeled, not a live
// Redis integration test; assertions also protect its argument/TTL contract.
function fixture({ mapping = "client_fixture", record = {
  agent_id: "agent_fixture", status: "completed", calendar: { preserved: true },
}, phone } = {}) {
  const records = new Map();
  if (mapping) records.set("agent:agent_fixture:client", mapping);
  if (record) records.set("prov:1234567890123", structuredClone(record));
  if (phone) records.set("agent:agent_fixture:phone", phone);
  const writes = [];
  const kv = {
    async get(key) { return records.get(key); },
    async set(key, value) { writes.push(key); records.set(key, value); },
    async eval(script, keys, args) {
      assert.match(script, /"KEEPTTL"/);
      assert.match(script, /record\.agent_id ~= ARGV\[1\]/);
      assert.match(script, /record\.phone_number = ARGV\[2\]/);
      assert.equal(keys.length, 1);
      assert.equal(args.length, 4);
      const r = records.get(keys[0]);
      if (!r) return "Provisioning record not found";
      if (r.agent_id !== args[0]) return "Provisioning agent ID does not match";
      if (r.phone_number && r.phone_number !== "(not purchased)" && r.phone_number !== args[1])
        return "Provisioning record already has a different phone";
      r.phone_number = args[1];
      if (args[2]) r.phone_number_id = args[2];
      r.updated_at = args[3];
      writes.push(keys[0]);
      return "updated";
    },
  };
  const sandbox = { module: { exports: {} }, process: { env: { KV_ADMIN_SECRET: "fixture-only" } },
    console: { error() {} }, require(name) {
      assert.equal(name, "@vercel/kv"); return { kv };
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../api/kv-set-agent-client.js"), "utf8"), sandbox);
  return { records, writes, async run(extra = {}) {
    let result;
    const res = { statusCode: 0, setHeader() {}, end(body) { result = JSON.parse(body); } };
    await sandbox.module.exports({ method: "POST", body: {
      admin_secret: "fixture-only", agent_id: "agent_fixture", client_id: "client_fixture",
      submission_id: "1234567890123", phone: "+12025550123", phone_number_id: "phone_fixture", ...extra,
    } }, res);
    return { status: res.statusCode, body: result };
  } };
}
test("phone persists in provisioning record and agent key without replacing other fields", async () => {
  const f = fixture();
  assert.equal((await f.run()).status, 200);
  const r = f.records.get("prov:1234567890123");
  assert.equal(r.phone_number, "+12025550123");
  assert.equal(r.phone_number_id, "phone_fixture");
  assert.equal(r.status, "completed");
  assert.deepEqual(r.calendar, { preserved: true });
  assert.equal(f.records.get("agent:agent_fixture:phone"), r.phone_number);
  assert.ok(!f.writes.includes("agent:agent_fixture:client"));
});
test("same request replay preserves existing client mapping", async () => {
  const f = fixture();
  await f.run();
  assert.equal((await f.run()).body.already_set, true);
  assert.equal(f.records.get("agent:agent_fixture:client"), "client_fixture");
});
test("conflicting client mapping rejects without any writes", async () => {
  const f = fixture({ mapping: "other_client" });
  assert.equal((await f.run()).status, 409);
  assert.equal(f.writes.length, 0);
});
test("existing mapping plus missing or mismatched provisioning record fails without phone writes", async () => {
  for (const record of [null, { agent_id: "other_agent" },
    { agent_id: "agent_fixture", phone_number: "+12025550999" }]) {
    const f = fixture({ record });
    assert.equal((await f.run()).status, 500);
    assert.equal(f.writes.length, 0);
  }
});
test("legacy requests without submission ID still persist phone only", async () => {
  const f = fixture();
  assert.equal((await f.run({ submission_id: undefined })).status, 200);
  assert.deepEqual(f.writes, ["agent:agent_fixture:phone"]);
});
test("new client mapping and provisioning phone both persist", async () => {
  const f = fixture({ mapping: null });
  assert.equal((await f.run()).body.set, true);
  assert.equal(f.records.get("agent:agent_fixture:client"), "client_fixture");
  assert.equal(f.records.get("prov:1234567890123").phone_number, "+12025550123");
});
test("unauthorized call leaves every key unchanged", async () => {
  const f = fixture();
  assert.equal((await f.run({ admin_secret: "wrong" })).status, 401);
  assert.equal(f.writes.length, 0);
});

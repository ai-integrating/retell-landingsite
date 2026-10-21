const { test } = require("node:test");
const assert = require("node:assert/strict");
const { enrollment, grantFor, key } = require("../lib/business-enrollment");
const { createHandler } = require("../api/business-enrollment");
const { withLlm } = require("../lib/refinement-coordinator");
const { BEGIN, END } = require("../lib/refinement-section");
function fixture() {
  const values = new Map([["agent:agent_fixture:client", "fixture"]]);
  const agent = { agent_id: "agent_fixture", version: 2, is_published: true,
    response_engine: { type: "retell-llm", llm_id: "llm_fixture", version: 4 } };
  const llm = { llm_id: "llm_fixture", version: 4, is_published: true,
    general_prompt: `Preserve greeting and Scheduler\n${BEGIN}\nBusiness data\n${END}`, general_tools: [{ name: "synthetic" }] };
  const phone = { phone_number: "+15555550111", inbound_agents: [{ agent_id: agent.agent_id, agent_version: 2, weight: 1 }],
    outbound_agents: [{ agent_id: agent.agent_id, agent_version: 2, weight: 1 }] };
  let versions = [{ version: 2, is_published: true }];
  const kv = {
    get: async k => structuredClone(values.get(k) ?? null),
    set: async (k, v) => { if (values.has(k)) return null; values.set(k, v); return "OK"; },
    eval: async (s, keys, args) => {
      if (values.get(keys[0]) !== args[0]) return 0;
      if (s.includes('redis.call("del"')) values.delete(keys[0]);
      if (keys.length === 2) values.set(keys[1], JSON.parse(args[1]));
      if (keys.length === 5) {
        const previous = values.get(keys[1]);
        if (previous && (!Number.isSafeInteger(previous.generation) || previous.generation >= args[4])) return -1;
        values.set(keys[1], JSON.parse(args[1])); values.set(keys[2], JSON.parse(args[2]));
        values.set(keys[3], JSON.parse(args[1])); values.set(keys[4], JSON.parse(args[3]));
      }
      return 1;
    },
  };
  const axios = {
    get: async (url, options) => {
      if (url.includes("/get-phone-number/")) return { data: structuredClone(phone) };
      if (url.includes("/list-agent-versions/")) return { data: { items: versions, has_more: false } };
      const obj = url.includes("/get-agent/") ? agent : llm;
      assert.equal(options.params.version, obj.version);
      return { data: structuredClone(obj) };
    },
    post: async url => {
      assert.ok(url.endsWith("/v2/list-agents"), "No publication or creation");
      return { data: { items: [{ agent_id: agent.agent_id, channel: "voice" }], has_more: false } };
    },
    patch: async () => { throw Error("NO_RETELL_WRITES"); },
  };
  const body = { action: "inspect", client_id: "fixture", agent_id: agent.agent_id, phone_number: phone.phone_number };
  const deps = { body, kv, axios, base: "https://mock.invalid", headers: {} };
  const run = change => enrollment({ ...deps, body: { ...body, generation: 1, ...change } });
  const approve = async () => {
    const evidence = await run({});
    const command = { action: "approve", request_id: "approve-1", expected_fingerprint: evidence.fingerprint };
    return { evidence, command, receipt: await run(command) };
  };
  return { deps, values, agent, llm, phone, run, approve, setVersions: v => { versions = v; } };
}
test("inspection, approval, lost response, retry, revoke and stale replay preserve history", async () => {
  const f = fixture(), { receipt, command } = await f.approve();
  assert.equal(receipt.enabled, true);
  assert.deepEqual(await f.run(command), receipt);
  assert.equal((await grantFor(f.deps.kv, f.deps.body)).llm_id, "llm_fixture");
  const revoke = { action: "revoke", generation: 2, request_id: "revoke-1", expected_fingerprint: receipt.fingerprint };
  assert.equal((await f.run(revoke)).enabled, false);
  assert.equal((await f.run(revoke)).enabled, false);
  await assert.rejects(f.run(command), /ENROLLMENT_SUPERSEDED/);
  assert.equal(await grantFor(f.deps.kv, f.deps.body), null);
  assert.ok([...f.values.keys()].some(k => k.includes(":history:")));
});
test("missing, duplicate, reversed and incomplete managed sections block inspection and approval", async () => {
  for (const prompt of ["No managed section", `${BEGIN}missing end`, `${END}reverse${BEGIN}`,
    `${BEGIN}one${END}${BEGIN}two${END}`]) {
    const f = fixture(); f.llm.general_prompt = prompt;
    const evidence = await f.run({});
    assert.equal(evidence.status, "blocked");
    assert.ok(evidence.issues.some(i => i.startsWith("MANAGED_SECTION_")));
    await assert.rejects(f.run({ action: "approve", request_id: "missing", expected_fingerprint: evidence.fingerprint }),
      /ENROLLMENT_REVIEW_CHANGED/);
    assert.equal(f.values.has(key(f.agent.agent_id)), false);
  }
});
test("revocation fences unseen delayed approvals, equal generations, and stale replay; newer approval works", async () => {
  const f = fixture(), { receipt } = await f.approve();
  await f.run({ action: "revoke", generation: 4, request_id: "revoke", expected_fingerprint: receipt.fingerprint });
  for (const generation of [1, 2, 3, 4]) {
    await assert.rejects(f.run({ action: "approve", generation, request_id: `unseen-${generation}`,
      expected_fingerprint: receipt.fingerprint }), /ENROLLMENT_SUPERSEDED/);
  }
  const command = { action: "approve", generation: 5, request_id: "new-review", expected_fingerprint: receipt.fingerprint };
  const next = await f.run(command);
  assert.equal(next.generation, 5);
  assert.deepEqual(await f.run(command), next);
  await assert.rejects(f.run({ ...command, generation: 6 }), /ENROLLMENT_RETRY_MISMATCH/);
});
test("revocation before first approval stores a durable high-water mark", async () => {
  const f = fixture(), e = await f.run({});
  await f.run({ action: "revoke", generation: 3, request_id: "cancel-unseen", expected_fingerprint: e.fingerprint });
  await assert.rejects(f.run({ action: "approve", generation: 2, request_id: "delayed-first",
    expected_fingerprint: e.fingerprint }), /ENROLLMENT_SUPERSEDED/);
  assert.equal(await grantFor(f.deps.kv, f.deps.body), null);
});
test("generation is required and atomic storage rejects competing stale generations", async () => {
  const f = fixture(), e = await f.run({});
  for (const generation of [undefined, 0, -1, 1.5, "1"])
    await assert.rejects(f.run({ action: "approve", generation, request_id: "bad", expected_fingerprint: e.fingerprint }),
      /INVALID_ENROLLMENT_REQUEST/);
  await f.approve();
  await assert.rejects(withLlm({ kv: f.deps.kv, llmId: "llm_fixture", versionLifecycle: true,
    getPrompt: async () => f.llm.general_prompt }, async ctx => {
    const current = await f.deps.kv.get(key(f.agent.agent_id));
    await ctx.storeEnrollment(key(f.agent.agent_id), { ...current, generation: 1, request_id: "racing" });
  }), /ENROLLMENT_SUPERSEDED/);
});
test("different client, phone, agent, and held client cannot use a grant", async () => {
  const f = fixture(); await f.approve();
  for (const change of [{ client_id: "other" }, { agent_id: "agent_other" }, { phone_number: "+15555550112" },
    { client_id: "test-6595816177431939415" }])
    assert.equal(await grantFor(f.deps.kv, { ...f.deps.body, ...change }), null);
});
test("changed prompt or tools invalidates previously reviewed fingerprint", async () => {
  for (const field of ["general_prompt", "general_tools"]) {
    const f = fixture(), e = await f.run({});
    f.llm[field] = field === "general_prompt" ? "manual edit" : [{ name: "changed" }];
    await assert.rejects(f.run({ action: "approve", request_id: "approve", expected_fingerprint: e.fingerprint }),
      /ENROLLMENT_REVIEW_CHANGED/);
    assert.equal(f.values.has(key(f.agent.agent_id)), false);
  }
});
test("missing mapping, unpublished baseline, omitted route and split routing require review", async () => {
  for (const mutate of [
    f => f.values.delete("agent:agent_fixture:client"),
    f => { f.agent.is_published = false; },
    f => { delete f.phone.inbound_agents[0].agent_version; },
    f => { f.phone.outbound_agents.push({ agent_id: "other", agent_version: 2 }); },
  ]) {
    const f = fixture(); mutate(f); assert.equal((await f.run({})).status, "blocked");
  }
});
test("unresolved journal and maintenance block preparation; writer lease blocks approval", async () => {
  for (const [name, value] of [["journal", { status: "uncertain" }], ["maintenance", true], ["versions", { status: "patching" }]]) {
    const f = fixture(); f.values.set(`refinement:v1:llm:llm_fixture:${name}`, value);
    assert.equal((await f.run({})).status, "blocked");
  }
  const f = fixture(), evidence = await f.run({});
  f.values.set("refinement:v1:llm:llm_fixture:lock", "another-writer");
  await assert.rejects(f.run({ action: "approve", request_id: "busy", expected_fingerprint: evidence.fingerprint }), /LLM_BUSY/);
});
test("approval fences legacy writers even before first portal save", async () => {
  const f = fixture(); await f.approve();
  await assert.rejects(withLlm({ kv: f.deps.kv, llmId: "llm_fixture", getPrompt: async () => f.llm.general_prompt },
    () => { throw Error("MUST_NOT_REACH_WRITER"); }), /VERSIONED_AGENT_REQUIRES_PORTAL/);
});
test("inspection does not write KV and rejects incomplete ownership pagination", async () => {
  const f = fixture(), before = structuredClone(f.values);
  await f.run({}); assert.deepEqual(f.values, before);
  f.deps.axios.post = async () => ({ data: [] });
  await assert.rejects(f.run({}), /OWNERSHIP_LIST_INCOMPLETE/);
});
test("management endpoint needs dedicated maintenance secret, not refinement secret", async () => {
  const f = fixture();
  for (const supplied of [undefined, "wrong"]) {
    const res = { setHeader() {}, status(n) { this.code = n; return this; }, json(v) { this.value = v; return this; } };
    await createHandler({ ...f.deps, secret: "operator-secret", apiKey: "mock" })(
      { method: "POST", headers: { "x-maintenance-secret": supplied }, body: f.deps.body }, res);
    assert.equal(res.code, 401); assert.equal(f.values.size, 1);
  }
});

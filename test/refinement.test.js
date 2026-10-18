const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("../api/refinement");
const { hash, OPERATION, SECTION_ID, BEGIN, END, FIELDS } = require("../lib/refinement-section");
const { RENEW, RELEASE, GUARDED_SET } = require("../lib/refinement-coordinator");

const SECRET = "mock-refinement-secret-never-a-real-credential";
function body(revision = 1, edits = {}) {
  const snapshot = Object.fromEntries(FIELDS.map(field => [field, null]));
  Object.assign(snapshot, { clientName: "Example business", serviceArea: "Example town" }, edits);
  const digest = hash(JSON.stringify(snapshot));
  return { operation: OPERATION, client_id: "example-client", agent_id: "agent_example",
    section_id: SECTION_ID, revision, snapshot_hash: digest,
    idempotency_key: `business:example-client:agent_example:${revision}:${digest}`,
    business_information: snapshot, publish: false };
}
function fixture({ prompt = "SYSTEM\r\nScheduler: keep appointment types, calendar tools and booking logic exactly.\r\n", enabled = true } = {}) {
  const values = new Map([["agent:agent_example:client", "example-client"]]);
  const writes = [];
  const calls = [];
  const agent = { agent_id: "agent_example", channel: "voice", version: 7, is_published: false, response_engine: { type: "retell-llm", llm_id: "llm_example", version: 3 } };
  const state = { prompt, agents: [agent], agent, patches: 0, publishCalls: 0, patch: null, afterGet: null, failCommit: false };
  const kv = {
    async get(key) { return structuredClone(values.get(key) ?? null); },
    async set(key, value, options = {}) {
      if (options.nx && values.has(key)) return null;
      values.set(key, structuredClone(value)); writes.push(key); return "OK";
    },
    async eval(script, keys, args) {
      if (values.get(keys[0]) !== args[0]) return 0;
      if (script === RENEW) return 1;
      if (script === RELEASE) { values.delete(keys[0]); return 1; }
      assert.equal(script, GUARDED_SET);
      const value = JSON.parse(args[1]);
      if (state.failCommit && value.status === "confirmed") { state.failCommit = false; throw Error("Mock durable completion outage"); }
      writes.push(keys[1]); values.set(keys[1], value); return 1;
    },
  };
  const axios = {
    async get(url, options) {
      calls.push(url);
      if (url.endsWith("/v2/list-agents")) return { data: Array.isArray(state.agents) ? { items: state.agents, has_more: false } : state.agents };
      if (url.includes("/list-agent-versions/")) return { data: { items: [{ version: 6, is_published: true }, { version: 7, is_published: state.agent.is_published }], has_more: false } };
      if (url.includes("/get-agent/") && !url.endsWith("/get-agent/agent_example")) {
        return { data: state.agents.find(a => url.endsWith(`/get-agent/${a.agent_id}`)) };
      }
      if (url.endsWith("/get-agent/agent_example")) return { data: options?.params?.version === 6
        ? { ...agent, version:6,is_published:true,response_engine:{type:"retell-llm",llm_id:"llm_example",version:2} }
        : structuredClone(state.agent) };
      if (url.endsWith("/list-agents")) return { data: structuredClone(state.agents) };
      assert.ok(url.endsWith("/get-retell-llm/llm_example"));
      if(options?.params?.version===2) return {data:{general_prompt:prompt,llm_id:"llm_example",version:2,is_published:true}};
      const result = { data: { general_prompt: options?.params?.version !== undefined && state.publishedPrompt !== undefined ? state.publishedPrompt : state.prompt,
        llm_id: "llm_example", version: 3, is_published: state.agent.is_published } };
      if (options?.params?.version !== undefined) assert.equal(options.params.version, 3);
      if (state.afterGet) state.afterGet();
      return result;
    },
    async patch(url, input) {
      calls.push(url); state.patches++;
      assert.ok(url.endsWith("/update-retell-llm/llm_example"));
      assert.deepEqual(Object.keys(input), ["general_prompt"]);
      if (state.patch) await state.patch(input.general_prompt);
      else state.prompt = input.general_prompt;
      return { data: { private_upstream_field: "must not be in response" } };
    },
    async post(url, body, options) {
      if (url.endsWith("/v2/list-agents")) {
        assert.deepEqual(body, {});
        return axios.get(url, options);
      }
      state.publishCalls++;
      if (state.publish) return state.publish();
      state.agent.is_published = true;
      return { data: { ok: true } };
    },
  };
  const handler = createHandler({ axios, kv, apiKey: "mock-api-key", secret: SECRET, enableSection: enabled });
  async function invoke(input = body(), { secret = SECRET, selectedHandler = handler } = {}) {
    const result = { status: 200, headers: {} };
    const res = {
      setHeader(key, value) { result.headers[key] = value; },
      status(value) { result.status = value; return this; },
      json(value) { result.body = value; return this; },
      send(value) { result.body = value; return this; },
    };
    await selectedHandler({ method: "POST", headers: { "x-refinement-secret": secret }, body: input }, res);
    return result;
  }
  return { state, values, writes, calls, kv, axios, invoke };
}
const legacy = overrides => ({ agent_id: "agent_example", category: "pricing", update_text: "Prices require a written estimate", request_id: "legacy-fixture", ...overrides });
const code = result => result.body.detail?.code;

test("test runner blocks real networking", async () => {
  await assert.rejects(async () => fetch("https://example.invalid"), /TEST_NETWORK_BLOCKED/);
  assert.throws(() => require("node:https").get("https://example.invalid"), /TEST_NETWORK_BLOCKED/);
});
test("unknown explicit operations never fall through; disabled operation makes no calls", async () => {
  const f = fixture({ enabled: false });
  assert.equal((await f.invoke(body())).status, 503);
  for (const operation of ["append_something", "", null]) {
    const result = await f.invoke({ ...legacy(), operation });
    assert.equal(result.status, 400); assert.equal(code(result), "UNKNOWN_OPERATION");
  }
  assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
});
test("missing/wrong/unset secrets are sanitized with no external calls", async () => {
  const f = fixture();
  for (const secret of ["", "private-wrong-value"]) {
    const r = await f.invoke(body(), { secret });
    assert.equal(r.status, 401);
    assert.ok(!JSON.stringify(r).includes(secret || "mock-refinement"));
    assert.equal(r.body.detail, null);
  }
  const unset = createHandler({ axios: f.axios, kv: f.kv, apiKey: "mock", secret: "" });
  assert.equal((await f.invoke(body(), { selectedHandler: unset })).status, 500);
  assert.equal(f.calls.length, 0);
});
test("validates complete schema, canonical hash, keys, revision and publish:false", async () => {
  const invalid = [
    { publish: true }, { revision: 0 }, { revision: 1.2 }, { revision: "1" },
    { snapshot_hash: "wrong" }, { idempotency_key: "wrong" }, { section_id: "other" },
    { llm_id: "llm_arbitrary" }, { client_id: "../other" }, { agent_id: "../other" },
    { business_information: { clientName: "only one field" } },
    { business_information: { ...body().business_information, unexpected: "value" } },
  ];
  for (const changes of invalid) {
    const f = fixture();
    assert.equal((await f.invoke({ ...body(), ...changes })).status, 400, JSON.stringify(changes));
    assert.equal(f.state.patches, 0); assert.equal(f.writes.length, 0);
  }
});
test("checks existing KV ownership without modifying mapping", async () => {
  for (const mapping of [null, "different-client", { client_id: "example-client" }]) {
    const f = fixture(); f.values.set("agent:agent_example:client", mapping);
    assert.equal((await f.invoke()).status, 403);
    assert.deepEqual(f.values.get("agent:agent_example:client"), mapping);
    assert.equal(f.writes.length, 0); assert.equal(f.calls.length, 0);
  }
});
test("rejects shared, non-LLM or unverified LLM ownership", async () => {
  for (const mode of ["shared", "missing", "envelope", "non-llm"]) {
    const f = fixture();
    if (mode === "shared") f.state.agents.push({ ...f.state.agent, agent_id: "agent_other" });
    if (mode === "missing") f.state.agents = [];
    if (mode === "envelope") f.state.agents = { agents: [f.state.agent], next: "page2" };
    if (mode === "non-llm") f.state.agent.response_engine.type = "custom-llm";
    assert.ok([409, 503].includes((await f.invoke()).status));
    assert.equal(f.state.patches, 0);
  }
});
test("preserves package restrictions on both request formats", async () => {
  const f = fixture();
  assert.equal((await f.invoke(body(1, { pricingPolicies: "notify by sms" }))).status, 402);
  assert.equal((await f.invoke(legacy({ update_text: "notify by sms" }))).status, 402);
  assert.equal((await f.invoke(legacy({ category: "new-feature" }))).status, 400);
  assert.equal(f.state.patches, 0);
});
test("first save preserves entire prompt, retries do not duplicate, receipts contain no upstream data", async () => {
  const f = fixture(); const original = f.state.prompt;
  const first = await f.invoke();
  assert.equal(first.status, 200);
  assert.ok(f.state.prompt.startsWith(original + "\n\n" + BEGIN));
  assert.equal(first.body.state, "draft"); assert.equal(first.body.published, false);
  assert.deepEqual(Object.keys(first.body).sort(), ["ok", "operation", "client_id", "agent_id", "llm_id",
    "section_id", "revision", "snapshot_hash", "idempotency_key", "state", "published"].sort());
  const retry = await f.invoke();
  assert.deepEqual(retry.body, first.body); assert.equal(f.state.patches, 1);
  assert.equal(f.state.publishCalls, 0);
  assert.ok(f.writes.every(key => key.startsWith("refinement:v1:llm:llm_example:")));
});
test("replacements preserve exact Scheduler prefix/suffix, old patches and whitespace", async () => {
  const f = fixture({ prompt: "  Scheduler\r\nBOOK EXACTLY\r\nREFINEMENT PATCH\nold instructions  \r\n" });
  const prefix = f.state.prompt + "\n\n";
  await f.invoke(body(1, { pricingPolicies: "Old price" }));
  const suffix = "\r\n \tScheduler tools JSON remains here: {\"event_types\":[1,2,3]}\r\n  ";
  f.state.prompt += suffix; // mocked out-of-band suffix before the next request
  assert.equal((await f.invoke(body(2, { pricingPolicies: "New price" }))).status, 200);
  const p = f.state.prompt;
  assert.equal(p.slice(0, p.indexOf(BEGIN)), prefix);
  assert.equal(p.slice(p.indexOf(END) + END.length), suffix);
  assert.ok(!p.includes("Old price")); assert.ok(p.includes("old instructions"));
  assert.equal(p.split(BEGIN).length - 1, 1);
});
test("null and empty values intentionally clear prior managed data; marker injection is quoted", async () => {
  const f = fixture();
  await f.invoke(body(1, { businessDescription: "To be removed", serviceArea: "Previous town" }));
  assert.equal((await f.invoke(body(2, { businessDescription: "", serviceArea: null, pricingPolicies: BEGIN + END }))).status, 200);
  assert.ok(!f.state.prompt.includes("To be removed"));
  assert.ok(!f.state.prompt.includes("Previous town"));
  assert.ok(f.state.prompt.includes('"businessDescription": ""'));
  assert.ok(f.state.prompt.includes('"serviceArea": null'));
  assert.equal(f.state.prompt.split(BEGIN).length - 1, 1);
});
test("one-sided, duplicate and reversed markers fail without a PATCH", async () => {
  for (const prompt of [BEGIN, END, END + BEGIN, BEGIN + END + BEGIN + END]) {
    const f = fixture({ prompt });
    const r = await f.invoke();
    assert.equal(r.status, 409); assert.equal(code(r), "AMBIGUOUS_SECTION_MARKERS");
    assert.equal(f.state.prompt, prompt); assert.equal(f.state.patches, 0);
  }
});
test("oversized update rejects without truncating existing instructions", async () => {
  const original = "x".repeat(23999);
  const f = fixture({ prompt: original });
  assert.equal((await f.invoke()).status, 413);
  assert.equal(f.state.prompt, original); assert.equal(f.state.patches, 0);
  assert.equal((await f.invoke(legacy())).status, 413);
  assert.equal(f.state.prompt, original);
});
test("stale and same-revision/different-hash requests cannot overwrite newer data", async () => {
  const f = fixture();
  await f.invoke(body(1)); await f.invoke(body(2, { serviceArea: "New area" }));
  assert.equal(code(await f.invoke(body(1))), "STALE_REVISION");
  assert.equal(code(await f.invoke(body(2, { serviceArea: "Other area" }))), "REVISION_CONFLICT");
  assert.equal(f.state.patches, 2);
});
test("missing durable state or section drift fails closed", async () => {
  const f = fixture(); await f.invoke();
  f.state.prompt = f.state.prompt.replace("Example town", "Manually edited town");
  assert.equal(code(await f.invoke()), "SECTION_DRIFT");
  assert.equal(code(await f.invoke(body(2))), "SECTION_DRIFT");
  f.values.delete("refinement:v1:llm:llm_example:section");
  assert.equal(code(await f.invoke(body(2))), "UNTRACKED_SECTION");
  assert.equal(f.state.patches, 1);
});
test("legacy format and section operation share the same per-LLM coordination", async () => {
  for (const first of [body(), legacy()]) {
    const f = fixture();
    let release, start;
    const started = new Promise(resolve => { start = resolve; });
    f.state.patch = async prompt => { start(); await new Promise(resolve => { release = resolve; }); f.state.prompt = prompt; };
    const pending = f.invoke(first); await started;
    const competing = await f.invoke(first.operation ? legacy() : body());
    assert.equal(competing.status, 409); assert.equal(code(competing), "LLM_BUSY");
    release(); assert.equal((await pending).status, 200);
    assert.equal(f.state.patches, 1);
  }
});
test("competing business revisions serialize and retry against latest state", async () => {
  const f = fixture(); let release, start;
  const started = new Promise(resolve => { start = resolve; });
  f.state.patch = async prompt => { start(); await new Promise(resolve => { release = resolve; }); f.state.prompt = prompt; };
  const pending = f.invoke(body(2)); await started;
  assert.equal((await f.invoke(body(1))).status, 409);
  release(); await pending; f.state.patch = null;
  assert.equal(code(await f.invoke(body(1))), "STALE_REVISION");
});
test("timeout after successful remote write recovers durably without another PATCH", async () => {
  const f = fixture();
  f.state.patch = async prompt => { f.state.prompt = prompt; throw Error("timeout with private upstream data"); };
  assert.equal((await f.invoke()).status, 502);
  f.state.patch = null;
  const retried = await f.invoke();
  assert.equal(retried.status, 200); assert.equal(f.state.patches, 1);
  assert.equal(f.values.get("refinement:v1:llm:llm_example:journal").status, "confirmed");
});
test("unknown timeout outcome blocks both writers; delayed completion can be reconciled", async () => {
  const f = fixture(); let delayed;
  f.state.patch = async prompt => { delayed = prompt; throw Error("timeout"); };
  await f.invoke();
  assert.equal(code(await f.invoke()), "UPDATE_OUTCOME_UNRESOLVED");
  assert.equal(code(await f.invoke(legacy())), "UPDATE_OUTCOME_UNRESOLVED");
  assert.equal(f.state.patches, 1);
  f.state.prompt = delayed; f.state.patch = null;
  assert.equal((await f.invoke()).status, 200); assert.equal(f.state.patches, 1);
});
test("KV completion outage recovers using persisted intent and actual prompt", async () => {
  const f = fixture(); f.state.failCommit = true;
  assert.equal((await f.invoke()).status, 502);
  assert.equal((await f.invoke()).status, 200); assert.equal(f.state.patches, 1);
});
test("expired lock does not allow a newer PATCH while original outcome is unknown", async () => {
  const f = fixture(); let release, start;
  const started = new Promise(resolve => { start = resolve; });
  f.state.patch = async prompt => { start(); await new Promise(resolve => { release = resolve; }); f.state.prompt = prompt; };
  const pending = f.invoke(); await started;
  f.values.delete("refinement:v1:llm:llm_example:lock"); // simulate expiry
  assert.equal(code(await f.invoke(body(2))), "UPDATE_OUTCOME_UNRESOLVED");
  release(); assert.equal((await pending).status, 409); // old token cannot commit
  f.state.patch = null;
  assert.equal((await f.invoke()).status, 200); assert.equal(f.state.patches, 1);
});
test("legacy aliases and idempotency are preserved, raw Retell response is not returned", async () => {
  const f = fixture();
  const first = await f.invoke(legacy());
  assert.equal(first.status, 200); assert.equal(first.body.published, false);
  assert.equal(first.body.refinement_request_id, "legacy-fixture");
  assert.ok(!JSON.stringify(first).includes("private_upstream_field"));
  assert.equal((await f.invoke(legacy())).body.skipped, true);
  assert.equal(f.state.patches, 1);
});
test("legacy may not inject managed markers; errors never echo upstream secrets", async () => {
  const f = fixture();
  assert.equal((await f.invoke(legacy({ update_text: BEGIN }))).status, 400);
  f.state.patch = async () => { const err = new Error("SECRET DATA"); err.response = { status: 500, data: "SECRET DATA" }; throw err; };
  const r = await f.invoke();
  assert.equal(r.status, 502); assert.ok(!JSON.stringify(r).includes("SECRET DATA"));
});
test("detects a prompt edit between planning and PATCH", async () => {
  const f = fixture();
  f.state.afterGet = () => { f.state.prompt += " changed outside coordination"; f.state.afterGet = null; };
  const result = await f.invoke();
  assert.equal(result.status, 409);
  assert.equal(code(result), "PROMPT_CHANGED");
  assert.equal(f.state.patches, 0);
});
test("canonical snapshot hash does not depend on incoming object property order", async () => {
  const f = fixture();
  const request = body();
  request.business_information = Object.fromEntries(Object.entries(request.business_information).reverse());
  assert.equal((await f.invoke(request)).status, 200);
});
test("explicit publication rejection retries publication only, preserving completed draft", async () => {
  const f = fixture();
  f.state.publish = () => { const e = Error("rejected"); e.response = { status: 429 }; throw e; };
  const input = legacy({ publish: true });
  const failed = await f.invoke(input);
  assert.equal(failed.status, 503); assert.equal(failed.body.published, false);
  assert.equal(failed.body.draft_applied, true);
  assert.equal(failed.body.publication_status, "not_confirmed");
  const draft = f.state.prompt;
  f.state.publish = null;
  const retry = await f.invoke(input);
  assert.equal(retry.status, 200); assert.equal(retry.body.published, true);
  assert.equal(retry.body.publication_status, "confirmed");
  assert.equal(f.state.patches, 1); assert.equal(f.state.publishCalls, 2);
  assert.equal(f.state.prompt, draft);
  assert.equal((await f.invoke(input)).body.published, true);
  assert.equal(f.state.publishCalls, 2);
});
test("publication timeout after commit is reconciled without another POST or PATCH", async () => {
  const f = fixture();
  f.state.publish = () => { f.state.agent.is_published = true; throw Error("timeout"); };
  const input = legacy({ publish: true });
  assert.equal((await f.invoke(input)).body.published, false);
  const retry = await f.invoke(input);
  assert.equal(retry.body.published, true);
  assert.equal(f.state.publishCalls, 1); assert.equal(f.state.patches, 1);
});
test("uncertain publication blocks blind retries and competing draft writes until confirmed", async () => {
  const f = fixture();
  f.state.publish = () => { throw Error("timeout"); };
  const input = legacy({ publish: true });
  await f.invoke(input);
  const retry = await f.invoke(input);
  assert.equal(retry.status, 503); assert.equal(retry.body.published, false);
  assert.equal((await f.invoke(legacy({ request_id: "another", update_text: "A different price" }))).status, 503);
  assert.equal((await f.invoke(body())).status, 503);
  assert.equal(f.state.patches, 1); assert.equal(f.state.publishCalls, 1);
  f.state.agent.is_published = true;
  assert.equal((await f.invoke(input)).body.published, true);
});
test("publish HTTP success alone and a mismatched version do not confirm publication", async () => {
  const f = fixture();
  f.state.publish = () => ({ data: { ok: true } });
  const input = legacy({ publish: true });
  assert.equal((await f.invoke(input)).body.published, false);
  f.state.agent.is_published = true; f.state.agent.version = 8;
  assert.equal((await f.invoke(input)).body.published, false);
  assert.equal(f.state.publishCalls, 1);
});
test("an old Request ID marker without matching durable draft evidence cannot trigger publication", async () => {
  const f = fixture({ prompt: "Historical instructions\nRequest ID: legacy-fixture\n" });
  const result = await f.invoke(legacy({ publish: true }));
  assert.equal(result.status, 409);
  assert.equal(code(result), "PUBLICATION_DRAFT_UNVERIFIED");
  assert.equal(f.state.publishCalls, 0); assert.equal(f.state.patches, 0);
});
test("a rejected publication cannot publish a newer unrelated draft on retry", async () => {
  const f = fixture();
  f.state.publish = () => { const e = Error("rejected"); e.response = { status: 400 }; throw e; };
  const input = legacy({ publish: true });
  await f.invoke(input);
  await f.invoke(legacy({ request_id: "newer", update_text: "Revised rates" }));
  f.state.publish = null;
  const result = await f.invoke(input);
  assert.equal(result.status, 409); assert.equal(code(result), "MANUAL_REVIEW_REQUIRED");
  assert.equal(result.body.published, false); assert.equal(f.state.publishCalls, 1);
});
test("published agent with wrong immutable LLM prompt cannot confirm publication", async () => {
  const f = fixture();
  f.state.publishedPrompt = "A different version's instructions";
  const result = await f.invoke(legacy({ publish: true }));
  assert.equal(result.status, 503); assert.equal(result.body.published, false);
});
test("published agent with null LLM version is unverified, never falls back to latest", async () => {
  const f = fixture();
  f.state.agent.response_engine.version = null;
  const result = await f.invoke(legacy({ publish: true }));
  assert.equal(result.status, 503); assert.equal(result.body.published, false);
});
test("SDK serializes implemented SET and Lua calls without contacting Redis", async () => {
  const { createClient } = require("@vercel/kv");
  const commands = [];
  const client = createClient({ request: async request => {
    commands.push(request.body);
    if (request.body[0] === "get") return { result: '{"status":"uncertain"}' };
    return { result: request.body[0] === "set" ? "OK" : 1 };
  } });
  assert.equal(await client.set("lock", "token", { nx: true, px: 60000 }), "OK");
  assert.deepEqual(commands.pop(), ["set", "lock", "token", "nx", "px", 60000]);
  for (const [script, keys, args] of [
    [RENEW, ["lock"], ["token", 60000]],
    [RELEASE, ["lock"], ["token"]],
    [GUARDED_SET, ["lock", "journal"], ["token", '{"status":"uncertain"}']],
  ]) {
    assert.equal(await client.eval(script, keys, args), 1);
    assert.deepEqual(commands.pop(), ["eval", script, keys.length, ...keys, ...args]);
  }
  assert.deepEqual(await client.get("journal"), { status: "uncertain" });
});
test("ownership follows both pagination levels and detects a shared historical LLM", async () => {
  const { verifyOwnership } = require("../lib/retell-ownership");
  const seen = [];
  const axios = { get: async (url, options) => {
    seen.push([url, options.params]);
    if (url.endsWith("/v2/list-agents")) return { data: options.params.pagination_key
      ? { items: [{ agent_id: "agent_other", channel: "chat" }], has_more: false }
      : { items: [{ agent_id: "agent_example", channel: "voice" }], has_more: true, pagination_key: "next-agents" } };
    if (url.includes("/list-agent-versions/")) return { data: options.params.pagination_key
      ? { items: [{ version: 2 }], has_more: false }
      : { items: [{ version: 1 }], has_more: true, pagination_key: "next-versions" } };
    const id = url.split("/").pop();
    return { data: { agent_id: id, version: options.params.version,
      response_engine: { type: "retell-llm", llm_id: id === "agent_example" || options.params.version === 2 ? "opaqueLLM" : "differentLLM" } } };
  } };
  axios.post = (url, body, options) => {
    assert.deepEqual(body, {});
    return axios.get(url, options);
  };
  await assert.rejects(verifyOwnership(axios, "https://mock.invalid", {}, "agent_example", "opaqueLLM"), /SHARED_OR_UNVERIFIED_LLM/);
  assert.ok(seen.some(([, params]) => params.pagination_key === "next-agents"));
  assert.ok(seen.some(([, params]) => params.pagination_key === "next-versions"));
  assert.ok(seen.some(([url]) => url.endsWith("/get-chat-agent/agent_other")));
});
test("missing, repeating or exhausted pagination fails closed rather than proving ownership", async () => {
  const { pages } = require("../lib/retell-ownership");
  for (const response of [
    { items: [], has_more: true },
    { items: [], has_more: true, pagination_key: "same" },
    { items: [] },
  ]) {
    await assert.rejects(pages({ get: async () => ({ data: response }) }, "https://mock.invalid", {}), /OWNERSHIP_LIST_INCOMPLETE/);
  }
  let calls = 0;
  await assert.rejects(pages({ get: async () => ({ data: {
    items: [], has_more: true, pagination_key: `cursor-${++calls}`,
  } }) }, "https://mock.invalid", {}), /OWNERSHIP_LIST_INCOMPLETE/);
  assert.equal(calls, 100);
});
test("official opaque LLM IDs without llm_ prefix are accepted", async () => {
  const f = fixture();
  f.state.agent.response_engine.llm_id = "opaqueLLM";
  const get = f.axios.get, patch = f.axios.patch;
  f.axios.get = (url, options) => get(url.replace("/opaqueLLM", "/llm_example"), options);
  f.axios.patch = (url, input) => patch(url.replace("/opaqueLLM", "/llm_example"), input);
  const result = await f.invoke();
  assert.equal(result.status, 200); assert.equal(result.body.llm_id, "opaqueLLM");
});
test("published LLM response must match the requested exact version", async () => {
  const f = fixture();
  const get = f.axios.get;
  f.axios.get = async (url, options) => {
    const response = await get(url, options);
    if (url.includes("/get-retell-llm/") && options?.params?.version !== undefined) response.data.version = 99;
    return response;
  };
  const result = await f.invoke(legacy({ publish: true }));
  assert.equal(result.status, 503); assert.equal(result.body.published, false);
});

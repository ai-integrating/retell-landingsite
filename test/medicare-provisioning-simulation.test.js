"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

// Run the REAL provision handler with in-memory KV and fake Retell/number APIs.
// Never call Stripe, Zapier, Retell, Vercel, or Cal.com.
function harness() {
  const state = new Map(), calls = [];
  let failNumberOnce = false;
  const kv = {
    get: async k => structuredClone(state.get(k) ?? null),
    set: async (k, v, opts = {}) => {
      if (opts.nx && state.has(k)) return null;
      state.set(k, structuredClone(v));
      return "OK";
    },
    del: async k => state.delete(k),
  };
  const axios = {
    get: async url => {
      calls.push(["GET", url]);
      if (url.includes("/get-conversation-flow/"))
        return { data: { model_choice: { type: "cascading", model: "gpt-4o-mini" },
          global_prompt: "mock", start_speaker: "agent", start_node_id: "start",
          nodes: [{ id: "start", type: "conversation" }], tools: [] } };
      if (url.includes("/get-retell-llm/"))
        return { data: { general_prompt: "mock", general_tools: [] } };
      if (url.includes("/get-agent/"))
        return { data: { interruption_sensitivity: 0, responsiveness: 1 } };
      throw Error("Unexpected GET: " + url);
    },
    post: async (url, payload) => {
      calls.push(["POST", url, structuredClone(payload)]);
      if (url.endsWith("/create-conversation-flow"))
        return { data: { conversation_flow_id: "conversation_flow_mock" } };
      if (url.endsWith("/create-retell-llm"))
        return { data: { llm_id: "llm_mock" } };
      if (url.endsWith("/create-agent"))
        return { data: { agent_id: "agent_mock" } };
      if (url.endsWith("/api/buy-number")) {
        if (failNumberOnce) { failNumberOnce = false; throw Error("SIMULATED_NUMBER_OUTAGE"); }
        return { data: { ok: true, phone_number: "+15555550100", phone_number_id: "pn_mock" } };
      }
      throw Error("Unexpected POST: " + url);
    },
    patch: async (url, payload) => { calls.push(["PATCH", url, payload]); return { data: payload }; },
  };
  const originalLoad = Module._load;
  const handlerPath = require.resolve("../api/provision.js");
  const previousKey = process.env.RETELL_API_KEY, previousVoice = process.env.VOICE_FEMALE_WARM,
    previousMale = process.env.VOICE_MALE_CALM;
  process.env.RETELL_API_KEY = "offline-mock-only";
  process.env.VOICE_FEMALE_WARM = "voice_mock_female";
  process.env.VOICE_MALE_CALM = "voice_mock_male";
  Module._load = function(request, parent, isMain) {
    if (request === "axios") return axios;
    if (request === "@vercel/kv") return { kv };
    if (request === "../lib/mcduffy-write-guard") return { protectedSetup: () => false };
    if (request === "../lib/onboarding-business") return { capture: () => null };
    if (request === "../lib/refinement-coordinator")
      return { withLlm: async (_config, fn) => fn({
        applyConfiguration: async ({ patch }) => patch(),
      }) };
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[handlerPath];
  const handler = require(handlerPath);
  Module._load = originalLoad;
  function cleanup() {
    delete require.cache[handlerPath];
    for (const [key, value] of [["RETELL_API_KEY",previousKey],
      ["VOICE_FEMALE_WARM",previousVoice],["VOICE_MALE_CALM",previousMale]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  async function invoke(body) {
    const res = { code: 200, headers: {},
      setHeader(k,v) { this.headers[k] = v; },
      status(n) { this.code = n; return this; },
      json(v) { this.data = v; return this; },
      end() { return this; } };
    await handler({ method: "POST", body: structuredClone(body), headers: {host:"mock.invalid"} }, res);
    return res;
  }
  return { state, calls, invoke, cleanup, failNumber: () => { failNumberOnce = true; } };
}
const base = {
  jotform_submission_id: "12345678901234567890",
  business_name: "Offline Mock Benefits",
  mode: "agent_only",
  global_info: "Owner Name: Jordan Rivera\nBusiness Phone: 555-0100",
  scheduler_setup: "Existing client appointments",
  cal_username: "mock-broker",
  cal_slug: "medicare-review",
  service_key: "medicare-review",
  timezone: "America/New_York",
};
const count = (h, suffix) => h.calls.filter(c => c[0] === "POST" && c[1].endsWith(suffix)).length;

test("Medicare purchase creates Conversation Flow agent, stores calendar and replays idempotently", async () => {
  const h = harness();
  try {
    const body = {...base, purchased_package: "Medicare Premium Scheduler"};
    const first = await h.invoke(body);
    assert.equal(first.code, 200, JSON.stringify(first.data));
    assert.equal(first.data.prompt_source, "medicare_conversation_flow");
    assert.equal(first.data.calendar_config_saved, true);
    assert.equal(count(h,"/create-conversation-flow"), 1);
    assert.equal(count(h,"/create-retell-llm"), 0);
    const create = h.calls.find(c=>c[1].endsWith("/create-agent"));
    assert.equal(create[2].response_engine.type, "conversation-flow");
    assert.equal(create[2].response_engine.conversation_flow_id, "conversation_flow_mock");
    assert.equal(h.state.get("prov:"+base.jotform_submission_id).conversation_flow_id,"conversation_flow_mock");
    assert.equal(h.state.get("agentcfg:agent_mock").cal_slug,"medicare-review");
    const second = await h.invoke(body);
    assert.equal(second.code,200);
    assert.equal(second.data.idempotent,true);
    assert.equal(count(h,"/create-agent"),1);
  } finally { h.cleanup(); }
});

test("number purchase outage resumes Medicare without creating another agent or flow", async () => {
  const h = harness();
  try {
    const body = {...base, purchased_package: "Medicare Premium Scheduler", mode: "agent_and_number"};
    h.failNumber();
    const failed = await h.invoke(body);
    assert.equal(failed.code,500);
    assert.equal(h.state.get("prov:"+base.jotform_submission_id).status,"agent_created");
    const recovered = await h.invoke(body);
    assert.equal(recovered.code,200,JSON.stringify(recovered.data));
    assert.equal(recovered.data.phone_number,"+15555550100");
    assert.equal(count(h,"/create-agent"),1);
    assert.equal(count(h,"/create-conversation-flow"),1);
    assert.equal(count(h,"/api/buy-number"),2);
  } finally { h.cleanup(); }
});

test("regular Marcus and Ava remain retell-llm agents, not Medicare flows", async () => {
  for (const [packageName,agentName] of [
    ["Marcus — Front Desk Receptionist","Marcus"],
    ["Ava — AI Scheduler","Ava"],
  ]) {
    const h = harness();
    try {
      const r = await h.invoke({...base,purchased_package:packageName,agent_name:agentName});
      assert.equal(r.code,200,JSON.stringify(r.data));
      assert.equal(count(h,"/create-conversation-flow"),0);
      assert.equal(count(h,"/create-retell-llm"),1);
      const create = h.calls.find(c=>c[1].endsWith("/create-agent"));
      assert.equal(create[2].response_engine.type,"retell-llm");
    } finally { h.cleanup(); }
  }
});

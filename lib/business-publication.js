const { isDeepStrictEqual } = require("node:util");
const { validate, OPERATION, range, section, receipt, hash, fail } = require("./refinement-section");
const { pages, verifyOwnership } = require("./retell-ownership");
const { withLlm } = require("./refinement-coordinator");
const { publishLegacy } = require("./refinement-publication");
const PUBLISH_OPERATION = "publish_business_section_v1";
function comparable(value, isLlm = false) {
  const result = structuredClone(value);
  // Only documented server-managed version metadata is excluded.
  for (const key of ["version", "is_published", "last_modification_timestamp", "created_timestamp"]) delete result[key];
  if (isLlm) delete result.general_prompt;
  else if (result.response_engine) delete result.response_engine.version;
  return result;
}
function outside(prompt) {
  if (typeof prompt !== "string") fail(409, "MANUAL_REVIEW_REQUIRED");
  const bounds = range(prompt);
  if (!bounds) fail(409, "INITIAL_SECTION_REVIEW_REQUIRED");
  return [prompt.slice(0, bounds.start), prompt.slice(bounds.end)];
}
function assertNoUnrelatedDraft(draft, published) {
  const draftOutside = outside(draft.llm.general_prompt);
  const publishedBounds = range(published.llm.general_prompt);
  const sameOutside = publishedBounds
    ? isDeepStrictEqual(draftOutside, outside(published.llm.general_prompt))
    : draftOutside[0] === published.llm.general_prompt + (published.llm.general_prompt ? "\n\n" : "") && draftOutside[1] === "";
  if (!isDeepStrictEqual(comparable(draft.agent), comparable(published.agent)) ||
      !isDeepStrictEqual(comparable(draft.llm, true), comparable(published.llm, true)) ||
      !sameOutside) {
    fail(409, "MANUAL_REVIEW_REQUIRED");
  }
}
function configurationHash(agent, llm) {
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
    return value;
  }
  return hash(JSON.stringify(canonical([comparable(agent), comparable(llm, true), llm.general_prompt])));
}
async function publishBusiness({ body, kv, axios, base, headers, expectedLlm }) {
  const v2 = body.operation === "publish_business_section_v2";
  const { validate, OPERATION, range, section, receipt, hash, fail } = require(v2 ? "./business-render-v2" : "./refinement-section");
  const PUBLISH_OPERATION = v2 ? "publish_business_section_v2" : "publish_business_section_v1";
  if (body.operation !== PUBLISH_OPERATION || body.publish !== true) fail(400, "INVALID_PUBLICATION_REQUEST");
  const { phone_number: phoneNumber, ...sectionBody } = body;
  if (typeof phoneNumber !== "string" || !/^\+[1-9]\d{7,14}$/.test(phoneNumber)) fail(409, "CALL_ROUTING_REVIEW_REQUIRED");
  const request = validate({ ...sectionBody, operation: OPERATION, publish: false });
  const options = { headers, timeout: 10000 };
  async function ensureRouting(version) {
    const phone = (await axios.get(`${base}/get-phone-number/${encodeURIComponent(phoneNumber)}`, options)).data;
    const validRoute = route => route?.agent_id === request.agent_id &&
      (route.agent_version === "latest_published" || route.agent_version === version) &&
      typeof route.weight === "number" && route.weight > 0;
    const inbound = phone?.inbound_agents;
    const outbound = phone?.outbound_agents;
    if (phone?.phone_number !== phoneNumber || phone.inbound_webhook_url ||
        !Array.isArray(inbound) || !inbound.length || !inbound.every(validRoute) ||
        Math.abs(inbound.reduce((n, r) => n + r.weight, 0) - 1) > 0.000001 ||
        (outbound?.length && (!Array.isArray(outbound) || !outbound.every(validRoute)))) {
      fail(409, "CALL_ROUTING_REVIEW_REQUIRED");
    }
  }
  const agentUrl = `${base}/get-agent/${request.agent_id}`;
  const agent = (await axios.get(agentUrl, options)).data;
  const llmId = agent?.response_engine?.llm_id;
  if (expectedLlm && llmId !== expectedLlm) fail(403, "PILOT_LLM_MISMATCH");
  if (agent?.response_engine?.type !== "retell-llm" || typeof llmId !== "string") fail(409, "INVALID_AGENT_LLM");
  if (await kv.get(`agent:${request.agent_id}:client`) !== request.client_id) fail(403, "CLIENT_AGENT_MISMATCH");
  await verifyOwnership(axios, base, options, request.agent_id, llmId);
  const llmUrl = `${base}/get-retell-llm/${llmId}`;
  return withLlm({ kv, llmId, getPrompt: async () => (await axios.get(llmUrl, options)).data.general_prompt,
    patchPrompt: () => { throw Error("PUBLICATION_CANNOT_PATCH"); },
  }, async ctx => {
    const state = ctx.state, bounds = range(ctx.prompt);
    if (!state || state.clientId !== request.client_id || state.agentId !== request.agent_id ||
        state.revision !== request.revision || state.hash !== request.snapshot_hash ||
        state.key !== request.idempotency_key || !bounds ||
        ctx.prompt.slice(bounds.start, bounds.end) !== section(request)) fail(409, "DRAFT_RECEIPT_REQUIRED");
    if (await kv.get(`agent:${request.agent_id}:client`) !== request.client_id) fail(409, "OWNERSHIP_CHANGED");
    const current = { agent: (await axios.get(agentUrl, options)).data, llm: (await axios.get(llmUrl, options)).data };
    if (current.agent.response_engine?.llm_id !== llmId) fail(409, "OWNERSHIP_CHANGED");
    const fingerprint = `business-publication:${request.idempotency_key}`;
    const previous = await ctx.getPublication();
    const configHash = configurationHash(current.agent, current.llm);
    const activeReceipt = async (version, llmVersion) => {
      await ensureRouting(version);
      return { ...receipt(request, llmId), operation: PUBLISH_OPERATION, state: "active", published: true,
        activation_verified: true, agent_version: version, llm_version: llmVersion };
    };
    await ensureRouting(previous?.fingerprint === fingerprint ? previous.version : current.agent.version);
    if (previous?.fingerprint === fingerprint) {
      if (previous.configHash !== configHash) fail(409, "MANUAL_REVIEW_REQUIRED");
    } else {
      const versions = await pages(axios, `${base}/list-agent-versions/${request.agent_id}`, options);
      const publishedVersions = versions.filter(v => v.is_published === true).sort((a, b) => b.version - a.version);
      if (!publishedVersions.length) fail(409, "INITIAL_PUBLICATION_REVIEW_REQUIRED");
      const publishedAgent = (await axios.get(agentUrl, { ...options, params: { version: publishedVersions[0].version } })).data;
      if (publishedAgent.agent_id !== request.agent_id || publishedAgent.version !== publishedVersions[0].version ||
          !publishedAgent.is_published || publishedAgent.response_engine?.llm_id !== llmId ||
          !Number.isSafeInteger(publishedAgent.response_engine.version)) fail(409, "PUBLISHED_BASELINE_UNVERIFIED");
      const publishedLlm = (await axios.get(llmUrl, { ...options, params: { version: publishedAgent.response_engine.version } })).data;
      if (publishedLlm.llm_id !== llmId || !publishedLlm.is_published || publishedLlm.version !== publishedAgent.response_engine.version) fail(409, "PUBLISHED_BASELINE_UNVERIFIED");
      assertNoUnrelatedDraft(current, { agent: publishedAgent, llm: publishedLlm });
      if (current.agent.is_published && current.llm.is_published &&
          configurationHash(publishedAgent, publishedLlm) === configHash) {
        return activeReceipt(publishedAgent.version, publishedLlm.version);
      }
    }
    await publishLegacy({ axios, base, headers, agentId: request.agent_id, llmId, fingerprint,
      prompt: ctx.prompt, getPublication: ctx.getPublication, assertLease: ctx.assertLease,
      storePublication: value => ctx.storePublication({ ...value, configHash }),
      verifyConfiguration: (a, l) => configurationHash(a, l) === configHash,
    });
    const published = await ctx.getPublication();
    const verifiedAgent = (await axios.get(agentUrl, { ...options, params: { version: published.version } })).data;
    if (verifiedAgent.agent_id !== request.agent_id || verifiedAgent.version !== published.version ||
        !verifiedAgent.is_published || verifiedAgent.response_engine?.llm_id !== llmId ||
        !Number.isSafeInteger(verifiedAgent.response_engine.version)) fail(503, "PUBLICATION_OUTCOME_UNRESOLVED");
    return activeReceipt(published.version, verifiedAgent.response_engine.version);
  });
}
module.exports = { publishBusiness, PUBLISH_OPERATION, assertNoUnrelatedDraft, configurationHash, comparable };

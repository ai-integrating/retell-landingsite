const { advance } = require("./versioned-lifecycle");
const contract = require("./business-render-v2");
const { pages, verifyOwnership } = require("./retell-ownership");
const { withLlm } = require("./refinement-coordinator");
const { fail } = require("./refinement-section");
async function versionedBusiness({ body, kv, axios, base, headers, expectedLlm, findUpgradeHits }) {
  const { operation, phase, phone_number, publish, ...payload } = body;
  if (operation !== "apply_business_revision_v3" || !["draft", "active"].includes(phase) ||
    publish !== (phase === "active") ||
    typeof phone_number !== "string" || !/^\+[1-9]\d{7,14}$/.test(phone_number))
    fail(400, "INVALID_VERSIONED_REQUEST");
  const request = contract.validate({ ...payload, operation: contract.OPERATION, publish: false });
  if (findUpgradeHits(Object.values(request.business_information).filter(v => v !== null).join("\n")).length)
    fail(402, "UPGRADE_REQUIRED");
  if (await kv.get(`agent:${request.agent_id}:client`) !== request.client_id) fail(403, "CLIENT_AGENT_MISMATCH");
  const options = { headers, timeout: 10000 };
  const agentUrl = `${base}/get-agent/${request.agent_id}`, phoneUrl = `${base}/get-phone-number/${encodeURIComponent(phone_number)}`;
  const phone = async () => {
    const value = (await axios.get(phoneUrl, options)).data;
    if (value.phone_number !== phone_number) fail(409, "PHONE_MISMATCH");
    // Only server-generated timestamp is excluded; preserve every other field.
    const { last_modification_timestamp, inbound_agents, outbound_agents, ...other } = value;
    return { phone_number, inbound_agents, outbound_agents,
      inbound_webhook_url: value.inbound_webhook_url || null,
      otherHash: contract.hash(JSON.stringify(other)) };
  };
  const initialPhone = await phone(), version = initialPhone.inbound_agents?.[0]?.agent_version;
  if (!Number.isSafeInteger(version) || version < 0) fail(409, "CALL_ROUTING_REVIEW_REQUIRED");
  const initial = (await axios.get(agentUrl, { ...options, params: { version } })).data;
  const llmId = initial.response_engine?.llm_id;
  if (initial.response_engine?.type !== "retell-llm" || !llmId ||
    (expectedLlm && llmId !== expectedLlm)) fail(409, "INVALID_AGENT_LLM");
  await verifyOwnership(axios, base, options, request.agent_id, llmId);
  const read = async agentVersion => {
    if (!Number.isSafeInteger(agentVersion) || agentVersion < 0) fail(409, "VERSION_REQUIRED");
    const agent = (await axios.get(agentUrl, { ...options, params: { version: agentVersion } })).data;
    const engine = agent.response_engine;
    if (agent.agent_id !== request.agent_id || agent.version !== agentVersion ||
      engine?.llm_id !== llmId || !Number.isSafeInteger(engine.version) || engine.version < 0)
      fail(409, "VERSION_BINDING_CHANGED");
    const llm = (await axios.get(`${base}/get-retell-llm/${llmId}`,
      { ...options, params: { version: engine.version } })).data;
    if (llm.llm_id !== llmId || llm.version !== engine.version) fail(409, "LLM_VERSION_CHANGED");
    return { agent, llm };
  };
  return withLlm({ kv, llmId, versionLifecycle: true,
    getPrompt: async () => (await read(version)).llm.general_prompt,
    patchPrompt: () => { throw Error("UNVERSIONED_PATCH_FORBIDDEN"); },
  }, async ctx => {
    const guard = async () => {
      await ctx.assertLease();
      if (await kv.get(`agent:${request.agent_id}:client`) !== request.client_id) fail(409, "OWNERSHIP_CHANGED");
    };
    const mutate = async action => { await guard(); return action(); };
    const result = await advance({ request, contract, phase, io: {
      load: ctx.loadVersions, store: value => mutate(async () => {
        await ctx.storeVersions(value);
        await ctx.registerVersionedAgent(request.agent_id);
      }),
      archive: value => mutate(() => ctx.archiveVersions(value)), phone, read,
      versions: () => pages(axios, `${base}/list-agent-versions/${request.agent_id}`, options),
      create: base_version => mutate(() => axios.post(`${base}/create-agent-version/${request.agent_id}`, { base_version }, options)),
      patch: (id, v, general_prompt) => mutate(() => axios.patch(`${base}/update-retell-llm/${id}`,
        { general_prompt }, { ...options, params: { version: v } })),
      publish: v => mutate(() => axios.post(`${base}/publish-agent-version/${request.agent_id}`, { version: v }, options)),
      route: routes => mutate(() => axios.patch(`${base}/update-phone-number/${encodeURIComponent(phone_number)}`, routes, options)),
    } });
    await guard();
    return result;
  });
}
module.exports = { versionedBusiness };

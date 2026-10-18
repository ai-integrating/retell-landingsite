const { OPERATION, validate, range, section, replaceSection, receipt, fail, hash } = require("./refinement-section");
const { withLlm } = require("./refinement-coordinator");
const { verifyOwnership } = require("./retell-ownership");

async function replaceBusiness({ body, kv, axios, base, headers, findUpgradeHits, expectedLlm }) {
  const contract = body.operation === "replace_business_section_v2" ? require("./business-render-v2") : require("./refinement-section");
  const { validate, range, section, replaceSection, receipt, fail, hash } = contract;
  const request = validate(body);
  const hits = findUpgradeHits(Object.values(request.business_information).filter(value => value !== null).join("\n"));
  if (hits.length) fail(402, "UPGRADE_REQUIRED");
  // Existing authoritative mapping is READ ONLY. Never infer, create or repair it.
  if (await kv.get(`agent:${request.agent_id}:client`) !== request.client_id) fail(403, "CLIENT_AGENT_MISMATCH");
  const options = { headers, timeout: 10000 };
  const getAgent = async () => (await axios.get(`${base}/get-agent/${request.agent_id}`, options)).data;
  const agent = await getAgent();
  const llmId = agent?.response_engine?.type === "retell-llm" && agent.response_engine.llm_id;
  if (expectedLlm && llmId !== expectedLlm) fail(403, "PILOT_LLM_MISMATCH");
  if (typeof llmId !== "string" || !/^[A-Za-z0-9_-]+$/.test(llmId)) fail(409, "INVALID_AGENT_LLM");
  // Official V2 pagination + version-specific details; summaries omit the LLM.
  await verifyOwnership(axios, base, options, request.agent_id, llmId);
  return withLlm({
    kv, llmId,
    getPrompt: async () => (await axios.get(`${base}/get-retell-llm/${llmId}`, options)).data?.general_prompt,
    patchPrompt: prompt => axios.patch(`${base}/update-retell-llm/${llmId}`, { general_prompt: prompt }, options),
  }, async ({ prompt, state, apply }) => {
    // Recheck mappings after obtaining coordination. No mappings are written.
    if (await kv.get(`agent:${request.agent_id}:client`) !== request.client_id ||
        (await getAgent())?.response_engine?.llm_id !== llmId) fail(409, "OWNERSHIP_CHANGED");
    const bounds = range(prompt);
    if (state) {
      if (state.rendererVersion && state.rendererVersion !== contract.RENDERER) fail(409, "RENDERER_DOWNGRADE_REJECTED");
      if (state.clientId !== request.client_id || state.agentId !== request.agent_id) fail(409, "SECTION_OWNER_CONFLICT");
      if (request.revision < state.revision) fail(409, "STALE_REVISION");
      if (request.revision === state.revision) {
        if (request.snapshot_hash !== state.hash || request.idempotency_key !== state.key) fail(409, "REVISION_CONFLICT");
        if (!bounds || prompt.slice(bounds.start, bounds.end) !== section(request)) fail(409, "SECTION_DRIFT");
        return receipt(request, llmId);
      }
      // Refuse to overwrite an untracked/manual change within the managed range.
      if (!bounds || hash(prompt.slice(bounds.start, bounds.end)) !== state.sectionHash) {
        fail(409, "SECTION_DRIFT");
      }
    } else if (bounds) {
      // A missing journal/state is not permission to adopt or destroy a section.
      fail(409, "UNTRACKED_SECTION");
    }
    const next = replaceSection(prompt, request);
    return apply(next, receipt(request, llmId), {
      clientId: request.client_id, agentId: request.agent_id, revision: request.revision,
      hash: request.snapshot_hash, key: request.idempotency_key,
      sectionHash: hash(section(request)),
      ...(contract.RENDERER ? { rendererVersion: contract.RENDERER, requestHash: request.request_hash } : {}),
    });
  });
}
module.exports = { replaceBusiness, OPERATION };

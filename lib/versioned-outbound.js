const { pinned, sameConfiguration } = require("./versioned-lifecycle");
const { fail } = require("./refinement-section");
const { hash } = require("./refinement-section");
async function outboundVersion({ kv, axios, base, headers, agentId, phoneNumber }) {
  const llmId = await kv.get(`agent:${agentId}:versioned-llm`);
  if (!llmId) return undefined; // Existing, non-enrolled clients are unchanged.
  const options = { headers, timeout: 10000 };
  const phone = (await axios.get(`${base}/get-phone-number/${encodeURIComponent(phoneNumber)}`, options)).data;
  const version = phone.outbound_agents?.[0]?.agent_version;
  if (!Number.isSafeInteger(version) || version < 0 || !pinned(phone, agentId, version))
    fail(409, "OUTBOUND_VERSION_UNVERIFIED");
  const agent = (await axios.get(`${base}/get-agent/${agentId}`, { ...options, params: { version } })).data;
  if (agent.agent_id !== agentId || agent.version !== version || !agent.is_published ||
    agent.response_engine?.llm_id !== llmId || !Number.isSafeInteger(agent.response_engine.version))
    fail(409, "OUTBOUND_VERSION_UNVERIFIED");
  const llm = (await axios.get(`${base}/get-retell-llm/${llmId}`,
    { ...options, params: { version: agent.response_engine.version } })).data;
  if (!llm.is_published || llm.llm_id !== llmId || llm.version !== agent.response_engine.version)
    fail(409, "OUTBOUND_VERSION_UNVERIFIED");
  const record = await kv.get(`refinement:v1:llm:${llmId}:versions`);
  if (!record) fail(409, "OUTBOUND_VERSION_UNVERIFIED");
  if (version === record.baselineVersion && record.status !== "active") {
    if (hash(JSON.stringify({ agent, llm })) !== record.baselineHash) fail(409, "OUTBOUND_BASELINE_CHANGED");
  } else {
    if (version !== record.draftAgentVersion || !["routing", "active"].includes(record.status) ||
      llm.version !== record.draftLlmVersion || hash(llm.general_prompt) !== record.targetHash)
      fail(409, "OUTBOUND_VERSION_UNVERIFIED");
    const baselineAgent = (await axios.get(`${base}/get-agent/${agentId}`,
      { ...options, params: { version: record.baselineVersion } })).data;
    const baselineLlm = (await axios.get(`${base}/get-retell-llm/${llmId}`,
      { ...options, params: { version: baselineAgent.response_engine.version } })).data;
    if (!sameConfiguration({ agent, llm }, { agent: baselineAgent, llm: baselineLlm }, record.targetGreeting))
      fail(409, "OUTBOUND_CONFIGURATION_CHANGED");
  }
  return version;
}
module.exports = { outboundVersion };

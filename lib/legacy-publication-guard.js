const { isDeepStrictEqual } = require("node:util");
const { pages } = require("./retell-ownership");
const { hash, fail } = require("./refinement-section");
const { comparable } = require("./business-publication");
async function legacyPublicationGuard({ axios, base, options, agentId, llmId, baseHash, targetPrompt }) {
  const versions = await pages(axios, `${base}/list-agent-versions/${agentId}`, options);
  const published = versions.filter(v => v.is_published).sort((a,b) => b.version-a.version)[0];
  if (!published) fail(409, "INITIAL_PUBLICATION_REVIEW_REQUIRED");
  const oldAgent = (await axios.get(`${base}/get-agent/${agentId}`, { ...options, params:{version:published.version} })).data;
  if (oldAgent.agent_id !== agentId || oldAgent.version !== published.version ||
      !oldAgent.is_published || oldAgent.response_engine?.llm_id !== llmId ||
      !Number.isSafeInteger(oldAgent.response_engine.version)) fail(409,"MANUAL_REVIEW_REQUIRED");
  const oldLlm = (await axios.get(`${base}/get-retell-llm/${llmId}`, { ...options, params:{version:oldAgent.response_engine.version} })).data;
  if (oldLlm.llm_id !== llmId || !oldLlm.is_published || oldLlm.version !== oldAgent.response_engine.version) fail(503,"PUBLISHED_BASELINE_UNVERIFIED");
  // Before the first publish, the authorized append must start from the actual
  // published prompt. On confirmed/uncertain replay it may already be published.
  if (![baseHash, hash(targetPrompt)].includes(hash(String(oldLlm.general_prompt)))) fail(409,"MANUAL_REVIEW_REQUIRED");
  return (agent,llm) => isDeepStrictEqual(comparable(agent),comparable(oldAgent)) &&
    isDeepStrictEqual(comparable(llm,true),comparable(oldLlm,true));
}
module.exports={legacyPublicationGuard};

const { hash, fail } = require("./refinement-section");

// Separate from the draft journal. Never infer publication from a successful
// prompt PATCH, a publish POST alone, or an unversioned/current-agent response.
async function publishLegacy({ axios, base, headers, agentId, llmId, fingerprint,
  prompt, getPublication, storePublication, assertLease, verifyConfiguration = () => true }) {
  const options = { headers, timeout: 10000 };
  let state = await getPublication();
  const targetHash = hash(prompt);
  const verify = async record => {
    const agent = (await axios.get(`${base}/get-agent/${agentId}`,
      { ...options, params: { version: record.version } })).data;
    if (!(agent?.agent_id === agentId && agent.version === record.version &&
      agent.is_published === true && agent.response_engine?.llm_id === llmId &&
      Number.isSafeInteger(agent.response_engine.version) && agent.response_engine.version >= 0)) return false;
    const llm = (await axios.get(`${base}/get-retell-llm/${llmId}`, {
      ...options, params: { version: agent.response_engine.version },
    })).data;
    return llm?.llm_id === llmId && llm.version === agent.response_engine.version &&
      llm.is_published === true && typeof llm.general_prompt === "string" &&
      hash(llm.general_prompt) === record.targetHash && verifyConfiguration(agent, llm);
  };
  if (state?.fingerprint === fingerprint) {
    if (state.targetHash !== targetHash || state.agentId !== agentId) fail(409, "PUBLICATION_DRAFT_CHANGED");
    if (state.status === "uncertain" || state.status === "confirmed") {
      if (!await verify(state)) fail(503, "PUBLICATION_OUTCOME_UNRESOLVED");
      await storePublication({ ...state, status: "confirmed" });
      return true;
    }
  } else if (state?.status === "uncertain") fail(503, "PUBLICATION_OUTCOME_UNRESOLVED");

  const agent = (await axios.get(`${base}/get-agent/${agentId}`, options)).data;
  if (agent?.agent_id !== agentId || agent.response_engine?.llm_id !== llmId ||
      !Number.isSafeInteger(agent.version) || agent.version < 0 || agent.is_published !== false) {
    fail(503, "PUBLICATION_VERSION_UNVERIFIED");
  }
  // Verify the intended draft is still current before recording dispatch.
  const llm = (await axios.get(`${base}/get-retell-llm/${llmId}`, options)).data;
  if (!verifyConfiguration(agent, llm)) fail(409, "PUBLICATION_CONFIGURATION_CHANGED");
  if (hash(String(llm?.general_prompt)) !== targetHash) fail(409, "PUBLICATION_DRAFT_CHANGED");
  await assertLease();
  state = { status: "uncertain", fingerprint, targetHash, agentId, version: agent.version };
  await storePublication(state);
  try {
    await axios.post(`${base}/publish-agent/${agentId}`, {}, options);
  } catch (error) {
    // Only explicit rejection is safely retryable. Timeouts, 408 and 5xx may
    // have committed remotely: keep uncertain and reconcile without re-POSTing.
    const status = error?.response?.status;
    if (status >= 400 && status < 500 && status !== 408) {
      await storePublication({ ...state, status: "rejected" });
    }
    fail(503, "PUBLICATION_NOT_CONFIRMED");
  }
  if (!await verify(state)) fail(503, "PUBLICATION_OUTCOME_UNRESOLVED");
  await storePublication({ ...state, status: "confirmed" });
  return true;
}
module.exports = { publishLegacy };

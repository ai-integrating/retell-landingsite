const { fail } = require("./refinement-section");
async function pages(axios, url, options, method = "get") {
  const items = [], cursors = new Set();
  let cursor;
  for (let page = 0; page < 100; page++) {
    const config = { ...options, params: { limit: 1000, ...(cursor ? { pagination_key: cursor } : {}) } };
    const data = (await (method === "post" ? axios.post(url, {}, config) : axios.get(url, config))).data;
    if (!Array.isArray(data?.items) || typeof data.has_more !== "boolean") fail(503, "OWNERSHIP_LIST_INCOMPLETE");
    items.push(...data.items);
    if (!data.has_more) return items;
    if (typeof data.pagination_key !== "string" || !data.pagination_key || cursors.has(data.pagination_key)) fail(503, "OWNERSHIP_LIST_INCOMPLETE");
    cursor = data.pagination_key;
    cursors.add(cursor);
  }
  fail(503, "OWNERSHIP_LIST_INCOMPLETE");
}
async function verifyOwnership(axios, base, options, agentId, llmId) {
  // V2 list items are summaries WITHOUT response_engine. Inspect every stored
  // version, not just latest: an older published version can share an LLM.
  const agents = await pages(axios, `${base}/v2/list-agents`, options, "post");
  const seen = new Set();
  let found = false, inspected = 0;
  for (const item of agents) {
    if (typeof item?.agent_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(item.agent_id) || seen.has(item.agent_id)) fail(503, "OWNERSHIP_LIST_INCOMPLETE");
    if (!["voice", "chat"].includes(item.channel)) fail(503, "OWNERSHIP_LIST_INCOMPLETE");
    seen.add(item.agent_id);
    const versions = await pages(axios, `${base}/list-agent-versions/${item.agent_id}`, options);
    if (!versions.length) fail(503, "OWNERSHIP_LIST_INCOMPLETE");
    for (const entry of versions) {
      if (!Number.isSafeInteger(entry.version) || entry.version < 0 || ++inspected > 5000) fail(503, "OWNERSHIP_LIST_INCOMPLETE");
      const endpoint = item.channel === "chat" ? "get-chat-agent" : "get-agent";
      const agent = (await axios.get(`${base}/${endpoint}/${item.agent_id}`, { ...options, params: { version: entry.version } })).data;
      if (agent?.agent_id !== item.agent_id || agent.version !== entry.version || !agent.response_engine) fail(503, "OWNERSHIP_LIST_INCOMPLETE");
      if (agent.response_engine.type === "retell-llm" && agent.response_engine.llm_id === llmId) {
        if (item.agent_id !== agentId) fail(409, "SHARED_OR_UNVERIFIED_LLM");
        found = true;
      }
    }
  }
  if (!found) fail(409, "SHARED_OR_UNVERIFIED_LLM");
}
module.exports = { pages, verifyOwnership };

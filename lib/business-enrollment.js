// Enrollment never edits Retell or applies previously saved business data.
const { createHash } = require("node:crypto");
const { pages, verifyOwnership } = require("./retell-ownership");
const { withLlm } = require("./refinement-coordinator");
const { fail, range } = require("./refinement-section");
const HOLD = new Set(["test-6595816177431939415"]);
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const key = agent => `business:enrollment:v1:${agent}`;
function validate(body) {
  if (!body || !["inspect", "approve", "revoke"].includes(body.action) ||
      !/^agent_[a-zA-Z0-9_-]+$/.test(body.agent_id) ||
      typeof body.client_id !== "string" || !body.client_id || body.client_id.length > 200 ||
      typeof body.phone_number !== "string" || !/^\+[1-9]\d{7,14}$/.test(body.phone_number) ||
      (body.action !== "inspect" && (!Number.isSafeInteger(body.generation) || body.generation < 1 ||
       !/^[a-f0-9]{64}$/.test(body.expected_fingerprint || "") ||
       !/^[a-zA-Z0-9:_-]{1,200}$/.test(body.request_id || ""))))
    fail(400, "INVALID_ENROLLMENT_REQUEST");
}
async function inspect({ body, kv, axios, base, headers }) {
  const issues = [];
  if (HOLD.has(body.client_id)) issues.push("OPERATOR_HOLD");
  const owner = await kv.get(`agent:${body.agent_id}:client`);
  if (owner !== body.client_id) issues.push(owner ? "KV_OWNER_CONFLICT" : "KV_OWNER_MISSING");
  const options = { headers, timeout: 10000 };
  const phone = (await axios.get(`${base}/get-phone-number/${encodeURIComponent(body.phone_number)}`, options)).data;
  if (phone.phone_number !== body.phone_number) fail(409, "PHONE_MISMATCH");
  const inbound = phone.inbound_agents, outbound = phone.outbound_agents;
  const version = inbound?.[0]?.agent_version;
  const valid = Number.isSafeInteger(version) && version >= 0;
  const route = list => Array.isArray(list) && list.length === 1 &&
    list[0].agent_id === body.agent_id && list[0].agent_version === version &&
    (list[0].weight === undefined || list[0].weight === 1);
  if (!valid || !route(inbound) || !route(outbound) || phone.inbound_webhook_url)
    issues.push("EXPLICIT_ROUTING_REVIEW_REQUIRED");
  // No implicit latest lookup, even when a phone binding is absent.
  if (!valid) return { status: "blocked", issues, fingerprint: digest({ body, owner, phone }), llm_id: null };
  const agent = (await axios.get(`${base}/get-agent/${body.agent_id}`, { ...options, params: { version } })).data;
  const engine = agent.response_engine;
  if (agent.agent_id !== body.agent_id || agent.version !== version || engine?.type !== "retell-llm" ||
      !engine.llm_id || !Number.isSafeInteger(engine.version) || engine.version < 0) fail(409, "VERSION_BINDING_CHANGED");
  const llm = (await axios.get(`${base}/get-retell-llm/${engine.llm_id}`, { ...options, params: { version: engine.version } })).data;
  if (llm.llm_id !== engine.llm_id || llm.version !== engine.version) fail(409, "LLM_VERSION_CHANGED");
  if (!agent.is_published || !llm.is_published) issues.push("INITIAL_PUBLICATION_REVIEW_REQUIRED");
  // Enrollment must satisfy the same required-section precondition as updates.
  try {
    if (typeof llm.general_prompt !== "string" || !range(llm.general_prompt))
      issues.push("MANAGED_SECTION_MISSING");
  } catch {
    issues.push("MANAGED_SECTION_INVALID");
  }
  await verifyOwnership(axios, base, options, body.agent_id, engine.llm_id);
  const versions = await pages(axios, `${base}/list-agent-versions/${body.agent_id}`, options);
  const root = `refinement:v1:llm:${engine.llm_id}`;
  const journal = await kv.get(`${root}:versions`);
  const retained = require("./retained-draft");
  let excluded = false;
  if (retained.matches(body)) {
    excluded = await retained.checkRetained({ body, record: journal,
      versions: async () => versions, read: async version => {
        const agent = (await axios.get(`${base}/get-agent/${body.agent_id}`, { ...options, params: { version } })).data;
        if (agent.agent_id !== body.agent_id || agent.version !== version ||
            agent.response_engine?.llm_id !== retained.REVIEW.llm_id ||
            !Number.isSafeInteger(agent.response_engine.version)) fail(409, "VERSION_BINDING_CHANGED");
        const llm = (await axios.get(`${base}/get-retell-llm/${agent.response_engine.llm_id}`,
          { ...options, params: { version: agent.response_engine.version } })).data;
        return { agent, llm };
      } });
  }
  if (versions.some(v => !v.is_published && !(excluded && v.version === 1))) issues.push("MANUAL_DRAFT_REVIEW_REQUIRED");
  if (journal && journal.status !== "active") issues.push("UNRESOLVED_VERSION_JOURNAL");
  for (const name of ["journal", "publication", "configuration"]) {
    const value = await kv.get(`${root}:${name}`);
    if (value && value.status !== "confirmed") issues.push("UNRESOLVED_WRITER");
  }
  if (await kv.get(`${root}:maintenance`)) issues.push("AGENT_MAINTENANCE");
  const evidence = {
    client_id: body.client_id, agent_id: body.agent_id, llm_id: engine.llm_id,
    phone_number: body.phone_number, agent_version: version, llm_version: engine.version,
    baseline_hash: digest({ agent, llm }), routing_hash: digest(phone), journal_hash: digest(journal),
    ...(excluded ? { retained_policy: retained.policyHash } : {}),
  };
  return { ...evidence, fingerprint: digest(evidence), status: issues.length ? "blocked" : "reviewable", issues };
}
async function enrollment(deps) {
  const { body, kv } = deps;
  validate(body);
  const prior = await kv.get(key(body.agent_id));
  const replay = body.action === "inspect" ? null : await kv.get(`${key(body.agent_id)}:requests:${body.request_id}`);
  // Retry recovery never re-enables a revoked grant.
  if (replay) {
    if (prior?.request_id !== body.request_id) fail(409, "ENROLLMENT_SUPERSEDED");
    if (replay.client_id !== body.client_id || replay.phone_number !== body.phone_number ||
        replay.fingerprint !== body.expected_fingerprint || replay.action !== body.action ||
        replay.generation !== body.generation)
      fail(409, "ENROLLMENT_RETRY_MISMATCH");
    if (body.action === "approve" && require("./retained-draft").matches(body)) {
      const fresh = await inspect(deps);
      if (fresh.status !== "reviewable" || fresh.fingerprint !== replay.fingerprint)
        fail(409, "ENROLLMENT_REVIEW_CHANGED");
    }
    return replay;
  }
  if (body.action !== "inspect" && prior &&
      (!Number.isSafeInteger(prior.generation) || body.generation <= prior.generation))
    fail(409, "ENROLLMENT_SUPERSEDED");
  if (body.action === "revoke") {
    // A delayed approval may never have arrived. Persist a revocation tombstone
    // even in that case, so its older generation cannot subsequently activate.
    const baseline = prior || await inspect(deps);
    if (baseline.client_id !== body.client_id || baseline.phone_number !== body.phone_number ||
        baseline.fingerprint !== body.expected_fingerprint || !baseline.llm_id)
      fail(409, "ENROLLMENT_CHANGED");
    // Share the writer lease: do not report revoked while an update is in flight.
    return withLlm({ kv, llmId: baseline.llm_id, versionLifecycle: true,
      getPrompt: async () => {
        const journal = await kv.get(`refinement:v1:llm:${baseline.llm_id}:journal`);
        if (journal && journal.status !== "confirmed") fail(409, "UNRESOLVED_WRITER");
        return "";
      }, patchPrompt: () => { throw Error("FORBIDDEN"); },
    }, async ctx => {
      const current = await kv.get(key(body.agent_id));
      if (digest(current) !== digest(prior)) fail(409, "ENROLLMENT_CHANGED");
      const next = { ...baseline, action: "revoke", enabled: false, request_id: body.request_id, generation: body.generation };
      await ctx.storeEnrollment(key(body.agent_id), next);
      return next;
    });
  }
  const evidence = await inspect(deps);
  if (body.action === "inspect") return evidence;
  if (evidence.status !== "reviewable" || evidence.fingerprint !== body.expected_fingerprint)
    fail(409, "ENROLLMENT_REVIEW_CHANGED");
  return withLlm({ kv, llmId: evidence.llm_id, versionLifecycle: true,
    getPrompt: async () => {
      const data = (await deps.axios.get(`${deps.base}/get-retell-llm/${evidence.llm_id}`,
        { headers: deps.headers, timeout: 10000, params: { version: evidence.llm_version } })).data;
      return data.general_prompt;
    }, patchPrompt: () => { throw Error("FORBIDDEN"); },
  }, async ctx => {
    const fresh = await inspect(deps);
    if (fresh.status !== "reviewable" || fresh.fingerprint !== evidence.fingerprint) fail(409, "ENROLLMENT_REVIEW_CHANGED");
    const current = await kv.get(key(body.agent_id));
    if (digest(current) !== digest(prior)) fail(409, "ENROLLMENT_CHANGED");
    const next = { ...evidence, enabled: true, action: "approve", request_id: body.request_id, generation: body.generation };
    await ctx.storeEnrollment(key(body.agent_id), next);
    return next;
  });
}
async function grantFor(kv, body) {
  if (HOLD.has(body.client_id)) return null;
  const grant = await kv.get(key(body.agent_id));
  return grant?.enabled === true && grant.client_id === body.client_id &&
    grant.agent_id === body.agent_id && grant.phone_number === body.phone_number &&
    typeof grant.llm_id === "string" ? grant : null;
}
module.exports = { enrollment, inspect, grantFor, digest, key };

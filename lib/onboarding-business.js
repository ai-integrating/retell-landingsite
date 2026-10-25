// Separate, operator-reviewed initialization. Never creates agents, numbers or accounts.
const render = require("./business-render-v2");
const { digest } = require("./business-enrollment");
const { comparable } = require("./business-publication");
const { withLlm } = require("./refinement-coordinator");
const { pages, verifyOwnership } = require("./retell-ownership");
const { fail } = require("./refinement-section");
const ENABLED = true;
const protectedClients = new Set(["test-6595816177431939415", "lets-go-6659962517436476386",
  "mcduffy-and-son-paving-6547488712412593990"]);
const check = (value, code) => { if (!value) fail(409, code); };
const proofKey = submission => `onboarding:business:v1:${submission}`;
// Only explicit signup fields; missing means not_supplied, never clear.
function capture(body, businessName) {
  const inputs = { clientName: businessName, businessPhone: body.business_phone,
    serviceArea: body.service_area, businessDescription: body.global_info,
    pricingPolicies: body.pricing_policies, typicalCallers: body.typical_callers,
    salesPreference: body.sales_preference, avoidTopics: body.avoid_topics,
    everyCallInstructions: body.every_call_instructions };
  const snapshot = Object.fromEntries(render.FIELDS.map(k => [k,
    typeof inputs[k] === "string" && inputs[k].trim() ? inputs[k].trim() : null]));
  return { version: 1, snapshot,
    fieldStates: Object.fromEntries(render.FIELDS.map(k => [k, snapshot[k] === null ? "not_supplied" : "value"])) };
}
function requestFor(body, seed) {
  const request = { operation: render.OPERATION, client_id: body.client_id, agent_id: body.agent_id,
    section_id: render.SECTION_ID, revision: 1, business_information: seed.snapshot,
    snapshot_hash: render.hash(JSON.stringify(seed.snapshot)), publish: false,
    renderer_version: render.RENDERER, field_states: seed.fieldStates };
  request.request_hash = render.identity(request); request.idempotency_key = render.key(request);
  return render.validate(request);
}
async function initialize({ body, kv, axios, base, headers, enabled = ENABLED }) {
  check(body && ["prepare", "activate"].includes(body.action) &&
    Object.keys(body).every(k => ["action","client_id","agent_id","phone_number","fingerprint"].includes(k)) &&
    typeof body.client_id === "string" && /^agent_[\w-]+$/.test(body.agent_id || "") &&
    /^\+[1-9]\d{7,14}$/.test(body.phone_number || ""), "INVALID_INITIALIZATION_REQUEST");
  check(!protectedClients.has(body.client_id), "EXISTING_CLIENT_REVIEW_REQUIRED");
  if (body.action === "activate") check(enabled, "INITIALIZATION_DISABLED");
  check(await kv.get(`agent:${body.agent_id}:client`) === body.client_id, "OWNER_CHANGED");
  const options = { headers, timeout: 10000 };
  const read = async () => {
    const agent = (await axios.get(`${base}/get-agent/${body.agent_id}`, { ...options, params: { version: 0 } })).data;
    check(agent.agent_id === body.agent_id && agent.version === 0 &&
      agent.response_engine?.type === "retell-llm" && agent.response_engine.version === 0, "VERSION_CHANGED");
    const llm = (await axios.get(`${base}/get-retell-llm/${agent.response_engine.llm_id}`,
      { ...options, params: { version: 0 } })).data;
    check(llm.llm_id === agent.response_engine.llm_id && llm.version === 0, "LLM_CHANGED");
    return { agent, llm };
  };
  const initial = await read(), llmId = initial.llm.llm_id;
  const evidence = await require("./provisioning-evidence").read(kv, body.agent_id, body.client_id, llmId);
  const submission = evidence.submission_id;
  const proof = { ...evidence, status: "completed" };
  check(proof.business_bootstrap?.version === 1, "NEW_PROVISIONING_PROOF_REQUIRED");
  const request = requestFor(body, proof.business_bootstrap);
  await verifyOwnership(axios, base, options, body.agent_id, llmId);
  const versions = () => pages(axios, `${base}/list-agent-versions/${body.agent_id}`, options);
  const phone = async () => {
    const { last_modification_timestamp, ...value } =
      (await axios.get(`${base}/get-phone-number/${encodeURIComponent(body.phone_number)}`, options)).data;
    check(value.phone_number === body.phone_number && !value.inbound_webhook_url, "PHONE_CHANGED");
    for (const k of ["inbound_agents","outbound_agents"]) check(value[k]?.length === 1 &&
      value[k][0].agent_id === body.agent_id && value[k][0].weight === 1 &&
      [undefined, 0].includes(value[k][0].agent_version), "PHONE_CHANGED");
    return value;
  };
  const root = `refinement:v1:llm:${llmId}`;
  const previous = await kv.get(`${root}:bootstrap`);
  const currentPhone = await phone();
  const configuration = state => digest([comparable(state.agent), comparable(state.llm, true)]);
  const known = await versions();
  check(known.length === 1 && known[0].version === 0, "UNEXPECTED_VERSION");
  check(!await kv.get(`${root}:maintenance`), "AGENT_MAINTENANCE");
  check(!await kv.get(`business:enrollment:v1:${body.agent_id}`), "EXISTING_ENROLLMENT");
  if (!previous) {
    check(!initial.agent.is_published && !initial.llm.is_published, "EXISTING_PUBLICATION");
    check(!render.range(initial.llm.general_prompt), "EXISTING_MANAGED_SECTION");
    for (const suffix of ["lock","versions","journal","publication"]) check(!await kv.get(`${root}:${suffix}`), "EXISTING_WRITER");
    const cfg = await kv.get(`${root}:configuration`);
    check(!cfg || cfg.status === "confirmed", "EXISTING_WRITER");
  }
  const proposed = { client_id: body.client_id, agent_id: body.agent_id, llm_id: llmId,
    phone_number: body.phone_number, request, baseline: initial, phone: currentPhone,
    configuration: configuration(initial) };
  const fingerprint = previous?.fingerprint || digest(proposed);
  if (body.action === "prepare") {
    check(!previous, "INITIALIZATION_ALREADY_STARTED");
    return { status: "initial_review_required", fingerprint, client_id: body.client_id,
      agent_id: body.agent_id, llm_id: llmId, phone_number: body.phone_number,
      snapshot: request.business_information, render_contract: { rendererVersion: render.RENDERER, fieldStates: request.field_states },
      agent_version: 0, llm_version: 0, proposed_section: render.section(request),
      baseline_prompt: initial.llm.general_prompt, proposed_prompt: render.replaceSection(initial.llm.general_prompt, request),
      configuration_hash: proposed.configuration };
  }
  check(body.fingerprint === fingerprint, "INITIAL_REVIEW_CHANGED");
  return withLlm({ kv, llmId, versionLifecycle: true, bootstrapLifecycle: true,
    getPrompt: async () => (await read()).llm.general_prompt }, async ctx => {
    let record = await ctx.loadBootstrap();
    const guard = async () => {
      await ctx.assertLease();
      const latestEvidence = await require("./provisioning-evidence").read(kv, body.agent_id, body.client_id, llmId);
      check(digest(latestEvidence) === digest(evidence), "PROVENANCE_CHANGED");
      check(await kv.get(`agent:${body.agent_id}:client`) === body.client_id, "OWNER_CHANGED");
      const all = await versions(); check(all.length === 1 && all[0].version === 0, "UNEXPECTED_VERSION");
      const state = await read(); check(configuration(state) === record.configuration, "CONFIGURATION_CHANGED");
      const p = await phone();
      check(digest(p) === digest(record.phone) || digest(p) === digest(record.desiredPhone), "PHONE_CHANGED");
      return state;
    };
    if (!record) {
      // Recheck all mutable inputs after acquiring the writer lease.
      check(digest({ ...proposed, baseline: await read(), phone: await phone() }) === fingerprint, "INITIAL_REVIEW_CHANGED");
      const desiredPhone = structuredClone(currentPhone);
      for (const k of ["inbound_agents","outbound_agents"]) desiredPhone[k][0].agent_version = 0;
      const { baseline: _privateConfiguration, ...safeProposal } = proposed;
      // Do not copy tool credentials/configuration into a new KV journal.
      record = { ...safeProposal, baselinePrompt: initial.llm.general_prompt, fingerprint, desiredPhone, status: "prepared",
        targetPrompt: render.replaceSection(initial.llm.general_prompt, request) };
      await ctx.storeBootstrap(record);
      // Keep provenance after the legacy 30-day provision record expires.
      await ctx.storeBootstrapProof(proofKey(submission), { status: "completed", agent_id: body.agent_id,
        llm_id: llmId, business_bootstrap: proof.business_bootstrap });
    }
    check(record.fingerprint === body.fingerprint && digest(record.request) === digest(request), "REQUEST_CHANGED");
    await ctx.registerInitializingAgent(body.agent_id);
    const store = async status => { record = { ...record, status }; await ctx.storeBootstrap(record); };
    let current = await guard();
    if (record.status === "prepared") {
      check(!current.agent.is_published && !current.llm.is_published &&
        current.llm.general_prompt === record.baselinePrompt, "PROMPT_CHANGED");
      await store("patch_uncertain"); await guard();
      await axios.patch(`${base}/update-retell-llm/${llmId}`, { general_prompt: record.targetPrompt },
        { ...options, params: { version: 0 } });
    }
    current = await guard(); check(current.llm.general_prompt === record.targetPrompt, "PATCH_UNCONFIRMED");
    if (record.status === "patch_uncertain") await store("draft");
    if (record.status === "draft") {
      check(!current.agent.is_published && !current.llm.is_published, "PUBLICATION_CHANGED");
      await store("publish_uncertain"); await guard();
      await axios.post(`${base}/publish-agent-version/${body.agent_id}`, { version: 0 }, options);
    }
    current = await guard();
    check(current.agent.is_published && current.llm.is_published, "PUBLICATION_UNCONFIRMED");
    if (record.status === "publish_uncertain") await store("published");
    if (record.status === "published") {
      await store("routing_uncertain"); await guard();
      await axios.patch(`${base}/update-phone-number/${encodeURIComponent(body.phone_number)}`,
        { inbound_agents: record.desiredPhone.inbound_agents, outbound_agents: record.desiredPhone.outbound_agents }, options);
    }
    current = await guard();
    check(digest(await phone()) === digest(record.desiredPhone), "ROUTING_UNCONFIRMED");
    const lifecycle = { identity: render.hash(JSON.stringify(request)), revision: 1, status: "active",
      baselineVersion: 0, baselineHash: render.hash(JSON.stringify(current)),
      phone: record.desiredPhone, knownVersions: [0], targetHash: render.hash(record.targetPrompt),
      draftAgentVersion: 0, draftLlmVersion: 0, llmId };
    const priorVersions = await ctx.loadVersions();
    check(!priorVersions || digest(priorVersions) === digest(lifecycle), "VERSION_JOURNAL_CHANGED");
    await ctx.storeVersions(lifecycle); await ctx.registerVersionedAgent(body.agent_id);
    await store("active");
    check(await require("./versioned-outbound").outboundVersion({kv,axios,base,headers,
      agentId:body.agent_id,phoneNumber:body.phone_number}) === 0, "OUTBOUND_UNCONFIRMED");
    return { ...render.receipt(request,llmId), operation:"initialize_business_v1", state:"active",
      published:true,activation_verified:true,agent_version:0,llm_version:0,
      fingerprint, phone_number:body.phone_number,snapshot:request.business_information,
      render_contract:{rendererVersion:render.RENDERER,fieldStates:request.field_states} };
  });
}
async function blocksNumberSetup(kv, agentId) {
  // Permanent target-only barrier: a delayed setup retry must never buy/bind
  // another number after reviewed initialization starts, even before publication.
  return Boolean(await kv.get(`agent:${agentId}:initialization-llm`));
}
module.exports = { initialize, capture, ENABLED, proofKey, blocksNumberSetup };

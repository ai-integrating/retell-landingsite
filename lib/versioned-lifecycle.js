const assert = require("node:assert/strict");
const { isDeepStrictEqual: equal } = require("node:util");
const { hash } = require("./refinement-section");
const { comparable } = require("./business-publication");
function same(a, b, expectedGreeting) {
  const agent = comparable(a.agent), baseline = comparable(b.agent);
  if (a.agent.version !== b.agent.version) {
    // A clone must name the exact requested parent, even if that original
    // baseline omitted lineage metadata. Never ignore unverified lineage.
    if (!number(b.agent.version) || a.agent.base_version !== b.agent.version) return false;
    delete agent.base_version;
    delete baseline.base_version;
  }
  // Same-version adoption/replay retains the metadata comparison. The caller
  // also checks the full baseline hash, including any original lineage field.
  const llm = comparable(a.llm, true), original = comparable(b.llm, true);
  if (expectedGreeting !== undefined) {
    if (a.llm.begin_message !== expectedGreeting) return false;
    // Exclude only after validating the explicitly authorized target.
    delete llm.begin_message; delete original.begin_message;
  }
  return equal(agent, baseline) && equal(llm, original);
}
const number = n => Number.isSafeInteger(n) && n >= 0;
function check(ok, code) { if (!ok) { const e = Error(code); e.code = code; throw e; } }
function pinned(phone, agent, version) {
  return !phone.inbound_webhook_url && ["inbound_agents", "outbound_agents"].every(k =>
    Array.isArray(phone[k]) && phone[k].length > 0 &&
    phone[k].every(x => x.agent_id === agent && x.agent_version === version && x.weight > 0) &&
    Math.abs(phone[k].reduce((s, x) => s + x.weight, 0) - 1) < 0.000001);
}
// IO must hold the shared LLM lease, persist before dispatch, and expose only
// version-specific reads/writes. Manual Retell edits still require maintenance.
async function advance({ io, request, contract, phase, initialAdoption = false }) {
  check(["draft", "active"].includes(phase), "INVALID_PHASE");
  const identity = hash(JSON.stringify(request));
  let record = await io.load();
  const phone = await io.phone();
  if (record && record.identity !== identity) {
    check(record.status === "active", "PREVIOUS_OPERATION_UNRESOLVED");
    check(request.revision > record.revision, "STALE_REVISION");
    check(pinned(phone, request.agent_id, record.draftAgentVersion), "ACTIVE_ROUTING_CHANGED");
    const active = await io.read(record.draftAgentVersion);
    check(active.agent.is_published && active.llm.is_published &&
      hash(active.llm.general_prompt) === record.targetHash &&
      same(active, await io.read(record.baselineVersion), record.targetGreeting), "ACTIVE_BASELINE_CHANGED");
    await io.archive(record);
    record = null;
  }
  if (!record) {
    const version = phone.inbound_agents?.[0]?.agent_version;
    check(number(version) && pinned(phone, request.agent_id, version), "CALL_ROUTING_REVIEW_REQUIRED");
    const baseline = await io.read(version);
    if (request.greeting) check(
      hash(JSON.stringify(baseline.llm.begin_message ?? null)) === request.greeting.expected_hash ||
      baseline.llm.begin_message === request.greeting.text, "GREETING_BASELINE_CHANGED");
    check(baseline.agent.is_published && baseline.llm.is_published, "INITIAL_PUBLICATION_REVIEW_REQUIRED");
    const versions = await io.versions();
    check(versions.every(v => v.is_published), "MANUAL_DRAFT_REVIEW_REQUIRED");
    const bounds = contract.range(baseline.llm.general_prompt);
    // Initial adoption must be separately reviewed; never import an arbitrary baseline.
    check(bounds || initialAdoption, "INITIAL_SECTION_REVIEW_REQUIRED");
    let alreadyPublished = false;
    if (contract.section && bounds) {
      const text = baseline.llm.general_prompt.slice(bounds.start, bounds.end);
      const prior = Number(text.match(/\nRevision: (\d+)\n/)?.[1]);
      check(Number.isSafeInteger(prior) && prior <= request.revision, "STALE_REVISION");
      if (prior === request.revision) {
        check(text === contract.section(request), "REVISION_CONFLICT");
        if (request.greeting) check(baseline.llm.begin_message === request.greeting.text, "GREETING_REVISION_CONFLICT");
        alreadyPublished = true;
      }
    }
    record = { identity, revision: request.revision, status: "creating",
      baselineHash: hash(JSON.stringify(baseline)),
      baselineVersion: version, phone, knownVersions: versions.map(v => v.version),
      targetHash: hash(contract.replaceSection(baseline.llm.general_prompt, request)),
      ...(request.greeting ? { targetGreeting: request.greeting.text } : {}) };
    if (alreadyPublished) {
      record = { ...record, status: "active", draftAgentVersion: baseline.agent.version,
        draftLlmVersion: baseline.llm.version, llmId: baseline.llm.llm_id };
    }
    await io.store(record);
    if (!alreadyPublished) await io.create(version); // Lost response: never repeat this POST.
  }
  const store = async changes => { record = { ...record, ...changes }; await io.store(record); };
  const baseline = await io.read(record.baselineVersion);
  check(hash(JSON.stringify(baseline)) === record.baselineHash, "BASELINE_CHANGED");
  const targetPrompt = contract.replaceSection(baseline.llm.general_prompt, request);
  check(hash(targetPrompt) === record.targetHash, "TARGET_CHANGED");
  if (record.status === "creating") {
    const candidates = (await io.versions()).filter(v => !record.knownVersions.includes(v.version));
    check(candidates.length === 1 && !candidates[0].is_published, "DRAFT_CREATION_UNRESOLVED");
    const draft = await io.read(candidates[0].version);
    check(same(draft, baseline) && draft.llm.general_prompt === baseline.llm.general_prompt &&
      !draft.llm.is_published, "DRAFT_CREATION_UNRESOLVED");
    await store({ status: "patching", draftAgentVersion: draft.agent.version,
      draftLlmVersion: draft.llm.version, llmId: draft.llm.llm_id });
  }
  const readDraft = async () => {
    const d = await io.read(record.draftAgentVersion);
    check(d.llm.llm_id === record.llmId && d.llm.version === record.draftLlmVersion &&
      (same(d, baseline, record.targetGreeting) ||
        (["patching", "patch_uncertain"].includes(record.status) && same(d, baseline))),
      "DRAFT_CONFIGURATION_CHANGED");
    return d;
  };
  if (record.status === "patching") {
    const d = await readDraft();
    check(!d.agent.is_published && !d.llm.is_published, "DRAFT_ALREADY_PUBLISHED");
    if (d.llm.general_prompt !== targetPrompt ||
        (record.targetGreeting !== undefined && d.llm.begin_message !== record.targetGreeting)) {
      check(d.llm.general_prompt === baseline.llm.general_prompt && same(d, baseline), "PROMPT_DRIFT");
      // Persist dispatch uncertainty separately: a timeout cannot authorize another PATCH.
      await store({ status: "patch_uncertain" });
      await io.patch(record.llmId, record.draftLlmVersion, targetPrompt, record.targetGreeting);
    }
    const applied = await readDraft();
    check(applied.llm.general_prompt === targetPrompt &&
      (record.targetGreeting === undefined || applied.llm.begin_message === record.targetGreeting), "PATCH_UNRESOLVED");
    await store({ status: "draft" });
  }
  if (record.status === "patch_uncertain") {
    const applied = await readDraft();
    check(applied.llm.general_prompt === targetPrompt &&
      (record.targetGreeting === undefined || applied.llm.begin_message === record.targetGreeting), "PATCH_UNRESOLVED");
    await store({ status: "draft" });
  }
  const receipt = active => ({ ...contract.receipt(request, record.llmId),
    operation: active ? "publish_business_section_v2" : request.operation,
    state: active ? "active" : "draft", published: active,
    activation_verified: active, agent_version: record.draftAgentVersion,
    llm_version: record.draftLlmVersion });
  if (phase === "draft") {
    check(["draft", "publishing", "routing", "active"].includes(record.status), "DRAFT_UNCONFIRMED");
    check((await readDraft()).llm.general_prompt === targetPrompt, "PROMPT_DRIFT");
    return receipt(false);
  }
  if (record.status === "draft") {
    const d = await readDraft();
    check(d.llm.general_prompt === targetPrompt, "PROMPT_DRIFT");
    check(equal(await io.phone(), record.phone), "ROUTING_CHANGED");
    check(!d.agent.is_published && !d.llm.is_published, "UNREVIEWED_PUBLICATION");
    await store({ status: "publishing" });
    await io.publish(record.draftAgentVersion);
  }
  // Never repeat publication after an uncertain outcome; reconcile exact reads.
  const published = await readDraft();
  check(published.agent.is_published && published.llm.is_published &&
    published.llm.general_prompt === targetPrompt, "PUBLICATION_UNRESOLVED");
  if (record.status === "publishing") await store({ status: "routing" });
  let current = await io.phone();
  const desired = { ...record.phone };
  for (const k of ["inbound_agents", "outbound_agents"])
    desired[k] = desired[k].map(x => ({ ...x, agent_version: record.draftAgentVersion }));
  if (!equal(current, desired)) {
    check(record.status === "routing" && equal(current, record.phone), "ROUTING_CHANGED");
    await io.route({ inbound_agents: desired.inbound_agents, outbound_agents: desired.outbound_agents });
    current = await io.phone();
  }
  check(equal(current, desired) && pinned(current, request.agent_id, record.draftAgentVersion), "ROUTING_UNVERIFIED");
  await store({ status: "active" });
  return receipt(true);
}
module.exports = { advance, pinned, sameConfiguration: same };

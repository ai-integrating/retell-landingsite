const { createHash } = require("node:crypto");
const { fail } = require("./refinement-section");
const REVIEW = require("./mcduffy-review.json");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const policyHash = hash(REVIEW);
const matches = body => body.client_id === REVIEW.client_id && body.agent_id === REVIEW.agent_id &&
  body.phone_number === REVIEW.phone_number;
// Policy is immutable release data, not caller-supplied exception configuration.
async function checkRetained({ body, read, versions, record, adoption = false }) {
  if (!matches(body)) return false;
  if (!adoption && record?.retained_policy !== policyHash) return false;
  const retained = await read(1);
  if (hash(retained.agent) !== REVIEW.draft_agent_hash || hash(retained.llm) !== REVIEW.draft_llm_hash ||
      retained.agent.is_published || retained.llm.is_published ||
      retained.agent.response_engine.llm_id !== REVIEW.llm_id ||
      retained.agent.response_engine.version !== 1 || retained.agent.base_version !== 0)
    fail(409, "RETAINED_DRAFT_CHANGED");
  const baseline = await read(0);
  if (hash(baseline) !== REVIEW.baseline_hash) fail(409, "ADOPTION_BASELINE_CHANGED");
  const list = await versions();
  if (list.filter(v => v.version === 1 && !v.is_published).length !== 1)
    fail(409, "RETAINED_DRAFT_CHANGED");
  // During an interrupted create, exactly one new draft may await read-back.
  const permitted = new Set([1, ...(Number.isSafeInteger(record?.draftAgentVersion) ? [record.draftAgentVersion] : [])]);
  const unknown = list.filter(v => !v.is_published && !permitted.has(v.version));
  if (unknown.length && !(record?.status === "creating" && unknown.length === 1 &&
      !record.knownVersions.includes(unknown[0].version))) fail(409, "UNEXPECTED_DRAFT");
  return true;
}
module.exports = { REVIEW, hash, policyHash, matches, checkRetained };

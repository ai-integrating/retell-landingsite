const review = require("./mcduffy-review.json");
const { fail } = require("./refinement-section");

// Static, target-only barrier: does not depend on a journal, lease or enrollment.
// versionLifecycle is selected by trusted server call sites, never request input.
function guardLegacyLlm(llmId, versionLifecycle) {
  if (llmId === review.llm_id && versionLifecycle !== true)
    fail(423, "MCDUFFY_LEGACY_WRITES_PAUSED");
}
function protectedSetup(...records) {
  const identities = new Set([review.client_id, review.agent_id, review.llm_id,
    review.client_id.slice(review.client_id.lastIndexOf("-") + 1)]);
  const identityFields = new Set(["client_id", "clientId", "config_client_id", "configClientId",
    "agent_id", "agentId", "retell_agent_id", "llm_id", "llmId", "retell_llm_id",
    "submission_id", "jotform_submission_id", "submissionId", "idempotency_key", "job_id"]);
  const seen = new Set();
  function matches(value) {
    if (typeof value === "string") return identities.has(value.trim());
    if (typeof value === "number") return identities.has(String(value));
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    return Object.entries(value).some(([key, child]) =>
      (child && typeof child === "object") || identityFields.has(key) ? matches(child) : false);
  }
  return records.some(matches);
}
module.exports = { guardLegacyLlm, protectedSetup };

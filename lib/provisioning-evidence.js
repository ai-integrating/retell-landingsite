const { isDeepStrictEqual } = require("node:util");
const candidateKey = agent => `onboarding:provisioned:v1:${agent}`;
const boundKey = agent => `onboarding:identity:v1:${agent}`;
function check(v) { if (!v) throw Error("PROVISIONING_EVIDENCE_CONFLICT"); }
async function immutable(kv, key, value) {
  const existing = await kv.get(key);
  if (existing) { check(isDeepStrictEqual(existing, value)); return; }
  const result = await kv.set(key, value, { nx: true });
  if (result !== "OK") check(isDeepStrictEqual(await kv.get(key), value));
}
async function retain(kv, record) {
  // Old jobs never acquire a bootstrap marker here.
  if (!record?.business_bootstrap) return;
  check(record.status === "completed" && /^\d{6,40}$/.test(record.submission_id) &&
    /^agent_[\w-]+$/.test(record.agent_id) && /^llm_[\w-]+$/.test(record.llm_id));
  await immutable(kv, candidateKey(record.agent_id), {
    version: 1, submission_id: record.submission_id, agent_id: record.agent_id,
    llm_id: record.llm_id, business_bootstrap: record.business_bootstrap,
  });
}
async function bind(kv, agentId, clientId, submissionId) {
  const p = await kv.get(candidateKey(agentId));
  if (!p) return; // Legacy mapping remains supported, without initialization eligibility.
  check(p.version === 1 && p.agent_id === agentId && submissionId === p.submission_id);
  const value = { ...p, client_id: clientId };
  // The existing authenticated mapping action is the only source of client identity.
  const result = await kv.eval(`
    if redis.call("get",KEYS[1]) ~= ARGV[1] then return 0 end
    local old=redis.call("get",KEYS[2])
    if old and old ~= ARGV[2] then return 0 end
    redis.call("set",KEYS[2],ARGV[2]); return 1`,
  [`agent:${agentId}:client`, boundKey(agentId)], [clientId, JSON.stringify(value)]);
  check(result === 1);
}
async function read(kv, agentId, clientId, llmId) {
  const p = await kv.get(candidateKey(agentId)), b = await kv.get(boundKey(agentId));
  check(p && b && b.version === 1 && b.agent_id === agentId && b.client_id === clientId &&
    b.llm_id === llmId && /^\d{6,40}$/.test(b.submission_id) &&
    await kv.get(`agent:${agentId}:client`) === clientId);
  const {client_id, ...rest} = b;
  check(isDeepStrictEqual(rest, p));
  return b;
}
module.exports = { retain, bind, read, candidateKey, boundKey };

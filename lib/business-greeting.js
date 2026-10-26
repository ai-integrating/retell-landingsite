// Explicit greeting contract. Old nine-field contracts/receipts remain unchanged.
const v2 = require("./business-render-v2");
const RENDERER = "business-greeting-v3";
function validateGreeting(g) {
  if (!g || Object.keys(g).sort().join(",") !== "expected_hash,text" ||
      typeof g.text !== "string" || !g.text.trim() || g.text.length > 500 ||
      /[\u0000-\u001f\u007f]/.test(g.text) || /[{}]/.test(g.text) ||
      !/^[a-f0-9]{64}$/.test(g.expected_hash || ""))
    v2.fail(400, "INVALID_GREETING");
  return g;
}
const greetingHash = text => v2.hash(JSON.stringify(text ?? null));
function identity(b) {
  return v2.hash(JSON.stringify({ renderer_version: RENDERER,
    business_request_hash: v2.identity(b), greeting: validateGreeting(b.greeting) }));
}
const key = b => `business:greeting:v3:${b.client_id}:${b.agent_id}:${b.revision}:${identity(b)}`;
function legacy(b) {
  const { greeting, ...old } = b;
  old.renderer_version = v2.RENDERER;
  old.request_hash = v2.identity(old); old.idempotency_key = v2.key(old);
  return old;
}
function validate(b) {
  if (b.renderer_version !== RENDERER) v2.fail(400, "INVALID_GREETING_CONTRACT");
  validateGreeting(b.greeting);
  v2.validate(legacy(b));
  if (b.request_hash !== identity(b) || b.idempotency_key !== key(b))
    v2.fail(400, "REQUEST_IDENTITY_MISMATCH");
  return b;
}
// Greeting is a separate Retell field, never executable text appended to the prompt.
const section = b => v2.section(legacy(b));
const replaceSection = (p,b) => v2.replaceSection(p,legacy(b));
function receipt(b,llm) {
  return { ...v2.receipt(legacy(b),llm), renderer_version: RENDERER,
    idempotency_key: b.idempotency_key, request_hash: identity(b),
    rendered_section_hash: v2.hash(section(b)), greeting_hash: greetingHash(b.greeting.text) };
}
module.exports = { ...v2, RENDERER, validate, identity, key, section, replaceSection, receipt,
  greetingHash, validateGreeting };

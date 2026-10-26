const crypto = require("node:crypto");
const ENABLED = false;
const canonical = value => JSON.stringify(value, function(key, v) {
  return v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v;
});
const hash = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");
const check = (ok, code) => { if (!ok) throw Error(code); };
const holdKey = r => `billing:test:hold:${r.kind}:${r.target}`;
async function assertAllowed(kind, target) {
  if (!ENABLED) return;
  const { kv } = require("@vercel/kv");
  if (await kv.get(`billing:test:hold:${kind}:${target}`))
    throw Error("BILLING_SERVICE_SUSPENDED");
}
// Only independently reviewed registry entries are accepted. This module never
// creates registry entries or infers ownership from request-supplied phone IDs.
async function operation(io, body) {
  const r = await io.get(`billing:test:resource:${body.key}`);
  check(r && r.testOnly === true && r.key === body.key &&
    r.clientId === body.clientId && r.bindingIds.includes(body.bindingId) &&
    r.ownershipHash === body.ownershipHash, "SERVICE_OWNERSHIP_CHANGED");
  check(r.agentId && r.configClientId &&
    await io.get(`agent:${r.agentId}:client`) === r.configClientId, "AGENT_OWNERSHIP_CHANGED");
  check(["phone_inbound","phone_outbound","outbound","booking"].includes(r.kind), "UNSUPPORTED_SERVICE");
  if (body.action === "resolve") return r;
  const intent = body.intent;
  check(intent?.action === "suspend" && intent.clientId === r.clientId &&
    intent.bindingId === body.bindingId && intent.serviceKeys.includes(r.key) &&
    Number.isFinite(intent.effectiveAt) && intent.effectiveAt>0 &&
    typeof intent.id==="string" && intent.id.length>0 && intent.effectiveAt <= io.now(), "INVALID_SUSPENSION");
  const id = `billing:test:journal:${intent.id}:${hash(r.key)}`;
  const expected = {intent, resource:r};
  const previous = await io.get(id);
  if (previous) check(previous.hash === hash(expected), "JOURNAL_CONFLICT");
  if (!previous) await io.set(id, {hash:hash(expected),state:"prepared",reviewed:expected});
  const phoneKind = r.kind.startsWith("phone_");
  const field = r.kind === "phone_inbound" ? "inbound_agents" : "outbound_agents";
  if(phoneKind)check(Array.isArray(r.reviewedRoute)&&r.reviewedRoute.length===1&&
    r.reviewedRoute[0].agent_id===r.agentId&&Number.isInteger(r.reviewedRoute[0].agent_version)&&
    r.reviewedRoute[0].agent_version>=0&&r.reviewedRoute[0].weight===1&&
    hash(r.reviewedRoute)===r.routeHash,"REVIEWED_ROUTE_REQUIRED");
  async function inspect() {
    if (!phoneKind) return (await io.get(holdKey(r)))?.ownershipHash === r.ownershipHash ? "suspended" : "running";
    const phone = await io.phone(r.target);
    check(phone.phone_number === r.target && !phone.inbound_webhook_url, "PHONE_SCOPE_CHANGED");
    const other = field === "inbound_agents" ? "outbound_agents" : "inbound_agents";
    // Review binds the untouched route too. Unexpected/manual changes stop work.
    const counterpart=r.kind==="phone_inbound"?"phone_outbound":"phone_inbound";
    const otherHold=await io.get(`billing:test:hold:${counterpart}:${r.target}`);
    check(hash(phone[other] ?? null) === r.otherRouteHash ||
      Array.isArray(phone[other])&&phone[other].length===0&&otherHold?.intentId===intent.id, "OTHER_ROUTE_CHANGED");
    if (Array.isArray(phone[field]) && phone[field].length === 0) {
      check(!phone[field==="inbound_agents"?"inbound_agent_id":"outbound_agent_id"],"LEGACY_ROUTING_UNCERTAIN");
      check((await io.get(holdKey(r)))?.ownershipHash === r.ownershipHash, "UNEXPLAINED_EMPTY_ROUTE");
      return "suspended";
    }
    check(hash(phone[field]) === r.routeHash, "PHONE_ROUTE_CHANGED");
    return "running";
  }
  let state = await inspect();
  if (body.action === "inspect") return {state};
  check(body.action === "suspend", "INVALID_ACTION");
  if (state !== "suspended") {
    // Durable admission hold precedes provider writes and survives lost replies.
    await io.set(holdKey(r), {ownershipHash:r.ownershipHash,intentId:intent.id});
    if(phoneKind){
      await io.set(`billing:test:hold:phone_writes:${r.target}`,{intentId:intent.id});
      await io.set(`billing:test:hold:agent_routes:${r.agentId}`,{intentId:intent.id});
    }
    if (phoneKind) await io.patchPhone(r.target, {[field]:[]});
    state = await inspect();
  }
  check(state === "suspended", "SHUTOFF_UNVERIFIED");
  await io.set(id, {hash:hash(expected),state:"suspended",reviewed:expected});
  return {state};
}
module.exports = {ENABLED,operation,assertAllowed,hash};

const crypto = require("node:crypto");
const ENABLED = false;
const canonical = value => JSON.stringify(value, function(key, v) {
  return v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v;
});
const hash = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");
const check = (ok, code) => { if (!ok) throw Error(code); };
const holdKey = r => `billing:test:hold:${r.kind}:${r.target}`;
const emptyRoute = v => v == null || Array.isArray(v)&&v.length===0;
async function assertAllowed(kind, target) {
  const {LIVE_ENABLED}=require("../lib/billing-live-policy");
  if (!ENABLED&&!LIVE_ENABLED) return;
  const { kv } = require("@vercel/kv");
  if ((ENABLED&&await kv.get(`billing:test:hold:${kind}:${target}`))||
      (LIVE_ENABLED&&await kv.get(`billing:live:hold:${kind}:${target}`)))
    throw Error("BILLING_SERVICE_SUSPENDED");
}
// Only independently reviewed registry entries are accepted. This module never
// creates registry entries or infers ownership from request-supplied phone IDs.
async function operation(io, body, policy={namespace:"test",approved:r=>r.testOnly===true}) {
  check(["test","live"].includes(policy.namespace),"INVALID_NAMESPACE");
  const prefix=`billing:${policy.namespace}`;
  const holdKey=r=>`${prefix}:hold:${r.kind}:${r.target}`;
  const r = await io.get(`${prefix}:resource:${body.key}`);
  check(r && policy.approved(r) && r.key === body.key &&
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
  const id = `${prefix}:journal:${intent.id}:${hash(r.key)}`;
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
    check(phone && phone.phone_number === r.target && !phone.inbound_webhook_url &&
      !phone.fallback_number && !phone.fallback_numbers &&
      !phone.inbound_agent_id && !phone.outbound_agent_id, "PHONE_SCOPE_CHANGED");
    const other = field === "inbound_agents" ? "outbound_agents" : "inbound_agents";
    // Review binds the untouched route too. Unexpected/manual changes stop work.
    const counterpart=r.kind==="phone_inbound"?"phone_outbound":"phone_inbound";
    const otherHold=await io.get(`${prefix}:hold:${counterpart}:${r.target}`);
    let clearedOther=false;
    if(emptyRoute(phone[other])&&otherHold?.intentId===intent.id){
      for(const key of intent.serviceKeys){
        const candidate=await io.get(`${prefix}:resource:${key}`);
        if(candidate?.key===key&&policy.approved(candidate)&&candidate.kind===counterpart&&
          candidate.target===r.target&&candidate.clientId===r.clientId&&candidate.agentId===r.agentId&&
          candidate.configClientId===r.configClientId&&candidate.bindingIds?.includes(body.bindingId)&&
          candidate.ownershipHash===otherHold.ownershipHash){
          const journal=await io.get(`${prefix}:journal:${intent.id}:${hash(key)}`);
          if(journal?.hash===hash({intent,resource:candidate}))clearedOther=true;
        }
      }
    }
    check(hash(phone[other] ?? null) === r.otherRouteHash || clearedOther, "OTHER_ROUTE_CHANGED");
    if (emptyRoute(phone[field])) {
      const hold=await io.get(holdKey(r));
      check(hold?.ownershipHash === r.ownershipHash&&hold.intentId===intent.id, "UNEXPLAINED_EMPTY_ROUTE");
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
      await io.set(`${prefix}:hold:phone_writes:${r.target}`,{intentId:intent.id});
      await io.set(`${prefix}:hold:agent_routes:${r.agentId}`,{intentId:intent.id});
    }
    if (phoneKind) await io.patchPhone(r.target, {[field]:[]});
    state = await inspect();
  }
  check(state === "suspended", "SHUTOFF_UNVERIFIED");
  await io.set(id, {hash:hash(expected),state:"suspended",reviewed:expected});
  return {state};
}
module.exports = {ENABLED,operation,assertAllowed,hash,emptyRoute};

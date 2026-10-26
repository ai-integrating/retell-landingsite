const { verifyOwnership } = require("./retell-ownership");
const { pinned } = require("./versioned-lifecycle");
const { fail } = require("./refinement-section");
const { greetingHash } = require("./business-greeting");
async function inspectGreeting({ body, kv, axios, base, headers, expectedLlm }) {
  if (Object.keys(body).sort().join(",") !== "agent_id,client_id,operation,phone_number" ||
      typeof body.client_id !== "string" || !/^agent_[\w-]+$/.test(body.agent_id || "") ||
      !/^\+[1-9]\d{7,14}$/.test(body.phone_number || "")) fail(400,"INVALID_REQUEST");
  if (await kv.get(`agent:${body.agent_id}:client`) !== body.client_id) fail(403,"CLIENT_AGENT_MISMATCH");
  const options={headers,timeout:10000};
  const getPhone=async()=> (await axios.get(`${base}/get-phone-number/${encodeURIComponent(body.phone_number)}`,options)).data;
  const phone=await getPhone(), version=phone.inbound_agents?.[0]?.agent_version;
  if (!Number.isSafeInteger(version) || version < 0 || phone.phone_number !== body.phone_number ||
      !pinned(phone,body.agent_id,version)) fail(409,"CALL_ROUTING_REVIEW_REQUIRED");
  const agent=(await axios.get(`${base}/get-agent/${body.agent_id}`,{...options,params:{version}})).data;
  const engine=agent.response_engine;
  if (!agent.is_published || agent.agent_id !== body.agent_id || agent.version !== version ||
      engine?.type !== "retell-llm" || !Number.isSafeInteger(engine.version) || engine.version < 0 ||
      (expectedLlm && engine.llm_id !== expectedLlm)) fail(409,"VERSION_BINDING_CHANGED");
  await verifyOwnership(axios,base,options,body.agent_id,engine.llm_id);
  const llm=(await axios.get(`${base}/get-retell-llm/${engine.llm_id}`,{...options,params:{version:engine.version}})).data;
  if (!llm.is_published || llm.llm_id !== engine.llm_id || llm.version !== engine.version ||
      !pinned(await getPhone(),body.agent_id,version)) fail(409,"VERSION_BINDING_CHANGED");
  return {ok:true,client_id:body.client_id,agent_id:body.agent_id,phone_number:body.phone_number,
    llm_id:llm.llm_id,agent_version:version,llm_version:llm.version,
    greeting:typeof llm.begin_message === "string" ? llm.begin_message : null,
    greeting_hash:greetingHash(llm.begin_message),verified:true};
}
module.exports={inspectGreeting};

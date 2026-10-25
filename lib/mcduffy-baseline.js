const { REVIEW,hash,matches,checkRetained }=require("./retained-draft");
const {withLlm}=require("./refinement-coordinator");
const {pages,verifyOwnership}=require("./retell-ownership");
const {fail}=require("./refinement-section");
const contract=require("./business-render-v2");
async function pinBaseline({body,kv,axios,base,headers}){
 const {phase,phone_number,operation,...payload}=body;
 const request=contract.validate({...payload,operation:contract.OPERATION,publish:false});
 if(phase!=="baseline"||operation!=="apply_business_revision_v3"||body.publish!==false||
 !matches(body)||request.revision!==1||request.snapshot_hash!==REVIEW.snapshot_hash||request.request_hash!==REVIEW.request_hash)
 fail(403,"ADOPTION_SCOPE_CHANGED");
 const options={headers,timeout:10000};
 const read=async version=>{
 const agent=(await axios.get(`${base}/get-agent/${REVIEW.agent_id}`,{...options,params:{version}})).data;
 if(agent.agent_id!==REVIEW.agent_id||agent.version!==version||agent.response_engine?.llm_id!==REVIEW.llm_id||
 agent.response_engine.version!==version)fail(409,"VERSION_BINDING_CHANGED");
 const llm=(await axios.get(`${base}/get-retell-llm/${REVIEW.llm_id}`,{...options,params:{version}})).data;
 return {agent,llm};};
 const versions=()=>pages(axios,`${base}/list-agent-versions/${REVIEW.agent_id}`,options);
 const phone=async()=>{const {last_modification_timestamp,...p}=(await axios.get(`${base}/get-phone-number/${encodeURIComponent(phone_number)}`,options)).data;return p;};
 const current=await phone(),original=structuredClone(current);
 for(const k of ["inbound_agents","outbound_agents"]){
 if(!Array.isArray(original[k])||original[k].length!==1||original[k][0].agent_id!==REVIEW.agent_id||
 original[k][0].weight!==1||![undefined,0].includes(original[k][0].agent_version))fail(409,"ROUTING_CHANGED");
 delete original[k][0].agent_version;}
 if(hash(original)!==REVIEW.phone_hash)fail(409,"ROUTING_CHANGED");
 const desired=structuredClone(original);for(const k of ["inbound_agents","outbound_agents"])desired[k][0].agent_version=0;
 await verifyOwnership(axios,base,options,REVIEW.agent_id,REVIEW.llm_id);
 return withLlm({kv,llmId:REVIEW.llm_id,versionLifecycle:true,expectedConfigurationHash:hash(desired),
 getPrompt:async()=>(await read(0)).llm.general_prompt},async ctx=>{
 const guard=async()=>{
 await ctx.assertLease();
 if(await ctx.loadVersions())fail(409,"ADOPTION_ALREADY_STARTED");
 if(await kv.get(`agent:${REVIEW.agent_id}:client`)!==REVIEW.client_id)fail(409,"OWNERSHIP_CHANGED");
 await checkRetained({body,read,versions,adoption:true});};
 await guard();
 await ctx.applyConfiguration({expected:desired,read:async()=>{
 const p=await phone();if(hash(p)!==hash(original)&&hash(p)!==hash(desired))fail(409,"ROUTING_CHANGED");return p;},
 patch:async()=>{await guard();await axios.patch(`${base}/update-phone-number/${encodeURIComponent(phone_number)}`,
 {inbound_agents:desired.inbound_agents,outbound_agents:desired.outbound_agents},options);}});
 await guard();return {state:"baseline_pinned",client_id:REVIEW.client_id,agent_id:REVIEW.agent_id,
 phone_number,agent_version:0,snapshot_hash:request.snapshot_hash};
 });
}
module.exports={pinBaseline};

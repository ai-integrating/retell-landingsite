// Operator-only, never imported by the application. No operation runs on import.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {execFileSync}=require("node:child_process");
const {hash,operation}=require("../lib/billing-cancellation");
const BASE="3df6a5db6f9b6c94176da0fc4cc37b6fadf031c1";
const check=(ok,code)=>{if(!ok)throw Error(code);};
function write(file,data){
 const tmp=file+"."+crypto.randomUUID()+".tmp",fd=fs.openSync(tmp,"wx",0o600);
 try{fs.writeFileSync(fd,JSON.stringify(data));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(tmp,file);const dir=fs.openSync(path.dirname(file),"r");
 try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
function open(root){
 check(path.isAbsolute(root),"ABSOLUTE_STATE_PATH_REQUIRED");
 fs.mkdirSync(root,{recursive:true,mode:0o700});check(!fs.lstatSync(root).isSymbolicLink(),"SYMLINK_STATE");
 fs.chmodSync(root,0o700);
 const read=n=>{
 const v=JSON.parse(fs.readFileSync(path.join(root,n),"utf8"));
 if(n==="state.json"){const {integrity,...data}=v;check(integrity===sign(data,JSON.parse(fs.readFileSync(path.join(root,"keys.json"),"utf8")).service),"STATE_INTEGRITY");}
 return v;
 };
 return {root,read,save:(n,v)=>{
 if(n==="state.json"){const {integrity,...data}=v;v={...data,integrity:sign(data,read("keys.json").service)};}
 write(path.join(root,n),v);
 }};
}
function provenance(){
 const repo=path.resolve(__dirname,".."),git=(...a)=>execFileSync("git",["-C",repo,...a],{encoding:"utf8",env:{...process.env,GIT_OPTIONAL_LOCKS:"0"}}).trim();
 check(fs.existsSync(path.join(repo,".git"))&&git("rev-parse","--show-toplevel")===repo,"REPOSITORY_IDENTITY");
 check(!git("diff",BASE,"--","api","lib"),"SERVICE_SOURCE_CHANGED");
 return {base:BASE,tooling:git("rev-parse","HEAD"),cliHash:crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex")};
}
function init(root){
 const store=open(root);check(!fs.existsSync(path.join(root,"keys.json")),"ALREADY_INITIALIZED");
 store.save("keys.json",Object.fromEntries(["execution","cleanup","service"].map(k=>[k,crypto.randomBytes(32).toString("hex")])));
 store.save("state.json",{runId:crypto.randomUUID(),source:provenance(),ids:{},kv:{},pending:{},attempts:[],created:[],removed:[]});
 return {initialized:true,credentialsPrinted:false};
}
const sign=(grant,key)=>crypto.createHmac("sha256",key).update(JSON.stringify(grant)).digest("hex");
function verifyGrant(store,state,kind,now=Date.now()){
 const {grant,signature}=store.read(kind+"-grant.json"),key=store.read("keys.json")[kind];
 check(typeof signature==="string"&&signature.length===64&&crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(sign(grant,key))),"GRANT_SIGNATURE");
 check(grant.kind===kind&&grant.runId===state.runId&&grant.expiresAt>now,"GRANT_EXPIRED_OR_WRONG_RUN");
 check(grant.sourceHash===hash(provenance()),"SOURCE_CHANGED");
 if(kind==="cleanup"){
 check(grant.inventoryHash===hash(state.created),"CLEANUP_INVENTORY_CHANGED");
 check(state.accountKeyHash===hash(process.env.RETELL_API_KEY),"CLEANUP_ACCOUNT_CHANGED");
 }
 else check(grant.workspaceId&&grant.keyHash===hash(process.env.RETELL_API_KEY)&&grant.phoneHash===hash(process.env.RETELL_TEST_CONSENTING_PHONE),"ACCOUNT_OR_PHONE_CHANGED");
 return grant;
}
async function command(cmd,root,{fetcher=fetch,approval}={}){
 if(cmd==="init")return init(root);
 const store=open(root),s=store.read("state.json"),save=()=>store.save("state.json",s);
 if(cmd==="authorize-execution"||cmd==="authorize-cleanup"){
 check(approval?.approved===true&&typeof approval.reviewReference==="string"&&approval.reviewReference.length>5,"EXPLICIT_REVIEW_REQUIRED");
 check(Number.isFinite(approval.expiresAt)&&approval.expiresAt>Date.now()&&approval.expiresAt<=Date.now()+3600000,"GRANT_MAX_ONE_HOUR");
 const kind=cmd==="authorize-cleanup"?"cleanup":"execution";
 if(kind==="execution"){
 check(approval.workspaceId&&approval.accountConfirmed===true,"WORKSPACE_CONFIRMATION_REQUIRED");
 check(approval.pricingVerified===true||approval.acceptedPricingUncertainty===true,"PRICING_REVIEW_REQUIRED");
 check(approval.maxAttempts===3&&approval.maxSeconds===60,"REVIEWED_LIMITS_REQUIRED");
 check(process.env.RETELL_API_KEY&&process.env.RETELL_TEST_CONSENTING_PHONE,"SECURE_PROVIDER_INPUTS_REQUIRED");
 }
 const grant={kind,runId:s.runId,sourceHash:hash(provenance()),expiresAt:approval.expiresAt,
 reviewReference:approval.reviewReference,...(kind==="cleanup"?{inventoryHash:hash(s.created)}:
 {workspaceId:approval.workspaceId,keyHash:hash(process.env.RETELL_API_KEY),phoneHash:hash(process.env.RETELL_TEST_CONSENTING_PHONE)})};
 store.save(kind+"-grant.json",{grant,signature:sign(grant,store.read("keys.json")[kind])});
 return {authorizationCreated:true,kind,expiresAt:grant.expiresAt};
 }
 if(cmd==="status")return {runId:s.runId,source:provenance(),initializedSource:s.source,created:s.created.length,attempts:s.attempts.length,
 pending:Object.keys(s.pending).filter(k=>s.pending[k]),removed:s.removed.length};
 const cleanup=cmd==="cleanup",grant=verifyGrant(store,s,cleanup?"cleanup":"execution");
 check(cleanup||!s.closed,"RUN_CLOSED");
 check(process.env.RETELL_API_KEY,"RETELL_CREDENTIAL_MISSING");
 const consent=process.env.RETELL_TEST_CONSENTING_PHONE;
 if(!cleanup)check(/^\+1[2-9]\d{9}$/.test(consent||""),"CONSENT_PHONE_FORMAT");
 const lock=path.join(root,"process.lock");
 if(fs.existsSync(lock)){
 const pid=Number(fs.readFileSync(lock,"utf8"));
 check(Number.isSafeInteger(pid)&&pid>1,"LOCK_REVIEW_REQUIRED");
 let dead=false;try{process.kill(pid,0);}catch(e){if(e.code==="ESRCH")dead=true;}
 check(dead,"TEST_PROCESS_STILL_ACTIVE");fs.unlinkSync(lock);
 }
 const fd=fs.openSync(lock,"wx",0o600);fs.writeFileSync(fd,String(process.pid));
 try{
 if(!cleanup){s.accountKeyHash=grant.keyHash;save();}
 const api=async(method,p,body)=>{
 verifyGrant(store,s,cleanup?"cleanup":"execution");
 const response=await fetcher("https://api.retellai.com"+p,{method,redirect:"error",signal:AbortSignal.timeout(20000),
 headers:{Authorization:`Bearer ${process.env.RETELL_API_KEY}`,"Content-Type":"application/json"},
 ...(body?{body:JSON.stringify(body)}:{})});
 if(response.status===404)return null;
 if(!response.ok){let code="";try{const j=await response.json();code=String(j.error?.code||j.code||"").replace(/[^A-Za-z0-9_-]/g,"").slice(0,80);}catch{}
 store.save("provider-error.json",{status:response.status,method,endpoint:p.split("?")[0].replace(/\/(agent_|llm_).*/,"/[test-resource]"),code});
 throw Error("PROVIDER_HTTP_"+response.status);}
 if(response.status===204)return {};
 return response.json();
 };
 const ep=(kind,verb)=>`/${verb}-${{number:"phone-number",agent:"agent",llm:"retell-llm"}[kind]}/${encodeURIComponent(s.ids[kind])}`;
 const read=kind=>api("GET",ep(kind,"get")+(kind==="number"?"":"?version=0"));
 const create=async(kind,p,body)=>{
 if(s.ids[kind])return;
 check(!s.pending[kind],"UNKNOWN_CREATION_NO_RETRY");
 s.pending[kind]=true;save();
 const result=await api("POST",p,body);const id=result?.[{llm:"llm_id",agent:"agent_id",number:"phone_number"}[kind]];
 check(typeof id==="string"&&({number:/^\+1[2-9]\d{9}$/,agent:/^agent_[A-Za-z0-9]+$/,llm:/^llm_[A-Za-z0-9]+$/}[kind]).test(id),"CREATION_ID_INVALID");
 s.ids[kind]=id;s.created.push({kind,id,createdByTest:true,responseHash:hash(result)});s.pending[kind]=false;save();
 };
 const calls=async()=>{
 if(!s.ids.agent)return [];
 const rows=await api("POST","/v2/list-calls",{filter_criteria:{agent_id:[s.ids.agent]},limit:1000,sort_order:"descending"});
 check(Array.isArray(rows)&&rows.length<1000,"CALL_SCAN_INCOMPLETE");
 check(rows.every(c=>c.agent_id===s.ids.agent),"CALL_SCOPE");
 return rows;
 };
 const idle=async()=>check((await calls()).every(c=>["ended","error","not_connected"].includes(c.call_status)),"CALL_STILL_ACTIVE");
 const preserve=async()=>{
 check(hash(await read("agent"))===s.agentHash&&hash(await read("llm"))===s.llmHash,"AGENT_CONFIGURATION_CHANGED");
 };
 if(cmd==="prepare"){
 check(!Object.entries(s.pending).some(([k,v])=>v&&k!=="publish"),"UNCERTAIN_OPERATION");
 await create("llm","/create-retell-llm",{model:"gpt-4.1-mini",model_temperature:0,
 general_prompt:"Synthetic cancellation test only. The test price is ten dollars. No bookings or external actions.",
 begin_message:"Hello. This is the synthetic cancellation test. The price is ten dollars.",general_tools:[],states:[],knowledge_base_ids:[]});
 const llm=await read("llm");check(llm?.version===0,"LLM_VERSION");
 await create("agent","/create-agent",{agent_name:"SYNTHETIC CANCELLATION "+s.runId,
 response_engine:{type:"retell-llm",llm_id:s.ids.llm,version:0},voice_id:"retell-Cimo",max_call_duration_ms:60000});
 let agent=await read("agent");check(agent?.version===0&&agent.max_call_duration_ms===60000,"AGENT_VERSION_OR_DURATION");
 check(agent.response_engine?.llm_id===s.ids.llm&&agent.response_engine?.version===0,"AGENT_LLM_BINDING");
 check(Array.isArray(llm.general_tools)&&llm.general_tools.length===0&&Array.isArray(llm.states)&&llm.states.length===0,"UNEXPECTED_TOOLS_OR_STATES");
 if(!agent.is_published){
 check(!s.pending.publish,"PUBLICATION_UNCERTAIN");
 s.pending.publish=true;save();await api("POST",`/publish-agent-version/${s.ids.agent}`,{version:0});
 }
 agent=await read("agent");check(agent?.is_published===true,"PUBLICATION_UNCONFIRMED");
 const publishedLlm=await read("llm");
 check(publishedLlm?.llm_id===s.ids.llm&&publishedLlm.version===0&&publishedLlm.is_published===true,"LLM_PUBLICATION_UNCONFIRMED");
 s.pending.publish=false;s.agentHash=hash(agent);s.llmHash=hash(publishedLlm);save();
 return {prepared:true};
 }
 if(cmd==="purchase"){
 check(s.agentHash,"PREPARE_FIRST");await preserve();
 await create("number","/create-phone-number",{country_code:"US",toll_free:false,nickname:"SYNTHETIC CANCELLATION "+s.runId,
 inbound_agents:[{agent_id:s.ids.agent,agent_version:0,weight:1}],outbound_agents:[{agent_id:s.ids.agent,agent_version:0,weight:1}]});
 check(s.ids.number!==consent,"NUMBER_SCOPE");
 const phone=await read("number");check(!phone.inbound_webhook_url&&!phone.fallback_number,"PHONE_FALLBACK");
 const expected=[{agent_id:s.ids.agent,agent_version:0,weight:1}];
 check(hash(phone.inbound_agents)===hash(expected)&&hash(phone.outbound_agents)===hash(expected),"PHONE_ROUTE_MISMATCH");
 s.phone=phone;save();return {purchased:true};
 }
 if(["inbound","outbound","post-shutdown-inbound"].includes(cmd)){
 check(s.phone,"PURCHASE_FIRST");await idle();await preserve();
 const currentPhone=await read("number");
 check(currentPhone?.phone_number===s.ids.number&&!currentPhone.inbound_webhook_url&&!currentPhone.fallback_number,"PHONE_SCOPE_CHANGED");
 for(const field of ["inbound_agents","outbound_agents"])
 check(hash(currentPhone[field])===hash(s.suspended?[]:s.phone[field]),"PHONE_ROUTING_CHANGED");
 const wanted=["inbound","outbound","post-shutdown-inbound"][s.attempts.length];
 check(wanted===cmd&&s.attempts.length<3,"ATTEMPT_ORDER_OR_LIMIT");
 check(cmd!=="post-shutdown-inbound"||s.suspended,"SHUTDOWN_FIRST");
 s.attempts.push({kind:cmd,reservedAt:Date.now(),version:0});save();
 if(cmd==="outbound"){
 const result=await api("POST","/v2/create-phone-call",{from_number:s.ids.number,to_number:consent,
 override_agent_id:s.ids.agent,override_agent_version:0,metadata:{isolated_test:s.runId}});
 check(result?.call_id,"CALL_UNCERTAIN");s.attempts.at(-1).callId=result.call_id;save();
 return {outboundDispatched:true};
 }
 return {action:"Call once now; do not retry",testNumber:s.ids.number,maxSeconds:60};
 }
 if(cmd==="suspend"){
 check(s.attempts.length===2,"BASELINE_CALLS_REQUIRED");await idle();await preserve();
 const rows=await calls();check(rows.length===2&&rows.every(c=>c.call_status==="ended"&&c.agent_version===0&&
 c.duration_ms<=60000&&((c.from_number===consent&&c.to_number===s.ids.number)||(c.from_number===s.ids.number&&c.to_number===consent))),"BASELINE_CALL_EVIDENCE");
 s.kv[`agent:${s.ids.agent}:client`]=s.runId;save();
 const intent={id:s.runId,clientId:900009,bindingId:s.runId,action:"suspend",effectiveAt:1,serviceKeys:["in","out"]};
 for(const [key,field,kind,other] of [["in","inbound_agents","phone_inbound","outbound_agents"],["out","outbound_agents","phone_outbound","inbound_agents"]]){
 const resource={key,testOnly:true,kind,target:s.ids.number,agentId:s.ids.agent,configClientId:s.runId,clientId:900009,
 bindingIds:[s.runId],ownershipHash:hash([s.runId,key,s.ids.number]),reviewedRoute:s.phone[field],routeHash:hash(s.phone[field]),otherRouteHash:hash(s.phone[other])};
 s.kv[`billing:test:resource:${key}`]=resource;save();
 await operation({now:()=>Math.floor(Date.now()/1000),get:async k=>s.kv[k],set:async(k,v)=>{s.kv[k]=v;save();},
 phone:()=>read("number"),patchPhone:async(n,p)=>{check(n===s.ids.number,"PHONE_SCOPE");
 await api("PATCH",ep("number","update"),p);}},
 {action:"suspend",key,clientId:900009,bindingId:s.runId,ownershipHash:resource.ownershipHash,intent});
 }
 s.suspended=true;save();await preserve();return {suspended:true};
 }
 if(cmd==="verify"){
 check(approval?.inboundShutdownObserved===true,"OPERATOR_SHUTDOWN_OBSERVATION_REQUIRED");
 await idle();await preserve();const p=await read("number");
 check(s.suspended&&p&&Array.isArray(p.inbound_agents)&&p.inbound_agents.length===0&&Array.isArray(p.outbound_agents)&&p.outbound_agents.length===0,"SHUTDOWN_UNCONFIRMED");
 const rows=await calls();check(rows.length<=3,"UNEXPECTED_CALLS");
 check(s.attempts.length===3,"THREE_ATTEMPTS_NOT_RECORDED");
 check(rows.every(c=>!Number.isFinite(c.duration_ms)||c.duration_ms<=60000),"DURATION_EXCEEDED");
 const after=rows.filter(c=>c.start_timestamp>=s.attempts[2].reservedAt);
 check(after.every(c=>["error","not_connected"].includes(c.call_status)),"POST_SHUTDOWN_AGENT_CONNECTED");
 store.save("evidence.json",{runId:s.runId,routesEmpty:true,agentPreserved:true,calls:rows.map(c=>({call_id:c.call_id,status:c.call_status,duration_ms:c.duration_ms,cost:c.call_cost?.combined_cost}))});
 return {routesEmpty:true,attempts:s.attempts.length,providerCalls:rows.length};
 }
 if(cmd==="cleanup"){
 check(!Object.entries(s.pending).some(([k,v])=>v&&["number","agent","llm"].includes(k)),"UNKNOWN_CREATION_REQUIRES_DISCOVERY");
 await idle();store.save("evidence-before-cleanup.json",{runId:s.runId,created:s.created,attempts:s.attempts,calls:await calls()});
 for(const kind of ["number","agent","llm"]){
 if(!s.ids[kind])continue;
 check(s.created.some(r=>r.kind===kind&&r.id===s.ids[kind]),"CLEANUP_SCOPE");
 const current=await read(kind);
 if(kind==="number"&&current){
 check(!current.inbound_webhook_url&&!current.fallback_number,"CLEANUP_ROUTING_REVIEW");
 for(const field of ["inbound_agents","outbound_agents"])
 check(Array.isArray(current[field])&&current[field].every(r=>r.agent_id===s.ids.agent&&r.agent_version===0),"CLEANUP_ROUTING_REVIEW");
 }
 if(current)await api("DELETE",ep(kind,"delete"));
 check(await read(kind)===null,"REMOVAL_UNCONFIRMED");
 if(!s.removed.includes(kind)){s.removed.push(kind);save();}
 }
 s.closed=true;save();return {cleanupVerified:true,removed:s.removed};
 }
 throw Error("UNKNOWN_COMMAND");
 }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
if(require.main===module)command(process.argv[2],path.resolve(process.argv[3]||".local/billing-live-test"),
 {approval:process.argv[4]?JSON.parse(fs.readFileSync(process.argv[4],"utf8")):undefined})
 .then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(/^[A-Z_0-9]+$/.test(e.message)?e.message:"TEST_STOPPED_REVIEW_PRIVATE_STATE");process.exitCode=1;});
module.exports={command,init,verifyGrant,sign,provenance};

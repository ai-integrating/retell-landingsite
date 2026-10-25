const {test}=require("node:test"),a=require("node:assert/strict");
const {retain,bind,read,candidateKey,boundKey}=require("../lib/provisioning-evidence");
function fixture(){
 const map=new Map(),kv={get:async k=>structuredClone(map.get(k)??null),
 set:async(k,v)=>{if(map.has(k))return null;map.set(k,structuredClone(v));return"OK"},
 eval:async(s,keys,args)=>{
  if(map.get(keys[0])!==args[0])return 0;
  const old=map.get(keys[1]);if(old&&JSON.stringify(old)!==args[1])return 0;
  map.set(keys[1],JSON.parse(args[1]));return 1;
 }};
 const record={status:"completed",submission_id:"1234567890",agent_id:"agent_new",llm_id:"llm_new",
 business_bootstrap:{version:1,snapshot:{clientName:"Synthetic"},fieldStates:{clientName:"value"}}};
 map.set("agent:agent_new:client","client_new");
 return{map,kv,record};
}
test("durable evidence survives legacy record expiration and repeated provisioning/mapping",async()=>{
 const f=fixture();await retain(f.kv,f.record);await bind(f.kv,"agent_new","client_new","1234567890");
 for(let n=0;n<2;n++){await retain(f.kv,f.record);await bind(f.kv,"agent_new","client_new","1234567890");}
 a.equal((await read(f.kv,"agent_new","client_new","llm_new")).submission_id,"1234567890");
});
test("old completed jobs do not become eligible on retries",async()=>{
 const f=fixture();delete f.record.business_bootstrap;
 await retain(f.kv,f.record);await bind(f.kv,"agent_new","client_new","1234567890");
 a.equal(f.map.has(candidateKey("agent_new")),false);
 await a.rejects(read(f.kv,"agent_new","client_new","llm_new"));
});
test("missing, changed client, LLM, submission and evidence all fail closed",async()=>{
 const f=fixture();await a.rejects(read(f.kv,"agent_new","client_new","llm_new"));
 await retain(f.kv,f.record);
 await a.rejects(bind(f.kv,"agent_new","client_new","9876543210"));
 await bind(f.kv,"agent_new","client_new","1234567890");
 await a.rejects(read(f.kv,"agent_new","client_new","llm_other"));
 f.map.set("agent:agent_new:client","client_other");
 await a.rejects(read(f.kv,"agent_new","client_new","llm_new"));
 await a.rejects(bind(f.kv,"agent_new","client_other","1234567890"));
 f.map.set("agent:agent_new:client","client_new");
 f.map.get(candidateKey("agent_new")).submission_id="9876543210";
 await a.rejects(read(f.kv,"agent_new","client_new","llm_new"));
});
test("interrupted binding recovers without replacing immutable evidence",async()=>{
 const f=fixture();await retain(f.kv,f.record);
 await a.rejects(read(f.kv,"agent_new","client_new","llm_new"));
 await bind(f.kv,"agent_new","client_new","1234567890");
 const b=structuredClone(f.map.get(boundKey("agent_new")));
 await bind(f.kv,"agent_new","client_new","1234567890");
 a.deepEqual(f.map.get(boundKey("agent_new")),b);
 await a.rejects(retain(f.kv,{...f.record,llm_id:"llm_other"}));
});

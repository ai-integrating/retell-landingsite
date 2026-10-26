const {test} = require("node:test");
const assert = require("node:assert/strict");
const {operation,hash,ENABLED} = require("../lib/billing-cancellation");
test("defaults disabled",()=>assert.equal(ENABLED,false));
test("lost phone response recovers; opposite route, number and configuration survive",async()=>{
  const kv=new Map(),phone={phone_number:"+15550001111",inbound_agents:[{agent_id:"synthetic",agent_version:0,weight:1}],
    outbound_agents:[{agent_id:"shared",agent_version:2,weight:1}],nickname:"preserve"};
  const resource={key:"voice",target:phone.phone_number,kind:"phone_inbound",clientId:999,bindingIds:["binding"],
    testOnly:true,agentId:"synthetic",configClientId:"synthetic-client",ownershipHash:"reviewed",
    reviewedRoute:structuredClone(phone.inbound_agents),routeHash:hash(phone.inbound_agents),otherRouteHash:hash(phone.outbound_agents)};
  kv.set("agent:synthetic:client","synthetic-client");
  kv.set("billing:test:resource:voice",resource);
  let writes=0,fail=true;
  const io={now:()=>100,get:async k=>kv.get(k),set:async(k,v)=>kv.set(k,v),phone:async()=>structuredClone(phone),
    patchPhone:async(_,patch)=>{writes++;Object.assign(phone,patch);if(fail){fail=false;throw Error("lost response");}}};
  const body={action:"suspend",key:"voice",clientId:999,bindingId:"binding",ownershipHash:"reviewed",
    intent:{id:"intent",clientId:999,bindingId:"binding",action:"suspend",serviceKeys:["voice"],effectiveAt:99}};
  await assert.rejects(operation(io,body),/lost response/);
  assert.deepEqual(await operation(io,body),{state:"suspended"});
  assert.deepEqual(await operation(io,{...body,action:"inspect"}),{state:"suspended"});
  assert.equal(writes,1);assert.equal(phone.nickname,"preserve");assert.equal(phone.outbound_agents[0].agent_id,"shared");
  await assert.rejects(operation(io,{...body,ownershipHash:"changed"}),/OWNERSHIP/);
});

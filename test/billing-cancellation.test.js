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
for(const representation of ["omitted","null","empty"]){
 test("cleared "+representation+" requires matching durable intent; recover and replay both directions",async()=>{
 const kv=new Map(),route=[{agent_id:"synthetic",agent_version:0,weight:1}];
 const phone={phone_number:"+15550001111",inbound_agents:structuredClone(route),outbound_agents:structuredClone(route)};
 kv.set("agent:synthetic:client","client");
 const intent={id:"intent",clientId:999,bindingId:"binding",action:"suspend",serviceKeys:["in","out"],effectiveAt:99};
 for(const [key,kind] of [["in","phone_inbound"],["out","phone_outbound"]])kv.set("billing:test:resource:"+key,
 {key,kind,target:phone.phone_number,clientId:999,bindingIds:["binding"],testOnly:true,agentId:"synthetic",configClientId:"client",
 ownershipHash:"review-"+key,reviewedRoute:route,routeHash:hash(route),otherRouteHash:hash(route)});
 let writes=0,lost=true;
 const io={now:()=>100,get:async k=>kv.get(k),set:async(k,v)=>kv.set(k,v),phone:async()=>structuredClone(phone),
 patchPhone:async(_,patch)=>{writes++;for(const field of Object.keys(patch)){if(representation==="omitted")delete phone[field];else phone[field]=representation==="null"?null:[];}if(lost){lost=false;throw Error("lost response");}}};
 const body=key=>({action:"suspend",key,clientId:999,bindingId:"binding",ownershipHash:"review-"+key,intent});
 await assert.rejects(operation(io,body("in")),/lost response/);
 assert.deepEqual(phone.outbound_agents,route);
 assert.equal((await operation(io,body("in"))).state,"suspended");
 assert.equal((await operation(io,body("out"))).state,"suspended");
 await operation(io,body("in"));await operation(io,body("out"));assert.equal(writes,2);
 // Wrong intent's hold must not validate an absent direction.
 kv.get("billing:test:hold:phone_inbound:"+phone.phone_number).intentId="old";
 await assert.rejects(operation(io,body("in")),/UNEXPLAINED_EMPTY_ROUTE/);
 });
}
for(const change of ["missing_without_hold","opposite_missing","opposite_changed","fallback","legacy","wrong_owner"]){
 test("route omission fails closed: "+change,async()=>{
 const kv=new Map(),route=[{agent_id:"synthetic",agent_version:0,weight:1}],phone={phone_number:"+15550001111",inbound_agents:route,outbound_agents:route};
 const r={key:"in",kind:"phone_inbound",target:phone.phone_number,clientId:999,bindingIds:["binding"],testOnly:true,agentId:"synthetic",configClientId:"client",
 ownershipHash:"review",reviewedRoute:route,routeHash:hash(route),otherRouteHash:hash(route)};
 kv.set("billing:test:resource:in",r);kv.set("agent:synthetic:client",change==="wrong_owner"?"foreign":"client");
 if(change==="missing_without_hold")delete phone.inbound_agents;
 if(change==="opposite_missing")delete phone.outbound_agents;
 if(change==="opposite_changed")phone.outbound_agents=[{agent_id:"foreign",agent_version:1,weight:1}];
 if(change==="fallback")phone.fallback_number="+15550009999";
 if(change==="legacy")phone.inbound_agent_id="foreign";
 let writes=0;const io={now:()=>100,get:async k=>kv.get(k),set:async(k,v)=>kv.set(k,v),phone:async()=>phone,patchPhone:async()=>{writes++;}};
 const body={action:"suspend",key:"in",clientId:999,bindingId:"binding",ownershipHash:"review",intent:{id:"i",clientId:999,bindingId:"binding",action:"suspend",serviceKeys:["in"],effectiveAt:99}};
 await assert.rejects(operation(io,body));assert.equal(writes,0);
 });
}

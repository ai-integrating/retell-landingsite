const {test}=require("node:test"),assert=require("node:assert/strict");
const {createRunner}=require("../tools/billing-shutdown-runner.cjs");
const {hash}=require("../lib/billing-cancellation");
function fixture(){
 const kv=new Map(),route=[{agent_id:"test",agent_version:0,weight:1}];
 const phone={phone_number:"+15550001111",inbound_agents:route,outbound_agents:route};
 const r={key:"in",kind:"phone_inbound",target:phone.phone_number,agentId:"test",configClientId:"test-config",
 clientId:999,bindingIds:["a"],ownershipHash:"h",testOnly:true,createdByTest:true,
 reviewedRoute:route,routeHash:hash(route),otherRouteHash:hash(route)};
 kv.set("billing:test:resource:in",r);kv.set("agent:test:client","test-config");
 let writes=0,shared=false,lost=false,exists=true;const events=[];
 const io={now:()=>100,assertLease:async()=>{},get:async k=>kv.get(k),set:async(k,v)=>kv.set(k,v),
 phone:async()=>structuredClone(phone),patchPhone:async(n,p)=>{writes++;Object.assign(phone,p);if(lost){lost=false;throw Error("lost");}},
 hasOtherPaidCoverage:async()=>shared,retainEvidence:async()=>events.push("evidence"),
 numberExists:async()=>exists,releaseNumber:async()=>{events.push("release");exists=false;},
 deleteTestResources:async()=>events.push("delete"),verifyCleanup:async()=>assert.equal(exists,false)};
 const manifest={mode:"isolated-test",customerResources:false,runId:"run",expiresAt:200,resources:[r],
 numbers:[{id:phone.phone_number,createdByTest:true}]};
 const args={manifest,token:"a".repeat(32),secret:"a".repeat(32),io};
 const body={key:"in",clientId:999,bindingId:"a",ownershipHash:"h",
 intent:{id:"run",clientId:999,bindingId:"a",action:"suspend",serviceKeys:["in"],effectiveAt:99}};
 return {args,body,phone,events,writes:()=>writes,setShared:v=>shared=v,setLost:v=>lost=v};
}
test("runner denies missing auth, expired manifest and foreign resource",async()=>{
 const f=fixture();
 assert.throws(()=>createRunner({...f.args,token:"bad"}),/UNAUTHORIZED/);
 assert.throws(()=>createRunner({...f.args,manifest:{...f.args.manifest,expiresAt:99}}),/MANIFEST/);
 await assert.rejects(createRunner(f.args).suspend({...f.body,clientId:9}),/SCOPE/);
 assert.equal(f.writes(),0);
});
test("shared coverage, lost-response recovery and replay preserve opposite route",async()=>{
 const f=fixture(),runner=createRunner(f.args),before=structuredClone(f.phone.outbound_agents);
 f.setShared(true);assert.equal((await runner.suspend(f.body)).state,"shared-preserved");assert.equal(f.writes(),0);
 f.setShared(false);f.setLost(true);await assert.rejects(runner.suspend(f.body),/lost/);
 assert.equal((await runner.suspend(f.body)).state,"suspended");
 await runner.suspend(f.body);assert.equal(f.writes(),1);assert.deepEqual(f.phone.outbound_agents,before);
 await runner.cleanup();assert.deepEqual(f.events,["evidence","release","delete"]);
});
test("cleanup uncertain release stops before deleting other resources",async()=>{
 const f=fixture();f.args.io.releaseNumber=async()=>{throw Error("uncertain");};
 await assert.rejects(createRunner(f.args).cleanup(),/uncertain/);
 assert.deepEqual(f.events,["evidence"]);
});
test("changed registry and renewed shared coverage reject provider writes",async()=>{
 const f=fixture(),get=f.args.io.get;
 f.args.io.get=async k=>k==="billing:test:resource:in"?{...await get(k),target:"+15550009999"}:get(k);
 await assert.rejects(createRunner(f.args).suspend(f.body),/REGISTRY_CHANGED/);assert.equal(f.writes(),0);
 f.args.io.get=get;let checks=0;f.args.io.hasOtherPaidCoverage=async()=>++checks>1;
 await assert.rejects(createRunner(f.args).suspend(f.body),/COVERAGE_CHANGED/);assert.equal(f.writes(),0);
});
test("expiry at dispatch and foreign cleanup manifest fail closed",async()=>{
 const f=fixture(),runner=createRunner(f.args);let n=0;
 f.args.io.now=()=>++n>1?201:100;
 await assert.rejects(runner.suspend(f.body),/MANIFEST/);assert.equal(f.writes(),0);
 const g=fixture();g.args.manifest.numbers.push({id:"customer-number",createdByTest:false});
 await assert.rejects(createRunner(g.args).cleanup(),/CLEANUP_SCOPE/);assert.deepEqual(g.events,[]);
});
test("lost lease blocks holds and provider writes",async()=>{
 const f=fixture();f.args.io.assertLease=async()=>{throw Error("LEASE_EXPIRED");};
 await assert.rejects(createRunner(f.args).suspend(f.body),/LEASE_EXPIRED/);assert.equal(f.writes(),0);
});
